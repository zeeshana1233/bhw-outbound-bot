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
  getExistingThreadIds 
} from '../database/queries.js';
import { 
  extractThreadId, 
  sanitizeText, 
  getThreadAgeCategory, 
  sleep, 
  randomDelay 
} from '../utils/helpers.js';
import aiEngine from '../services/aiEngine.js';
import { logActivity } from '../database/queries.js';

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
  async initBrowser() {
    if (this.browser) {
      return; // Already initialized
    }

    logger.info('Initializing real browser for scraping...');
    
    // Connect with puppeteer-real-browser for CloudFlare bypass
    const { browser, page } = await connect({
      headless: 'auto',
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
      disableXvfb: false,
      ignoreAllFlags: false
    });

    this.browser = browser;
    this.page = page;

    // Set realistic browser headers and viewport
    await this.page.setViewport({ width: 1366, height: 768 });
    await this.page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
    });

    // ── Human warmup: visit BHW homepage before going to the forum ──
    // A real user doesn't jump straight to a deep page — they land on the
    // homepage first. This builds a legit-looking session cookie from scratch.
    logger.info('Warming up session — visiting BHW homepage first...');
    try {
      await this.page.goto('https://www.blackhatworld.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
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

      await sleep(randomDelay(2000, 4000));
      logger.info('Warmup complete — session established.');
    } catch (e) {
      logger.warn('Warmup visit failed (non-fatal):', e.message);
    }

    logger.info('Real browser initialized successfully (CloudFlare bypass enabled)');
  }

  /**
   * Close browser
   */
  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      logger.info('Browser closed');
    }
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
   */
  async fetchPageWithRetries(url, attempt = 1) {
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

      // Check if CloudFlare challenge is present
      let title = await this.page.title();
      logger.debug(`Page title: ${title}`);

      if (title.includes('Just a moment') || title.includes('Cloudflare')) {
        logger.info('CloudFlare challenge detected, waiting up to 60 seconds...');
        
        try {
          await this.page.waitForFunction(
            () => !document.title.includes('Just a moment') && !document.title.includes('Cloudflare'),
            { timeout: 60000 }
          );
          
          logger.info('CloudFlare challenge passed!');
          await sleep(randomDelay(2000, 4000));
          
        } catch (e) {
          logger.warn('CloudFlare challenge still present after 60s, marking as blocked.');
          this.cloudflareBlocked = true;
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
      logger.error(`Fetch attempt ${attempt}/${this.maxRetries} failed for ${url}:`, error.message);
      
      if (attempt < this.maxRetries) {
        const delay = this.retryDelay * attempt;
        logger.info(`Retrying in ${delay}ms...`);
        await sleep(delay);
        return this.fetchPageWithRetries(url, attempt + 1);
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
        return 'No description found';
      }

      const $ = cheerio.load(html);
      
      // Find the OP's first post
      const opDescription = $('article.message.message--post').first();
      
      if (opDescription.length > 0) {
        const opBody = opDescription.find('.message-content .bbWrapper');
        const description = this.cleanText(opBody.text().trim()) || 'No description found';
        logger.info(`Description fetched: ${description.length} chars`);
        return description;
      }

      return 'No description found';
    } catch (error) {
      logger.error(`Error fetching thread description from ${url}:`, error.message);
      return 'No description found';
    }
  }

  /**
   * Scrape thread listing page and fetch details
   */
  async scrapeListingWithDetails(pageNum = 1) {
    const url = pageNum === 1 ? this.baseUrl : `${this.baseUrl}page-${pageNum}`;
    
    logger.info(`Scraping BHW page ${pageNum}...`);
    
    const html = await this.fetchPageWithRetries(url);
    
    if (!html) {
      logger.error(`Failed to fetch listing page ${pageNum}`);
      return [];
    }

    const $ = cheerio.load(html);
    const allCards = $('div.structItem--thread').toArray();

    // ── Only look at the top 5 cards ────────────────────────────────────────
    // BHW always lists newest posts first. New leads always arrive at the top.
    // Checking only the top 5 avoids scanning 20+ irrelevant threads every cycle.
    const TOP_N    = 5;
    const threadCards = allCards.slice(0, TOP_N);

    // Tracks all 5 inspected posts with per-post status for the WA ping
    const inspectedPosts = [];

    const stats = {
      total_found: allCards.length,   // total on page (info only)
      filtered_out: 0,
      already_exists: 0,
      new_processed: 0
    };

    logger.info(`Found ${stats.total_found} threads on page ${pageNum} — inspecting top ${TOP_N}`);

    // ============================================
    // PASS 1: Extract IDs from top 5 only (fast, no DB calls)
    // ============================================
    logger.info('Step 1: Extracting top-5 thread IDs...');
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
      const threadId = extractThreadId(fullUrl) || fullUrl;
      const title = this.cleanText(titleTag.text().trim());

      // Extract author
      const authorTag = card.find('.structItem-minor .username, .structItem-parts .username').first();
      const author = authorTag.length > 0 ? this.cleanText(authorTag.text().trim()) : null;

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
    // PASS 3: Process only NEW threads from the top 5
    // ============================================
    logger.info('Step 3: Processing NEW threads from top-5...');
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

      logger.info('NEW thread - fetching details...');
      
      // Fetch full description
      const description = await this.getThreadDescription(basicData.fullUrl, threadId);
      
      // Store in database first (before AI qualification)
      logger.info('Storing thread in database...');
      const leadData = {
        threadId,
        threadUrl: basicData.fullUrl,
        title: basicData.title,
        description,
        posterUsername: basicData.author,
        posterUrl: basicData.author ? `https://www.blackhatworld.com/members/${basicData.author}/` : null,
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

      // Qualify with AI (OpenClaw — GPT-4o mini)
      // NOTE: AI is ONLY called here for genuinely NEW posts.
      // Already-seen posts are caught by the DB batch check in PASS 2 and never reach here.
      logger.info('Qualifying thread with OpenClaw (GPT-4o mini)...');
      const qualification = await aiEngine.qualifyLead(basicData.title, description);
      
      logger.info(`Qualification result: ${qualification.qualified ? 'APPROVED' : 'REJECTED'} (Confidence: ${qualification.confidence}, Tier: ${qualification.tier})`);

      // Track in inspectedPosts
      const ip = inspectedPosts.find(p => p.threadId === threadId);
      if (ip) {
        ip.status = qualification.qualified ? 'new-approved' : 'new-rejected';
        ip.confidence = qualification.confidence;
        ip.age = threadAgeCategory;
      }

      // Update lead with qualification
      await updateLeadQualification(
        lead.id,
        qualification.qualified,
        qualification.reason,
        qualification.confidence
      );

      // Log qualification
      await logActivity({
        actionType: 'qualification',
        leadId: lead.id,
        description: `AI qualification: ${qualification.qualified ? 'APPROVED' : 'REJECTED'}`,
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
   * Main scraping function
   * @param {number} pages - Number of pages to scrape
   */
  async scrapeAndStore(pages = 1) {
    logger.info(`Starting BHW scraper for ${pages} page(s)...`);
    
    try {
      // Initialize browser
      await this.initBrowser();
      
      const allThreads = [];
      let totalFound = 0;
      let totalAlreadyExisted = 0;
      let totalNewProcessed = 0;
      let allInspectedPosts = [];

      for (let p = 1; p <= pages; p++) {
        const { threads, inspectedPosts, stats: pageStats } = await this.scrapeListingWithDetails(p);
        logger.info(`Completed page ${p}: ${threads.length} new threads processed`);
        allThreads.push(...threads);
        allInspectedPosts.push(...inspectedPosts);
        totalFound        += pageStats.totalFound;
        totalAlreadyExisted += pageStats.alreadyExisted;
        totalNewProcessed += pageStats.newProcessed;

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
      await this.closeBrowser();
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

