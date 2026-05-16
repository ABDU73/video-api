const express = require('express');
const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// ====================== CACHE ======================
const CACHE_FILE = path.join(__dirname, 'url_cache.json');
const cache = new Map();

// load cache from disk
try {
  if (fs.existsSync(CACHE_FILE)) {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const entries = JSON.parse(raw);
    for (const [key, value] of Object.entries(entries)) {
      cache.set(key, value);
    }
  }
} catch (_) {}

// save cache periodically and on exit
function saveCache() {
  try {
    const obj = Object.fromEntries(cache);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch (_) {}
}
setInterval(saveCache, 300000);
process.on('SIGINT', () => { saveCache(); process.exit(0); });
process.on('SIGTERM', () => { saveCache(); process.exit(0); });

// ====================== RATE LIMITER ======================
const activeRequests = new Set();
const MAX_CONCURRENT = 3;
async function withLimit(url, fn) {
  while (activeRequests.size >= MAX_CONCURRENT) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  activeRequests.add(url);
  try { return await fn(); } finally { activeRequests.delete(url); }
}

// ====================== HELPERS ======================
function getYouTubeId(url) {
  const match = url.match(/(?:youtube\.com\/.*[?&]v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// ====================== EXTRACTION ======================
async function extractYtDlp(url, format = '18') {
  const cookieFile = '/tmp/yt-cookies.txt';
  const cookiesRaw = process.env.YOUTUBE_COOKIES || '';

  if (!cookiesRaw) throw new Error('YOUTUBE_COOKIES not set');

  // Detect if the cookie string is already plain Netscape or Base64
  let cookies;
  if (cookiesRaw.startsWith('# Netscape')) {
    cookies = cookiesRaw;                     // already plain text
  } else {
    cookies = Buffer.from(cookiesRaw, 'base64').toString('utf8');
  }

  fs.writeFileSync(cookieFile, cookies);

  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const cmd = `yt-dlp --user-agent "${userAgent}" --cookies "${cookieFile}" -f ${format} --no-playlist --socket-timeout 10 -g "${url}"`;

  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000 }, (error, stdout, stderr) => {
      try { fs.unlinkSync(cookieFile); } catch (_) {}
      if (error) return reject(new Error(stderr || error.message));
      const directUrl = stdout.trim();
      if (directUrl && directUrl.startsWith('http')) resolve(directUrl);
      else reject(new Error('No direct URL'));
    });
  });
}

// ====================== GET STREAM URL ======================
async function getStreamUrl(youtubeUrl, quality = 'download', targetHeight = null) {
  const videoId = getYouTubeId(youtubeUrl);
  if (!videoId) throw new Error('Invalid YouTube URL');

  let format;
  if (quality === 'play') {
    format = 'best[height<=720]';                     // streaming
  } else if (targetHeight) {
    // /get?q=360  →  best[height<=360][ext=mp4]
    format = `best[height<=${targetHeight}][ext=mp4]`;
  } else {
    // default download = 480p
    format = 'best[height<=480][ext=mp4]';
  }

  return await extractYtDlp(youtubeUrl, format);
}

// ====================== ENDPOINTS ======================

// Health check
app.get('/status', (req, res) => res.json({ status: 'ok', cacheSize: cache.size }));

// Download endpoint – now accepts optional `q` (quality height)
app.get('/get', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const targetHeight = req.query.q ? parseInt(req.query.q, 10) : null;
  const cacheKey = targetHeight ? `${url}::${targetHeight}` : url;

  const cached = cache.get(cacheKey);
  if (cached) return res.json({ url: cached });

  try {
    const direct = await withLimit(cacheKey, () => getStreamUrl(url, 'download', targetHeight));
    cache.set(cacheKey, direct);
    return res.json({ url: direct });
  } catch (e) {
    console.error('Download extraction failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// Playback endpoint (best ≤720p, cached separately)
app.get('/play', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const cacheKey = `play:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ url: cached });

  try {
    const direct = await withLimit(cacheKey, () => getStreamUrl(url, 'play'));
    cache.set(cacheKey, direct);
    return res.json({ url: direct });
  } catch (e) {
    console.error('Playback extraction failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// Optional: search (needs YOUTUBE_API_KEY env var)
// You can delete this whole block if you don't use server-side search
app.get('/search', async (req, res) => {
  const { q, pageToken } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  if (!process.env.YOUTUBE_API_KEY) return res.status(500).json({ error: 'API key missing' });

  try {
    const resp = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        maxResults: 20,
        q,
        type: 'video',
        key: process.env.YOUTUBE_API_KEY,
        pageToken,
      },
    });

    const items = resp.data.items;
    let durations = {};
    if (items.length) {
      try {
        const durResp = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
          params: {
            part: 'contentDetails',
            id: items.map(i => i.id.videoId).join(','),
            key: process.env.YOUTUBE_API_KEY,
          },
        });
        durResp.data.items.forEach(i => durations[i.id] = i.contentDetails.duration);
      } catch (e) {}
    }

    const videos = items.map(i => ({
      videoId: i.id.videoId,
      title: i.snippet.title,
      author: i.snippet.channelTitle,
      thumbnail: i.snippet.thumbnails.high?.url || i.snippet.thumbnails.medium?.url || i.snippet.thumbnails.default?.url,
      duration: durations[i.id.videoId] || 'Unknown',
    }));

    res.json({ videos, nextPageToken: resp.data.nextPageToken });
  } catch (e) {
    res.status(500).json({ error: 'Search failed' });
  }
});

app.listen(port, () => console.log(`Vortex proxy running on port ${port}`));
