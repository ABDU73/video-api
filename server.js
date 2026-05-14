const express = require('express');
const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// ========== Simple file-backed cache ==========
const CACHE_FILE = path.join(__dirname, 'url_cache.json');
const cache = new Map();

try {
  if (fs.existsSync(CACHE_FILE)) {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const entries = JSON.parse(raw);
    for (const [key, value] of Object.entries(entries)) {
      cache.set(key, value);
    }
  }
} catch (_) {}

function saveCache() {
  try {
    const obj = Object.fromEntries(cache);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch (_) {}
}
setInterval(saveCache, 300000);
process.on('SIGINT', () => { saveCache(); process.exit(0); });
process.on('SIGTERM', () => { saveCache(); process.exit(0); });

// ========== Rate limiter ==========
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

// ========== Invidious instances ==========
const invidiousInstances = [
  'https://inv.nadeko.net',
  'https://vid.puffyan.us',
  'https://invidious.snopyta.org',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
  'https://inv.riverside.rocks',
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

// ========== yt-dlp (with cookies) ==========
async function extractYtDlp(url, format = '18') {
  const cookieFile = '/tmp/yt-cookies.txt';
  const cookies = process.env.YOUTUBE_COOKIES;
  if (!cookies) throw new Error('YOUTUBE_COOKIES not set');
  fs.writeFileSync(cookieFile, cookies);

  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const cmd = `yt-dlp --user-agent "${ua}" --cookies "${cookieFile}" -f ${format} --no-playlist --socket-timeout 10 -g "${url}"`;

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

// ========== Main extraction logic ==========
async function getStreamUrl(youtubeUrl, quality = 'download') {
  const videoId = getYouTubeId(youtubeUrl);
  if (!videoId) throw new Error('Invalid YouTube URL');

  // 1. Invidious (instant, gives format 18)
  try { return await extractInvidious(videoId); } catch (_) {}

  // 2. yt-dlp fallback – use format 18 for download, or best ≤720p for playback
  const format = quality === 'play' ? 'best[height<=720]' : '18';
  return await extractYtDlp(youtubeUrl, format);
}

// ========== Endpoints ==========
app.get('/status', (req, res) => res.json({ status: 'ok', cacheSize: cache.size }));

// Download / playback URL (cached)
app.get('/get', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  const cached = cache.get(url);
  if (cached) return res.json({ url: cached });

  try {
    const direct = await withLimit(url, () => getStreamUrl(url, 'download'));
    cache.set(url, direct);
    return res.json({ url: direct });
  } catch (e) {
    console.error('Extraction failed:', e.message);
    return res.status(500).json({ error: 'Extraction failed' });
  }
});

// Extra endpoint for playback (higher quality, cached separately)
app.get('/play', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  const cacheKey = `play:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ url: cached });

  try {
    const direct = await withLimit(url, () => getStreamUrl(url, 'play'));
    cache.set(cacheKey, direct);
    return res.json({ url: direct });
  } catch (e) {
    console.error('Playback extraction failed:', e.message);
    return res.status(500).json({ error: 'Extraction failed' });
  }
});

// Search (unchanged)
app.get('/search', async (req, res) => {
  // ... your existing search code (requires YOUTUBE_API_KEY)
});

app.listen(port, () => console.log(`Vortex proxy running on port ${port}`));
