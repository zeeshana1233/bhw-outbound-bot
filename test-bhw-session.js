/**
 * Test BHW Session — Cookie-Based
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PREREQUISITE:  Run  node save-cookies.js  FIRST to save your BHW cookies.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * What this test does:
 *   1. Loads cookies from bhw-cookies.json
 *   2. Opens a browser and injects the cookies
 *   3. Navigates to BHW home and verifies the session is active
 *   4. Navigates to Hire-a-Freelancer and confirms access
 *   5. Keeps browser open 10 s so you can visually verify
 *   6. Closes browser
 *
 * If this test fails with "SESSION EXPIRED":
 *   → Run  node save-cookies.js  to refresh your cookies.
 * ─────────────────────────────────────────────────────────────────────────
 */

import bhwSession from './src/utils/bhwSession.js';
import { COOKIES_FILE } from './src/utils/bhwSession.js';
import logger from './src/utils/logger.js';
import fs from 'fs';

async function testSession() {
  try {
    logger.info('');
    logger.info('╔══════════════════════════════════════════════════════════╗');
    logger.info('║         BHW SESSION TEST — COOKIE-BASED                  ║');
    logger.info('╚══════════════════════════════════════════════════════════╝');
    logger.info('');

    // ── Pre-flight check ───────────────────────────────────────────────
    if (!fs.existsSync(COOKIES_FILE)) {
      logger.error('bhw-cookies.json not found!');
      logger.error('Run  node save-cookies.js  first to save your cookies.');
      process.exit(1);
    }

    const raw = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
    if (!Array.isArray(raw) || raw.length === 0) {
      logger.error('bhw-cookies.json is empty!');
      logger.error('Run  node save-cookies.js  first to save your cookies.');
      process.exit(1);
    }

    logger.info(`Cookie file found — ${raw.length} cookies loaded.`);

    // ── 1. Authenticate ────────────────────────────────────────────────
    logger.info('\nStep 1/3 — Injecting cookies and verifying session...');
    await bhwSession.ensureAuthenticated();

    if (!bhwSession.isLoggedIn()) {
      logger.error('❌ Authentication failed.');
      logger.error('Run  node save-cookies.js  to refresh your cookies.');
      await bhwSession.close();
      process.exit(1);
    }

    logger.info(`✅ Authenticated as: ${bhwSession.getUsername()}`);

    // ── 2. Navigate to Hire-a-Freelancer ───────────────────────────────
    logger.info('\nStep 2/3 — Navigating to Hire-a-Freelancer...');
    await bhwSession.navigateTo('https://www.blackhatworld.com/forums/hire-a-freelancer.76/');
    logger.info('✅ Navigation successful!');

    // ── 3. Visual verification window ──────────────────────────────────
    logger.info('\nStep 3/3 — Keeping browser open 10 s for visual check...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    await bhwSession.close();

    logger.info('');
    logger.info('╔══════════════════════════════════════════════════════════╗');
    logger.info('║  ✅  SESSION TEST PASSED                                  ║');
    logger.info('║                                                          ║');
    logger.info('║  Cookie-based auth is working.                           ║');
    logger.info('║  The bot will use bhw-cookies.json on every run.         ║');
    logger.info('║  Re-run save-cookies.js only when the session expires.   ║');
    logger.info('╚══════════════════════════════════════════════════════════╝');
    logger.info('');

  } catch (error) {
    logger.error('Session test failed:', error.message);
    await bhwSession.close().catch(() => {});
    process.exit(1);
  }
}

testSession();
