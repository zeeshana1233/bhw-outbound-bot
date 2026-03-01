/**
 * Community Commenter Engine
 *
 * Scans BHW sub-forums for new threads where we can add genuine value,
 * then posts a helpful, policy-compliant reply using OpenClaw + knowledge base.
 *
 * ── HOW IT WORKS ────────────────────────────────────────────────────────────
 *  1. Scans a curated list of relevant BHW sub-forums every 4–6 hours (random)
 *  2. Finds threads posted today that we haven't commented on yet
 *  3. Keyword pre-screen: skip threads with no overlap with our expertise
 *  4. Navigate to each promising thread, read the opening post
 *  5. OpenClaw classifies full relevance (title + OP snippet) → score 0-10
 *  6. For score ≥ 6: select matching tips from knowledge-base.json
 *  7. OpenClaw generates a genuine, non-promotional helpful reply
 *  8. Post using the shared BHW session with human-behaviour simulation
 *  9. Track in community_comments DB table (never double-post)
 * 10. Per-run limit: max 3 comments — keeps activity natural
 *
 * ── BHW POLICY ──────────────────────────────────────────────────────────────
 *  ✗ No promotion, no upselling, no Telegram link
 *  ✗ No "contact me", "DM me", "check my profile"
 *  ✓ Purely helpful replies — the signature banner does the selling passively
 *  ✓ Reads like a knowledgeable community member, not a vendor
 */

import * as cheerio from 'cheerio';
import logger from '../utils/logger.js';
import { sleep, randomDelay } from '../utils/helpers.js';
import aiEngine from '../services/aiEngine.js';
import bhwSession from '../utils/bhwSession.js';
import { botState } from '../utils/botState.js';
import { postToThread } from './comment.js';
import { query } from '../database/init.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const knowledgeBase = require('../data/knowledge-base.json');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

/** Sub-forums to scan.  Add/remove as you grow knowledge in new categories. */
const SCAN_FORUMS = [
  { url: 'https://www.blackhatworld.com/forums/white-hat-seo.3/',       name: 'SEO' },
  { url: 'https://www.blackhatworld.com/forums/black-hat-seo.15/',      name: 'Black Hat SEO' },
  { url: 'https://www.blackhatworld.com/forums/programming.69/',        name: 'Programming' },
  { url: 'https://www.blackhatworld.com/forums/tools.24/',              name: 'Tools' },
  { url: 'https://www.blackhatworld.com/forums/social-media.72/',       name: 'Social Media' },
  { url: 'https://www.blackhatworld.com/forums/web-design.53/',         name: 'Web Design' },
  { url: 'https://www.blackhatworld.com/forums/general-discussion.29/', name: 'General' },
  { url: 'https://www.blackhatworld.com/forums/php-coding.70/',         name: 'PHP' },
];

/** Only post to threads with a relevanceScore at or above this threshold */
const MIN_RELEVANCE_SCORE = 6;

/** Maximum comments per scan cycle (keeps activity organic-looking) */
const MAX_COMMENTS_PER_RUN = 3;

/** Gap between posting consecutive community comments (ms) */
const BETWEEN_COMMENTS_MIN_MS = 8  * 60 * 1000;  // 8 min
const BETWEEN_COMMENTS_MAX_MS = 20 * 60 * 1000;  // 20 min

/** Loop interval: run once every 4–6 hours */
const LOOP_MIN_MS = 4 * 60 * 60 * 1000;
const LOOP_MAX_MS = 6 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// KEYWORD PRE-SCREEN  (free — no AI call)
// Maps category tags to a flat Set for fast lookup
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_KEYWORDS = {};
for (const [cat, data] of Object.entries(knowledgeBase)) {
  if (cat === '_meta') continue;
  const tagSet = new Set();
  for (const tip of (data.tips || [])) {
    for (const t of (tip.tags || [])) {
      t.toLowerCase().split(/\s+/).forEach(w => tagSet.add(w));
    }
  }
  CATEGORY_KEYWORDS[cat] = tagSet;
}

