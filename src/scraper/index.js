/**
 * BHW Scraper Module - Discovers job posts from BlackHatWorld
 * Translated from working Python implementation
 * Uses puppeteer-real-browser to bypass CloudFlare protection
 * 
 * Successfully tested and bypasses CloudFlare challenges!
 */

import { connect } from 'puppeteer-real-browser';
import * as cheerio from 'cheerio';
import logger from '../utils/logger.js';
import { config } from '../config/config.js';
import { 
  checkThreadExists, 
  createLead, 
  updateLeadQualification,
  getExistingThreadIds,
  logActivity
} from '../database/queries.js';
import { 
  extractThreadId, 
  sanitizeText, 
  getThreadAgeCategory, 
  sleep, 
  randomDelay 
} from '../utils/helpers.js';
import aiEngine from '../services/aiEngine.js';
import { sendPipelineCJobAlert, sendLeadDisqualifiedAlert } from '../services/alerts.js';

// ── Persistent anonymous browser (shared across scrape cycles) ─────────────
// Reusing one browser avoids a fresh Cloudflare Turnstile on every tick.
// Still anonymous — no login cookies, no bhwSession / app_pilot.
let _sharedBrowser = null;
let _sharedPage = null;

async function isCloudflareChallenge(page) {
  try {
    const title = await page.title().catch(() => '');
    if (/just a moment|cloudflare|attention required/i.test(title || '')) return true;
    const flagged = await page.evaluate(() => {
      const body = (document.body?.innerText || '').slice(0, 2000);
      return /checking your browser|just a moment|cf-browser-verification|turnstile|enable javascript and cookies/i.test(body)
        || !!document.querySelector('#challenge-running, #challenge-stage, .cf-browser-verification, iframe[src*="challenges.cloudflare.com"]');
    }).catch(() => false);
    return !!flagged;
  } catch {
    return false;
  }
}

class BHWScraper {
  constructor() {
    this.baseUrl = config.bhw.baseUrl;
    this.browser = null;
    this.page = null;
    this.maxRetries = 3;
    this.retryDelay = 2000; // 2 seconds
    this.cloudflareBlocked = false; // set true if CF challenge can't be bypassed
  }

  /**
   * Initialize browser for scraping using puppeteer-real-browser
   * This bypasses CloudFlare protection
   */
  async initBrowser({ forceFresh = false } = {}) {
    if (!forceFresh && _sharedBrowser && _sharedPage) {
      this.browser = _sharedBrowser;
      this.page = _sharedPage;
      logger.info('Reusing persistent anonymous scraper browser (no login).');
      return;
    }

    if (forceFresh) {
      await this.closeBrowser({ discardShared: true });
    }

    if (this.browser) {
      return; // Already initialized on this instance
    }

    logger.info('Initializing real browser for scraping (anonymous — no login)...');
    
    // Connect with puppeteer-real-browser for CloudFlare bypass
    // Wrap in a timeout in case connect() hangs (no error thrown, promise never resolves).
    const CONNECT_TIMEOUT_MS = 90_000; // 90 seconds
    // headless: false — Cloudflare fingerprints headless:true and blocks it.
    // Running with headless:false on Linux uses the Xvfb virtual display (:99)
    // managed by puppeteer-real-browser itself (disableXvfb: false).
    // This scraper browser is ALWAYS a fresh anonymous session — no cookies,
    // no login. It never touches the bhwSession singleton (app_pilot profile).
    // BHW forum listing is fully public — no authentication needed to read it.
    const proxy = config.bhw.scraperProxy;
    if (proxy) {
      logger.info(`Using residential scraper proxy → ${proxy.host}:${proxy.port} (auth: ${proxy.username ? 'yes' : 'no'})`);
    } else {
      logger.warn('No SCRAPER_PROXY_URL set — scraping via direct VPS IP (higher CF risk)');
    }

    const connectOpts = {
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1366,768',
        '--lang=en-US,en;q=0.9',
        '--disable-extensions',
        '--no-first-run',
        '--disable-default-apps',
      ],
      turnstile: true,
      customConfig: {},
      connectOption: {},
      disableXvfb: false,  // false = let puppeteer-real-browser manage its own Xvfb session on Linux
      ignoreAllFlags: false,
    };
    if (proxy) {
      connectOpts.proxy = {
        host: proxy.host,
        port: proxy.port,
        ...(proxy.username ? { username: proxy.username } : {}),
        ...(proxy.password ? { password: proxy.password } : {}),
      };
    }

