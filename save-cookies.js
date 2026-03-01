/**
 * Save BHW Cookies — One-Time Setup Helper
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What this does:
 *   1. Opens a real Chrome browser
 *   2. Navigates to BlackHatWorld
 *   3. Waits for you to log in manually (takes your time — no timeout pressure)
 *   4. Automatically extracts all BHW cookies
 *   5. Saves them to  bhw-cookies.json  in the project root
 *   6. From this point the bot uses the saved cookies every time — no login!
 *
 * When to re-run:
 *   - When the bot logs a "SESSION EXPIRED" or "cookies invalid" error
 *   - Typically every few weeks / months depending on BHW session length
 *
 * Usage:
 *   node save-cookies.js
 * ─────────────────────────────────────────────────────────────────────────
 */

import { connect } from 'puppeteer-real-browser';
import { saveCookiesToFile } from './src/utils/bhwSession.js';
import logger from './src/utils/logger.js';

const BHW_URL = 'https://www.blackhatworld.com';
const CHECK_INTERVAL_MS = 5000;   // check login status every 5 seconds
const MAX_WAIT_MS = 10 * 60 * 1000; // wait up to 10 minutes

async function saveCookies() {
  let browser;
  try {
    logger.info('');
    logger.info('╔══════════════════════════════════════════════════════════╗');
    logger.info('║           BHW COOKIE SAVER — ONE-TIME SETUP              ║');
    logger.info('╠══════════════════════════════════════════════════════════╣');
    logger.info('║                                                          ║');
    logger.info('║  A browser window is about to open.                      ║');
    logger.info('║                                                          ║');
    logger.info('║  1. Log into BlackHatWorld as  app_pilot                 ║');
    logger.info('║  2. Complete any 2FA / email verification                ║');
    logger.info('║  3. Just stay on the page — this script detects login    ║');
    logger.info('║     automatically and saves your cookies.                ║');
    logger.info('║                                                          ║');
    logger.info('║  You have 10 minutes. Take your time.                    ║');
    logger.info('║                                                          ║');
    logger.info('╚══════════════════════════════════════════════════════════╝');
    logger.info('');

    // Launch real browser (CloudFlare bypass)
    const { browser: b, page } = await connect({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1280,900',
      ],
      turnstile: true,
      customConfig: {},
      connectOption: {},
      disableXvfb: false,
      ignoreAllFlags: false,
    });
    browser = b;

    // Navigate to BHW
    await page.goto(BHW_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    logger.info('Browser open. Please log in now...\n');

    // ── Poll until logged in ───────────────────────────────────────────
    const started = Date.now();
    let loggedIn = false;

    while (Date.now() - started < MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));

      const html = await page.content().catch(() => '');
      loggedIn =
        html.includes('p-navgroup-link--user') ||
        html.includes('data-xf-click="member-tooltip"') ||
        html.includes('Log out') ||
        html.includes('Account details');

      if (loggedIn) break;

      const elapsed = Math.floor((Date.now() - started) / 1000);
      if (elapsed % 30 === 0 && elapsed > 0) {
        logger.info(`Still waiting for login... (${Math.floor(elapsed / 60)}m ${elapsed % 60}s elapsed)`);
      }
    }

    if (!loggedIn) {
      throw new Error('Login timeout — please run save-cookies.js again and log in within 10 minutes.');
    }

    logger.info('Login detected! Extracting cookies...');

    // ── Extract cookies ────────────────────────────────────────────────
    const cookies = await page.cookies();
    const bhwCookies = cookies.filter(c =>
      c.domain.includes('blackhatworld.com')
    );

    if (bhwCookies.length === 0) {
      throw new Error('No BHW cookies found after login. Please try again.');
    }

    // ── Save to file ───────────────────────────────────────────────────
    saveCookiesToFile(bhwCookies);

    // Extract username for confirmation
    let username = 'app_pilot';
    try {
      const el = await page.$('.p-navgroup-link--user .p-navgroup-linkText');
      if (el) username = await page.evaluate(n => n.textContent.trim(), el);
    } catch (_) {}

    logger.info('');
    logger.info('╔══════════════════════════════════════════════════════════╗');
    logger.info('║  ✅  COOKIES SAVED SUCCESSFULLY                          ║');
    logger.info('╠══════════════════════════════════════════════════════════╣');
    logger.info(`║  Logged in as : ${username.padEnd(41)}║`);
    logger.info(`║  Cookies saved: ${String(bhwCookies.length).padEnd(41)}║`);
    logger.info('║  File         : bhw-cookies.json                        ║');
    logger.info('║                                                          ║');
    logger.info('║  The bot will now use these cookies automatically.       ║');
    logger.info('║  Run this script again only when the session expires.    ║');
    logger.info('╚══════════════════════════════════════════════════════════╝');
    logger.info('');

    await browser.close();
    process.exit(0);

  } catch (err) {
    logger.error('save-cookies.js failed:', err.message);
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }
}

saveCookies();
