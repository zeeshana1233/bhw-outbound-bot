/**
 * Pipeline D — Niche Comment Scout
 *
 * After Hire-a-Freelancer scrape:
 *   1. Scrape BHW What's New listing (anonymous shared browser)
 *   2. Keep posts from today only
 *   3. Drop marketplace URLs
 *   4. Dedup against niche_scout_posts
 *   5. Scrape title + OP body
 *   6. Classify via Relay chatgpt (user-supplied prompt)
 *   7. Persist + Discord notify sales (fit/maybe only)
 *
 * Never posts comments on BHW.
 */

import * as cheerio from 'cheerio';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';
import { BHWScraper } from '../scraper/index.js';
import { extractThreadId, sleep, randomDelay } from '../utils/helpers.js';
import {
  getExistingNicheScoutThreadIds,
  createNicheScoutPost,
  markNicheScoutDiscordSent,
  getPendingNicheScoutDiscordSends,
  logActivity,
} from '../database/queries.js';
import relayClient from '../services/relayClient.js';
import { buildNicheScoutFullPrompt } from '../prompts/nicheScoutPrompt.js';
import { sendNicheScoutAlert } from '../services/alerts.js';
import { botState } from '../utils/botState.js';

const CHUNK_SIZE = 5;

function isMarketplaceUrl(url) {
  return /\/marketplace\//i.test(url || '');
}

function stripJsonFences(text) {
  if (!text) return '';
  let s = String(text).trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  return s.trim();
}

/**
 * GPT sometimes inserts raw newlines inside JSON string values (esp. URLs).
 * Collapse those so JSON.parse succeeds.
 */
function sanitizeJsonText(text) {
  let s = String(text || '');
  // Replace raw control chars that appear outside of escaped sequences
  // by normalizing whitespace inside the payload before parse.
  s = s.replace(/\r\n/g, '\n');
  // Fix broken string literals: newline inside a quoted value → space
  s = s.replace(/"([^"\\]|\\.)*"/g, (m) =>
    m.replace(/[\n\r\t]/g, (ch) => (ch === '\t' ? '\\t' : ' '))
  );
  return s;
}

function parseClassificationArray(rawText) {
  const stripped = sanitizeJsonText(stripJsonFences(rawText));
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.results)) return parsed.results;
    if (parsed && Array.isArray(parsed.posts)) return parsed.posts;
  } catch (_) {
    const match = stripped.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(sanitizeJsonText(match[0]));
        if (Array.isArray(parsed)) return parsed;
      } catch (__) {}
    }
  }
  throw new Error(`NicheScout: could not parse JSON array from Relay response: ${stripped.slice(0, 200)}`);
}

function normalizeVerdict(v) {
  const s = String(v || '').toLowerCase().trim();
  if (s === 'fit' || s === 'maybe' || s === 'skip') return s;
  if (s === 'yes' || s === 'good' || s === 'match') return 'fit';
  if (s === 'no' || s === 'none' || s === 'reject') return 'skip';
  return 'skip';
}

/**
 * Parse What's New listing HTML into thread cards.
 */
function parseWhatsNewListing(html, scraper) {
  const $ = cheerio.load(html);
  let cards = $('div.structItem--thread').toArray();
  if (cards.length === 0) {
    cards = $('div.structItem').toArray();
  }

  const items = [];
  for (const el of cards) {
    const card = $(el);

    const titleTag = card.find('.structItem-title a:not(.labelLink)').first();
    if (titleTag.length === 0) continue;

    const threadPath = titleTag.attr('href') || '';
    if (!threadPath) continue;

    const fullUrl = threadPath.startsWith('http')
      ? threadPath
      : `https://www.blackhatworld.com${threadPath}`;

    const threadId = extractThreadId(fullUrl);
    if (!threadId) continue;

    const title = scraper.cleanText(titleTag.text().trim());

    const authorTag = card.find(
      '.structItem-minor .username, .structItem-parts .username, ' +
      '.structItem-cell--user .username, a.username, ' +
      '.structItem-minor a[href*="/members/"]'
    ).first();
    let author = authorTag.length > 0 ? scraper.cleanText(authorTag.text().trim()) : null;
    if (!author && authorTag.length > 0) {
      const href = authorTag.attr('href') || '';
      const match = href.match(/\/members\/([^\/\.]+)/);
      if (match) author = match[1];
    }

    const postedTimeTag = card.find(
      '.structItem-startDate time.u-dt, .structItem-cell--main time.u-dt, ' +
      '.structItem-minor time, time'
    ).first();
    const datetimeAttr =
      postedTimeTag.attr('datetime')
      || postedTimeTag.attr('data-datetime')
      || postedTimeTag.attr('title');
    const postedAt = scraper.parseTime(datetimeAttr);

    items.push({
      threadId: String(threadId),
      url: fullUrl.split('?')[0],
      title,
      author,
      postedAt,
    });
  }

  // Dedup by threadId within the listing itself
  const seen = new Set();
  return items.filter((it) => {
    if (seen.has(it.threadId)) return false;
    seen.add(it.threadId);
    return true;
  });
}

