const express = require('express');
const { exec } = require('child_process');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
// Not using cookies for this test
// const COOKIEFILE = process.env.COOKIEFILE || '';

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; rv:123.0) Gecko/20100101 Firefox/123.0',
];

// Cache
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

// Rate limiter
const activeRequests = new Set();
const MAX_CONCURRENT = 3;
async function withRateLimit(url, fn) {
  while (activeRequests.size >= MAX_CONCURRENT) await new Promise(resolve => setTimeout(resolve, 200));
  try { activeRequests.add(url); return await fn(); } finally { activeRequests.delete(url); }
}

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// ---------- /test – does yt-dlp work? ----------
app.get('/test', (req, res) => {
  exec('yt-dlp --version', { timeout: 10000 }, (error, stdout, stderr) => {
    if (error) {
      console.error('yt-dlp version error:', error.message, 'stderr:', stderr);
      return res.json({ status: 'error', message: error.message, stderr: stderr });
    }
    res.json({ status: 'ok', version: stdout.trim() });
  });
});

// ---------- Simple extraction – just one format, no cookies ----------
async function extract(url) {
  const ua = getRandomUserAgent();
  // Basic command without cookies or js-runtimes
  const cmd = `yt-dlp --user-agent "${ua}" -f "best[height<=480]" --extractor-args "youtube:player_client=android" -g "${url}"`;
  console.log('Running:', cmd);

  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 20000 }, (error, stdout, stderr) => {
      if (error) {
        console.error('yt-dlp error:', error.message);
        console.error('stderr:', stderr);
        return reject(new Error(stderr || error.message));
      }
      const directUrl = stdout.trim();
      if (directUrl && directUrl.startsWith('http')) {
        resolve(directUrl);
      } else {
        reject(new Error('No direct URL in output: ' + stdout));
      }
    });
  });
}

// ---------- /get ----------
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

// ---------- /search (unchanged, but we can leave it) ----------
app.get('/search', async (req, res) => {
  const { q, pageToken } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const resp = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'snippet', maxResults: 20, q, type: 'video', key: YOUTUBE_API_KEY, pageToken },
    });
    const items = resp.data.items;
    const durations = await (async () => {
      if (!items.length) return {};
      try {
        const durResp = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
          params: { part: 'contentDetails', id: items.map(i => i.id.videoId).join(','), key: YOUTUBE_API_KEY },
        });
        const map = {};
        durResp.data.items.forEach(i => map[i.id] = i.contentDetails.duration);
        return map;
      } catch (e) { return {}; }
    })();
    const videos = items.map(i => ({
      videoId: i.id.videoId,
      title: i.snippet.title,
      author: i.snippet.channelTitle,
      thumbnail: i.snippet.thumbnails.high?.url || i.snippet.thumbnails.medium?.url || i.snippet.thumbnails.default?.url,
      duration: durations[i.id.videoId] || 'Unknown',
    }));
    res.json({ videos, nextPageToken: resp.data.nextPageToken || null });
  } catch (e) {
    res.status(500).json({ error: 'Search failed' });
  }
});

app.listen(port, () => console.log(`Vortex proxy running on port ${port}`));
