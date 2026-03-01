/**
 * Alerts Service
 *
 * Sends WhatsApp alerts to Zeeshan when the bot detects a conversation
 * that needs human attention ([HANDOFF] detected).
 *
 * Uses CallMeBot — free WhatsApp API (no account needed beyond linking once).
 *
 * HOW TO SET UP CallMeBot (one-time, 30 seconds):
 *   1. Save +34 644 321 633 as a WhatsApp contact
 *   2. Send this exact message to that number on WhatsApp:
 *        "I allow callmebot to send me messages"
 *   3. You'll receive your API key in reply
 *   4. Set CALLMEBOT_API_KEY and WHATSAPP_ALERT_NUMBER in your .env
 *
 * Config (from .env):
 *   WHATSAPP_ENABLED=true
 *   WHATSAPP_ALERT_NUMBER=your_number_with_country_code  (e.g. 447912345678)
 *   CALLMEBOT_API_KEY=your_callmebot_api_key
 */

import https from 'https';
import logger from '../utils/logger.js';
import { config } from '../config/config.js';

// ─────────────────────────────────────────────────
// INTERNAL — HTTP GET helper (no extra dependencies)
// ─────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

// ─────────────────────────────────────────────────
// LOW-LEVEL SEND
// ─────────────────────────────────────────────────

/**
 * Send a raw WhatsApp message via CallMeBot.
 * @param {string} text - Plain text (will be URL-encoded)
 */
async function sendWhatsApp(text) {
  const enabled = config.whatsapp?.enabled ?? process.env.WHATSAPP_ENABLED === 'true';
  const phone   = config.whatsapp?.alertNumber ?? process.env.WHATSAPP_ALERT_NUMBER;
  const apiKey  = config.whatsapp?.callmebotApiKey ?? process.env.CALLMEBOT_API_KEY;

  if (!enabled) {
    logger.info('[Alerts] WhatsApp disabled — would have sent:', text.substring(0, 80));
    return { skipped: true };
  }

  if (!phone || !apiKey) {
    logger.warn('[Alerts] WHATSAPP_ALERT_NUMBER or CALLMEBOT_API_KEY not set — skipping alert.');
    return { skipped: true };
  }

  const encodedText = encodeURIComponent(text);
  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodedText}&apikey=${apiKey}`;

  try {
    const resp = await httpsGet(url);
    if (resp.status === 200) {
      logger.info('[Alerts] WhatsApp alert sent successfully.');
      return { sent: true };
    } else {
      logger.warn(`[Alerts] CallMeBot returned HTTP ${resp.status}: ${resp.body.substring(0, 120)}`);
      return { sent: false, status: resp.status };
    }
  } catch (err) {
    logger.error('[Alerts] WhatsApp send failed:', err.message);
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
  return sendWhatsApp(text);
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
  return sendWhatsApp(text);
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
  return sendWhatsApp(lines.join('\n'));
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
  return sendWhatsApp(text);
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
  return sendWhatsApp(text);
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
  return sendWhatsApp(text);
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
  return sendWhatsApp(text);
}

export default { sendRawAlert, sendHandoffAlert, sendHotLeadAlert, sendCallReminder, sendTelegramRedirectAlert, sendSessionExpiredAlert, sendDailyReport };
