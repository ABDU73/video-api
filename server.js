const express = require('express');
const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');

const app = express();
const port = process.env.PORT || 3000;

// -------- Persistent cache (file-based, survives Render restarts) ----------
const CACHE_FILE = path.join(__dirname, 'url_cache.json');
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

try {
  if (fs.existsSync(CACHE_FILE)) {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    cache.mget(Object.keys(data));
  }
} catch (_) {}

setInterval(() => {
  const all = cache.mget(cache.keys());
  fs.writeFileSync(CACHE_FILE, JSON.stringify(all));
}, 300000);

// -------- Rate limiting ----------
const activeRequests = new Set();
const MAX_CONCURRENT = 3;
async function withLimit(url, fn) {
  while (activeRequests.size >= MAX_CONCURRENT) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  activeRequests.add(url);
  try { return await fn(); } finally { activeRequests.delete(url); }
}

// -------- Extract YouTube video ID ----------
function getYouTubeId(url) {
  const match = url.match(/(?:youtube\.com\/.*[?&]v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// ======== Primary: Invidious (instant) ========
async function extractInvidious(videoId) {
  const api = `https://inv.nadeko.net/latest_version?id=${videoId}&itag=18`;
  const { data } = await axios.get(api, { timeout: 5000 });
  if (data && data.startsWith('http')) return data;
  throw new Error('Invalid Invidious response');
}

// ======== Fallback: yt-dlp (fast format 18) ========
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

// ======== Main extraction logic ========
async function getDirectUrl(youtubeUrl) {
  const videoId = getYouTubeId(youtubeUrl);
  if (!videoId) throw new Error('Invalid YouTube URL');

  // 1. Try Invidious first (instant)
  try { return await extractInvidious(videoId); } catch (_) {}

  // 2. Fallback to yt-dlp
  return await extractYtDlp(youtubeUrl);
}

// ======== Endpoints ========
app.get('/status', (req, res) => res.json({ status: 'ok', cacheSize: cache.stats.keys }));

app.get('/get', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });

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

// Search (unchanged)
app.get('/search', async (req, res) => {
  // ... your existing search code ...
});

app.listen(port, () => console.log(`Vortex proxy running on port ${port}`));
