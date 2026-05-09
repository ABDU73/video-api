const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const PROFILE_DIR = path.join(__dirname, 'profile');

const EMAIL = process.env.YT_EMAIL;
const PASSWORD = process.env.YT_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('❌ Set YT_EMAIL and YT_PASSWORD environment variables');
  process.exit(1);
}

async function refreshTokens() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--user-data-dir=${PROFILE_DIR}`,   // keep login across restarts
    ],
  });

  try {
    const page = await browser.newPage();
    // Increase default timeout (60 seconds)
    page.setDefaultNavigationTimeout(60000);

    // Go to YouTube – if we're already logged in (profile exists), skip login
    await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Check if we see the account button
    const loggedIn = await page.evaluate(() => {
      return !!document.querySelector('button[aria-label="Account"]');
    });

    if (!loggedIn) {
      console.log('🔐 Not logged in – performing login…');
      await page.goto(
        'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fwww.youtube.com',
        { waitUntil: 'domcontentloaded' }
      );

      // Enter email
      await page.waitForSelector('input[type="email"]', { timeout: 30000 });
      await page.type('input[type="email"]', EMAIL);
      await page.click('#identifierNext');

      // Enter password
      await page.waitForSelector('input[type="password"]', { visible: true, timeout: 30000 });
      await page.type('input[type="password"]', PASSWORD);
      await page.click('#passwordNext');

      // Wait for YouTube to load after login
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log('✅ Login successful');
    } else {
      console.log('🔓 Already logged in (profile reused)');
    }

    // Extract all cookies
    const cookies = await page.cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Extract poToken and visitorData (optional, for future use)
    const tokenData = await page.evaluate(() => {
      try {
        const ytcfg = window.ytcfg || {};
        const data = ytcfg.data_ || ytcfg.get('') || {};
        return {
          poToken: data.PO_TOKEN || '',
          visitorData: data.VISITOR_DATA || '',
        };
      } catch (e) {
        return { poToken: '', visitorData: '' };
      }
    });

    const result = {
      cookies: cookieString,
      poToken: tokenData.poToken,
      visitorData: tokenData.visitorData,
      updatedAt: Date.now(),
    };

    fs.writeFileSync(TOKENS_FILE, JSON.stringify(result, null, 2));
    console.log('🎉 Cookies saved to tokens.json');
  } catch (err) {
    console.error('Token refresh failed:', err);
  } finally {
    await browser.close();
  }
}

module.exports = { refreshTokens };