/**
 * Classify a batch of posts via Relay chatgpt. Chunks by CHUNK_SIZE.
 * @returns {Map<string, object>} url → classification
 */
async function classifyPosts(posts) {
  const byUrl = new Map();
  if (!posts.length) return byUrl;

  for (let i = 0; i < posts.length; i += CHUNK_SIZE) {
    const chunk = posts.slice(i, i + CHUNK_SIZE);
    const prompt = buildNicheScoutFullPrompt(chunk.map((p) => ({
      url: p.url,
      title: p.title,
      body: p.body,
      posterUsername: p.posterUsername,
    })));

    logger.info(`[NicheScout] Classifying chunk ${Math.floor(i / CHUNK_SIZE) + 1} (${chunk.length} posts) via Relay…`);

    const result = await relayClient.run({
      prompt,
      serviceId: config.relay.serviceId || 'chatgpt',
      timeout: 300,
    });

    const text = relayClient.extractText(result);
    const arr = parseClassificationArray(text);

    for (const row of arr) {
      const url = (row.url || row.thread_url || '').trim();
      if (!url) continue;
      byUrl.set(url, {
        niche: row.niche || row.category || null,
        verdict: normalizeVerdict(row.verdict || row.status),
        commentAngle: row.comment_angle || row.commentAngle || row.angle || null,
        raw: row,
      });
    }

    // Also try matching by thread_id if URL mismatch
    for (const p of chunk) {
      if (byUrl.has(p.url)) continue;
      const match = arr.find((r) => {
        const u = (r.url || r.thread_url || '').trim();
        return u && (u === p.url || u.includes(p.threadId) || p.url.includes(extractThreadId(u) || '___'));
      });
      if (match) {
        byUrl.set(p.url, {
          niche: match.niche || match.category || null,
          verdict: normalizeVerdict(match.verdict || match.status),
          commentAngle: match.comment_angle || match.commentAngle || match.angle || null,
          raw: match,
        });
      }
    }
  }

  return byUrl;
}

/**
 * One full Niche Scout run.
 */
