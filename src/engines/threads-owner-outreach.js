/**
 * Threads Owner Outreach Engine — Main Loop
 *
 * [THREADS-OWNER-OUTREACH] module
 *
 * Daily flow:
 *   1. Send up to 5 DMs per day, randomly spread across the full 24 hours
 *      (min gap: 90 min between any two DMs)
 *   2. For each target:
 *      duplicate-check → scrape → generate DM → send → store → schedule follow-ups
 *   3. After all DMs sent → runOutreachFollowUps() + checkOutreachInbox()
 *   4. Sleep ~24 hours, then repeat
 *
 * Session strategy: HYBRID — shares the singleton bhwSession (no second browser).
 * Session conflict prevention: yields to the existing queue via checkBusy retry.
 */

import logger                           from '../utils/logger.js';
import { sleep, randomDelay, sanitizeBHWMessage } from '../utils/helpers.js';
import bhwSession                       from '../utils/bhwSession.js';
import aiEngine                         from '../services/aiEngine.js';
import alerts                           from '../services/alerts.js';
import { botState }                     from '../utils/botState.js';
import { config }                       from '../config/config.js';
import { getLeadByPosterUsername, logActivity, getOutreachProgress, getDueOutreachFollowUps } from '../database/queries.js';
import {
  getPendingOutreachTargets,
  getOutreachTargetByUsername,
  updateOutreachTargetScraped,
  skipOutreachTarget,
  markOutreachTargetDMSent,
  markOutreachTargetPreviewed,
  createOutreachConversation,
  updateOutreachConversationUrl,
  updateOutreachConversationStatus,
  incrementOutreachConversationMessages,
  createOutreachDM,
  createOutreachFollowUps,
}                                       from '../database/queries.js';
import { runOutreachFollowUps }         from './outreach-follow-up.js';
import { checkOutreachInbox }           from './outreach-inbox.js';
import { query as dbQuery }             from '../database/init.js';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const MIN_GAP_MS           = config.outreach.minGapMinutes * 60 * 1000;  // 90 min
const MAX_GAP_MS           = 2 * 60 * 60 * 1000;              // 2 hours
const DAILY_CAP            = config.outreach.dailyCap;         // 5
const TEST_MODE            = process.env.OUTREACH_TEST_MODE === 'true'; // bypass timing gates
const PREVIEW_MODE         = config.outreach.previewMode;      // WA-only: no BHW send, rotate targets
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
  // Retry up to 3 times — boundingBox can return null briefly after scroll reflow
  let box = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const element = await page.$(selector);
    if (!element) throw new Error(`Element not found: ${selector}`);
    box = await element.boundingBox();
    if (box) break;
    if (attempt < 3) await sleep(randomDelay(400, 800));
  }
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
      // scrollIntoView is synchronous and guarantees the element is in the viewport
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, selector);
  // Wait for any layout reflow after scroll
  await sleep(randomDelay(800, 1400));
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
      // Use keyboard.down + keyboard.up to avoid stuck key state with press()
      await page.keyboard.down('Backspace');
      await sleep(randomDelay(30, 80));
      await page.keyboard.up('Backspace');
      await sleep(randomDelay(100, 250));
    }
    await page.keyboard.type(char);
    await sleep(randomDelay(45, 140));
    if ('.!?,;:'.includes(char)) await sleep(randomDelay(150, 400));
  }
  // Release any potentially stuck modifier keys after typing
  await page.keyboard.up('Shift').catch(() => {});
  await page.keyboard.up('Control').catch(() => {});
  await page.keyboard.up('Alt').catch(() => {});
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

  // Detect Cloudflare / BHW error pages — throw so the retry loop catches it
  const pageTitle = await page.title().catch(() => '');
  if (pageTitle.toLowerCase().includes('oops') || pageTitle.toLowerCase().includes('error')) {
    throw new Error(`BHW error page detected: "${pageTitle}" — may be a temporary Cloudflare block`);
  }

  try {
    // OP body — first post on the page
    const description = await page.evaluate(() => {
      const opBody = document.querySelector(
        '.message-body .bbWrapper, .message-content .bbWrapper, .message-body'
      );
      return opBody ? opBody.innerText.trim() : null;
    });

    // Poster username — from the first post author block.
    // BHW stores the canonical DM-resolvable username in the data-username attribute
    // on the post wrapper or the author link. Text content / href slugs can differ
    // (display name with spaces, or lowercase hyphenated slug) and won't resolve.
    const posterUsername = await page.evaluate(() => {
      // 1. data-author on the first post's article/li wrapper (most reliable)
      const postEl = document.querySelector(
        'article.message[data-author], li.message[data-author], .message[data-author]'
      );
      if (postEl) {
        const author = postEl.getAttribute('data-author');
        if (author && author.trim() && !author.includes(' ')) return author.trim();
      }

      // 2. data-username on the author link itself
      const authorEl = document.querySelector(
        '.message-name a.username, .message-userDetails .username, h4.message-name a'
      );
      if (authorEl) {
        const dataUsername = authorEl.getAttribute('data-username');
        if (dataUsername && dataUsername.trim() && !dataUsername.includes(' ')) return dataUsername.trim();

        // 3. Extract username from profile href: /members/username.12345/ → username
        const href = authorEl.getAttribute('href') || '';
        const hrefMatch = href.match(/\/members\/([^./]+)\.\d+\/?/);
        if (hrefMatch && hrefMatch[1]) return hrefMatch[1].trim();

        // 4. text content — last resort (may be display name, caught by spaces guard downstream)
        return authorEl.textContent.trim() || null;
      }

      return null;
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

    // Detect BHW error page — user account may be banned/restricted from receiving DMs
    const dmPageTitle = await page.title().catch(() => '');
    if (dmPageTitle.toLowerCase().includes('oops') || dmPageTitle.toLowerCase().includes('error')) {
      throw new Error(`BHW_ACCOUNT_RESTRICTED: "${dmPageTitle}" — user may not be able to receive DMs`);
    }

    // ── Fill subject ─────────────────────────────────────────────────────────
    const subjectSelector = 'input[name="title"]';
    await smoothScrollToElement(page, subjectSelector);
    await moveMouseAndClick(page, subjectSelector);
    await sleep(randomDelay(300, 700));
    await humanTypeInBrowser(page, subject.slice(0, 60));

    // ── Locate Froala body editor ────────────────────────────────────────────
    const EDITOR_SELECTORS = [
      '.fr-element[contenteditable="true"]',
      'div[data-placeholder][contenteditable="true"]',
      'textarea[name="message"]',
      '#ctrl_message',
    ];
    let bodySelector = null;
    for (const sel of EDITOR_SELECTORS) {
      const found = await page.$(sel);
      if (found) { bodySelector = sel; break; }
    }
    if (!bodySelector) {
      // Scroll to bottom and try again
      await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight }));
      await sleep(1500);
      for (const sel of EDITOR_SELECTORS) {
        const found = await page.$(sel);
        if (found) { bodySelector = sel; break; }
      }
    }
    if (!bodySelector) throw new Error('Could not locate message editor');

    // ── Activate Froala editor (mirrors dm.js Step 6) ────────────────────────
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus();
      ['mouseenter', 'mousedown', 'mouseup', 'click'].forEach(type =>
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
      );
      el.innerHTML = '<p><br></p>';
      el.dispatchEvent(new InputEvent('input',  { bubbles: true }));
      el.dispatchEvent(new InputEvent('change', { bubbles: true }));
    }, bodySelector);
    await sleep(randomDelay(500, 900));

    await page.click(bodySelector).catch(() => {});
    await page.focus(bodySelector);
    await sleep(randomDelay(300, 500));

    // Clear any pre-filled content
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.press('Delete');
    await sleep(randomDelay(200, 400));

    await page.click(bodySelector).catch(() => {});
    await sleep(randomDelay(200, 400));

    // ── Type body ────────────────────────────────────────────────────────────
    await humanTypeInBrowser(page, sanitizeBHWMessage(dmText));

    // ── Sync Froala → hidden textarea (CRITICAL — mirrors dm.js Step 7.5) ────
    const syncResult = await page.evaluate((sel, text) => {
      const ed = document.querySelector(sel);
      if (!ed) return 'no_editor';
      if (!ed.textContent.trim()) {
        ed.innerHTML = '<p>' + text.replace(/\n/g, '<br>') + '</p>';
      }
      const html = ed.innerHTML;
      const form = ed.closest('form');
      if (!form) return 'no_form';
      let synced = 0;
      form.querySelectorAll('textarea, input[type="hidden"]').forEach(el => {
        const name = (el.name || el.id || '').toLowerCase();
        if (name.includes('message') || name.includes('body') || name.includes('content')) {
          el.value = html;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          synced++;
        }
      });
      form.querySelectorAll('textarea').forEach(ta => {
        if (getComputedStyle(ta).display === 'none' || ta.hidden) {
          ta.value = html; synced++;
        }
      });
      return 'synced:' + synced;
    }, bodySelector, sanitizeBHWMessage(dmText));
    logger.info(`[THREADS-OWNER-OUTREACH] Editor sync: ${syncResult}`);

    // ── Pre-submit pause ─────────────────────────────────────────────────────
    await sleep(randomDelay(1800, 4500));

    // ── Submit via DOM dispatch (no bounding box needed) — mirrors dm.js Step 9
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    await sleep(randomDelay(1000, 1800));

    const submitResult = await page.evaluate((sel) => {
      const ed = document.querySelector(sel);
      let form = ed ? ed.closest('form') : null;
      if (!form) {
        form = document.querySelector('form[action*="conversation"]') ||
               document.querySelector('form[action*="add"]') ||
               document.querySelector('form');
      }
      const btn = form
        ? (form.querySelector('[data-xf-click="submit"]') ||
           form.querySelector('button[type="submit"]') ||
           form.querySelector('input[type="submit"]'))
        : (document.querySelector('button[data-xf-click="submit"]') ||
           document.querySelector('button.button--primary[type="submit"]'));

      if (btn) {
        btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const opts = { bubbles: true, cancelable: true, view: window };
        btn.dispatchEvent(new MouseEvent('mouseenter', opts));
        btn.dispatchEvent(new MouseEvent('mousemove',  opts));
        btn.dispatchEvent(new MouseEvent('mousedown',  opts));
        btn.dispatchEvent(new MouseEvent('mouseup',    opts));
        btn.dispatchEvent(new MouseEvent('click',      opts));
        return 'btn_events:' + (btn.textContent.trim().slice(0, 30));
      }
      if (form) {
        try { form.requestSubmit(); return 'form_requestSubmit'; }
        catch (e) { form.submit(); return 'form_submit'; }
      }
      return 'nothing_found';
    }, bodySelector);
    logger.info(`[THREADS-OWNER-OUTREACH] Submit: ${submitResult}`);

    // Wait for redirect to /conversations/ID/
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await sleep(randomDelay(3000, 6000));

    const finalUrl = page.url();
    const isConvUrl = finalUrl.includes('/conversations/') || finalUrl.includes('/direct-messages/');
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

  // Always prefer the freshly scraped username — the CSV value may be a
  // display name (e.g. "TopRank Solutions") which BHW cannot resolve for DMs.
  const posterUsername = scrapeData.posterUsername || target.poster_username;

  if (!posterUsername) {
    await skipOutreachTarget(target.id, 'no_username');
    logger.warn(`${tag} Could not find poster_username — skipping target #${target.id}`);
    return false;
  }

  // BHW usernames cannot contain spaces — a space means it's a display name
  // and the conversations/add?to= URL will not resolve correctly, causing a hang.
  if (posterUsername.includes(' ')) {
    await skipOutreachTarget(target.id, 'username_has_spaces');
    logger.warn(`${tag} poster_username "${posterUsername}" contains spaces (display name, not a BHW username) — skipping target #${target.id}`);
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

  // ── Step 2.5: DM-ability probe — check before paying for AI ─────────────
  // Navigate to the start-conversation page and look for the "Oops" error.
  // This costs one page load (~3s) but saves the full AI generation cost when
  // the target has DMs disabled or their account is restricted.
  logger.info(`${tag} Probing DM-ability for @${posterUsername}…`);
  try {
    const probeUrl   = `${BHW_BASE}/conversations/add?to=${encodeURIComponent(posterUsername)}`;
    const probePage  = bhwSession.page;
    await bhwSession.navigateTo(probeUrl);
    await sleep(randomDelay(1500, 3000));
    const probeTitle = await probePage.title().catch(() => '');
    if (probeTitle.toLowerCase().includes('oops') || probeTitle.toLowerCase().includes('error')) {
      await skipOutreachTarget(target.id, 'bhw_account_restricted_oops_error');
      logger.warn(`${tag} @${posterUsername} cannot receive DMs (probe: "${probeTitle}") — skipped before AI call`);
      await alerts.sendRawAlert(
        `${tag} DM blocked — skipped before AI ⛔\n` +
        `@${posterUsername} has DMs disabled or account restricted\n` +
        `Thread: "${(target.title || target.thread_url).slice(0, 80)}"\n` +
        `No AI cost incurred.`
      ).catch(() => {});
      return false;
    }
    logger.info(`${tag} DM-ability probe passed for @${posterUsername} — proceeding to AI generation`);
  } catch (probeErr) {
    // If the probe itself errors (network blip etc.) log and continue — the real
    // send will catch it at step 4, same as before.
    logger.warn(`${tag} DM-ability probe failed with error (continuing): ${probeErr.message}`);
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

  // ── Preview mode: WA notify only, no BHW send, rotate target ────────────
  if (PREVIEW_MODE) {
    const progress = await getOutreachProgress().catch(() => null);
    const progressLine = progress
      ? `Progress: ${progress.dm_sent + progress.replied} / ${progress.total} done — ${progress.pending} remaining`
      : '';

    await alerts.sendRawAlert(
      `${tag} 👁 *PREVIEW*\n` +
      `To: @${posterUsername}\n` +
      `Thread: "${title.slice(0, 80)}"\n\n` +
      `*Initial DM:*\n${dmText}\n\n` +
      `*Follow-up #1 (Day ${FOLLOW_UP_DAYS[0]}):*\n${generated.followUp1}\n\n` +
      `*Follow-up #2 (Day ${FOLLOW_UP_DAYS[1]}):*\n${generated.followUp2}\n\n` +
      `*Follow-up #3 (Day ${FOLLOW_UP_DAYS[2]}):*\n${generated.followUp3}\n\n` +
      `⚠️ No BHW DM sent — preview mode\n` +
      progressLine
    ).catch(() => {});

    await markOutreachTargetPreviewed(target.id);
    await logActivity({
      actionType:  'threads_owner_outreach_previewed',
      leadId:      null,
      metadata:    {
        target_id:       target.id,
        poster_username: posterUsername,
        thread_url:      target.thread_url,
      },
    }).catch(() => {});

    logger.info(`${tag} ✅ PREVIEW — @${posterUsername} | WA notified | marked previewed | no BHW DM sent`);
    return true;
  }

  // ── Step 4: Send DM ──────────────────────────────────────────────────────
  const subject   = `Re: ${title}`.slice(0, 60);

  // Wrap sendOutreachDM in a 3-minute timeout to prevent infinite hangs
  const DM_TIMEOUT_MS = 3 * 60 * 1000;
  const sendResult = await Promise.race([
    sendOutreachDM(posterUsername, subject, dmText, dryRun),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`DM send timed out after ${DM_TIMEOUT_MS / 1000}s`)), DM_TIMEOUT_MS)
    ),
  ]).catch(err => ({ success: false, error: err.message }));

  if (!sendResult.success) {
    logger.error(`${tag} DM send failed for @${posterUsername}: ${sendResult.error}`);
    // If BHW account is restricted/banned from receiving DMs — skip permanently
    if (sendResult.error && sendResult.error.includes('BHW_ACCOUNT_RESTRICTED')) {
      await skipOutreachTarget(target.id, 'bhw_account_restricted_oops_error');
      logger.warn(`${tag} @${posterUsername} cannot receive DMs (account restricted) — skipped permanently`);
    }
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

  // ── Step 7: Save pre-generated follow-ups — DISABLED, uncomment to re-enable
  // const followUps = {
  //   followUp1: generated.followUp1,
  //   followUp2: generated.followUp2,
  //   followUp3: generated.followUp3,
  // };
  // await createOutreachFollowUps(
  //   target.id,
  //   conv.id,
  //   followUps,
  //   contactedAt,
  //   FOLLOW_UP_DAYS
  // );

  // ── Step 8: Log activity ─────────────────────────────────────────────────
  await logActivity({
    actionType:  'threads_owner_outreach_dm_sent',
    leadId:      null,
    metadata:    {
      target_id:       target.id,
      poster_username: posterUsername,
      thread_url:      target.thread_url,
      conversation_id: conv.id,
      dry_run:         dryRun,
    },
  }).catch(() => {});

  // ── Step 9: Discord alert ────────────────────────────────────────────────
  const progress = await getOutreachProgress().catch(() => null);
  const progressLine = progress
    ? `Progress: ${progress.dm_sent + progress.replied} / ${progress.total} done — ${progress.pending} remaining`
    : '';

  if (dryRun) {
    // Full preview in dry run mode — show DM text + all 3 follow-ups
    await alerts.sendRawAlert(
      `${tag} 🔍 *DRY RUN preview*\n` +
      `To: @${posterUsername}\n` +
      `Thread: "${title.slice(0, 80)}"\n\n` +
      `*Initial DM:*\n${dmText}\n\n` +
      `*Follow-up #1 (Day ${FOLLOW_UP_DAYS[0]}):*\n${generated.followUp1}\n\n` +
      `*Follow-up #2 (Day ${FOLLOW_UP_DAYS[1]}):*\n${generated.followUp2}\n\n` +
      `*Follow-up #3 (Day ${FOLLOW_UP_DAYS[2]}):*\n${generated.followUp3}\n\n` +
      `⚠️ No BHW DM sent — dry run mode\n` +
      progressLine
    ).catch(() => {});
  } else {
    // Live mode — full preview so you can review every DM that actually went out
    await alerts.sendRawAlert(
      `${tag} DM sent ✅\n` +
      `To: @${posterUsername}\n` +
      `Thread: "${title.slice(0, 80)}"\n\n` +
      `**Initial DM:**\n${dmText}\n\n` +
      `**Follow-up #1 (Day ${FOLLOW_UP_DAYS[0]}):**\n${generated.followUp1}\n\n` +
      `**Follow-up #2 (Day ${FOLLOW_UP_DAYS[1]}):**\n${generated.followUp2}\n\n` +
      `**Follow-up #3 (Day ${FOLLOW_UP_DAYS[2]}):**\n${generated.followUp3}\n\n` +
      progressLine
    ).catch(() => {});
  }

  logger.info(`${tag} ✅ Done — @${posterUsername} | DM sent | 3 follow-ups scheduled`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT — startThreadsOwnerOutreach()
// ─────────────────────────────────────────────────────────────────────────────

export async function startThreadsOwnerOutreach(opts = {}) {
  const dryRun = opts.dryRun !== undefined ? opts.dryRun : (process.env.DRY_RUN === 'true');
  const tag    = '[THREADS-OWNER-OUTREACH]';

  if (!config.outreach.enabled) {
    logger.info(`${tag} Disabled (OUTREACH_ENABLED != true) — not starting.`);
    return;
  }

  logger.info(`${tag} Starting… [${dryRun ? '🔍 DRY RUN — no BHW DMs will be sent' : '🔴 LIVE'}]`);

  // Show progress summary + resume state at startup
  try {
    const p = await getOutreachProgress();
    const done = p.dm_sent + p.replied;

    // Next upcoming pending follow-up (not yet due — for resume context)
    const nextFuRow = await dbQuery(`
      SELECT ofu.scheduled_for, ofu.follow_up_number, ot.poster_username
      FROM   outreach_follow_ups ofu
      JOIN   outreach_targets ot ON ot.id = ofu.target_id
      WHERE  ofu.status = 'pending'
      ORDER  BY ofu.scheduled_for ASC
      LIMIT  1
    `);
    const nextFu = nextFuRow.rows[0];
    const nextFuLine = nextFu
      ? `Next follow-up: FU#${nextFu.follow_up_number} for @${nextFu.poster_username} at ${new Date(nextFu.scheduled_for).toISOString().replace('T', ' ').slice(0, 16)} UTC`
      : `Next follow-up: none pending`;

    logger.info(`${tag} Progress: ${done}/${p.total} targets done | ${p.pending} pending | ${p.skipped} skipped`);
    logger.info(`${tag} ${nextFuLine}`);

    await alerts.sendRawAlert(
      `${tag} Started [${dryRun ? 'DRY RUN' : '🔴 LIVE'}]\n` +
      `Progress: ${done}/${p.total} done | ${p.pending} pending | ${p.skipped} skipped\n` +
      `${nextFuLine}\n` +
      `Daily cap: ${DAILY_CAP}/day | Mode: 24h random spread`
    ).catch(() => {});
  } catch (e) { logger.warn(`${tag} Could not load progress: ${e.message}`); }

  const cycle = async (firstRun = false) => {
    if (firstRun) {
      logger.info(`${tag} First run — starting full batch of ${DAILY_CAP} DMs now…`);
    } else if (TEST_MODE) {
      logger.info(`${tag} TEST_MODE — running immediately`);
    }

    if (botState.isPaused()) {
      logger.info(`${tag} Bot paused — skipping cycle`);
      setTimeout(cycle, 60 * 60 * 1000);
      return;
    }

    // ── Progress summary ────────────────────────────────────────────────────
    const progress = await getOutreachProgress().catch(() => null);
    if (progress) {
      const done = progress.dm_sent + progress.replied;
      logger.info(`${tag} Progress: ${done}/${progress.total} done | ${progress.pending} pending | ${progress.skipped} skipped`);
    }

    let dmsSentThisCycle = 0;

    for (let i = 0; i < DAILY_CAP; i++) {
      if (botState.isPaused()) {
        logger.info(`${tag} Bot paused — stopping cycle`);
        break;
      }

      // ── Pick exactly 1 fresh target from DB ───────────────────────────────
      const [target] = await getPendingOutreachTargets(1);
      if (!target) {
        logger.info(`${tag} No more pending targets${i === 0 ? ' — sleeping 6 hours' : ` after ${i} DM(s)`}`);
        break;
      }

      logger.info(`${tag} DM ${i + 1}/${DAILY_CAP}: @${target.poster_username || `target#${target.id}`}`);

      try {
        await processOutreachTarget(target, dryRun);
        dmsSentThisCycle++;
      } catch (err) {
        logger.error(`${tag} Error on target #${target.id}: ${err.message}`);
      }

      // ── After every DM: check inbox → (follow-ups disabled)
      logger.info(`${tag} DM ${i + 1} done — checking inbox…`);
      try { await checkOutreachInbox({ dryRun });              } catch (e) { logger.error(`${tag} Inbox error: ${e.message}`); }
      // try { await runOutreachFollowUps({ dryRun, limit: 1 }); } catch (e) { logger.error(`${tag} Follow-up error: ${e.message}`); }

      // ── Inter-DM gap: random 90–240 min (skip on last DM and in TEST_MODE) ──
      if (!TEST_MODE && i < DAILY_CAP - 1) {
        const gapMs  = randomDelay(MIN_GAP_MS, MAX_GAP_MS);
        const gapMin = Math.round(gapMs / 60000);
        logger.info(`${tag} Sleeping ~${gapMin} min before next DM…`);
        await sleep(gapMs);
      }
    }

    if (dmsSentThisCycle === 0) {
      // No targets left at all — long sleep before checking again
      setTimeout(() => cycle(false), 6 * 60 * 60 * 1000);
      return;
    }

    // ── Final safety sweep: follow-ups disabled
    // try { await runOutreachFollowUps({ dryRun }); } catch (e) { logger.error(`${tag} Final follow-up sweep error: ${e.message}`); }

    // ── Schedule next cycle: always ~24 hours from now ──────────────────────
    // Add small random jitter (±30 min) so the daily time drifts naturally
    const jitterMs   = (Math.random() * 2 - 1) * 30 * 60 * 1000; // ±30 min
    const nextWaitMs = 24 * 60 * 60 * 1000 + jitterMs;
    const nextWaitHrs = Math.round(nextWaitMs / 1000 / 60 / 60 * 10) / 10;
    logger.info(`${tag} Next cycle in ~${nextWaitHrs}h`);
    setTimeout(() => cycle(false), nextWaitMs);
  };

  // Kick off immediately — first DM fires right away, rest follow normal schedule
  cycle(true).catch(err => {
    logger.error(`${tag} Unhandled cycle error: ${err.message}`);
    // Retry after 1h on unexpected crash
    setTimeout(() => startThreadsOwnerOutreach(opts), 60 * 60 * 1000);  });
}
