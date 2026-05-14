const express = require('express');
const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// ========== Simple in‑memory cache (file‑backed, no npm packages) ==========
const CACHE_FILE = path.join(__dirname, 'url_cache.json');
const cache = new Map();

// Load cache from disk on startup
try {
  if (fs.existsSync(CACHE_FILE)) {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const entries = JSON.parse(raw);
    for (const [key, value] of Object.entries(entries)) {
      cache.set(key, value);
    }
  }
} catch (_) {}

// Save cache to disk periodically
function saveCache() {
  try {
    const obj = Object.fromEntries(cache);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch (_) {}
}
setInterval(saveCache, 300000); // every 5 minutes
process.on('SIGINT', () => { saveCache(); process.exit(0); });
process.on('SIGTERM', () => { saveCache(); process.exit(0); });

// ========== Rate limiter (max 3 concurrent extractions) ==========
const activeRequests = new Set();
const MAX_CONCURRENT = 3;
async function withLimit(url, fn) {
  while (activeRequests.size >= MAX_CONCURRENT) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  activeRequests.add(url);
  try { return await fn(); } finally { activeRequests.delete(url); }
}

// ========== Extract YouTube video ID ==========
function getYouTubeId(url) {
  const match = url.match(/(?:youtube\.com\/.*[?&]v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// ========== Invidious (instant – multiple instances for reliability) ==========
const invidiousInstances = [
  'https://inv.nadeko.net',
  'https://vid.puffyan.us',
  'https://invidious.snopyta.org',
];

async function extractInvidious(videoId) {
  for (const base of invidiousInstances) {
    try {
      const api = `${base}/latest_version?id=${videoId}&itag=18`;
      const { data } = await axios.get(api, { timeout: 4000 });
      if (data && data.startsWith('http')) return data;
    } catch (_) {}
  }
  throw new Error('All Invidious instances failed');
}

// ========== yt‑dlp fallback (fast format 18) ==========
async function extractYtDlp(url) {
  const cookieFile = '/tmp/yt-cookies.txt';
  const cookies = process.env.YOUTUBE_COOKIES || '';
  if (!cookies) throw new Error('YOUTUBE_COOKIES not set');

  fs.writeFileSync(cookieFile, cookies);

  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const cmd = `yt-dlp --user-agent "${userAgent}" --cookies "${cookieFile}" -f 18 --no-playlist --socket-timeout 10 -g "${url}"`;

  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 10000 }, (error, stdout, stderr) => {
      try { fs.unlinkSync(cookieFile); } catch (_) {}
      if (error) return reject(new Error(stderr || error.message));
      const directUrl = stdout.trim();
      if (directUrl && directUrl.startsWith('http')) resolve(directUrl);
      else reject(new Error('No direct URL'));
    });
  });
}

// ========== Main extraction ==========
async function getDirectUrl(youtubeUrl) {
  const videoId = getYouTubeId(youtubeUrl);
  if (!videoId) throw new Error('Invalid YouTube URL');

  // 1. Invidious (instant)
  try { return await extractInvidious(videoId); } catch (_) {}

  // 2. yt‑dlp fallback
  return await extractYtDlp(youtubeUrl);
}

// ========== Endpoints ==========
app.get('/status', (req, res) => res.json({ status: 'ok', cacheSize: cache.size }));

app.get('/get', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  // Return cached result if available
  const cached = cache.get(url);
  if (cached) return res.json({ url: cached });

  try {
    const direct = await withLimit(url, () => getDirectUrl(url));
    cache.set(url, direct);
    return res.json({ url: direct });
  } catch (e) {
    console.error('Extraction failed:', e.message);
    return res.status(500).json({ error: 'Extraction failed' });
  }
});

// ========== Search (using YouTube Data API + pre‑warms downloads) ==========
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

    // Pre‑warm download URLs in the background
    videos.forEach(v => {
      const ytUrl = `https://www.youtube.com/watch?v=${v.videoId}`;
      if (!cache.has(ytUrl)) {
        withLimit(ytUrl, () => getDirectUrl(ytUrl))
          .then(direct => cache.set(ytUrl, direct))
          .catch(() => {});
      }
    });

    res.json({ videos, nextPageToken: resp.data.nextPageToken });
  } catch (e) {
    res.status(500).json({ error: 'Search failed' });
  }
});

app.listen(port, () => console.log(`Vortex proxy running on port ${port}`));
