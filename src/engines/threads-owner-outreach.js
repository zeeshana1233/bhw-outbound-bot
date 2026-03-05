/**
 * Threads Owner Outreach Engine — Main Loop
 *
 * [THREADS-OWNER-OUTREACH] module
 *
 * Daily flow:
 *   1. Wait for the active window to open (15:00–07:00 UTC, ±30-min jitter)
 *   2. Pick 5 pending targets from outreach_targets (FIFO)
 *   3. Randomly scatter 5 send-times across the 16-hour window
 *      (min gap: 90 min, max gap: 4 hours between any two)
 *   4. For each target at its scheduled time:
 *      duplicate-check → scrape → generate DM → send → store → schedule follow-ups
 *   5. After all 5 sent → runOutreachFollowUps() + checkOutreachInbox()
 *   6. Sleep until the next day's window
 *
 * Session strategy: HYBRID — shares the singleton bhwSession (no second browser).
 * Session conflict prevention: yields to the existing queue via checkBusy retry.
 */

import logger                           from '../utils/logger.js';
import { sleep, randomDelay }           from '../utils/helpers.js';
import bhwSession                       from '../utils/bhwSession.js';
import aiEngine                         from '../services/aiEngine.js';
import alerts                           from '../services/alerts.js';
import { botState }                     from '../utils/botState.js';
import { config }                       from '../config/config.js';
import { getLeadByPosterUsername, logActivity } from '../database/queries.js';
import {
  getPendingOutreachTargets,
  getOutreachTargetByUsername,
  updateOutreachTargetScraped,
  skipOutreachTarget,
  markOutreachTargetDMSent,
  createOutreachConversation,
  updateOutreachConversationUrl,
  updateOutreachConversationStatus,
  incrementOutreachConversationMessages,
  createOutreachDM,
  createOutreachFollowUps,
}                                       from '../database/queries.js';
import { runOutreachFollowUps }         from './outreach-follow-up.js';
import { checkOutreachInbox }           from './outreach-inbox.js';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const ACTIVE_START_UTC     = config.outreach.activeStartUtc;   // 15 = 3pm UTC
const ACTIVE_END_UTC       = config.outreach.activeEndUtc;     // 7  = 7am UTC
const WINDOW_JITTER_MIN    = config.outreach.windowJitterMin;  // ±30 min
const MIN_GAP_MS           = config.outreach.minGapMinutes * 60 * 1000;  // 90 min
const MAX_GAP_MS           = 4 * 60 * 60 * 1000;              // 4 hours
const DAILY_CAP            = config.outreach.dailyCap;         // 5
const FOLLOW_UP_DAYS       = [
  config.outreach.followUp1Days,  // 3
  config.outreach.followUp2Days,  // 7
  config.outreach.followUp3Days,  // 14
];

const BHW_BASE = 'https://www.blackhatworld.com';

// ─────────────────────────────────────────────────────────────────────────────
// BROWSER HELPERS — mirrored from dm.js for consistency
// ─────────────────────────────────────────────────────────────────────────────

async function moveMouseAndClick(page, selector) {
  const element = await page.$(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  const box = await element.boundingBox();
  if (!box) throw new Error(`Could not get bounding box for: ${selector}`);
  const x = box.x + box.width  * (0.3 + Math.random() * 0.4);
  const y = box.y + box.height * (0.3 + Math.random() * 0.4);
  await page.mouse.move(x, y, { steps: randomDelay(8, 20) });
  await sleep(randomDelay(80, 200));
  await page.mouse.click(x, y);
  await sleep(randomDelay(200, 500));
}

async function smoothScrollToElement(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      const rect   = el.getBoundingClientRect();
      const scrollY = window.scrollY + rect.top - Math.floor(window.innerHeight * 0.35);
      window.scrollTo({ top: scrollY, behavior: 'smooth' });
    }
  }, selector);
  await sleep(randomDelay(600, 1200));
}

