/**
 * BHW Session Manager — Cookie-Based Authentication
 *
 * How it works:
 * ─────────────────────────────────────────────────────────────────────────
 * 1. You export your BHW cookies once using one of these methods:
 *    A) Run `node save-cookies.js`  — opens a browser, you log in, cookies
 *       are saved to bhw-cookies.json automatically.  ← EASIEST
 *    B) Use the "Cookie-Editor" Chrome/Firefox extension → Export → JSON
 *       then paste the JSON into bhw-cookies.json manually.
 *
 * 2. From that point on, the bot just reads bhw-cookies.json on every start
 *    and injects the cookies into the browser — no password, no 2FA, no
 *    waiting.
 *
 * 3. If the bot logs a SESSION EXPIRED error, repeat step 1.
 *    The cookies file has a clear template so you always know what to paste.
 *
 * Cookie file location:  bhw-cookies.json  (project root)
 * ─────────────────────────────────────────────────────────────────────────
 */

import { connect } from 'puppeteer-real-browser';
import { config } from '../config/config.js';
import logger from './logger.js';
import { sleep } from './helpers.js';
import path from 'path';
import alerts from '../services/alerts.js';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Where cookies are stored (project root)
export const COOKIES_FILE = path.join(__dirname, '../../bhw-cookies.json');

// BHW base URL used for cookie domain matching
const BHW_BASE_URL = 'https://www.blackhatworld.com';

// ─────────────────────────────────────────────────────────────────────────
// CloudFlare wait helper
// ─────────────────────────────────────────────────────────────────────────

/**
 * Poll the page title every 2 seconds until CloudFlare clears.
 * "Just a moment..." is the CloudFlare challenge page title.
 * Resolves once BHW's real page loads, or throws after maxWaitMs.
 */
async function waitForCloudFlareToClear(page, maxWaitMs = 60000) {
  const started = Date.now();
  logger.info('Waiting for CloudFlare to clear...');

  while (Date.now() - started < maxWaitMs) {
    await sleep(2000);
    const title = await page.title().catch(() => '');
    logger.debug(`Page title: "${title}"`);

    if (title && title !== 'Just a moment...' && title !== '') {
      logger.info(`CloudFlare cleared — page: "${title}"`);
      return;
    }
  }

  throw new Error('Timed out waiting for CloudFlare to clear. Check your network/VPN.');
}

// ─────────────────────────────────────────────────────────────────────────
// Cookie helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Read cookies from bhw-cookies.json.
 * Returns an empty array (and logs a warning) if the file is missing.
 */
export function loadCookiesFromFile() {
  if (!fs.existsSync(COOKIES_FILE)) {
    logger.warn('');
    logger.warn('╔══════════════════════════════════════════════════════════╗');
    logger.warn('║  bhw-cookies.json NOT FOUND                              ║');
    logger.warn('║                                                          ║');
    logger.warn('║  You need to create this file first:                     ║');
    logger.warn('║                                                          ║');
    logger.warn('║  OPTION A (easiest):                                     ║');
    logger.warn('║    node save-cookies.js                                  ║');
    logger.warn('║    (opens browser, you log in, cookies saved auto)       ║');
    logger.warn('║                                                          ║');
    logger.warn('║  OPTION B (manual):                                      ║');
    logger.warn('║    1. Open Chrome → blackhatworld.com → log in           ║');
    logger.warn('║    2. Install "Cookie-Editor" extension                  ║');
    logger.warn('║    3. Click Export → JSON                                ║');
    logger.warn('║    4. Paste JSON into bhw-cookies.json                   ║');
    logger.warn('╚══════════════════════════════════════════════════════════╝');
    logger.warn('');
    return [];
  }

  try {
    const raw = fs.readFileSync(COOKIES_FILE, 'utf8').trim();
    if (!raw || raw === '[]') {
      logger.warn('bhw-cookies.json is empty — please add your BHW cookies.');
      return [];
    }
    const cookies = JSON.parse(raw);
    logger.info(`Loaded ${cookies.length} cookies from bhw-cookies.json`);
    return cookies;
  } catch (err) {
    logger.error('Failed to parse bhw-cookies.json:', err.message);
    logger.error('Make sure the file contains valid JSON (an array of cookie objects).');
    return [];
  }
}

