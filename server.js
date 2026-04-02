const express = require('express');
const { exec } = require('child_process');
const app = express();
const port = process.env.PORT || 3000;

// List of real User-Agents (rotate to avoid blocking)
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; rv:123.0) Gecko/20100101 Firefox/123.0',
];

// Simple in‑memory cache (expires after 10 minutes)
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

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

// Health check endpoint
app.get('/status', (req, res) => {
  res.send({ status: 'ok', cacheSize: cache.size });
});

// Main extraction endpoint
app.get('/get', async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).send({ error: 'Missing url parameter' });
  }

  // Check cache first
  const cached = getFromCache(url);
  if (cached) {
    return res.send({ url: cached });
  }

  // Try different clients in order (most permissive first)
  const clients = ['android', 'ios', 'web', 'mweb'];
  let lastError = null;

  for (const client of clients) {
    // Random delay between 1 and 4 seconds to mimic human behavior
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

  // All clients failed
  console.error(`All clients failed for ${url}`);
  return res.status(500).send({
    error: 'Failed to extract video URL',
    details: lastError?.stderr || 'Unknown error',
  });
});

app.listen(port, () => {
  console.log(`Vortex proxy running on port ${port}`);
});
