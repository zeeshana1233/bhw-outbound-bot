/**
 * Conversation Engine
 *
 * Handles individual BHW DM conversations:
 * 1. Reading all messages from a conversation thread
 * 2. Generating a contextual reply via OpenClaw (GPT-4o mini)
 * 3. Posting the reply with full human-behaviour simulation
 * 4. Updating the database (DM record + conversation counters)
 *
 * Called by the Inbox Monitor for each unread conversation.
 * Also called by the Comment Engine right after a comment is posted
 * (so we never leave a reply sitting unanswered).
 */

import logger from '../utils/logger.js';
import { sleep, randomDelay } from '../utils/helpers.js';
import aiEngine from '../services/aiEngine.js';
import alerts from '../services/alerts.js';
import bhwSession from '../utils/bhwSession.js';
import {
  createDM,
  incrementConversationMessages,
  updateConversationStatus,
  markConversationHandedOff,
  logActivity,
} from '../database/queries.js';

const OUR_USERNAME = 'app_pilot'; // bot's own BHW username

// ─────────────────────────────────────────────────
// BROWSER HELPERS
// ─────────────────────────────────────────────────

async function moveMouseAndClick(page, selector) {
  const el = await page.$(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  const box = await el.boundingBox();
  if (!box) throw new Error(`No bounding box: ${selector}`);
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
      const rect = el.getBoundingClientRect();
      window.scrollTo({ top: window.scrollY + rect.top - Math.floor(window.innerHeight * 0.35), behavior: 'smooth' });
    }
  }, selector);
  await sleep(randomDelay(600, 1200));
}

async function humanTypeInBrowser(page, text) {
  const TYPO_PROB = 0.03;
  const TYPO_MAP = {
    a:'s',b:'v',c:'x',d:'s',e:'w',f:'g',g:'h',h:'j',i:'u',j:'k',
    k:'l',l:'k',m:'n',n:'m',o:'p',p:'o',q:'w',r:'e',s:'a',t:'r',
    u:'y',v:'b',w:'e',x:'z',y:'u',z:'x',
  };
  let wordCount = 0, nextPauseAt = randomDelay(8, 15);
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === ' ') {
      wordCount++;
      if (wordCount >= nextPauseAt) { await sleep(randomDelay(400, 900)); wordCount = 0; nextPauseAt = randomDelay(8, 15); }
    }
    if (TYPO_PROB > Math.random() && char.toLowerCase() in TYPO_MAP && char !== ' ' && char !== '\n') {
      await page.keyboard.type(TYPO_MAP[char.toLowerCase()]);
      await sleep(randomDelay(80, 180));
      await page.keyboard.press('Backspace');
      await sleep(randomDelay(100, 250));
    }
    await page.keyboard.type(char);
    const base = randomDelay(50, 140);
    const extra = ['.', ',', '!', '?', '\n', ' '].includes(char) ? randomDelay(0, 80) : 0;
    await sleep(base + extra);
  }
}

// ─────────────────────────────────────────────────
// MESSAGE READING
// ─────────────────────────────────────────────────

/**
 * Read all messages on the current conversation page.
 * Returns an array of { username, text, isOurs } objects,
 * ordered oldest → newest.
 *
 * XenForo 2 conversations and thread pages use the same
 * `.message--post` article structure.
 */
export async function readConversationMessages(page) {
  const messages = await page.evaluate((ourUser) => {
    const items = [];
    document.querySelectorAll('article.message, li.message').forEach(msg => {
      const usernameEl = msg.querySelector('.message-name .username, .message-userDetails .username');
      const bodyEl     = msg.querySelector('.message-content .bbWrapper, .message-body .bbWrapper, .message-userContent .bbWrapper');
      if (!usernameEl || !bodyEl) return;
      const username = usernameEl.innerText.trim();
      const text     = bodyEl.innerText.trim();
      items.push({ username, text, isOurs: username === ourUser });
    });
    return items;
  }, OUR_USERNAME);

  return messages;
}

// ─────────────────────────────────────────────────
// REPLY SENDING
// ─────────────────────────────────────────────────

