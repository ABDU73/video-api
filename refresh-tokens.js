const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, 'tokens.json');

const EMAIL = process.env.YT_EMAIL;
const PASSWORD = process.env.YT_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('YT_EMAIL and YT_PASSWORD must be set');
  process.exit(1);
}

async function refreshTokens() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.goto('https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fwww.youtube.com', {
      waitUntil: 'networkidle2',
    });

    // Enter email
    await page.waitForSelector('input[type="email"]');
    await page.type('input[type="email"]', EMAIL);
    await page.click('#identifierNext');

    // Enter password
    await page.waitForSelector('input[type="password"]', { visible: true });
    await page.type('input[type="password"]', PASSWORD);
    await page.click('#passwordNext');

    // Wait for YouTube to load (login successful)
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // Extract all cookies
    const cookies = await page.cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Extract poToken and visitorData from YouTube’s page config
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
    console.log('Tokens refreshed successfully');
  } catch (err) {
    console.error('Token refresh failed:', err);
  } finally {
    await browser.close();
  }
}

module.exports = { refreshTokens };
