const express = require('express');
const { exec } = require('child_process');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; rv:123.0) Gecko/20100101 Firefox/123.0',
];

// Cache: 500 entries, 1‑hour TTL (was 100 / 10 min)
const MAX_CACHE = 500;
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;           // 1 hour

function getFromCache(url) {
  const entry = cache.get(url);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.directUrl;
  return null;
}

function setCache(url, directUrl) {
  if (cache.size >= MAX_CACHE) {
    // delete the oldest entry
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(url, { directUrl, timestamp: Date.now() });
}

// Rate limiter
const activeRequests = new Set();
const MAX_CONCURRENT = 3;

async function withRateLimit(url, fn) {
  while (activeRequests.size >= MAX_CONCURRENT) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  try {
    activeRequests.add(url);
    return await fn();
  } finally {
    activeRequests.delete(url);
  }
}

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// ---------- Search helpers ----------
async function getVideoDurations(videoIds) {
  if (!videoIds.length) return {};
  try {
    const resp = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: { part: 'contentDetails', id: videoIds.join(','), key: YOUTUBE_API_KEY },
    });
    const map = {};
    resp.data.items.forEach(i => map[i.id] = i.contentDetails.duration);
    return map;
  } catch (e) { return {}; }
}

// ---------- Extraction logic (unchanged) ----------
async function extract(url) {
  const ua = getRandomUserAgent();

  // Try the fastest resolution first (480p), then fallback
  const formats = [
    `best[height<=480]`,    // fastest to extract, still looks good on mobile
    `best[height<=720]`,
    `best`,
  ];

  for (const fmt of formats) {
    const cmd = `yt-dlp --user-agent "${ua}" -f "${fmt}" --extractor-args "youtube:player_client=android" -g "${url}"`;
    try {
      const output = await runCommand(cmd, 15000);   // 15 seconds timeout (faster fail)
      const directUrl = output.trim();
      if (directUrl && directUrl.startsWith('http')) {
        return directUrl;
      }
    } catch (e) {
      // try next format
    }
  }

  throw new Error('All extraction formats failed');
}

function runCommand(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: timeoutMs }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

// ---------- Pre‑cache: extract all search results in the background ----------
function preCacheVideo(youtubeUrl) {
  if (getFromCache(youtubeUrl)) return;   // already cached

  // Fire‑and‑forget, no waiting
  withRateLimit(youtubeUrl, () => extract(youtubeUrl))
    .then(directUrl => setCache(youtubeUrl, directUrl))
    .catch(() => {});   // ignore failures
}

// ---------- Endpoints ----------
app.get('/status', (req, res) => res.json({ status: 'ok', cacheSize: cache.size }));

app.get('/get', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  const cached = getFromCache(url);
  if (cached) {
    return res.json({ url: cached });
  }

  try {
    const result = await withRateLimit(url, () => extract(url));
    if (result) {
      setCache(url, result);
      return res.json({ url: result });
    }
    return res.status(500).json({ error: 'Failed to extract video URL' });
  } catch (e) {
    console.error('Extraction error:', e.message || e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/search', async (req, res) => {
  const { q, pageToken } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });

  try {
    const resp = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'snippet', maxResults: 20, q, type: 'video', key: YOUTUBE_API_KEY, pageToken },
    });
    const items = resp.data.items;
    const durations = await getVideoDurations(items.map(i => i.id.videoId));

    const videos = items.map(i => ({
      videoId: i.id.videoId,
      title: i.snippet.title,
      author: i.snippet.channelTitle,
      thumbnail: i.snippet.thumbnails.high?.url || i.snippet.thumbnails.medium?.url || i.snippet.thumbnails.default?.url,
      duration: durations[i.id.videoId] || 'Unknown',
    }));

    // Respond immediately with the list
    res.json({ videos, nextPageToken: resp.data.nextPageToken || null });

    // 🔥 NOW start extracting all the video URLs in the background
    videos.forEach(v => {
      const youtubeUrl = `https://www.youtube.com/watch?v=${v.videoId}`;
      preCacheVideo(youtubeUrl);
    });

  } catch (e) {
    res.status(500).json({ error: 'Search failed' });
  }
});

app.listen(port, () => console.log(`Vortex proxy running on port ${port}`));