/**
 * Save cookies to bhw-cookies.json (used by save-cookies.js).
 */
export function saveCookiesToFile(cookies) {
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2), 'utf8');
  logger.info(`Saved ${cookies.length} cookies to bhw-cookies.json`);
}

/**
 * Normalise cookies exported from different sources into the format
 * Puppeteer's page.setCookie() expects.
 *
 * Handles both:
 *  - Cookie-Editor JSON  (has "name", "value", "domain", etc.)
 *  - Puppeteer-exported cookies (same format, already normalised)
 */
function normaliseCookies(raw) {
  return raw.map(c => {
    const out = {
      name: c.name,
      value: c.value,
      domain: c.domain || '.blackhatworld.com',
      path: c.path || '/',
      httpOnly: c.httpOnly || false,
      secure: c.secure || false,
    };

    // Handle expiry field name differences
    if (c.expirationDate != null) out.expires = Math.floor(c.expirationDate);
    else if (c.expires != null && c.expires !== -1) out.expires = Math.floor(c.expires);

    // SameSite
    if (c.sameSite) out.sameSite = c.sameSite;

    return out;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Session manager
// ─────────────────────────────────────────────────────────────────────────

class BHWSessionManager {
  constructor() {
    this.browser        = null;
    this.page           = null;
    this.isAuthenticated = false;
    this.username       = null;
    this.sessionDown    = false;  // true while BHW cookies are known-dead
    this._alertedDown   = false;  // prevent alert spam — only fire once per outage
    this._healthTimer   = null;
    this._lockPromise   = Promise.resolve();
  }

  /**
   * Sequential mutex lock: guarantees only ONE task can use the shared Puppeteer page at a time.
   */
  async withLock(actionFn) {
    const next = this._lockPromise.then(async () => {
      try {
        return await actionFn();
      } catch (err) {
        throw err;
      }
    });
    this._lockPromise = next.catch(() => {});
    return next;
  }

  // ── Browser init ──────────────────────────────────────────────────────

  async initBrowser() {
    if (this.browser) return;

    logger.info('Initializing BHW browser...');

    const { browser, page } = await connect({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1920,1080',
      ],
      turnstile: true,      // CloudFlare Turnstile bypass
      customConfig: {},
      connectOption: {},
      disableXvfb: false,
      ignoreAllFlags: false,
    });

    this.browser = browser;
    this.page = page;

    // ── Tab prevention ─────────────────────────────────────────────────
    this.browser.on('targetcreated', async (target) => {
      try {
        if (target.type() === 'page') {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const newPage = await target.page();
          if (newPage && newPage !== this.page) {
            const allPages = await this.browser.pages();
            if (allPages.length > 1) {
              logger.debug('Extra tab detected — closing it');
              await newPage.close();
            }
          }
        }
      } catch (e) {
        logger.debug('Tab close error:', e.message);
      }
    });

    // Close any tabs already open beyond the first
    const existingPages = await this.browser.pages();
    for (let i = 1; i < existingPages.length; i++) {
      try { await existingPages[i].close(); } catch (_) {}
    }

    // Remove webdriver flag
    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    logger.info('Browser ready.');
  }

  // ── Cookie injection ──────────────────────────────────────────────────

  /**
   * Inject cookies from bhw-cookies.json into the current browser session.
   * Navigates to BHW first so the domain matches (required by Puppeteer).
   * Waits for CloudFlare to clear both before and after injection.
   */
  async injectCookies() {
    const raw = loadCookiesFromFile();
    if (raw.length === 0) {
      throw new Error(
        'No cookies loaded. Run `node save-cookies.js` or paste cookies into bhw-cookies.json.'
      );
    }

    const cookies = normaliseCookies(raw);

    // Navigate to BHW home — needed to set the domain for cookies
    logger.info('Navigating to BHW...');
    await this.page.goto(BHW_BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Wait for CloudFlare Turnstile to resolve before injecting
    await waitForCloudFlareToClear(this.page, 60000);

    // Inject cookies
    await this.page.setCookie(...cookies);
    logger.info(`Injected ${cookies.length} cookies — reloading page to apply...`);

    // Reload so the cookies take effect and BHW sees us as logged in
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for CloudFlare to clear again after reload
    await waitForCloudFlareToClear(this.page, 60000);

    // Small buffer
    await sleep(1500);
  }

  // ── Session verification ──────────────────────────────────────────────

  /**
   * Check the current page for login indicators.
   * injectCookies() already navigated and reloaded — no new navigation needed.
   */
  async verifySession() {
    logger.info('Verifying BHW session...');

    const html = await this.page.content();

    // Debug: show page title
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    logger.debug(`Page title: ${titleMatch ? titleMatch[1] : '(no title)'}`);

    const loggedIn =
      html.includes('p-navgroup-link--user') ||
      html.includes('data-xf-click="member-tooltip"') ||
      html.includes('Log out') ||
      html.includes('Account details') ||
      html.includes('"isLoggedIn":true') ||
      html.includes('xf-user-activity');

    if (loggedIn) {
      try {
        const el = await this.page.$('.p-navgroup-link--user .p-navgroup-linkText');
        this.username = el
          ? await this.page.evaluate(n => n.textContent.trim(), el)
          : (config.bhw.username || 'app_pilot');
      } catch (_) {
        this.username = config.bhw.username || 'app_pilot';
      }

      this.isAuthenticated = true;
      logger.info(`Session verified — logged in as: ${this.username}`);
      return true;
    }

    this.isAuthenticated = false;
    return false;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Main entry point.
   * - Initialises browser
   * - Loads + injects cookies from bhw-cookies.json
   * - Verifies the session is authenticated
   *
   * If authentication fails, throws a clear error telling you
   * to refresh bhw-cookies.json.
   */
  async ensureAuthenticated() {
    if (!this.browser) {
      await this.initBrowser();
    }

    await this.injectCookies();

    const ok = await this.verifySession();

    if (!ok) {
      logger.error('');
      logger.error('╔══════════════════════════════════════════════════════════╗');
      logger.error('║  SESSION EXPIRED — COOKIES NEED REFRESHING               ║');
      logger.error('║                                                          ║');
      logger.error('║  Your cookies in bhw-cookies.json are no longer valid.   ║');
      logger.error('║                                                          ║');
      logger.error('║  To fix:                                                 ║');
      logger.error('║    node save-cookies.js                                  ║');
      logger.error('║    (logs in once, saves fresh cookies automatically)     ║');
      logger.error('║                                                          ║');
      logger.error('║  OR paste fresh cookies manually into bhw-cookies.json  ║');
      logger.error('╚══════════════════════════════════════════════════════════╝');
      logger.error('');

      // Mark session as down — all engine loops will pause
      this.sessionDown = true;
      this.isAuthenticated = false;

      // Fire Discord alert ONCE per outage (not on every retry)
      if (!this._alertedDown) {
        this._alertedDown = true;
        alerts.sendSessionExpiredAlert().catch(() => {});
      }

      throw new Error('BHW session authentication failed — cookies expired or invalid.');
    }

    // Session is good — clear any previous down state
    this.sessionDown  = false;
    this._alertedDown = false;
    return true;
  }

  /**
   * Periodic session health check.
   *
   * Behaviour:
   *  - Runs a silent verification every 30 minutes while the session is healthy
    *  - If the session dies: marks sessionDown=true, fires Discord alert ONCE,
    *    then switches to a fast retry loop (every 5 min) waiting for the user
    *    to refresh bhw-cookies.json
    *  - When cookies are refreshed and session comes back: fires a "session
    *    restored" Discord alert and resumes normal 30-min checks
   *
   * Call once from main() after initDatabase().
   */
  startHealthCheck() {
    const HEALTHY_INTERVAL_MS = 30 * 60 * 1000;  // 30 min
    const RETRY_INTERVAL_MS   =  5 * 60 * 1000;  // 5 min while down

    const check = async () => {
      try {
        // Don't navigate or disrupt ongoing actions — just re-read the current page
        // and look for login indicators.  If the browser isn't open yet, skip.
        if (!this.browser || !this.page) {
          logger.debug('[HealthCheck] Browser not ready yet — skipping.');
          scheduleNext();
          return;
        }

        const ok = await this.verifySession();

        if (!ok) {
          if (!this.sessionDown) {
            // Transition: healthy → down
            this.sessionDown  = true;
            this.isAuthenticated = false;
            logger.warn('[HealthCheck] ⚠️  Session lost mid-run! Alerting Zeeshan…');

            if (!this._alertedDown) {
              this._alertedDown = true;
              alerts.sendSessionExpiredAlert().catch(() => {});
            }
          } else {
            logger.debug('[HealthCheck] Session still down — waiting for cookie refresh…');
          }

          // Retry soon — Zeeshan may refresh cookies at any moment
          this._healthTimer = setTimeout(check, RETRY_INTERVAL_MS);
          return;
        }

        // Session is alive
        if (this.sessionDown) {
          // Transition: down → restored
          this.sessionDown  = false;
          this._alertedDown = false;
          logger.info('[HealthCheck] ✅  Session restored — bot resuming normal operation.');

          // Discord: let Zeeshan know it's back
          alerts.sendRawAlert(
            '✅ *BHW Session Restored*\n\nCookies are valid again. Bot has resumed automatically.'
          ).catch(() => {});
        } else {
          logger.debug(`[HealthCheck] Session healthy (${this.username}).`);
        }

        scheduleNext();

      } catch (err) {
        logger.warn('[HealthCheck] Error during health check:', err.message);
        scheduleNext();
      }
    };

    const scheduleNext = () => {
      const interval = this.sessionDown ? RETRY_INTERVAL_MS : HEALTHY_INTERVAL_MS;
      this._healthTimer = setTimeout(check, interval);
    };

    // First check after 30 min (startup already verified the session)
    this._healthTimer = setTimeout(check, HEALTHY_INTERVAL_MS);
    logger.info('[HealthCheck] Session health check started — runs every 30 min.');
  }

  /** Returns true if the session is currently known to be down. */
  isSessionDown() { return this.sessionDown; }

  /**
   * Navigate to a URL. Ensures authentication first.
   * Waits for CloudFlare to clear after every navigation.
   */
  async navigateTo(url) {
    if (!this.isAuthenticated) {
      await this.ensureAuthenticated();
    }

    logger.info(`Navigating to: ${url}`);
    await this.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await waitForCloudFlareToClear(this.page, 60000);
    await sleep(1000);
  }

  /**
   * Hot-reload cookies without restarting the browser.
   * Call this if the session dies mid-run after you've updated the cookie file.
   */
  async reloadCookies() {
    logger.info('Reloading cookies from bhw-cookies.json...');
    await this.injectCookies();
    const ok = await this.verifySession();
    if (!ok) {
      throw new Error('Session still invalid after cookie reload — please refresh bhw-cookies.json.');
    }
    logger.info('Cookies reloaded and session is active.');
    return true;
  }

  getPage()       { return this.page; }
  getBrowser()    { return this.browser; }
  getUsername()   { return this.username; }
  isLoggedIn()    { return this.isAuthenticated && !this.sessionDown; }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.isAuthenticated = false;
      logger.info('Browser closed.');
    }
  }
}

// Singleton
export const bhwSession = new BHWSessionManager();
export default bhwSession;
