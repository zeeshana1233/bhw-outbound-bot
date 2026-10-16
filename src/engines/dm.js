/**
 * DM Engine
 *
 * Handles:
 * 1. Generating a personalised DM via OpenClaw (GPT-4o mini)
 * 2. Sending the DM on BHW via XenForo's "Start a Conversation" system
 *    using the saved BHW session with full human-behaviour simulation
 * 3. Scheduling follow-up messages (day 7, 14, 21) immediately after sending
 *
 * Human Behaviour Simulation:
 * - Random delays between every action
 * - Smooth scroll to fields before interacting
 * - Mouse movement simulation before clicking
 * - Character-by-character typing with per-character random delays
 *   (including occasional typo + backspace)
 * - Pause mid-sentence (thinking pauses) on longer texts
 * - Natural review pause before submitting
 *
 * BHW DM URL pattern (XenForo 2):
 *   https://www.blackhatworld.com/conversations/add?to=USERNAME
 *
 * Form layout:
 *   input[name="title"]                  — conversation subject
 *   .fr-element[contenteditable="true"]  — Froala rich-text editor (message body)
 *   button.button--primary[type="submit"] — Send button
 *
 * All DB writes use the shared queries module.
 */

import logger from '../utils/logger.js';
import { sleep, randomDelay } from '../utils/helpers.js';
import aiEngine from '../services/aiEngine.js';
import alerts from '../services/alerts.js';
import bhwSession from '../utils/bhwSession.js';
import {
  createConversation,
  createDM,
  markLeadDMSent,
  updateLeadStatus,
  scheduleFollowUp,
  getConversationByLeadId,
  incrementConversationMessages,
  updateConversationBhwUrl,
  getLeadById,
  wasUserDMedRecently,
} from '../database/queries.js';
import { config } from '../config/config.js';

const BHW_CONVERSATIONS_URL = 'https://www.blackhatworld.com/conversations/add';

// ─────────────────────────────────────────────────
// INTERNAL BROWSER HELPERS
// (mirrored from comment engine for consistency)
// ─────────────────────────────────────────────────

async function moveMouseAndClick(page, selector) {
  const element = await page.$(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);

  const box = await element.boundingBox();
  if (!box) throw new Error(`Could not get bounding box for: ${selector}`);

  const targetX = box.x + box.width  * (0.3 + Math.random() * 0.4);
  const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);

  await page.mouse.move(targetX, targetY, { steps: randomDelay(8, 20) });
  await sleep(randomDelay(80, 200));
  await page.mouse.click(targetX, targetY);
  await sleep(randomDelay(200, 500));
}

async function smoothScrollToElement(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      const rect = el.getBoundingClientRect();
      const scrollY = window.scrollY + rect.top - Math.floor(window.innerHeight * 0.35);
      window.scrollTo({ top: scrollY, behavior: 'smooth' });
    }
  }, selector);
  await sleep(randomDelay(600, 1200));
}

async function humanTypeInBrowser(page, text) {
  const TYPO_PROB = 0.03;
  const TYPO_MAP = {
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
      char !== ' ' &&
      char !== '\n'
    ) {
      const wrongChar = TYPO_MAP[char.toLowerCase()];
      await page.keyboard.type(wrongChar);
      await sleep(randomDelay(80, 180));
      await page.keyboard.press('Backspace');
      await sleep(randomDelay(100, 250));
    }

    await page.keyboard.type(char);

    const baseDelay = randomDelay(
      config.bot.typingSpeedMin || 50,
      config.bot.typingSpeedMax || 140
    );
    const extra = ['.', ',', '!', '?', '\n', ' '].includes(char)
      ? randomDelay(0, 80)
      : 0;
    await sleep(baseDelay + extra);
  }
}

// ─────────────────────────────────────────────────
// FOLLOW-UP SCHEDULING
// ─────────────────────────────────────────────────

// ─────────────────────────────────────────────────

/**
 * Schedule a single follow-up message (Message 2) to fire 24–72 hours after initial DM.
 *
 * @param {Object} lead
 * @param {number} conversationId
 * @param {string} followUpText
 */
