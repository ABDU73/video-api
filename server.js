const express = require('express');
const { exec } = require('child_process');
const axios = require('axios');                           // ← added
const app = express();
const port = process.env.PORT || 3000;

// ------------------- YouTube API key (set on Render env) -------------------
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;     // ← required

// ------------------- User‑agents and cache (unchanged) -------------------
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; rv:123.0) Gecko/20100101 Firefox/123.0',
];

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

function getFromCache(url) {
  const entry = cache.get(url);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    console.log(`Cache hit for ${url}`);
    return entry.directUrl;
  }
  return null;
}

function setCache(url, directUrl) {
  cache.set(url, { directUrl, timestamp: Date.now() });
}

// ------------------- Health check (unchanged) -------------------
app.get('/status', (req, res) => {
  res.send({ status: 'ok', cacheSize: cache.size });
});

// ------------------- Main extraction endpoint (unchanged) -------------------
app.get('/get', async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).send({ error: 'Missing url parameter' });
  }

  const cached = getFromCache(url);
  if (cached) {
    return res.send({ url: cached });
  }

  const clients = ['android', 'ios', 'web', 'mweb'];
  let lastError = null;

  for (const client of clients) {
    const delay = Math.floor(Math.random() * 3000) + 1000;
    await new Promise(resolve => setTimeout(resolve, delay));

    const userAgent = getRandomUserAgent();
    const command = `yt-dlp --user-agent "${userAgent}" --extractor-args youtube:player_client=${client} --sleep-requests 2 -g "${url}"`;
    console.log(`Trying client ${client} with UA ${userAgent}`);

    try {
      const result = await new Promise((resolve, reject) => {
        exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
          if (error) reject({ error, stderr });
          else resolve(stdout.trim());
        });
      });
      const directUrl = result;
      if (directUrl && directUrl.startsWith('http')) {
        setCache(url, directUrl);
        console.log(`Success with client ${client}`);
        return res.send({ url: directUrl });
      }
    } catch (err) {
      console.error(`Client ${client} failed: ${err.error?.message || err}`);
      lastError = err;
    }
  }

  console.error(`All clients failed for ${url}`);
  return res.status(500).send({
    error: 'Failed to extract video URL',
    details: lastError?.stderr || 'Unknown error',
  });
});

// ===================================================================
//                     NEW: Search endpoint (paginated)
// ===================================================================
app.get('/search', async (req, res) => {
  const { q, pageToken } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter q' });
  }

  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        maxResults: 20,                     // 20 per page
        q,
        type: 'video',
        key: YOUTUBE_API_KEY,
        pageToken: pageToken || undefined,   // null → not sent
      },
    });

    const items = response.data.items.map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      author: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails.high?.url ||
                 item.snippet.thumbnails.medium?.url ||
                 item.snippet.thumbnails.default?.url,
      duration: 'Unknown',                 // duration isn't in search results
    }));

    res.json({
      videos: items,
      nextPageToken: response.data.nextPageToken || null,
    });
  } catch (error) {
    console.error('YouTube search proxy error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ===================================================================

app.listen(port, () => {
  console.log(`Vortex proxy running on port ${port}`);
});