/**
 * Type and submit a reply in the open conversation page.
 * Uses the same Froala/textarea selectors as the comment engine.
 *
 * @param {Page}   page      - Puppeteer page (already on conversation URL)
 * @param {string} replyText - The reply text to type
 */
export async function sendConversationReply(page, replyText) {
  const EDITOR_SELECTORS = [
    '.fr-element[contenteditable="true"]',
    'div[data-placeholder][contenteditable="true"]',
    'textarea[name="message"]',
    '#ctrl_message',
  ];

  const SUBMIT_SELECTORS = [
    'button.button--primary[type="submit"]',
    'button[data-xf-click="submit"]',
    '.formSubmitRow button.button--primary',
    'button[type="submit"]',
  ];

  // Locate editor
  let editorSel = null;
  for (const sel of EDITOR_SELECTORS) {
    if (await page.$(sel)) { editorSel = sel; break; }
  }
  if (!editorSel) {
    // Scroll to bottom and try again
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    await sleep(randomDelay(1200, 2000));
    for (const sel of EDITOR_SELECTORS) {
      if (await page.$(sel)) { editorSel = sel; break; }
    }
  }
  if (!editorSel) throw new Error('Could not find reply editor in conversation.');

  // Click + type
  await smoothScrollToElement(page, editorSel);
  await sleep(randomDelay(400, 900));
  await moveMouseAndClick(page, editorSel);
  await page.focus(editorSel);
  await sleep(randomDelay(300, 600));

  logger.info('  Typing reply (human speed)...');
  await humanTypeInBrowser(page, replyText);

  // Review pause
  await sleep(randomDelay(1800, 4000));

  // Submit
  let submitted = false;
  for (const sel of SUBMIT_SELECTORS) {
    const btn = await page.$(sel);
    if (btn) {
      await smoothScrollToElement(page, sel);
      await sleep(randomDelay(300, 600));
      await moveMouseAndClick(page, sel);
      submitted = true;
      logger.info(`  Clicked send: ${sel}`);
      break;
    }
  }
  if (!submitted) {
    await page.focus(editorSel);
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    logger.info('  Sent via Ctrl+Enter.');
  }

  await sleep(randomDelay(2500, 5000));
}

// ─────────────────────────────────────────────────
// MAIN: Handle one conversation
// ─────────────────────────────────────────────────

/**
 * Full flow for a single unread conversation:
 *   1. Navigate to conversation URL
 *   2. Read all messages to build history
 *   3. Generate a reply with OpenClaw using the full context
 *   4. Send the reply with human-behaviour simulation
 *   5. Update DB (DM record + conversation counter)
 *
 * @param {string}      convUrl        - Full BHW conversation URL
 * @param {string}      otherUsername  - The other person's BHW username
 * @param {Object|null} lead           - DB lead row (or null if not found in DB)
 * @param {number|null} dbConvId       - DB conversations.id (or null)
 * @param {Object}      [opts]
 * @param {boolean}     [opts.dryRun]  - If true, skip actual sending
 */
