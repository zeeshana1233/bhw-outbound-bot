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
  scheduleFollowUp,
  getConversationByLeadId,
  incrementConversationMessages,
  updateConversationBhwUrl,
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

/**
 * Schedule 3 follow-up messages immediately after the DM is sent.
 * Generates the text for each interval right now (context is fresh)
 * and stores it in the DB ready to send.
 */
async function scheduleFollowUps(lead, conversationId, dmText) {
  const intervals = [7, 12, 21]; // base days after DM sent (plan §5.2)
  const previousMessages = `Outbound DM:\n${dmText}`;

  for (let i = 0; i < intervals.length; i++) {
    const days = intervals[i];

    // Add random jitter: 0–24 hrs so follow-ups never land at a predictable time
    const jitterMs    = Math.floor(Math.random() * 24 * 60 * 60 * 1000);
    const scheduledFor = new Date(Date.now() + days * 24 * 60 * 60 * 1000 + jitterMs);
    const scheduledStr = scheduledFor.toLocaleString();

    try {
      const followUpText = await aiEngine.generateFollowUp(
        lead.title,
        lead.description || '',
        days,
        previousMessages
      );

      await scheduleFollowUp({
        leadId:         lead.id,
        conversationId: conversationId,
        scheduledFor:   scheduledFor,
        followUpNumber: i + 1,
        messageText:    followUpText,
      });

      logger.info(`  Follow-up #${i + 1} scheduled for day ~${days} (${scheduledStr})`);
    } catch (err) {
      logger.warn(`  Failed to schedule follow-up #${i + 1}: ${err.message}`);
    }
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
  logger.info(`Generating DM for lead "${lead.title}"...`);

  const pitchAngle = lead.pitch_angle ||
    lead.qualification_reason ||
    'software development and automation expertise';

  const dmText = await aiEngine.generateDMOutreach(
    lead.title,
    lead.description || '',
    lead.poster_username,
    pitchAngle
  );

  logger.info('DM generated successfully.');
  return dmText.trim();
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

  if (DRY_RUN) {
    logger.info('DRY RUN — skipping browser actions and DB update.\n');
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

  // ── 6. Clear + click message editor ────────────────────────────────
  logger.info('Step 6/10 — Clearing any draft and clicking editor...');

  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, editorSelector);
  await sleep(randomDelay(600, 1000));

  await page.click(editorSelector).catch(() => {});
  await sleep(randomDelay(300, 600));
  await page.focus(editorSelector);
  await sleep(randomDelay(200, 400));

  // Clear any pre-filled content
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await sleep(randomDelay(150, 300));
  await page.keyboard.press('Backspace');
  await sleep(randomDelay(200, 400));

  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.value = '';
    } else {
      el.innerHTML = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  }, editorSelector);
  await sleep(randomDelay(300, 500));

  await page.click(editorSelector).catch(() => {});
  await sleep(randomDelay(200, 400));

  // ── 7. Type the DM ─────────────────────────────────────────────────
  logger.info('Step 7/10 — Typing DM (human speed)...');
  await humanTypeInBrowser(page, dmText);
  logger.info('           Typing complete.');

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

  const SUBMIT_SELECTORS = [
    'button.button--primary[type="submit"]',
    'button[data-xf-click="submit"]',
    '.formSubmitRow button.button--primary',
    'input[type="submit"]',
    'button[type="submit"]',
  ];

  // Scroll to bottom so the Send button is in viewport
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
  await sleep(randomDelay(800, 1500));

  let submitted = false;
  for (const sel of SUBMIT_SELECTORS) {
    const btn = await page.$(sel);
    if (btn) {
      await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, sel);
      await sleep(randomDelay(500, 900));

      try {
        await page.click(sel);
        submitted = true;
        logger.info(`           Clicked send (page.click): ${sel}`);
      } catch (clickErr) {
        logger.warn(`           page.click failed — using DOM click: ${clickErr.message}`);
        try {
          await page.$eval(sel, el => el.click());
          submitted = true;
          logger.info(`           Clicked send (DOM eval): ${sel}`);
        } catch (evalErr) {
          logger.warn(`           DOM click also failed: ${evalErr.message}`);
          continue;
        }
      }
      break;
    }
  }

  if (!submitted) {
    logger.warn('Send button not found — using Ctrl+Enter keyboard fallback...');
    await page.focus(editorSelector);
    await sleep(randomDelay(200, 400));
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    submitted = true;
  }

  await sleep(randomDelay(3000, 6000));

  // ── 10. Verify + update DB ──────────────────────────────────────────
  logger.info('Step 10/10 — Verifying send + updating database...');

  const currentUrl = page.url();
  const conversationMatch = currentUrl.match(/\/conversations\/(\d+)/);
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

    logger.info('           Scheduling follow-up sequence...');
    await scheduleFollowUps(lead, dbConversationId, dmText);

  } catch (dbErr) {
    logger.error('Failed to update database after sending DM:', dbErr.message);
  }

  logger.info('');
  logger.info('✅ DM sent successfully!');
  logger.info(`   Recipient     : @${lead.poster_username}`);
  logger.info(`   Conversation  : ${conversationUrl || currentUrl}`);
  logger.info(`   DB conv ID    : ${dbConversationId}`);
  logger.info(`   Follow-ups    : scheduled at day 7, 14, 21`);
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
  const dmText = await generateDM(lead);
  const result = await sendDM(lead, dmText, opts);

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
      logger.info(`[DM] Hot lead score ${hotScore}/10 — WhatsApp alert sent.`);
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

  return { ...result, dmText };
}

export default {
  generateDM,
  sendDM,
  generateAndSendDM,
};