export async function runNicheScout() {
  if (!config.nicheScout?.enabled) {
    logger.debug('[NicheScout] Disabled (NICHE_SCOUT_ENABLED≠true) — skipping');
    return { skipped: true, reason: 'disabled' };
  }

  if (botState.isPaused()) {
    logger.info('[NicheScout] Bot paused — skipping');
    return { skipped: true, reason: 'paused' };
  }

  if (!config.relay.apiKey || !config.relay.baseUrl) {
    logger.warn('[NicheScout] RELAY_API_KEY / RELAY_BASE_URL missing — skipping');
    return { skipped: true, reason: 'relay_config' };
  }

  const scraper = new BHWScraper();
  const summary = {
    listed: 0,
    today: 0,
    marketplaceDropped: 0,
    alreadySeen: 0,
    bodiesFetched: 0,
    classified: 0,
    discordSent: 0,
    cloudflareBlocked: false,
  };

  try {
    await scraper.initBrowser();

    // Retry any prior Discord failures first (cheap)
    await retryPendingDiscordSends().catch((err) =>
      logger.warn(`[NicheScout] Discord retry sweep failed: ${err.message}`)
    );

    const listUrl = config.nicheScout.whatsNewUrl;
    logger.info(`[NicheScout] Fetching What's New: ${listUrl}`);

    let listingHtml = await scraper.fetchPageWithRetries(listUrl, 1, { waitForThreads: true });
    if (!listingHtml || scraper.cloudflareBlocked) {
      // Retry once without strict thread-card wait (What's New markup can differ)
      scraper.cloudflareBlocked = false;
      listingHtml = await scraper.fetchPageWithRetries(listUrl, 1, { waitForThreads: false });
      if (!listingHtml || scraper.cloudflareBlocked) {
        summary.cloudflareBlocked = true;
        logger.warn('[NicheScout] Cloudflare / empty listing — aborting run');
        return summary;
      }
    }

    let items = parseWhatsNewListing(listingHtml, scraper);
    summary.listed = items.length;
    logger.info(`[NicheScout] Listed ${items.length} thread cards`);

    // Today only
    const todayItems = items.filter((it) => it.postedAt && scraper.isToday(it.postedAt));
    summary.today = todayItems.length;
    logger.info(`[NicheScout] Today-only: ${todayItems.length}`);

    // Drop marketplace
    items = todayItems.filter((it) => {
      if (isMarketplaceUrl(it.url)) {
        summary.marketplaceDropped++;
        return false;
      }
      return true;
    });

    if (items.length === 0) {
      logger.info('[NicheScout] No new today/non-marketplace posts this run');
      return summary;
    }

    // DB dedup
    const ids = items.map((it) => it.threadId);
    const existing = new Set(await getExistingNicheScoutThreadIds(ids));
    items = items.filter((it) => {
      if (existing.has(it.threadId)) {
        summary.alreadySeen++;
        return false;
      }
      return true;
    });

    if (items.length === 0) {
      logger.info(`[NicheScout] All today posts already seen (${summary.alreadySeen} deduped)`);
      return summary;
    }

    // Cap per run
    const maxPerRun = config.nicheScout.maxPerRun || 25;
    if (items.length > maxPerRun) {
      logger.info(`[NicheScout] Capping ${items.length} → ${maxPerRun} bodies this run`);
      items = items.slice(0, maxPerRun);
    }

    // Body scrape
    const withBodies = [];
    for (const it of items) {
      await sleep(randomDelay(800, 2000));
      const { description, authorUsername } = await scraper.getThreadDescription(it.url, it.threadId);
      withBodies.push({
        ...it,
        body: description,
        posterUsername: authorUsername || it.author || null,
      });
      summary.bodiesFetched++;
    }

    // Classify
    let classifications;
    try {
      classifications = await classifyPosts(withBodies);
    } catch (err) {
      logger.error(`[NicheScout] Classification failed: ${err.message}`);
      await logActivity({
        actionType: 'niche_scout_error',
        description: `Relay classify failed: ${err.message}`,
        status: 'failed',
        errorMessage: err.message,
      }).catch(() => {});
      return summary;
    }

    // Persist + Discord
    for (const post of withBodies) {
      const c = classifications.get(post.url) || {
        niche: null,
        verdict: 'skip',
        commentAngle: null,
        raw: null,
      };

      const row = await createNicheScoutPost({
        threadId: post.threadId,
        threadUrl: post.url,
        title: post.title,
        posterUsername: post.posterUsername,
        body: post.body,
        postedAt: post.postedAt,
        niche: c.niche,
        verdict: c.verdict,
        commentAngle: c.commentAngle,
        rawAiResponse: c.raw,
      });

      summary.classified++;

      if (!row) continue;

      if (row.discord_sent) continue;

      if (c.verdict === 'fit' || c.verdict === 'maybe') {
        try {
          await sendNicheScoutAlert({
            title: post.title,
            url: post.url,
            posterUsername: post.posterUsername,
            niche: c.niche,
            verdict: c.verdict,
            angle: c.commentAngle,
            postedAt: post.postedAt,
          });
          await markNicheScoutDiscordSent(row.id);
          summary.discordSent++;
        } catch (err) {
          logger.warn(`[NicheScout] Discord send failed for ${post.threadId}: ${err.message}`);
        }
      }
    }

    await logActivity({
      actionType: 'niche_scout_run',
      description: `NicheScout: listed=${summary.listed} today=${summary.today} sent=${summary.discordSent}`,
      status: 'success',
      metadata: summary,
    }).catch(() => {});

    logger.info(
      `[NicheScout] Done — listed=${summary.listed} today=${summary.today} ` +
      `mktDrop=${summary.marketplaceDropped} seen=${summary.alreadySeen} ` +
      `bodies=${summary.bodiesFetched} classified=${summary.classified} discord=${summary.discordSent}`
    );

    return summary;
  } catch (err) {
    logger.error(`[NicheScout] Run failed: ${err.message}`);
    await logActivity({
      actionType: 'niche_scout_error',
      description: err.message,
      status: 'failed',
      errorMessage: err.message,
    }).catch(() => {});
    throw err;
  } finally {
    await scraper.closeBrowser({ discardShared: false });
  }
}

async function retryPendingDiscordSends() {
  const pending = await getPendingNicheScoutDiscordSends(10);
  for (const row of pending) {
    try {
      await sendNicheScoutAlert({
        title: row.title,
        url: row.thread_url,
        posterUsername: row.poster_username,
        niche: row.niche,
        verdict: row.verdict,
        angle: row.comment_angle,
        postedAt: row.posted_at,
      });
      await markNicheScoutDiscordSent(row.id);
      logger.info(`[NicheScout] Retried Discord send for thread ${row.thread_id}`);
    } catch (err) {
      logger.warn(`[NicheScout] Retry Discord failed for ${row.thread_id}: ${err.message}`);
    }
  }
}

export default { runNicheScout };