    const connectPromise = connect(connectOpts);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`puppeteer connect() timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS)
    );
    const { browser, page } = await Promise.race([connectPromise, timeoutPromise]);

    this.browser = browser;
    this.page = page;
    _sharedBrowser = browser;
    _sharedPage = page;

    // Set realistic browser headers and viewport
    await this.page.setViewport({ width: 1366, height: 768 });
    await this.page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
    });

    try {
      await this.page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
    } catch (_) {}

    // ── Human warmup: visit BHW homepage before going to the forum ──
    // A real user doesn't jump straight to a deep page — they land on the
    // homepage first. This builds a legit-looking anonymous CF session.
    logger.info('Warming up anonymous session — visiting BHW homepage first...');
    try {
      await this.page.goto('https://www.blackhatworld.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await this.waitForCloudflareClear(120000);
      await sleep(randomDelay(3000, 6000));

      // Simulate reading the page — scroll down slowly like a human
      await this.page.evaluate(async () => {
        await new Promise(resolve => {
          let pos = 0;
          const step = () => {
            pos += Math.floor(Math.random() * 120 + 60);
            window.scrollTo(0, pos);
            if (pos < 900) setTimeout(step, Math.floor(Math.random() * 200 + 100));
            else resolve();
          };
          step();
        });
      });

      // Light mouse wander — helps Turnstile / bot scoring without any login
      try {
        await this.page.mouse.move(120 + Math.random() * 400, 160 + Math.random() * 200, { steps: 8 });
        await sleep(randomDelay(400, 900));
        await this.page.mouse.move(300 + Math.random() * 500, 280 + Math.random() * 250, { steps: 10 });
      } catch (_) {}

      await sleep(randomDelay(2000, 4000));
      logger.info('Warmup complete — anonymous session established.');
    } catch (e) {
      // Puppeteer sometimes throws non-Error objects (e.g. plain strings or
      // objects whose .message is undefined). Use `e?.message ?? String(e)`
      // so the log always shows a readable string instead of a character-by-character
      // object dump like {"0":"E","1":"x",...}.
      logger.warn(`Warmup visit failed (non-fatal): ${e?.message ?? String(e)}`);
    }

    logger.info('Real browser initialized successfully (CloudFlare bypass enabled, anonymous)');
  }

  /**
   * Wait for Cloudflare / Turnstile challenge to clear (anonymous path).
   * @returns {Promise<boolean>} true if cleared, false if still blocked
   */
  async waitForCloudflareClear(maxWaitMs = 120000) {
    const started = Date.now();
    if (!(await isCloudflareChallenge(this.page))) return true;

    logger.info(`CloudFlare challenge detected — waiting up to ${Math.round(maxWaitMs / 1000)}s for Turnstile bypass...`);
    while (Date.now() - started < maxWaitMs) {
      await sleep(2000);
      if (!(await isCloudflareChallenge(this.page))) {
        logger.info('CloudFlare challenge passed!');
        await sleep(randomDelay(4000, 7000));
        return true;
      }
    }
    logger.warn(`CloudFlare challenge still present after ${Math.round(maxWaitMs / 1000)}s.`);
    return false;
  }

  /**
   * Close browser. By default keeps the shared instance for the next cycle.
   * Pass discardShared:true after a CF block so the next init is fresh.
   */
  async closeBrowser({ discardShared = false } = {}) {
    if (!discardShared) {
      // Keep persistent anonymous browser alive between scrape cycles
      this.browser = null;
      this.page = null;
      return;
    }

    const browser = this.browser || _sharedBrowser;
    if (browser) {
      try { await browser.close(); } catch (_) {}
      logger.info('Anonymous scraper browser closed (discarded after CF block or shutdown)');
    }
    this.browser = null;
    this.page = null;
    _sharedBrowser = null;
    _sharedPage = null;
  }

  /**
   * Parse integer from string (handles commas, etc.)
   */
  parseInteger(str) {
    if (!str) return null;
    const cleaned = str.replace(/,/g, '').replace(/[^\d]/g, '');
    return cleaned ? parseInt(cleaned, 10) : null;
  }

  /**
   * Clean text to remove problematic Unicode characters
   */
  cleanText(text) {
    if (!text) return text;
    
    return text
      .replace(/\u0131/g, 'i')     // Turkish dotless i
      .replace(/\u2019/g, "'")     // Right single quotation mark
      .replace(/\u2018/g, "'")     // Left single quotation mark
      .replace(/\u201c/g, '"')     // Left double quotation mark
      .replace(/\u201d/g, '"')     // Right double quotation mark
      .replace(/\u2013/g, '-')     // En dash
      .replace(/\u2014/g, '-')     // Em dash
      .replace(/\u2026/g, '...')   // Horizontal ellipsis
      .replace(/[^\x00-\x7F]/g, '?'); // Remove non-ASCII
  }

  /**
   * Parse time from various BHW time formats
   */
  parseTime(timeAttr) {
    if (!timeAttr) return null;
    
    try {
      const date = new Date(timeAttr);
      return isNaN(date.getTime()) ? null : date;
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if date is today
   */
  isToday(date) {
    if (!date) return false;
    const today = new Date();
    return date.toDateString() === today.toDateString();
  }

  /**
   * Fetch page with retry logic using Puppeteer Real Browser
   * Handles CloudFlare challenges automatically
   * @param {string} url
   * @param {number} attempt
   * @param {{ waitForThreads?: boolean }} opts - listing pages should wait for thread cards
   */
  async fetchPageWithRetries(url, attempt = 1, opts = {}) {
    try {
      logger.debug(`Fetching ${url} (attempt ${attempt}/${this.maxRetries})`);
      
      if (attempt > 1) {
        await sleep(randomDelay(2000, 5000));
      }

      await this.page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 60000 
      });

      // Wait a bit for initial load
      await sleep(2000);

      const title = await this.page.title().catch(() => '');
      logger.info(`Page title: ${title}`);

      // Give puppeteer-real-browser Turnstile handler more time (up to 120s).
      // Still anonymous — no login cookies.
      if (await isCloudflareChallenge(this.page)) {
        const cleared = await this.waitForCloudflareClear(120000);
        if (!cleared) {
          logger.warn('CloudFlare challenge still present after 120s — will retry with fresh browser.');
          this.cloudflareBlocked = true;
          return null;
        }
      }

      // Listing pages: CF title can clear before XenForo thread cards render.
      // Waiting here prevents false "0 threads" scrapes.
      if (opts.waitForThreads) {
        try {
          await this.page.waitForSelector('div.structItem--thread', { timeout: 45000 });
          logger.info('Thread cards visible on listing page.');
        } catch (_) {
          const finalTitle = await this.page.title().catch(() => '');
          const count = await this.page.evaluate(
            () => document.querySelectorAll('div.structItem--thread').length
          ).catch(() => 0);
          logger.warn(`Listing page has no thread cards after wait (title="${finalTitle}", count=${count})`);
          if (count === 0) {
            this.cloudflareBlocked = true;
            return null;
          }
        }
      }

      // Simulate human reading — scroll partway down the page
      try {
        await this.page.evaluate(async () => {
          await new Promise(resolve => {
            let pos = 0;
            const step = () => {
              pos += Math.floor(Math.random() * 100 + 50);
              window.scrollTo(0, pos);
              if (pos < 600) setTimeout(step, Math.floor(Math.random() * 150 + 80));
              else resolve();
            };
            step();
          });
        });
      } catch (_) {}

      // Wait for any dynamic content
      await sleep(randomDelay(1500, 3000));

      return await this.page.content();
    } catch (error) {
      const msg = error?.message ?? String(error);
      logger.error(`Fetch attempt ${attempt}/${this.maxRetries} failed for ${url}: ${msg}`);
      if (/INVALID_AUTH_CREDENTIALS|ERR_PROXY|407/i.test(msg)) {
        logger.error('Proxy auth/network failure — check SCRAPER_PROXY_URL credentials/quota.');
        this.cloudflareBlocked = true;
        return null;
      }
      
      if (attempt < this.maxRetries) {
        const delay = this.retryDelay * attempt;
        logger.info(`Retrying in ${delay}ms...`);
        await sleep(delay);
        return this.fetchPageWithRetries(url, attempt + 1, opts);
      }
      
      return null;
    }
  }

  /**
   * Get thread description (OP's first post)
   */
  async getThreadDescription(url, threadId) {
    try {
      logger.info(`Fetching description for thread: ${threadId}`);
      
      const html = await this.fetchPageWithRetries(url);
      
      if (!html) {
        logger.warn(`Failed to retrieve thread page: ${url}`);
        return { description: 'No description found', authorUsername: null };
      }

      const $ = cheerio.load(html);
      
      // Find the OP's first post
      const opPost = $('article.message.message--post').first();

      // Extract the OP's username from the post itself (reliable — direct DOM, not listing card)
      let authorUsername = null;
      if (opPost.length > 0) {
        const usernameEl = opPost.find('.message-name a.username, .message-userDetails a.username, .message-name .username, a.username').first();
        if (usernameEl.length > 0) {
          authorUsername = this.cleanText(usernameEl.text().trim()) || null;
        }
        // Fallback: extract from message-userDetails href
        if (!authorUsername) {
          const userLink = opPost.find('a[href*="/members/"]').first();
          if (userLink.length > 0) {
            const href = userLink.attr('href') || '';
            const match = href.match(/\/members\/([^\/\.]+)/);
            if (match) authorUsername = match[1];
          }
        }
      }

      if (authorUsername) {
        logger.info(`Author extracted from thread page: @${authorUsername}`);
      } else {
        logger.warn(`Could not extract author username from thread page: ${url}`);
      }
      
      if (opPost.length > 0) {
        const opBody = opPost.find('.message-content .bbWrapper');
        const description = this.cleanText(opBody.text().trim()) || 'No description found';
        logger.info(`Description fetched: ${description.length} chars`);
        return { description, authorUsername };
      }

      return { description: 'No description found', authorUsername };
    } catch (error) {
      logger.error(`Error fetching thread description from ${url}:`, error.message);
      return { description: 'No description found', authorUsername: null };
    }
  }

  /**
   * Scrape thread listing page and fetch details
   */
  async scrapeListingWithDetails(pageNum = 1) {
    const url = pageNum === 1 ? this.baseUrl : `${this.baseUrl}page-${pageNum}`;
    
    logger.info(`Scraping BHW page ${pageNum}...`);
    
    const emptyResult = {
      threads: [],
      inspectedPosts: [],
      stats: { totalFound: 0, filteredOut: 0, alreadyExisted: 0, newProcessed: 0, approved: 0, rejected: 0 },
    };

    const html = await this.fetchPageWithRetries(url, 1, { waitForThreads: true });
    
    if (!html) {
      logger.error(`Failed to fetch listing page ${pageNum}`);
      return emptyResult;
    }

    const $ = cheerio.load(html);
    const allCards = $('div.structItem--thread').toArray();

    // Empty listing after a "successful" fetch = soft-block / incomplete CF pass
    if (allCards.length === 0) {
      const title = await this.page.title().catch(() => '');
      logger.warn(`Listing HTML parsed 0 thread cards (title="${title}") — treating as blocked.`);
      this.cloudflareBlocked = true;
      return emptyResult;
    }

    // ── Top N listing cards ─────────────────────────────────────────────────
    // Pipeline C only: 10 is enough for today-jobs (newest float to top).
    // Full Pipeline A keeps 20 for catch-up headroom.
    const TOP_N    = config.pipelineCOnly ? 10 : 20;
    const threadCards = allCards.slice(0, TOP_N);

    // Tracks inspected posts with per-post status for Discord / logs
    const inspectedPosts = [];

    const stats = {
      total_found: allCards.length,   // total on page (info only)
      filtered_out: 0,
      already_exists: 0,
      new_processed: 0
    };

    logger.info(`Found ${stats.total_found} threads on page ${pageNum} — inspecting top ${TOP_N}${config.pipelineCOnly ? ' [Pipeline C]' : ''}`);

    // ============================================
    // PASS 1: Extract IDs from top N (fast, no DB calls)
    // ============================================
    logger.info(`Step 1: Extracting top-${TOP_N} thread IDs...`);
    const allThreadIds = [];
    const threadDataMap = new Map();

    for (let i = 0; i < threadCards.length; i++) {
      const card = $(threadCards[i]);

      // Extract title and URL
      const titleTag = card.find('.structItem-title a:not(.labelLink)').first();
      if (titleTag.length === 0) {
        stats.filtered_out++;
        continue;
      }

      const threadPath = titleTag.attr('href') || '';
      const fullUrl = 'https://www.blackhatworld.com' + threadPath;
      const threadId = extractThreadId(fullUrl);
      if (!threadId) {
        logger.warn(`  Could not extract thread ID from URL: ${fullUrl} — skipping`);
        stats.filtered_out++;
        continue;
      }
      const title = this.cleanText(titleTag.text().trim());

      // Skip pinned/rules posts — they are permanent fixtures, never jobs
      if (/^\[RULE|^\[STICKY|^\[PINNED|^\[OFFICIAL|^\[IMPORTANT|^\[MODERATOR/i.test(title)) {
        logger.info(`  Skipping pinned post: "${title.substring(0, 60)}"`);
        inspectedPosts.push({ threadId, title, url: fullUrl, status: 'skipped-pinned' });
        stats.filtered_out++;
        continue;
      }

      // Extract author — try multiple selectors (BHW XenForo 2 HTML varies)
      const authorTag = card.find(
        '.structItem-minor .username, .structItem-parts .username, ' +
        '.structItem-cell--user .username, a.username, ' +
        '.structItem-minor a[href*="/members/"]'
      ).first();
      let author = authorTag.length > 0 ? this.cleanText(authorTag.text().trim()) : null;
      // Fallback: extract username from member href
      if (!author && authorTag.length > 0) {
        const href = authorTag.attr('href') || '';
        const match = href.match(/\/members\/([^\/\.]+)/);
        if (match) author = match[1];
      }

      // Extract replies and views
      const metaPairs = card.find('.structItem-cell--meta dl.pairs.pairs--justified dd').toArray();
      const replies = metaPairs.length >= 1 ? this.parseInteger($(metaPairs[0]).text()) : null;
      const views = metaPairs.length >= 2 ? this.parseInteger($(metaPairs[1]).text()) : null;

      // Extract posted time
      const postedTimeTag = card.find('.structItem-startDate time.u-dt, .structItem-cell--main time.u-dt, .structItem-minor time, time').first();
      const datetimeAttr = postedTimeTag.attr('datetime') || postedTimeTag.attr('data-datetime') || postedTimeTag.attr('title');
      const postedAt = this.parseTime(datetimeAttr);

      allThreadIds.push(threadId);
      threadDataMap.set(threadId, {
        threadId,
        fullUrl,
        title,
        author,
        replies,
        views,
        postedAt
      });

      // Pre-populate inspectedPosts — status updated in later passes
      inspectedPosts.push({ threadId, title, url: fullUrl, status: 'pending' });
    }

    logger.info(`Extracted ${allThreadIds.length} thread IDs`);

    // ============================================
    // PASS 2: Batch check which threads already exist (1 DB query)
    // ============================================
    logger.info('Step 2: Checking database for existing threads (batch query)...');
    const existingThreadIds = await getExistingThreadIds(allThreadIds);
    const existingSet = new Set(existingThreadIds);

    logger.info(`Found ${existingThreadIds.length} threads already in database`);
    stats.already_exists = existingThreadIds.length;

    // Mark already-seen posts in inspectedPosts
    for (const tid of existingThreadIds) {
      const p = inspectedPosts.find(p => p.threadId === tid);
      if (p) p.status = 'seen';
    }

    // ============================================
    // PASS 3: Process only NEW threads from the top N
    // ============================================
    logger.info(`Step 3: Processing NEW threads from top-${TOP_N}...`);
    const newThreadIds = allThreadIds.filter(id => !existingSet.has(id));
    logger.info(`${newThreadIds.length} NEW thread(s) to process this cycle (out of top ${TOP_N} checked)`);

    const threadsData = [];
    let processedCount = 0;

    for (const threadId of newThreadIds) {
      processedCount++;
      const basicData = threadDataMap.get(threadId);
      
      logger.info(`Processing thread ${processedCount}/${newThreadIds.length}...`);
      logger.info(`  Thread: ${basicData.title.substring(0, 50)}...`);
      logger.info(`  Posted: ${basicData.postedAt}`);
      
      // Calculate thread age category
      const threadAgeCategory = getThreadAgeCategory(basicData.postedAt);
      logger.info(`Thread age category: ${threadAgeCategory}`);

      // Skip ancient threads (>1 year)
      if (threadAgeCategory === 'ancient') {
        logger.info('Skipping - thread is too old (>1 year)');
        stats.filtered_out++;
        const ip = inspectedPosts.find(p => p.threadId === threadId);
        if (ip) { ip.status = 'skipped-ancient'; ip.age = threadAgeCategory; }
        continue;
      }

      // ── "Posted Today Only" gate (Pipeline C & Pipeline A) ────────────────
      // Only open the thread page (heavy) when the post is from TODAY.
      // Non-today threads: store a lightweight listing row for dedup — no goto, no AI qualification.
      const postedToday = !!(basicData.postedAt && this.isToday(basicData.postedAt));
      const shouldEnforceToday = config.pipelineCOnly || config.bot?.todayOnly;

      if (shouldEnforceToday && !postedToday) {
        const modeTag = config.pipelineCOnly ? '[Pipeline C]' : '[Pipeline A]';
        logger.info(`${modeTag} Skipping thread page fetch — not posted today`);
        const posterUsername = basicData.author || null;
        const description = '(listing only — not posted today; skipped by today-only filter)';

        const lead = await createLead({
          threadId,
          threadUrl: basicData.fullUrl,
          title: basicData.title,
          description,
          posterUsername,
          posterUrl: posterUsername ? `https://www.blackhatworld.com/members/${posterUsername}/` : null,
          postDate: basicData.postedAt,
          threadAgeCategory,
          tags: [],
        });

        await updateLeadQualification(
          lead.id,
          false,
          'Skipped thread fetch — not today',
          0
        );

        const ip = inspectedPosts.find(p => p.threadId === threadId);
        if (ip) { ip.status = 'skipped-not-today'; ip.age = threadAgeCategory; }

        await logActivity({
          actionType: 'today_filter_skip',
          leadId: lead.id,
          description: `Skipped thread page (not today): ${basicData.title}`,
          metadata: { threadId, postedAt: basicData.postedAt },
        });

        stats.new_processed++;
        stats.filtered_out++;
        continue;
      }

      logger.info('NEW thread - fetching details...');
      
      // Fetch full description (also extracts author username from the post page — more reliable)
      const { description, authorUsername: fetchedAuthor } = await this.getThreadDescription(basicData.fullUrl, threadId);

      // Use listing-page author if found; fall back to author extracted from thread post page
      const posterUsername = basicData.author || fetchedAuthor || null;
      if (!basicData.author && fetchedAuthor) {
        logger.info(`Using author from thread page as fallback: @${fetchedAuthor}`);
      }
      if (!posterUsername) {
        logger.warn(`Could not determine poster username for thread ${threadId} — DM will be skipped for this lead`);
      }
      
      // Store in database first (before AI qualification)
      logger.info('Storing thread in database...');
      const leadData = {
        threadId,
        threadUrl: basicData.fullUrl,
        title: basicData.title,
        description,
        posterUsername,
        posterUrl: posterUsername ? `https://www.blackhatworld.com/members/${posterUsername}/` : null,
        postDate: basicData.postedAt,
        threadAgeCategory,
        tags: []
      };

      const lead = await createLead(leadData);
      
      // Log activity
      await logActivity({
        actionType: 'scrape',
        leadId: lead.id,
        description: `Discovered new thread: ${basicData.title}`,
        metadata: {
          threadId,
          threadAgeCategory,
          replies: basicData.replies,
          views: basicData.views
        }
      });

      logger.info(`Thread stored in database (Lead ID: ${lead.id})`);

      // Pipeline C only: skip AI qualification — notifier does not need it.
      // Full Pipeline A path still qualifies with GPT-4o mini.
      let qualification;
      if (config.pipelineCOnly) {
        qualification = {
          qualified: false,
          confidence: 0,
          tier: 'pipeline-c-only',
          reason: 'Skipped — PIPELINE_C_ONLY mode (job notifier, no outreach)',
        };
        logger.info('[Pipeline C] Skipping AI qualification (notifier-only mode)');
      } else {
        // NOTE: AI is ONLY called here for genuinely NEW posts.
        // Already-seen posts are caught by the DB batch check in PASS 2 and never reach here.
        logger.info('Qualifying thread with OpenAI...');
        qualification = await aiEngine.qualifyLead(basicData.title, description);
        logger.info(`Qualification result: ${qualification.qualified ? 'APPROVED' : 'REJECTED'} (Confidence: ${qualification.confidence}, Tier: ${qualification.tier})`);
      }

      // Track in inspectedPosts
      const ip = inspectedPosts.find(p => p.threadId === threadId);
      if (ip) {
        ip.status = config.pipelineCOnly
          ? 'pipeline-c'
          : (qualification.qualified ? 'new-approved' : 'new-rejected');
        ip.confidence = qualification.confidence;
        ip.age = threadAgeCategory;
      }

      // Tag as 'development' if qualified as a development/coding job
      const updatedTags = qualification.is_development
        ? Array.from(new Set([...(leadData.tags || []), 'development']))
        : (leadData.tags || []);

      // Update lead with qualification (skipped score in C-only still written for DB consistency)
      await updateLeadQualification(
        lead.id,
        qualification.qualified,
        qualification.reason,
        qualification.confidence,
        updatedTags
      );

      // ── Pipeline C: Today-only new job notifier ──────────────────────────
      // Fires for every brand-new thread posted TODAY regardless of AI result.
      // Bumped/old threads that BHW floats to the top are silently ignored.
      if (basicData.postedAt && this.isToday(basicData.postedAt)) {
        sendPipelineCJobAlert({
          title:          basicData.title,
          url:            basicData.fullUrl,
          posterUsername: posterUsername,
          description:    description,
          postedAt:       basicData.postedAt,
        }).catch(err => logger.warn(`[Pipeline C] Alert failed: ${err.message}`));
      } else {
        logger.info(`[Pipeline C] Skipping alert — thread not from today (age: ${threadAgeCategory}, posted: ${basicData.postedAt || 'unknown'})`);
      }

      // ── Pipeline A: Disqualification alert to DM Channel ────────────────
      // When a newly scraped post is disqualified by AI, notify the DM channel so the team sees why.
      if (!config.pipelineCOnly && !qualification.qualified) {
        sendLeadDisqualifiedAlert({
          title:          basicData.title,
          url:            basicData.fullUrl,
          posterUsername: posterUsername,
          reason:         qualification.reason,
          confidence:     qualification.confidence,
        }).catch(err => logger.warn(`[DM Alert] Disqualification alert failed: ${err.message}`));
      }

      // Log qualification / notifier activity
      await logActivity({
        actionType: config.pipelineCOnly ? 'pipeline_c_notify' : 'qualification',
        leadId: lead.id,
        description: config.pipelineCOnly
          ? `Pipeline C notifier stored thread: ${basicData.title}`
          : `AI qualification: ${qualification.qualified ? 'APPROVED' : 'REJECTED'}`,
        metadata: {
          confidence: qualification.confidence,
          tier: qualification.tier,
          reason: qualification.reason
        }
      });

      threadsData.push({
        threadId,
        title: basicData.title,
        url: basicData.fullUrl,
        author: basicData.author,
        repliesCount: basicData.replies,
        viewsCount: basicData.views,
        postedAt: basicData.postedAt,
        threadAgeCategory,
        description,
        qualified: qualification.qualified,
        qualificationScore: qualification.confidence,
        leadId: lead.id
      });

      stats.new_processed++;

      // Add delay between threads to avoid rate limiting
      if (processedCount < newThreadIds.length) {
        const delay = randomDelay(1000, 3000);
        logger.debug(`Waiting ${delay}ms before next thread...`);
        await sleep(delay);
      }
    }

    logger.info(`Page ${pageNum} Statistics:`);
    logger.info(`  Total found: ${stats.total_found}`);
    logger.info(`  Filtered out: ${stats.filtered_out}`);
    logger.info(`  Already exists: ${stats.already_exists}`);
    logger.info(`  New threads stored: ${stats.new_processed}`);
    
    const approved = threadsData.filter(t => t.qualified).length;
    const rejected = threadsData.filter(t => !t.qualified).length;
    logger.info(`  AI approved: ${approved}`);
    logger.info(`  AI rejected: ${rejected}`);

    return {
      threads: threadsData,
      inspectedPosts,
      stats: {
        totalFound: stats.total_found,
        filteredOut: stats.filtered_out,
        alreadyExisted: stats.already_exists,
        newProcessed: stats.new_processed,
        approved,
        rejected,
      },
    };
  }

  /**
   * Main scraping function — scrapes `pages` pages of BHW listings.
   * If CloudFlare blocks mid-run, tears down the browser, sleeps 2–3 min,
   * then retries once with a completely fresh browser instance.
   * @param {number} pages - Number of pages to scrape
   */
  async scrapeAndStore(pages = 1) {
    logger.info(`Starting BHW scraper for ${pages} page(s)...`);
    
    try {
      await this.initBrowser();
      
      const allThreads = [];
      let totalFound = 0;
      let totalAlreadyExisted = 0;
      let totalNewProcessed = 0;
      let allInspectedPosts = [];

      for (let p = 1; p <= pages; p++) {
        const { threads, inspectedPosts, stats: pageStats } = await this.scrapeListingWithDetails(p);

        // ── CF block recovery ────────────────────────────────────────────────
        // If CF blocked the listing page, discard the shared browser, wait
        // 2–3 minutes, then retry ONCE with a brand-new anonymous browser.
        // Still no login. If it blocks again, skip cycle (outer loop backs off).
        if (this.cloudflareBlocked) {
          logger.warn('CF block detected during listing scrape — discarding browser and waiting before retry...');
          await this.closeBrowser({ discardShared: true });
          const cooldown = randomDelay(120000, 180000); // 2–3 min
          logger.info(`Waiting ${Math.round(cooldown / 1000)}s for CF cooldown before fresh-browser retry...`);
          await sleep(cooldown);

          logger.info('Retrying with fresh anonymous browser...');
          this.cloudflareBlocked = false; // reset flag for the retry
          await this.initBrowser({ forceFresh: true });

          const retryResult = await this.scrapeListingWithDetails(p);
          if (this.cloudflareBlocked) {
            logger.warn('CF still blocking after fresh-browser retry — skipping this cycle entirely.');
            await this.closeBrowser({ discardShared: true });
            break; // give up for this cycle; outer loop applies exponential backoff
          }
          allThreads.push(...(retryResult.threads || []));
          allInspectedPosts.push(...(retryResult.inspectedPosts || []));
          totalFound          += retryResult.stats?.totalFound || 0;
          totalAlreadyExisted += retryResult.stats?.alreadyExisted || 0;
          totalNewProcessed   += retryResult.stats?.newProcessed || 0;
          continue;
        }
        // ────────────────────────────────────────────────────────────────────

        logger.info(`Completed page ${p}: ${threads.length} new threads processed`);
        allThreads.push(...threads);
        allInspectedPosts.push(...inspectedPosts);
        totalFound          += pageStats.totalFound;
        totalAlreadyExisted += pageStats.alreadyExisted;
        totalNewProcessed   += pageStats.newProcessed;

        if (p < pages) {
          const delay = randomDelay(2000, 5000);
          logger.info(`Waiting ${delay}ms before next page...`);
          await sleep(delay);
        }
      }

      logger.info('\n=== SCRAPING COMPLETED ===');
      logger.info(`Total new threads stored: ${allThreads.length}`);
      
      const approved = allThreads.filter(t => t.qualified).length;
      const rejected  = allThreads.filter(t => !t.qualified).length;
      const approvalRate = allThreads.length > 0 ? ((approved / allThreads.length) * 100).toFixed(1) : 0;
      
      logger.info(`Threads approved by AI: ${approved}`);
      logger.info(`Threads rejected by AI: ${rejected}`);
      logger.info(`Approval rate: ${approvalRate}%`);

      return {
        threads: allThreads,
        inspectedPosts: allInspectedPosts,
        cloudflareBlocked: this.cloudflareBlocked,
        totalFound,
        alreadyExisted: totalAlreadyExisted,
        newProcessed: totalNewProcessed,
        approved,
        rejected,
      };
    } finally {
      // Keep anonymous browser alive for the next cycle (unless discarded after CF)
      await this.closeBrowser({ discardShared: false });
    }
  }
}

/**
 * Main scraper loop - runs every 2 minutes
 */
export async function startScraperLoop() {
  logger.info('Scraper loop starting...');
  
  // Run immediately on start
  logger.info('Running initial scrape...');
  const scraper = new BHWScraper();
  
  try {
    await scraper.scrapeAndStore(1);
  } catch (error) {
    logger.error('Error in initial scrape:', error);
    await logActivity({
      actionType: 'error',
      description: 'Initial scrape error',
      status: 'failed',
      errorMessage: error.message
    });
  }

  // Then run every 2 minutes
  setInterval(async () => {
    const intervalScraper = new BHWScraper();
    try {
      logger.info('Running scheduled scrape...');
      await intervalScraper.scrapeAndStore(1);
    } catch (error) {
      logger.error('Error in scheduled scrape:', error);
      await logActivity({
        actionType: 'error',
        description: 'Scheduled scrape error',
        status: 'failed',
        errorMessage: error.message
      });
    }
  }, config.bhw.scrapeInterval);

  logger.info(`Scraper loop started (interval: ${config.bhw.scrapeInterval}ms = ${config.bhw.scrapeInterval / 1000 / 60} minutes)`);
}

export { BHWScraper };
export default BHWScraper;