async function scheduleSingleFollowUp(lead, conversationId, followUpText) {
  if (!followUpText || !followUpText.trim()) {
    logger.info(`  No follow-up text provided for lead #${lead.id} — skipping follow-up scheduling.`);
    return;
  }

  // Random delay between 24 hours and 72 hours (1–3 days)
  const MIN_HOURS = 24;
  const MAX_HOURS = 72;
  const delayMs = randomDelay(MIN_HOURS * 3600 * 1000, MAX_HOURS * 3600 * 1000);
  const scheduledFor = new Date(Date.now() + delayMs);
  const scheduledStr = scheduledFor.toLocaleString();

  try {
    await scheduleFollowUp({
      leadId:         lead.id,
      conversationId: conversationId,
      scheduledFor:   scheduledFor,
      followUpNumber: 1,
      messageText:    followUpText,
    });

    const hoursFromNow = Math.round(delayMs / 3600000);
    logger.info(`  Follow-up #1 scheduled in ~${hoursFromNow}h (${scheduledStr})`);
  } catch (err) {
    logger.warn(`  Failed to schedule follow-up #1: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────
// MAIN EXPORTED FUNCTIONS
// ─────────────────────────────────────────────────

/**
 * Generate the initial DM text for a qualified lead.
 *
 * @param {Object} lead - DB lead row (must have title, description, poster_username, pitch_angle)
 * @returns {string} The generated DM text
 */
export async function generateDM(lead) {
  logger.info(`Generating two-message sequence for lead "${lead.title}"...`);

  const { message1, message2, subject, thoughts } = await aiEngine.generateLeadDMAndFollowUp(
    lead.title,
    lead.description || '',
    lead.poster_username,
    lead.thread_url || ''
  );

  if (thoughts) {
    logger.info(`  AI Thoughts: ${thoughts}`);
  }
  logger.info('DM (Message 1) and Follow-Up (Message 2) generated successfully.');
  return { 
    dmText: message1 ? message1.trim() : '', 
    followUpText: message2 ? message2.trim() : '', 
    subject: subject ? subject.trim() : '' 
  };
}

/**
 * Send a DM to a BHW thread poster using XenForo's conversations system.
 *
 * Flow (10 steps):
 *  1.  Ensure BHW session is authenticated
 *  2.  Guard: skip if DM already sent to this lead
 *  3.  Navigate to /conversations/add?to=USERNAME
 *  4.  Verify the conversation form loaded
 *  5.  Fill in the conversation subject (shortened job title)
 *  6.  Click the message editor
 *  7.  Type the DM with human behaviour simulation
 *  8.  Pre-submit review pause
 *  9.  Submit the conversation
 * 10.  Verify success + update DB (conversation, DM record, lead status, follow-ups)
 *
 * @param {Object} lead       - full DB lead row
 * @param {string} dmText     - The DM text to send (from generateDM)
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false] - Preview only, do not submit
 * @returns {Object} { success, conversationUrl, conversationId }
 */
export async function sendDM(lead, dmText, opts = {}) {
  const DRY_RUN = opts.dryRun === true;

  logger.info('═══════════════════════════════════════════════════════════');
  logger.info(DRY_RUN ? '📨 DM ENGINE — DRY RUN MODE' : '📨 DM ENGINE — LIVE MODE');
  logger.info('═══════════════════════════════════════════════════════════');
  logger.info(`Recipient : @${lead.poster_username}`);
  logger.info(`Lead ID   : ${lead.id}`);
  logger.info(`Thread    : ${lead.thread_url}`);
  logger.info('DM text:');
  logger.info('─────────────────────────────────────────────────────────');
  dmText.split('\n').forEach(l => logger.info(`  ${l}`));
  logger.info('─────────────────────────────────────────────────────────\n');

  // ── GUARD: already sent? ────────────────────────────────────────────
  if (lead.dm_sent) {
    logger.warn(`DM already sent to lead #${lead.id} — skipping.`);
    return { success: false, reason: 'already_sent' };
  }

  // ── GUARD: no username = can't DM ───────────────────────────────────
  if (!lead.poster_username || lead.poster_username === 'unknown') {
    logger.warn(`Lead #${lead.id} has no poster_username — cannot send DM. Skipping.`);
    return { success: false, reason: 'no_username' };
  }

  // ── GUARD: fresh DB check to prevent duplicate DMs ──────────────────
  try {
    const freshLead = await getLeadById(lead.id);
    if (freshLead && freshLead.dm_sent === true) {
      logger.warn(`Lead #${lead.id} already dm_sent in DB — aborting to prevent duplicate.`);
      return { success: false, reason: 'already_sent_db' };
    }
  } catch (checkErr) {
    logger.error(`Failed DB freshness check for lead #${lead.id}:`, checkErr.message);
  }

  // ── GUARD: 30-day cross-pipeline dedup (GAP-07) ──────────────────────
  // Prevents DMing the same BHW user twice within 30 days, even if they
  // posted multiple threads or were already contacted via Pipeline B.
  try {
    const recentlyDMed = await wasUserDMedRecently(lead.poster_username, 30);
    if (recentlyDMed) {
      logger.warn(`@${lead.poster_username} was already DM'd within the last 30 days (cross-pipeline dedup) — skipping.`);
      return { success: false, reason: 'recently_dmed' };
    }
  } catch (dedupErr) {
    logger.error(`Failed 30-day dedup check for @${lead.poster_username}:`, dedupErr.message);
  }

  if (DRY_RUN) {
    logger.info('DRY RUN — skipping BHW browser actions. Advancing DB queue for Discord testing...\n');
    try {
      const existingConv = await getConversationByLeadId(lead.id);
      const conversation = existingConv || await createConversation(lead.id);
      const dbConversationId = conversation.id;

      await createDM({
        leadId:         lead.id,
        conversationId: dbConversationId,
        direction:      'outbound',
        messageText:    dmText,
        messageType:    'initial_outreach',
        generatedBy:    'aiEngine',
        promptUsed:     `title: ${lead.title}`,
      });

      await incrementConversationMessages(dbConversationId, 'outbound');
      await markLeadDMSent(lead.id);
      logger.info(`           [DRY RUN] Lead #${lead.id} marked dm_sent in DB (next cycle will test next lead).`);

      if (opts.followUpText) {
        await scheduleSingleFollowUp(lead, dbConversationId, opts.followUpText);
        logger.info(`           [DRY RUN] Scheduled follow-up preview for lead #${lead.id}.`);
      }
    } catch (dryErr) {
      logger.warn('[DRY RUN] DB update error:', dryErr.message);
    }
    return { success: true, conversationUrl: null, conversationId: null, dryRun: true };
  }

  // ── 1. Ensure authenticated ─────────────────────────────────────────
  logger.info('Step 1/10 — Verifying BHW session...');
  await bhwSession.ensureAuthenticated();
  const page = bhwSession.getPage();
  logger.info(`           Session active as: ${bhwSession.getUsername()}`);

  // ── 2. Build DM URL ──────────────────────────────────────────────────
  const dmUrl = `${BHW_CONVERSATIONS_URL}?to=${encodeURIComponent(lead.poster_username)}`;
  logger.info(`Step 2/10 — Opening DM compose form...`);
  logger.info(`           URL: ${dmUrl}`);

  await sleep(randomDelay(1500, 3500));
  await page.goto(dmUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await sleep(randomDelay(2000, 4000));

  // ── 3. Verify form loaded ────────────────────────────────────────────
  logger.info('Step 3/10 — Verifying conversation form...');

  const TITLE_SELECTORS = [
    'input[name="title"]',
    '#ctrl_title',
  ];

  let titleSelector = null;
  for (const sel of TITLE_SELECTORS) {
    const found = await page.$(sel);
    if (found) { titleSelector = sel; break; }
  }

  if (!titleSelector) {
    const pageTitle = await page.title().catch(() => '');
    
    // Check for XenForo error block (e.g. privacy settings, user does not accept DMs)
    let errorText = '';
    try {
      const errEl = await page.$('.blockMessage, .blockMessage--error, .p-body-pageContent');
      if (errEl) {
        errorText = await page.evaluate(el => el.textContent.trim(), errEl);
      }
    } catch (_) {}

    const isPrivacyBlocked = 
      /privacy settings/i.test(errorText) || 
      /may not send a direct message/i.test(errorText) ||
      /cannot start a conversation/i.test(errorText) ||
      /Oops! We ran into some problems/i.test(pageTitle);

    if (isPrivacyBlocked) {
      logger.warn(`  ⚠️ User @${lead.poster_username} does not accept direct messages (Privacy Blocked: "${errorText.slice(0, 100)}").`);
      logger.info(`  Marking lead #${lead.id} as privacy_blocked so it won't be retried.`);
      await updateLeadStatus(lead.id, 'privacy_blocked');
      await markLeadDMSent(lead.id); // Prevents infinite retry loop
      return { success: false, reason: 'privacy_blocked' };
    }

    throw new Error(
      `Conversation form not found (page: "${pageTitle}"). ` +
      `The user @${lead.poster_username} may not exist or your account lacks messaging permissions.`
    );
  }

  logger.info(`           Form loaded. Title field: ${titleSelector}`);

  // ── 4. Fill subject line ────────────────────────────────────────────
  const subject = lead.title.length > 60
    ? lead.title.substring(0, 57) + '...'
    : lead.title;

  logger.info(`Step 4/10 — Filling subject: "${subject}"`);
  await smoothScrollToElement(page, titleSelector);
  await sleep(randomDelay(400, 800));
  await moveMouseAndClick(page, titleSelector);
  await sleep(randomDelay(300, 600));
  await humanTypeInBrowser(page, subject);
  logger.info('           Subject typed.');

  // ── 5. Locate the message editor ───────────────────────────────────
  logger.info('Step 5/10 — Locating message editor...');

  const EDITOR_SELECTORS = [
    '.fr-element[contenteditable="true"]',
    'div[data-placeholder][contenteditable="true"]',
    'div.bbWrapper .fr-element',
    'textarea[name="message"]',
    '#ctrl_message',
  ];

  let editorSelector = null;
  for (const sel of EDITOR_SELECTORS) {
    const found = await page.$(sel);
    if (found) { editorSelector = sel; logger.info(`           Editor found: ${sel}`); break; }
  }

  if (!editorSelector) {
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    await sleep(randomDelay(1500, 2500));
    for (const sel of EDITOR_SELECTORS) {
      const found = await page.$(sel);
      if (found) { editorSelector = sel; logger.info(`           Editor found after scroll: ${sel}`); break; }
    }
  }

  if (!editorSelector) {
    throw new Error('Could not locate message editor on the conversation compose page.');
  }

  // ── 6. Activate Froala editor + clear any draft ────────────────────
  logger.info('Step 6/10 — Activating editor and clearing draft...');

  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, editorSelector);
  await sleep(randomDelay(800, 1200));

  // Activate Froala with full mouse event sequence
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.focus();
    ['mouseenter', 'mousedown', 'mouseup', 'click'].forEach(type =>
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    );
    // Froala's correct empty state is <p><br></p> — NOT empty string
    el.innerHTML = '<p><br></p>';
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    el.dispatchEvent(new InputEvent('change', { bubbles: true }));
  }, editorSelector);
  await sleep(randomDelay(500, 900));

  await page.click(editorSelector).catch(() => {});
  await page.focus(editorSelector);
  await sleep(randomDelay(300, 500));

  // Keyboard clear
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Delete');
  await sleep(randomDelay(200, 400));

  await page.click(editorSelector).catch(() => {});
  await sleep(randomDelay(200, 400));

  // ── 7. Type the DM ─────────────────────────────────────────────────
  logger.info('Step 7/10 — Typing DM (human speed)...');
  await humanTypeInBrowser(page, dmText);
  logger.info('           Typing complete.');

  // ── 7.5 Sync Froala → hidden textarea (CRITICAL) ───────────────────
  // Froala maintains a hidden <textarea> that gets submitted with the form.
  // Keyboard events may not fully sync the visual editor → hidden input.
  // Force-sync here to guarantee the form receives the text.
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
        el.dispatchEvent(new Event('input', { bubbles: true }));
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
  }, editorSelector, dmText);
  logger.info(`           Editor sync: ${syncResult}`);

  // ── 8. Pre-submit pause ─────────────────────────────────────────────
  logger.info('Step 8/10 — Reviewing before send...');
  await sleep(randomDelay(2000, 5000));

  for (let i = 0; i < randomDelay(1, 3); i++) {
    await page.evaluate(() => window.scrollBy({ top: -80, behavior: 'smooth' }));
    await sleep(randomDelay(400, 800));
    await page.evaluate(() => window.scrollBy({ top: 80, behavior: 'smooth' }));
    await sleep(randomDelay(400, 800));
  }

  // ── 9. Submit ───────────────────────────────────────────────────────
  logger.info('Step 9/10 — Sending DM...');

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
  }, editorSelector);
  logger.info(`           Submit: ${submitResult}`);

  await sleep(randomDelay(4000, 7000));

  await sleep(randomDelay(3000, 6000));

  // ── 10. Verify + update DB ──────────────────────────────────────────
  logger.info('Step 10/10 — Verifying send + updating database...');

  const currentUrl = page.url();
  // BHW uses /direct-messages/ or /conversations/ depending on XF version/config
  const conversationMatch = currentUrl.match(/\/(?:conversations|direct-messages)\/[^/]*\.?(\d+)\/?/);
  const conversationUrl   = conversationMatch ? currentUrl : null;
  const bhwConversationId = conversationMatch ? conversationMatch[1] : null;

  if (conversationUrl) {
    logger.info(`           DM sent! Conversation URL: ${conversationUrl}`);
  } else {
    const errEl = await page.$('.blockMessage--error, .errorOverlay .blockMessage');
    if (errEl) {
      const errText = await page.evaluate(el => el.innerText.trim(), errEl);
      logger.warn(`           Possible error on page: "${errText}"`);
    } else {
      logger.warn(`           Could not confirm redirect — current URL: ${currentUrl}`);
    }
  }

  let dbConversationId = null;
  try {
    const existingConv = await getConversationByLeadId(lead.id);
    const conversation = existingConv || await createConversation(lead.id);
    dbConversationId = conversation.id;

    // Store the BHW conversation URL so the follow-up engine can navigate back to it
    if (conversationUrl) {
      await updateConversationBhwUrl(dbConversationId, conversationUrl);
    }

    await createDM({
      leadId:         lead.id,
      conversationId: dbConversationId,
      direction:      'outbound',
      messageText:    dmText,
      messageType:    'initial_outreach',
      generatedBy:    'aiEngine',
      promptUsed:     `title: ${lead.title}`,
    });

    await incrementConversationMessages(dbConversationId, 'outbound');
    await markLeadDMSent(lead.id);
    logger.info(`           Database updated — lead #${lead.id} marked dm_sent.`);

    // Schedule single follow-up (Message 2) for 24–72 hours later if provided
    if (opts.followUpText) {
      logger.info('           Scheduling 24–72h follow-up (Message 2)...');
      await scheduleSingleFollowUp(lead, dbConversationId, opts.followUpText);
    }

  } catch (dbErr) {
    logger.error('CRITICAL — Failed to update database after sending DM:', dbErr.message);
    logger.error('This lead may get double-DMed on next cycle!');
    throw new Error(`DM sent but DB update failed for lead #${lead.id}: ${dbErr.message}`);
  }

  logger.info('');
  logger.info('✅ DM sent successfully!');
  logger.info(`   Recipient     : @${lead.poster_username}`);
  logger.info(`   Conversation  : ${conversationUrl || currentUrl}`);
  logger.info(`   DB conv ID    : ${dbConversationId}`);
  if (opts.followUpText) {
    logger.info(`   Follow-up     : scheduled for 24–72h (Message 2)`);
  }
  logger.info('═══════════════════════════════════════════════════════════\n');

  return {
    success: true,
    conversationUrl: conversationUrl || currentUrl,
    conversationId: dbConversationId,
    bhwConversationId,
  };
}

