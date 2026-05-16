const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');

const EMAIL = process.env.YT_EMAIL;
const PASSWORD = process.env.YT_PASSWORD;
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const SERVICE_ID = process.env.RENDER_SERVICE_ID;

if (!EMAIL || !PASSWORD || !RENDER_API_KEY || !SERVICE_ID) {
  console.error('Missing environment variables');
  process.exit(1);
}

// Persistent profile – keeps login state between runs
const PROFILE_DIR = '/tmp/yt-profile';
if (!fs.existsSync(PROFILE_DIR)) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
}

async function refreshAndUpdate() {
  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir: PROFILE_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Go to YouTube first
    await page.goto('https://www.youtube.com', { waitUntil: 'networkidle2' });

    // Check if already logged in
    const loggedIn = await page.evaluate(() => {
      return !!document.querySelector('#avatar-btn') ||
             !!document.querySelector('button[aria-label="Account"]');
    });

    if (!loggedIn) {
      console.log('Not logged in – performing login...');

      // Navigate to Google sign‑in
      await page.goto('https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fwww.youtube.com&hl=en&flowName=GlifWebSignIn&flowEntry=ServiceLogin', { waitUntil: 'networkidle2' });

      // Try multiple selectors for the email field
      const emailSelectors = [
        'input[type="email"]',
        'input[name="identifier"]',
        'input[id="identifierId"]',
        'input[aria-label="Email or phone"]',
      ];

      let emailInput = null;
      for (const sel of emailSelectors) {
        try {
          emailInput = await page.waitForSelector(sel, { timeout: 8000 });
          if (emailInput) break;
        } catch (_) {}
      }

      if (!emailInput) {
        console.error('Could not find email input field');
        throw new Error('Email field not found');
      }

      await emailInput.type(EMAIL, { delay: 50 });
      await page.click('#identifierNext');
      await page.waitForNavigation({ waitUntil: 'networkidle2' });

      // Wait for password field
      const passwordSelectors = [
        'input[type="password"]',
        'input[name="Passwd"]',
        'input[aria-label="Enter your password"]',
      ];

      let passwordInput = null;
      for (const sel of passwordSelectors) {
        try {
          passwordInput = await page.waitForSelector(sel, { timeout: 8000 });
          if (passwordInput) break;
        } catch (_) {}
      }

      if (!passwordInput) {
        console.error('Could not find password input field');
        throw new Error('Password field not found');
      }

      await passwordInput.type(PASSWORD, { delay: 50 });
      await page.click('#passwordNext');
      await page.waitForNavigation({ waitUntil: 'networkidle2' });

      console.log('Login successful');
    } else {
      console.log('Already logged in (profile reused)');
    }

    // Extract cookies in Netscape format
    const cookies = await page.cookies();
    let netscape = '# Netscape HTTP Cookie File\n';
    cookies.forEach(c => {
      const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
      const expires = c.expires ? Math.floor(c.expires) : 0;
      netscape += `${domain}\tTRUE\t/\tFALSE\t${expires}\t${c.name}\t${c.value}\n`;
    });

    // Base64 encode
    const base64Cookies = Buffer.from(netscape).toString('base64');

    // Update Render environment variable via API
    const response = await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/env-vars`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${RENDER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ key: 'YOUTUBE_COOKIES', value: base64Cookies }]),
    });

    if (!response.ok) {
      throw new Error(`Render API failed: ${await response.text()}`);
    }

    console.log('Cookies updated, triggering deploy...');

    // Trigger deploy
    await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/deploys`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RENDER_API_KEY}` },
    });

    console.log('Deploy triggered successfully');
  } catch (err) {
    console.error('Refresh failed:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

refreshAndUpdate();