/** Returns true if the title/snippet text overlaps with ANY category's keywords */
function passesKeywordPreScreen(text) {
  const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  for (const tagSet of Object.values(CATEGORY_KEYWORDS)) {
    for (const w of words) {
      if (tagSet.has(w)) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// TIP SELECTOR
// Picks the most relevant tips from knowledge-base for a given category + text
// ─────────────────────────────────────────────────────────────────────────────

function selectRelevantTips(category, text) {
  const catData = knowledgeBase[category];
  if (!catData || !catData.tips) return [];

  const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 3);

  const scored = catData.tips.map(tip => {
    const tagWords = (tip.tags || []).join(' ').toLowerCase().split(/\W+/);
    const overlap  = tagWords.filter(t => words.includes(t)).length;
    return { tip, score: overlap };
  });

  // Sort by overlap desc, fall back to original order
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(s => s.tip);
}

// ─────────────────────────────────────────────────────────────────────────────
// DB HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function hasAlreadyCommented(threadId) {
  const result = await query(
    'SELECT id FROM community_comments WHERE thread_id = $1',
    [threadId]
  );
  return result.rows.length > 0;
}

async function saveCommunityComment({ threadId, threadUrl, threadTitle, category, relevanceScore, commentText, commentUrl, commentId, dryRun }) {
  await query(
    `INSERT INTO community_comments
       (thread_id, thread_url, thread_title, category, relevance_score, comment_text, comment_url, comment_id, dry_run)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (thread_id) DO NOTHING`,
    [threadId, threadUrl, threadTitle, category, relevanceScore, commentText, commentUrl, commentId, dryRun || false]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BHW PAGE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scrape a BHW forum listing page and return thread stubs.
 * Parses XenForo 2 structItem HTML via cheerio.
 */
async function scrapeForumPage(page, forumUrl) {
  logger.info(`  Scanning: ${forumUrl}`);
  await page.goto(forumUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(randomDelay(1500, 3000));

  const html = await page.content();
  const $    = cheerio.load(html);

  const threads = [];

  $('.structItem--thread').each((_, el) => {
    const titleEl = $(el).find('.structItem-title a').not('[href*="forums/"]').first();
    const title   = titleEl.text().trim();
    const href    = titleEl.attr('href');
    if (!title || !href) return;

    // Build absolute URL
    const url = href.startsWith('http') ? href : `https://www.blackhatworld.com${href}`;

    // Extract thread ID from URL pattern: /threads/slug.12345/
    const idMatch = url.match(/\.(\d+)\/?$/);
    const threadId = idMatch ? idMatch[1] : url;

    // Grab post date from <time> element
    const timeEl  = $(el).find('time[datetime]').first();
    const dateStr = timeEl.attr('datetime');
    const postDate = dateStr ? new Date(dateStr) : null;

    // Only include threads posted today (or within last 24 hours)
    const isRecent = postDate
      ? (Date.now() - postDate.getTime()) < 24 * 60 * 60 * 1000
      : false;

    if (title && url && isRecent) {
      threads.push({ threadId, url, title, postDate });
    }
  });

  logger.info(`    Found ${threads.length} thread(s) posted in last 24h`);
  return threads;
}

/**
 * Navigate to a thread page and extract the opening post text.
 * We read it like a user would — no aggressive scraping.
 */
async function scrapeOpeningPost(page, threadUrl) {
  await page.goto(threadUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(randomDelay(1500, 3000));

  // Simulate brief reading pause
  await page.evaluate(() => window.scrollBy({ top: randomDelay ? 200 : 300, behavior: 'smooth' }));
  await sleep(randomDelay(800, 2000));

  const html = await page.content();
  const $    = cheerio.load(html);

  // First article.message contains the OP
  const op = $('article.message').first();
  const snippet = op.find('.bbWrapper').text().replace(/\s+/g, ' ').trim().substring(0, 1000);
  return snippet;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCAN + COMMENT CYCLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One full community commenting run:
 *   1. Scan all forum pages
 *   2. Filter → classify → generate → post
 *   3. Stop after MAX_COMMENTS_PER_RUN
 */
export async function runCommunityCycle(opts = {}) {
  if (botState.isPaused()) {
    logger.info('⏸️  Bot paused — skipping community comment cycle');
    return { commented: 0 };
  }

  if (bhwSession.isSessionDown()) {
    logger.info('💤 BHW session down — skipping community comment cycle');
    return { commented: 0 };
  }

  const DRY_RUN = opts.dryRun !== undefined ? opts.dryRun : botState.isDryRun();
  logger.info('');
  logger.info('══════════════════════════════════════════════════════════');
  logger.info(DRY_RUN ? '🗣️  COMMUNITY COMMENTER — DRY RUN' : '🗣️  COMMUNITY COMMENTER — LIVE');
  logger.info('══════════════════════════════════════════════════════════');

  await bhwSession.ensureAuthenticated();
  const page = bhwSession.getPage();

  let commented = 0;

  for (const forum of SCAN_FORUMS) {
    if (commented >= MAX_COMMENTS_PER_RUN) break;

    let threads;
    try {
      threads = await scrapeForumPage(page, forum.url);
    } catch (err) {
      logger.warn(`  Scan failed for ${forum.name}: ${err.message}`);
      continue;
    }

    for (const thread of threads) {
      if (commented >= MAX_COMMENTS_PER_RUN) break;

      // Skip threads we've already commented on
      if (await hasAlreadyCommented(thread.threadId).catch(() => false)) {
        logger.debug(`  Skip (already commented): ${thread.title}`);
        continue;
      }

      // Keyword pre-screen (free — no AI cost)
      if (!passesKeywordPreScreen(thread.title)) {
        logger.debug(`  Skip (keyword mismatch): ${thread.title}`);
        continue;
      }

      logger.info(`\n  📖 Reading: "${thread.title}"`);

      // Read the opening post
      let snippet = '';
      try {
        snippet = await scrapeOpeningPost(page, thread.url);
      } catch (err) {
        logger.warn(`  Could not read OP for "${thread.title}": ${err.message}`);
        continue;
      }

      if (!snippet || snippet.length < 30) {
        logger.info('  Skip — OP too short to assess.');
        continue;
      }

      // OpenClaw relevance classification
      let classification;
      try {
        classification = await aiEngine.classifyThreadRelevance(thread.title, snippet);
      } catch (err) {
        logger.warn(`  Relevance check failed: ${err.message}`);
        continue;
      }

      logger.info(`  Relevance: ${classification.relevanceScore}/10 [${classification.category}] — ${classification.reason}`);

      if (!classification.relevant || classification.relevanceScore < MIN_RELEVANCE_SCORE) {
        logger.info('  Skip — below relevance threshold.');
        await saveCommunityComment({
          threadId:       thread.threadId,
          threadUrl:      thread.url,
          threadTitle:    thread.title,
          category:       classification.category,
          relevanceScore: classification.relevanceScore,
          commentText:    null,
          commentUrl:     null,
          commentId:      null,
          dryRun:         true, // record with no comment so we don't re-classify it
        }).catch(() => {});
        continue;
      }

      // Select relevant tips from knowledge base
      const tips = selectRelevantTips(classification.category, `${thread.title} ${snippet}`);
      if (tips.length === 0) {
        logger.info(`  Skip — no matching tips in knowledge base for "${classification.category}".`);
        continue;
      }

      // Generate the helpful comment via OpenClaw
      let commentText;
      try {
        commentText = await aiEngine.generateCommunityComment(
          thread.title,
          snippet,
          tips,
          classification.category
        );
      } catch (err) {
        logger.warn(`  Comment generation failed: ${err.message}`);
        continue;
      }

      logger.info(`  ✍️  Generated (${commentText.length} chars):`);
      commentText.split('\n').forEach(l => logger.info(`     ${l}`));

      // Post the comment
      let postResult = { success: false, commentUrl: null, commentId: null };
      try {
        postResult = await postToThread(thread.url, commentText, { dryRun: DRY_RUN });
      } catch (err) {
        logger.error(`  Post failed: ${err.message}`);
        continue;
      }

      // Track in DB
      await saveCommunityComment({
        threadId:       thread.threadId,
        threadUrl:      thread.url,
        threadTitle:    thread.title,
        category:       classification.category,
        relevanceScore: classification.relevanceScore,
        commentText,
        commentUrl:     postResult.commentUrl,
        commentId:      postResult.commentId,
        dryRun:         DRY_RUN,
      }).catch(err => logger.warn('  DB save failed (non-fatal):', err.message));

      commented++;
      logger.info(`  ✅ Community comment ${commented}/${MAX_COMMENTS_PER_RUN} posted`);

      // Human pause between community comments — don't rush
      if (commented < MAX_COMMENTS_PER_RUN) {
        const waitMs  = BETWEEN_COMMENTS_MIN_MS + Math.random() * (BETWEEN_COMMENTS_MAX_MS - BETWEEN_COMMENTS_MIN_MS);
        const waitMin = Math.round(waitMs / 60000);
        logger.info(`  ⏳ Waiting ~${waitMin} min before next community comment…`);
        await sleep(waitMs);
      }
    }

    // Small pause between scanning different sub-forums
    await sleep(randomDelay(3000, 8000));
  }

  logger.info('');
  logger.info(`🗣️  Community commenter cycle complete — posted ${commented} comment(s)`);
  logger.info('══════════════════════════════════════════════════════════\n');
  return { commented };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOOP — runs on a slow, randomised interval so it looks organic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start the community commenter loop.
 * Runs a full scan every 4–6 hours (randomly re-randomised after each cycle).
 * Called once from src/index.js at startup.
 */
export function startCommunityCommenter(opts = {}) {
  const tick = async () => {
    try {
      await runCommunityCycle(opts);
    } catch (err) {
      logger.error('Community commenter tick error:', err.message);
    }

    // Re-randomise interval after every run
    const nextMs  = LOOP_MIN_MS + Math.random() * (LOOP_MAX_MS - LOOP_MIN_MS);
    const nextHr  = Math.round(nextMs / 3600000 * 10) / 10;
    logger.info(`🗣️  Community commenter: next scan in ~${nextHr}h`);
    setTimeout(tick, nextMs);
  };

  // First run: delay 30 minutes after startup so scraper/outreach gets priority
  const firstDelayMs = 30 * 60 * 1000;
  logger.info('🗣️  Community commenter started — first scan in 30 min');
  setTimeout(tick, firstDelayMs);
}

export default { runCommunityCycle, startCommunityCommenter };
