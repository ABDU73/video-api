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

// ---------- Cache (unchanged) ----------
const MAX_CACHE = 100;
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;   // 10 minutes

function getFromCache(url) {
  const entry = cache.get(url);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    console.log(`Cache hit for ${url}`);
    return entry.directUrl;
  }
  return null;
}

function setCache(url, directUrl) {
  if (cache.size >= MAX_CACHE) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(url, { directUrl, timestamp: Date.now() });
}

// ---------- Rate limiter (unchanged) ----------
const activeRequests = new Set();
const MAX_CONCURRENT = 3;

async function withRateLimit(url, fn) {
  while (activeRequests.size >= MAX_CONCURRENT) {
    await new Promise(resolve => setTimeout(resolve, 200));   // shorter wait
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

// ---------- Duration helper ----------
async function getVideoDurations(videoIds) {
  if (!videoIds.length) return {};
  const ids = videoIds.join(',');
  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'contentDetails',
        id: ids,
        key: YOUTUBE_API_KEY,
      },
    });
    const durationMap = {};
    response.data.items.forEach(item => {
      durationMap[item.id] = item.contentDetails.duration;
    });
    return durationMap;
  } catch (err) {
    console.error('Failed to fetch video durations:', err.message);
    return {};
  }
}

// ==================== Endpoints ====================
app.get('/status', (req, res) => {
  res.send({ status: 'ok', cacheSize: cache.size, activeRequests: activeRequests.size });
});

app.get('/get', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send({ error: 'Missing url parameter' });

  const cached = getFromCache(url);
  if (cached) return res.send({ url: cached });

  try {
    const result = await withRateLimit(url, () => extract(url));
    if (result) {
      setCache(url, result);
      return res.send({ url: result });
    }
    return res.status(500).send({ error: 'Failed to extract video URL' });
  } catch (err) {
    console.error(err);
    return res.status(500).send({ error: 'Internal error' });
  }
});

// ==================== ROBUST EXTRACTION ====================
async function extract(url) {
  const ua = getRandomUserAgent();
  const commands = [
    // 1st: pre‑muxed stream ≤ 720p (fast & safe)
    `yt-dlp --user-agent "${ua}" -f "best[height<=720]" --extractor-args "youtube:player_client=android" -g "${url}"`,
    // 2nd: any format (no height limit)
    `yt-dlp --user-agent "${ua}" -g "${url}"`,
  ];

  for (const cmd of commands) {
    console.log(`Trying: ${cmd}`);
    try {
      const stdout = await runCommand(cmd);
      const directUrl = stdout.trim();
      if (directUrl && directUrl.startsWith('http')) {
        console.log('Success');
        return directUrl;
      }
    } catch (e) {
      console.error(`Command failed: ${e.message || e}`);
    }
  }
  throw new Error('All extraction commands failed');
}

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

// ==================== Search endpoint (unchanged) ====================
app.get('/search', async (req, res) => {
  const { q, pageToken } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        maxResults: 20,
        q,
        type: 'video',
        key: YOUTUBE_API_KEY,
        pageToken: pageToken || undefined,
      },
    });

    const items = response.data.items;
    const videoIds = items.map(item => item.id.videoId);
    const durationMap = await getVideoDurations(videoIds);

    const videos = items.map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      author: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails.high?.url ||
                 item.snippet.thumbnails.medium?.url ||
                 item.snippet.thumbnails.default?.url,
      duration: durationMap[item.id.videoId] || 'Unknown',
    }));

    res.json({
      videos,
      nextPageToken: response.data.nextPageToken || null,
    });
  } catch (error) {
    console.error('YouTube search proxy error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.listen(port, () => {
  console.log(`Vortex proxy running on port ${port}`);
});
