/**
 * Alerts Service
 *
 * Sends alerts to the WhatsApp command group when the bot detects anything
 * that needs Zeeshan's attention (handoffs, hot leads, session expiry, etc.).
 *
 * Uses whatsapp-web.js via the shared whatsappClient singleton — same session
 * that the command center uses for inbound commands.
 *
 * NO extra setup required beyond what whatsappClient.js already needs:
 *   1. QR scan once on first run
 *   2. Set WA_GROUP_NAME in .env to the exact name of your control group
 *
 * All exported functions keep their original signatures so nothing else
 * in the codebase needs changing.
 */

import logger from '../utils/logger.js';
import { sendToGroup } from './whatsappClient.js';

// ─────────────────────────────────────────────────
// INTERNAL — thin wrapper so every caller goes via sendToGroup
// ─────────────────────────────────────────────────

async function sendAlert(text) {
  try {
    const result = await sendToGroup(text);
    if (result?.skipped) {
      logger.info('[Alerts] WhatsApp not ready — skipped:', text.substring(0, 80));
    } else if (result?.sent === false) {
      logger.warn('[Alerts] sendToGroup failed:', result.error || 'unknown error');
    } else {
      logger.info('[Alerts] Alert sent to WhatsApp group.');
    }
    return result;
  } catch (err) {
    logger.error('[Alerts] sendAlert error:', err.message);
    return { sent: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────
// PUBLIC — HANDOFF ALERT
// ─────────────────────────────────────────────────

/**
 * Send any plain-text WhatsApp message.
 * Used for one-off alerts (e.g. session restored).
 */
export async function sendRawAlert(text) {
  return sendAlert(text);
}

/**
 * Fire a handoff alert when the AI decides it cannot handle a conversation.
 *
 * @param {string}   username    - BHW username of the lead
 * @param {string}   convUrl     - Full URL of the BHW conversation thread
 * @param {Array}    messages    - Array of { isOurs, username, text } message objects
 * @param {string}   reason      - Short human-readable reason (e.g. "8+ exchanges")
 */
export async function sendHandoffAlert(username, convUrl, messages, reason = 'AI flagged complex conversation') {
  const msgCount  = messages?.length ?? 0;
  const lastFew   = (messages || [])
    .slice(-3)
    .map(m => `  ${m.isOurs ? 'Us' : m.username}: ${m.text.substring(0, 150)}`)
    .join('\n');

  const text = [
    '🚨 *HANDOFF ALERT* — Bot needs you!',
    '',
    `👤 Lead: @${username}`,
    `💬 Messages so far: ${msgCount}`,
    `📌 Reason: ${reason}`,
    '',
    '📝 Last 3 messages:',
    lastFew || '  (no messages logged)',
    '',
    `🔗 Conversation: ${convUrl}`,
    '',
    'Bot has sent its last auto-reply. Take over when ready.',
  ].join('\n');

  logger.warn(`[Alerts] Firing handoff alert for @${username} — "${reason}"`);
  return sendAlert(text);
}

// ─────────────────────────────────────────────────
// PUBLIC — TELEGRAM REDIRECT
// ─────────────────────────────────────────────────

/**
 * Alert Zeeshan when the bot successfully redirected a lead to Telegram.
 * He should expect an incoming message from that username.
 *
 * @param {string} username - BHW username of the lead
 * @param {string}      username  - BHW username of the lead
 * @param {string}      convUrl   - BHW conversation URL
 * @param {Object|null} lead      - DB lead row (title, description, thread_url)
 * @param {Array}       messages  - Full conversation messages array
 * @param {string}      replyText - The bot's reply that contained the redirect
 */
export async function sendTelegramRedirectAlert(username, convUrl, lead, messages, replyText) {
  const projectTitle   = lead?.title?.substring(0, 120) || 'Unknown project';
  const projectDesc    = lead?.description?.substring(0, 200) || '';
  const msgCount       = messages?.length ?? 0;

  // Their most recent message (the one we replied to)
  const theirMessages  = (messages || []).filter(m => !m.isOurs);
  const lastTheirMsg   = theirMessages[theirMessages.length - 1]?.text?.substring(0, 200) || '';

  const lines = [
    '📲 *LEAD → TELEGRAM — Expect an incoming message!*',
    '',
    `👤 BHW: @${username}`,
    `📁 Project: "${projectTitle}"`,
    `💬 ${msgCount} messages exchanged on BHW`,
    '',
    '🗣 Their last message:',
    `"${lastTheirMsg}"`,
  ];

  if (projectDesc) {
    lines.push('');
    lines.push('📋 What they need:');
    lines.push(projectDesc);
  }

  lines.push('');
  lines.push('📲 They are heading to @bitbashagency on Telegram now.');
  lines.push(`🔗 BHW conversation: ${convUrl}`);

  logger.info(`[Alerts] Telegram redirect alert for @${username} — "${projectTitle}"`);
  return sendAlert(lines.join('\n'));
}

// ─────────────────────────────────────────────────
// PUBLIC — SESSION EXPIRED
// ─────────────────────────────────────────────────

/**
 * Alert Zeeshan that BHW cookies have expired and the bot is paused.
 * He needs to run `node save-cookies.js` to restore the session.
 */
export async function sendSessionExpiredAlert() {
  const text = [
    '🔴 *BHW SESSION DOWN*',
    '',
    'The bot\'s BHW cookies have expired.',
    'All actions are paused until the session is restored.',
    '',
    '👉 To fix — run on the server:',
    '   node save-cookies.js',
    '',
    'Bot will resume automatically once cookies are refreshed.',
  ].join('\n');

  logger.warn('[Alerts] Session expired alert fired');
  return sendAlert(text);
}

// ─────────────────────────────────────────────────
// PUBLIC — HOT LEAD PREVIEW
// ─────────────────────────────────────────────────

/**
 * Alert Zeeshan when the bot DMs a high-scoring lead (score ≥ 8).
 * Shows the DM that was just sent so he can follow up personally if needed.
 *
 * @param {Object} lead    - DB lead row (title, poster_username, thread_url, niche_match_score)
 * @param {string} dmText  - The DM text that was sent by the bot
 */
export async function sendHotLeadAlert(lead, dmText) {
  const score = lead.niche_match_score ?? '?';
  const preview = dmText?.length > 300 ? dmText.substring(0, 300) + '...' : dmText;

  const text = [
    `🔥 *HOT LEAD — Score ${score}/10*`,
    '',
    `👤 @${lead.poster_username}`,
    `📌 "${lead.title?.substring(0, 120)}"`,
    `🔗 ${lead.thread_url}`,
    '',
    '📨 Bot just sent this DM:',
    `"${preview}"`,
    '',
    'Monitor this one — reply when they respond.',
  ].join('\n');

  logger.info(`[Alerts] Hot lead alert for @${lead.poster_username} (score ${score})`);
  return sendAlert(text);
}

// ─────────────────────────────────────────────────
// PUBLIC — URGENT CALL REMINDER
// ─────────────────────────────────────────────────

/**
 * Fire a call reminder when a lead or inbound message shows urgency signals.
 * Used to lock in time-sensitive deals before they go to a competitor.
 *
 * @param {string} username    - BHW username of the lead
 * @param {string} convUrl     - BHW conversation / thread URL
 * @param {string} urgentLine  - The actual line that triggered urgency detection
 * @param {string} [context]   - Short context: 'initial_dm' | 'inbound_reply'
 */
export async function sendCallReminder(username, convUrl, urgentLine, context = 'inbound_reply') {
  const source = context === 'initial_dm' ? 'Job post flagged URGENT' : 'They just replied with urgency';

  const text = [
    `📞 *CALL REMINDER — Lock in this deal!*`,
    '',
    `👤 @${username}`,
    `⚡ ${source}`,
    '',
    `💬 Trigger: "${urgentLine?.substring(0, 200)}"`,
    '',
    `🔗 ${convUrl}`,
    '',
    'Jump on a call ASAP to close before they hire someone else.',
  ].join('\n');

  logger.warn(`[Alerts] Urgent call reminder for @${username} — "${urgentLine?.substring(0, 60)}"`);
  return sendAlert(text);
}

// ─────────────────────────────────────────────────
// PUBLIC — DAILY REPORT (stub — ready for later)
// ─────────────────────────────────────────────────

/**
 * Send a daily summary report via WhatsApp.
 * @param {Object} stats - { leadsScraped, dmsSent, replied, handoffs, conversions }
 */
export async function sendDailyReport(stats = {}) {
  const {
    leadsScraped  = 0,
    dmsSent       = 0,
    replied       = 0,
    handoffs      = 0,
    conversions   = 0,
    date          = new Date().toLocaleDateString('en-GB'),
  } = stats;

  const text = [
    `📊 *Daily Bot Report — ${date}*`,
    '',
    `🔍 Leads scraped:    ${leadsScraped}`,
    `📨 DMs sent:         ${dmsSent}`,
    `💬 Replies sent:     ${replied}`,
    `🚨 Handoffs:         ${handoffs}`,
    `✅ Conversions:      ${conversions}`,
    '',
    'Have a great day! 🚀',
  ].join('\n');

  logger.info('[Alerts] Sending daily report...');
  return sendAlert(text);
}

export default { sendRawAlert, sendHandoffAlert, sendHotLeadAlert, sendCallReminder, sendTelegramRedirectAlert, sendSessionExpiredAlert, sendDailyReport };