export async function handleConversation(convUrl, otherUsername, lead, dbConvId, opts = {}) {
  const DRY_RUN = opts.dryRun === true;

  logger.info(`─── Conversation with @${otherUsername} ───`);
  logger.info(`    URL: ${convUrl}`);

  const page = bhwSession.getPage();

  // Navigate
  logger.info('  Navigating to conversation...');
  await page.goto(convUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(randomDelay(2000, 4000));

  // Read messages
  const messages = await readConversationMessages(page);
  if (messages.length === 0) {
    logger.info('  No messages found on page — skipping.');
    return { success: false, reason: 'no_messages' };
  }

  const latestMessage = messages[messages.length - 1];
  if (latestMessage.isOurs) {
    logger.info('  Last message is ours — nothing to reply to.');
    return { success: false, reason: 'last_is_ours' };
  }

  logger.info(`  ${messages.length} messages found. Latest from @${latestMessage.username}:`);
  logger.info(`  "${latestMessage.text.substring(0, 120)}..."`);

  // Urgency detection — ask AI to judge if this reply is time-sensitive
  const { urgent, matchedLine } = await aiEngine.detectUrgencyAI(latestMessage.text);
  if (urgent) {
    logger.warn(`  ⚡ Urgency detected in @${otherUsername}'s message — firing call reminder`);
    alerts.sendCallReminder(
      otherUsername,
      convUrl,
      matchedLine,
      'inbound_reply'
    ).catch(err => logger.error('  Call reminder alert failed:', err.message));
  }

  // Build conversation history string for OpenClaw
  const history = messages
    .map(m => `${m.isOurs ? 'Us' : m.username}: ${m.text}`);
  const historyStr = history.slice(0, -1).join('\n\n'); // all except the latest
  const latestText = latestMessage.text;

  // Generate reply (pass total message count for [HANDOFF] 8-message rule)
  logger.info('  Generating reply via AI Engine...');
  const rawReply = await aiEngine.generateDMReply(historyStr, latestText, messages.length);

  // Detect and strip [HANDOFF] tag before sending
  const isHandoff = /\[HANDOFF\]/i.test(rawReply);
  const replyText = rawReply.replace(/\[HANDOFF\]/gi, '').trim();

  if (isHandoff) {
    logger.warn(`  🚨 [HANDOFF] detected for @${otherUsername} — Zeeshan will take over`);
  }
  logger.info(`  Reply (${replyText.length} chars): "${replyText.substring(0, 100)}..."`);

  if (DRY_RUN) {
    logger.info('  DRY RUN — skipping send.');
    if (isHandoff) logger.info('  DRY RUN — would have fired handoff alert + marked DB.');
    return { success: true, replyText, handoff: isHandoff, dryRun: true };
  }

  // Send the clean reply (no [HANDOFF] tag) regardless of handoff status
  await sendConversationReply(page, replyText);

  // Telegram redirect detection — did this reply push the lead to Telegram?
  const mentionsTelegram = /@bitbashagency|t\.me\/bitbashagency/i.test(replyText);
  if (mentionsTelegram) {
    logger.info(`  📲 Telegram redirect sent to @${otherUsername} — alerting Zeeshan`);
    alerts.sendTelegramRedirectAlert(otherUsername, convUrl, lead, messages, replyText)
      .catch(err => logger.error('  Telegram redirect alert failed:', err.message));
  }

  // DB update for the reply we just sent
  if (lead && dbConvId) {
    try {
      await createDM({
        leadId:         lead.id,
        conversationId: dbConvId,
        direction:      'outbound',
        messageText:    replyText,
        messageType:    'reply',
        generatedBy:    'aiEngine',
        promptUsed:     `history: ${historyStr.substring(0, 200)}`,
      });
      await incrementConversationMessages(dbConvId, 'outbound');
    } catch (dbErr) {
      logger.error('  DB update failed:', dbErr.message);
    }
  }

  // ── HANDOFF post-processing ──────────────────────────────────────
  if (isHandoff) {
    const handoffReason = messages.length >= 8
      ? `${messages.length} messages — conversation complexity`
      : 'AI flagged complex/high-value conversation';

    // 1. Mark DB — inbox-monitor will skip this conversation from now on
    if (dbConvId) {
      try {
        await markConversationHandedOff(dbConvId, handoffReason);
        logger.info(`  ✅ DB: conversation #${dbConvId} marked as handed_off`);
      } catch (dbErr) {
        logger.error('  DB handoff mark failed:', dbErr.message);
      }
    }

    // 2. Alert Zeeshan on WhatsApp
    try {
      await alerts.sendHandoffAlert(otherUsername, convUrl, messages, handoffReason);
    } catch (alertErr) {
      logger.error('  WhatsApp alert failed:', alertErr.message);
    }

    // 3. Activity log
    if (lead) {
      await logActivity({
        actionType:   'handoff',
        leadId:        lead.id,
        description:  `Conversation with @${otherUsername} handed off to Zeeshan`,
        metadata:     { convUrl, messageCount: messages.length, reason: handoffReason },
      }).catch(() => {});
    }
  }
  // ────────────────────────────────────────────────────────────────

  logger.info(`  ✅ Reply sent to @${otherUsername}${isHandoff ? ' [LAST AUTO-REPLY — handed off]' : ''}`);
  return { success: true, replyText, handoff: isHandoff };
}

export default { readConversationMessages, sendConversationReply, handleConversation };