/**
 * Full pipeline: generate DM text then send it.
 *
 * @param {Object} lead  - full DB lead row
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false] - preview only, do not submit
 * @returns {Object} { success, dmText, conversationUrl, conversationId }
 */
export async function generateAndSendDM(lead, opts = {}) {
  const { dmText, followUpText, subject } = await generateDM(lead);
  const result = await sendDM(lead, dmText, { ...opts, followUpText, subject });

  // ── Post-send alerts ─────────────────────────────────────────────────────
  if (result.success) {
    const isDryRun = result.dryRun === true;

    // Hot lead scoring — uses AI (scoreLeadHotness) instead of raw DB integer
    const { score: hotScore } = await aiEngine.scoreLeadHotness(
      lead.title || '',
      lead.description || ''
    ).catch(() => ({ score: 5 }));

    if (hotScore >= 8) {
      alerts.sendHotLeadAlert(lead, dmText).catch(err =>
        logger.error('[DM] Hot lead alert failed:', err.message)
      );
      logger.info(`[DM] Hot lead score ${hotScore}/10 — Discord alert sent.`);
    }

    // Urgency call reminder — ask AI to judge title + description
    const searchText = `${lead.title || ''} ${lead.description || ''}`;
    const { urgent, matchedLine } = await aiEngine.detectUrgencyAI(searchText);
    if (urgent) {
      const convUrl = result.conversationUrl || lead.thread_url;
      alerts.sendCallReminder(
        lead.poster_username,
        convUrl,
        matchedLine,
        'initial_dm'
      ).catch(err =>
        logger.error('[DM] Call reminder alert failed:', err.message)
      );
      if (isDryRun) logger.info('[DM] DRY RUN — would have sent urgent call reminder.');
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  return { ...result, dmText, followUpText, subject };
}

export default {
  generateDM,
  sendDM,
  generateAndSendDM,
};