async function humanTypeInBrowser(page, text) {
  const TYPO_PROB = 0.03;
  const TYPO_MAP  = {
    a: 's', b: 'v', c: 'x', d: 's', e: 'w', f: 'g', g: 'h', h: 'j',
    i: 'u', j: 'k', k: 'l', l: 'k', m: 'n', n: 'm', o: 'p', p: 'o',
    q: 'w', r: 'e', s: 'a', t: 'r', u: 'y', v: 'b', w: 'e', x: 'z',
    y: 'u', z: 'x',
  };
  let wordCount   = 0;
  let nextPauseAt = randomDelay(8, 15);

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === ' ') {
      wordCount++;
      if (wordCount >= nextPauseAt) {
        await sleep(randomDelay(400, 900));
        wordCount   = 0;
        nextPauseAt = randomDelay(8, 15);
      }
    }
    if (
      TYPO_PROB > Math.random() &&
      char.toLowerCase() in TYPO_MAP &&
      char !== ' ' && char !== '\n'
    ) {
      await page.keyboard.type(TYPO_MAP[char.toLowerCase()]);
      await sleep(randomDelay(80, 180));
      await page.keyboard.press('Backspace');
      await sleep(randomDelay(100, 250));
    }
    await page.keyboard.type(char);
    await sleep(randomDelay(45, 140));
    if ('.!?,;:'.includes(char)) await sleep(randomDelay(150, 400));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCRAPE THREAD via bhwSession
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Navigate to a BHW thread and extract: poster_username, OP body text.
 * Returns { posterUsername, description } or null on failure.
 */
