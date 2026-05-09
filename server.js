const express = require('express');
const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// ---------- Auto‑login ----------
const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const { refreshTokens } = require('./refresh-tokens');

async function startTokenRefresh() {
  try {
    await refreshTokens();
  } catch (e) {
    console.error('Auto‑login failed, using manual YOUTUBE_COOKIES if set.');
  }
  // Refresh every 2 hours
  setInterval(async () => {
    try { await refreshTokens(); } catch (_) {}
  }, 2 * 60 * 60 * 1000);
}

// ---------- yt-dlp extraction ----------
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; rv:123.0) Gecko/20100101 Firefox/123.0',
];

const MAX_CACHE = 500;
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

function getFromCache(url) {
  const entry = cache.get(url);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.directUrl;
  return null;
}

function setCache(url, directUrl) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(url, { directUrl, timestamp: Date.now() });
}

const activeRequests = new Set();
const MAX_CONCURRENT = 3;
async function withRateLimit(url, fn) {
  while (activeRequests.size >= MAX_CONCURRENT) await new Promise(resolve => setTimeout(resolve, 200));
  try { activeRequests.add(url); return await fn(); } finally { activeRequests.delete(url); }
}

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

async function extract(url) {
  const ua = getRandomUserAgent();

  // 1. Try tokens.json (auto‑login)
  let cookieFile = '';
  if (fs.existsSync(TOKENS_FILE)) {
    const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    if (tokens.cookies) {
      cookieFile = path.join(__dirname, 'yt-cookies.txt');
      fs.writeFileSync(cookieFile, tokens.cookies);
    }
  }

  // 2. Fallback to YOUTUBE_COOKIES environment variable (manual)
  if (!cookieFile && process.env.YOUTUBE_COOKIES) {
    cookieFile = path.join(__dirname, 'yt-cookies.txt');
    fs.writeFileSync(cookieFile, process.env.YOUTUBE_COOKIES);
  }

  const cookieArgs = cookieFile ? `--cookies "${cookieFile}"` : '';
  const cmd = `yt-dlp --user-agent "${ua}" ${cookieArgs} -f "best[height<=480]" --extractor-args "youtube:player_client=android" -g "${url}"`;

  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 20000 }, (error, stdout, stderr) => {
      if (error) {
        console.error('yt-dlp error:', stderr || error.message);
        if (cookieFile) fs.unlinkSync(cookieFile);
        return reject(new Error(stderr || error.message));
      }
      const directUrl = stdout.trim();
      if (directUrl && directUrl.startsWith('http')) {
        if (cookieFile) fs.unlinkSync(cookieFile);
        resolve(directUrl);
      } else {
        if (cookieFile) fs.unlinkSync(cookieFile);
        reject(new Error('No direct URL in output'));
      }
    });
  });
}

function preCacheVideo(youtubeUrl) {
  if (getFromCache(youtubeUrl)) return;
  withRateLimit(youtubeUrl, () => extract(youtubeUrl))
    .then(directUrl => setCache(youtubeUrl, directUrl))
    .catch(() => {});
}

// ---------- Endpoints ----------
app.get('/status', (req, res) => res.json({ status: 'ok', cacheSize: cache.size }));

app.get('/get', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });
  const cached = getFromCache(url);
  if (cached) return res.json({ url: cached });
  try {
    const result = await withRateLimit(url, () => extract(url));
    if (result) {
      setCache(url, result);
      return res.json({ url: result });
    }
    return res.status(500).json({ error: 'Failed to extract video URL' });
  } catch (e) {
    console.error('Extraction error:', e.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/search', async (req, res) => {
  const { q, pageToken } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
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
    res.json({ videos, nextPageToken: resp.data.nextPageToken || null });
    videos.forEach(v => preCacheVideo(`https://www.youtube.com/watch?v=${v.videoId}`));
  } catch (e) {
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/auth-tokens', (req, res) => {
  if (fs.existsSync(TOKENS_FILE)) {
    const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    return res.json(tokens);
  }
  res.json({ cookies: process.env.YOUTUBE_COOKIES || '' });
});

app.listen(port, () => {
  console.log(`Vortex proxy running on port ${port}`);
  startTokenRefresh();
});