async function scrapeThread(threadUrl) {
  const page = bhwSession.page;
  if (!page) throw new Error('bhwSession page not available');

  await bhwSession.navigateTo(threadUrl);
  await sleep(randomDelay(1500, 3000));

  try {
    // OP body — first post on the page
    const description = await page.evaluate(() => {
      const opBody = document.querySelector(
        '.message-body .bbWrapper, .message-content .bbWrapper, .message-body'
      );
      return opBody ? opBody.innerText.trim() : null;
    });

    // Poster username — from the first post author block
    const posterUsername = await page.evaluate(() => {
      const authorEl = document.querySelector(
        '.message-name a.username, .message-userDetails .username, h4.message-name a'
      );
      return authorEl ? authorEl.textContent.trim() : null;
    });

    return { description: description || null, posterUsername: posterUsername || null };
  } catch (err) {
    logger.warn(`[THREADS-OWNER-OUTREACH] Scrape parse error on ${threadUrl}: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND DM via bhwSession — mirrors dm.js flow exactly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Navigate to BHW Start Conversation page and send the DM.
 * Returns { success, conversationUrl } or { success: false, error }.
 */
async function sendOutreachDM(posterUsername, subject, dmText, dryRun = false) {
  const url  = `${BHW_BASE}/conversations/add?to=${encodeURIComponent(posterUsername)}`;
  const page = bhwSession.page;

  if (dryRun) {
    logger.info(`  [DRY RUN] Would send DM to @${posterUsername}`);
    logger.info(`  [DRY RUN] Subject: ${subject}`);
    logger.info(`  [DRY RUN] Body (${dmText.length} chars): ${dmText.slice(0, 80)}...`);
    return { success: true, conversationUrl: null, dryRun: true };
  }

  try {
    await bhwSession.navigateTo(url);
    await sleep(randomDelay(1500, 3000));

    // Fill subject
    const subjectSelector = 'input[name="title"]';
    await smoothScrollToElement(page, subjectSelector);
    await moveMouseAndClick(page, subjectSelector);
    await sleep(randomDelay(300, 700));
    await humanTypeInBrowser(page, subject.slice(0, 60));

    // Fill body (Froala editor)
    const bodySelector = '.fr-element[contenteditable="true"]';
    await smoothScrollToElement(page, bodySelector);
    await moveMouseAndClick(page, bodySelector);
    await sleep(randomDelay(300, 700));
    await humanTypeInBrowser(page, dmText);

    // Pre-submit review pause
    await sleep(randomDelay(1800, 4500));

    // Click Send
    const submitSelectors = [
      'button.button--primary[type="submit"]',
      'button[type="submit"]',
      'input[type="submit"]',
    ];
    let submitted = false;
    for (const sel of submitSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        await smoothScrollToElement(page, sel);
        await moveMouseAndClick(page, sel);
        submitted = true;
        break;
      }
    }
    if (!submitted) throw new Error('Could not find submit button');

    // Wait for redirect to /conversations/ID/
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await sleep(randomDelay(1000, 2500));

    const finalUrl = page.url();
    const isConvUrl = finalUrl.includes('/conversations/');
    if (!isConvUrl) {
      logger.warn(`[THREADS-OWNER-OUTREACH] DM redirect unexpected: ${finalUrl}`);
    }

    return { success: true, conversationUrl: isConvUrl ? finalUrl : null };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-TARGET FLOW — Steps 1–9 from the dev plan
// ─────────────────────────────────────────────────────────────────────────────

async function processOutreachTarget(target, dryRun = false) {
  const tag = '[THREADS-OWNER-OUTREACH]';
  logger.info(`\n${tag} Processing target #${target.id}: "${(target.title || target.thread_url).slice(0, 60)}"`);

  // ── Step 1a: Duplicate check (if username already known) ─────────────────
  if (target.poster_username) {
    // Within-module check
    if (target.status !== 'pending') {
      logger.info(`${tag} ⏭ Already processed (status=${target.status}) — skipping`);
      return false;
    }

    // Cross-module check: has main pipeline already DM'd this user?
    const mainLead = await getLeadByPosterUsername(target.poster_username).catch(() => null);
    if (mainLead && mainLead.dm_sent) {
      await skipOutreachTarget(target.id, 'already_contacted_main_pipeline');
      logger.info(`${tag} ⏭ @${target.poster_username} already contacted by main pipeline — skip`);
      await alerts.sendRawAlert(
        `${tag} Skipped ⏭\n@${target.poster_username} — already_contacted_main_pipeline`
      ).catch(() => {});
      return false;
    }
  }

  // ── Step 2: Scrape thread ────────────────────────────────────────────────
  await bhwSession.ensureAuthenticated();
  let scrapeData = null;
  let scrapeAttempts = 0;
  while (scrapeAttempts < 3) {
    scrapeAttempts++;
    try {
      scrapeData = await scrapeThread(target.thread_url);
      if (scrapeData) break;
    } catch (err) {
      logger.warn(`${tag} Scrape attempt ${scrapeAttempts} failed: ${err.message}`);
      if (scrapeAttempts < 3) await sleep(randomDelay(5000, 12000));
    }
  }

  if (!scrapeData) {
    await skipOutreachTarget(target.id, 'scrape_failed');
    logger.warn(`${tag} Scrape failed after 3 attempts — skipping target #${target.id}`);
    return false;
  }

  // Save scraped data
  await updateOutreachTargetScraped(target.id, {
    description:    scrapeData.description,
    posterUsername: scrapeData.posterUsername,
  });

  const posterUsername = target.poster_username || scrapeData.posterUsername;

  if (!posterUsername) {
    await skipOutreachTarget(target.id, 'no_username');
    logger.warn(`${tag} Could not find poster_username — skipping target #${target.id}`);
    return false;
  }

  // ── Step 1b: Re-run duplicate check now that we have the username ─────────
  const existingOutreach = await getOutreachTargetByUsername(posterUsername).catch(() => null);
  if (
    existingOutreach &&
    existingOutreach.id !== target.id &&
    ['dm_sent', 'replied', 'cold', 'skip'].includes(existingOutreach.status)
  ) {
    await skipOutreachTarget(target.id, 'already_contacted_outreach');
    logger.info(`${tag} ⏭ @${posterUsername} already handled in another outreach target row — skip`);
    return false;
  }

  const mainLead2 = await getLeadByPosterUsername(posterUsername).catch(() => null);
  if (mainLead2 && mainLead2.dm_sent) {
    await skipOutreachTarget(target.id, 'already_contacted_main_pipeline');
    logger.info(`${tag} ⏭ @${posterUsername} already DM'd by main pipeline — skip`);
    await alerts.sendRawAlert(
      `${tag} Skipped ⏭\n@${posterUsername} — already_contacted_main_pipeline`
    ).catch(() => {});
    return false;
  }

  // ── Step 3: Generate DM + follow-ups (single API call) ─────────────────
  const title       = target.title || '(untitled)';
  const description = scrapeData.description || target.description || '';

  logger.info(`${tag} Generating DM + follow-ups for @${posterUsername}…`);
  const generated = await aiEngine.generateThreadsOwnerOutreachDMAndFollowUps(title, description, posterUsername);
  const dmText    = generated.dmText;

  if (!dmText || dmText.trim().length < 20) {
    logger.warn(`${tag} AI returned empty/short DM — skipping target #${target.id}`);
    return false;
  }

  // ── Step 4: Send DM ──────────────────────────────────────────────────────
  const subject   = `Re: ${title}`.slice(0, 60);
  const sendResult = await sendOutreachDM(posterUsername, subject, dmText, dryRun);

  if (!sendResult.success) {
    logger.error(`${tag} DM send failed for @${posterUsername}: ${sendResult.error}`);
    return false;
  }

  // ── Step 5: Store in DB ──────────────────────────────────────────────────
  const conv = await createOutreachConversation(target.id);
  await createOutreachDM({
    targetId:       target.id,
    conversationId: conv.id,
    direction:      'outbound',
    messageText:    dmText,
    messageType:    'initial_pitch',
  });
  await incrementOutreachConversationMessages(conv.id, 'outbound');
  await updateOutreachConversationStatus(conv.id, 'waiting_reply', 'us');

  if (sendResult.conversationUrl) {
    await updateOutreachConversationUrl(conv.id, sendResult.conversationUrl);
  }

  // ── Step 6: Update target ────────────────────────────────────────────────
  await markOutreachTargetDMSent(target.id);
  const contactedAt = new Date();

  // ── Step 7: Save pre-generated follow-ups (already in memory from Step 3) ─
  const followUps = {
    followUp1: generated.followUp1,
    followUp2: generated.followUp2,
    followUp3: generated.followUp3,
  };
  await createOutreachFollowUps(
    target.id,
    conv.id,
    followUps,
    contactedAt,
    FOLLOW_UP_DAYS
  );

  // ── Step 8: Log activity ─────────────────────────────────────────────────
  await logActivity({
    action_type: 'threads_owner_outreach_dm_sent',
    lead_id:     null,
    metadata:    JSON.stringify({
      target_id:       target.id,
      poster_username: posterUsername,
      thread_url:      target.thread_url,
      conversation_id: conv.id,
      dry_run:         dryRun,
    }),
  }).catch(() => {});

  // ── Step 9: WhatsApp alert ───────────────────────────────────────────────
  await alerts.sendRawAlert(
    `${tag} DM sent ✅\n` +
    `To: @${posterUsername}\n` +
    `Thread: "${title.slice(0, 80)}"\n` +
    `Follow-ups: Day ${FOLLOW_UP_DAYS[0]} / Day ${FOLLOW_UP_DAYS[1]} / Day ${FOLLOW_UP_DAYS[2]} scheduled` +
    (dryRun ? '\n⚠️ DRY RUN — nothing actually sent' : '')
  ).catch(() => {});

  logger.info(`${tag} ✅ Done — @${posterUsername} | DM sent | 3 follow-ups scheduled`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// WINDOW TIMING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns milliseconds until the next active window opens.
 * Active window: ACTIVE_START_UTC → ACTIVE_END_UTC (wraps midnight).
 * Adds random jitter of ±WINDOW_JITTER_MIN minutes.
 */
function msUntilNextActiveWindow() {
  const now      = new Date();
  const nowUtcH  = now.getUTCHours() + now.getUTCMinutes() / 60;
  const jitterMs = (Math.random() * 2 - 1) * WINDOW_JITTER_MIN * 60 * 1000; // ±jitter

  // Active window: 15:00 → 07:00 UTC (crosses midnight)
  // We're "inside" the window if hour >= START or hour < END
  const inWindow = (nowUtcH >= ACTIVE_START_UTC) || (nowUtcH < ACTIVE_END_UTC);

  if (inWindow) return Math.max(0, jitterMs); // start now (+ jitter)

  // We're in the sleep window. Calculate time until ACTIVE_START_UTC today or tomorrow.
  const nextStart = new Date(now);
  nextStart.setUTCHours(ACTIVE_START_UTC, 0, 0, 0);
  if (nextStart <= now) nextStart.setUTCDate(nextStart.getUTCDate() + 1);

  return (nextStart - now) + jitterMs;
}

/**
 * Returns milliseconds until the active window CLOSES.
 * (i.e. until ACTIVE_END_UTC tomorrow UTC)
 */
function msUntilWindowClose() {
  const now     = new Date();
  const nextEnd = new Date(now);
  nextEnd.setUTCHours(ACTIVE_END_UTC, 0, 0, 0);
  if (nextEnd <= now) nextEnd.setUTCDate(nextEnd.getUTCDate() + 1);
  return nextEnd - now;
}

/**
 * Scatter N send-times randomly across the active window.
 * Constraints: min gap = MIN_GAP_MS, max gap = MAX_GAP_MS.
 * Returns array of Date objects sorted ascending.
 */
function scatterSendTimes(count, windowMs) {
  const times = [];
  let cursor  = 0;

  for (let i = 0; i < count; i++) {
    const remaining = windowMs - cursor - (count - i - 1) * MIN_GAP_MS;
    const maxStep   = Math.min(MAX_GAP_MS, remaining);
    const step      = MIN_GAP_MS + Math.floor(Math.random() * Math.max(0, maxStep - MIN_GAP_MS));
    cursor += step;
    times.push(cursor);
  }

  const now = Date.now();
  return times.map(ms => new Date(now + ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT — startThreadsOwnerOutreach()
// ─────────────────────────────────────────────────────────────────────────────

export async function startThreadsOwnerOutreach(opts = {}) {
  const dryRun = opts.dryRun    !== undefined ? opts.dryRun : (process.env.DRY_RUN !== 'false');
  const tag    = '[THREADS-OWNER-OUTREACH]';

  if (!config.outreach.enabled) {
    logger.info(`${tag} Disabled (OUTREACH_ENABLED != true) — not starting.`);
    return;
  }

  logger.info(`${tag} Starting… [${dryRun ? 'DRY RUN' : '🔴 LIVE'}]`);

  const cycle = async () => {
    // ── Wait for active window ──────────────────────────────────────────────
    const waitMs  = msUntilNextActiveWindow();
    const waitMin = Math.round(waitMs / 60000);
    logger.info(`${tag} Next active window in ~${waitMin} min`);
    await sleep(waitMs);

    if (botState.isPaused()) {
      logger.info(`${tag} Bot paused — skipping cycle`);
      setTimeout(cycle, 60 * 60 * 1000);
      return;
    }

    // ── Pick 5 targets ──────────────────────────────────────────────────────
    const targets = await getPendingOutreachTargets(DAILY_CAP);
    if (targets.length === 0) {
      logger.info(`${tag} No pending targets — sleeping 6 hours`);
      setTimeout(cycle, 6 * 60 * 60 * 1000);
      return;
    }

    logger.info(`${tag} ${targets.length} target(s) picked for today's batch`);

    // ── Scatter send-times across the active window ─────────────────────────
    const windowMs   = msUntilWindowClose();
    const sendTimes  = scatterSendTimes(targets.length, windowMs);

    logger.info(`${tag} Send schedule for this batch:`);
    sendTimes.forEach((t, i) => {
      logger.info(`  ${i + 1}. ${t.toISOString()} — @${targets[i].poster_username || `target#${targets[i].id}`}`);
    });

    // ── Fire each DM at its scheduled time ──────────────────────────────────
    for (let i = 0; i < targets.length; i++) {
      const target    = targets[i];
      const sendAt    = sendTimes[i];
      const nowMs     = Date.now();
      const delayMs   = Math.max(0, sendAt - nowMs);
      const delayMin  = Math.round(delayMs / 60000);

      logger.info(`${tag} Sleeping ~${delayMin} min until DM #${i + 1}…`);
      await sleep(delayMs);

      if (botState.isPaused()) {
        logger.info(`${tag} Bot paused mid-batch — stopping for today`);
        break;
      }

      try {
        await processOutreachTarget(target, dryRun);
      } catch (err) {
        logger.error(`${tag} Error on target #${target.id}: ${err.message}`);
      }

      // ── After every DM: check inbox → send 1 follow-up ──────────────────
      logger.info(`${tag} DM #${i + 1} done — checking inbox…`);
      try { await checkOutreachInbox({ dryRun });              } catch (e) { logger.error(`${tag} Inbox error: ${e.message}`); }
      logger.info(`${tag} Sending 1 pending follow-up (if due)…`);
      try { await runOutreachFollowUps({ dryRun, limit: 1 }); } catch (e) { logger.error(`${tag} Follow-up error: ${e.message}`); }
    }

    // ── Final safety sweep: catch any remaining due follow-ups ──────────────
    // (handles edge case where more follow-ups are due than DMs sent today)
    logger.info(`${tag} Batch complete — final follow-up sweep…`);
    try { await runOutreachFollowUps({ dryRun }); } catch (e) { logger.error(`${tag} Final follow-up sweep error: ${e.message}`); }

    // ── Schedule next cycle ─────────────────────────────────────────────────
    const nextWaitMs  = msUntilNextActiveWindow();
    const nextWaitHrs = Math.round(nextWaitMs / 1000 / 60 / 60 * 10) / 10;
    logger.info(`${tag} Next cycle in ~${nextWaitHrs}h`);
    setTimeout(cycle, nextWaitMs);
  };

  // Kick off immediately — cycle() handles its own window-wait
  cycle().catch(err => {
    logger.error(`${tag} Unhandled cycle error: ${err.message}`);
    // Retry after 1h on unexpected crash
    setTimeout(() => startThreadsOwnerOutreach(opts), 60 * 60 * 1000);
  });
}
