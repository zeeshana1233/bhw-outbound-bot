/**
 * Alerts Service
 *
 * Sends alerts to the Discord control channel when the bot detects anything
 * that needs Zeeshan's attention (handoffs, hot leads, session expiry, etc.).
 *
 * Uses discord.js via the shared discordClient singleton — same bot instance
 * that the command center uses for inbound slash commands.
 *
 * NO extra setup required beyond what discordClient.js already needs:
 *   1. Set DISCORD_BOT_TOKEN in .env (token from Discord Developer Portal)
 *   2. Set DISCORD_CHANNEL_ID in .env (snowflake channel ID)
 *
 * All exported functions keep their original signatures so nothing else
 * in the codebase needs changing.
 */

import logger from '../utils/logger.js';
import { sendToChannel, sendToChannelById } from './discordClient.js';
import { config } from '../config/config.js';

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL — thin wrapper so every caller goes via sendToChannel
// ─────────────────────────────────────────────────────────────────────────────

async function sendAlert(text) {
  try {
    const result = await sendToChannel(text);
    if (result?.skipped) {
      logger.info(`[Alerts] Discord not ready — skipped: ${text.substring(0, 80)}`);
    } else if (result?.sent === false) {
      logger.warn('[Alerts] sendToChannel failed:', result.error || 'unknown error');
    } else {
      logger.info('[Alerts] Alert sent to Discord channel.');
    }
    return result;
  } catch (err) {
    logger.error('[Alerts] sendAlert error:', err.message);
    return { sent: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — HANDOFF ALERT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send any plain-text Discord message.
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
    '🚨 **HANDOFF ALERT** — Bot needs you!',
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

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — LEAD CTA ALERT (lead redirected to Telegram sales handle)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Alert Zeeshan when the bot successfully redirected a lead to the Telegram
 * sales handle (@bitbashagency). He should expect an incoming message from
 * that username.
 *
 * @param {string} username - BHW username of the lead
 * @param {string}      convUrl   - BHW conversation URL
 * @param {Object|null} lead      - DB lead row (title, description, thread_url)
 * @param {Array}       messages  - Full conversation messages array
 * @param {string}      replyText - The bot's reply that contained the redirect
 */
export async function sendLeadCTAAlert(username, convUrl, lead, messages, replyText) {
  const projectTitle   = lead?.title?.substring(0, 120) || 'Unknown project';
  const projectDesc    = lead?.description?.substring(0, 200) || '';
  const msgCount       = messages?.length ?? 0;

  // Their most recent message (the one we replied to)
  const theirMessages  = (messages || []).filter(m => !m.isOurs);
  const lastTheirMsg   = theirMessages[theirMessages.length - 1]?.text?.substring(0, 200) || '';

  const lines = [
    '📲 **LEAD → TELEGRAM — Expect an incoming message!**',
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

  logger.info(`[Alerts] Redirect alert for @${username} — "${projectTitle}"`);
  return sendAlert(lines.join('\n'));
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — SESSION EXPIRED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Alert Zeeshan that BHW cookies have expired and the bot is paused.
 * He needs to run `node save-cookies.js` to restore the session.
 */
export async function sendSessionExpiredAlert() {
  const text = [
    '🔴 **BHW SESSION DOWN**',
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

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — HOT LEAD PREVIEW
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Alert Zeeshan when the bot DMs a high-scoring lead (score >= 8).
 * Shows the DM that was just sent so he can follow up personally if needed.
 *
 * @param {Object} lead    - DB lead row (title, poster_username, thread_url, niche_match_score)
 * @param {string} dmText  - The DM text that was sent by the bot
 */
export async function sendHotLeadAlert(lead, dmText) {
  const score = lead.niche_match_score ?? '?';
  const preview = dmText?.length > 300 ? dmText.substring(0, 300) + '...' : dmText;

  const text = [
    `🔥 **HOT LEAD — Score ${score}/10**`,
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

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — URGENT CALL REMINDER
// ─────────────────────────────────────────────────────────────────────────────

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
    `📞 **CALL REMINDER — Lock in this deal!**`,
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

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — DAILY REPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a daily summary report via Discord.
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
    nicheScout    = null,
  } = stats;

  const lines = [
    `📊 **Daily Bot Report — ${date}**`,
    '',
    `🔍 Leads scraped:    ${leadsScraped}`,
    `📨 DMs sent:         ${dmsSent}`,
    `💬 Replies sent:     ${replied}`,
    `🚨 Handoffs:         ${handoffs}`,
    `✅ Conversions:      ${conversions}`,
  ];

  if (nicheScout) {
    const t = nicheScout.today || {};
    const w = nicheScout.week || {};
    lines.push(
      '',
      '🎯 **Niche Scout**',
      `Today: ${(t.fit || 0) + (t.maybe || 0)} matched / ${t.skip || 0} skip (of ${t.total || 0})`,
      `Week:  ${(w.fit || 0) + (w.maybe || 0)} matched / ${w.skip || 0} skip (of ${w.total || 0})`,
    );
    const by = t.byNiche || {};
    const nicheLines = Object.keys(by)
      .filter((k) => k !== 'none')
      .sort()
      .map((k) => `  • ${k}: ${(by[k].fit || 0) + (by[k].maybe || 0)}`);
    if (nicheLines.length) {
      lines.push('Today by niche:', ...nicheLines);
    }
  }

  lines.push('', 'Have a great day! 🚀');

  const text = lines.join('\n');
  logger.info('[Alerts] Sending daily report...');
  return sendAlert(text);
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — PIPELINE C: NEW JOB NOTIFIER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a full job card to the dedicated Pipeline C Discord channel.
 * Fires once per new thread that was posted TODAY (caller is responsible
 * for the today-only gate — this function just formats and sends).
 *
 * Full title + full description — no truncation.
 * Long descriptions arrive as multiple sequential Discord messages via
 * the existing splitMessage() helper in discordClient.js.
 *
 * @param {Object} thread
 * @param {string} thread.title          - Full thread title
 * @param {string} thread.url            - BHW thread URL
 * @param {string} thread.posterUsername - BHW username of the poster
 * @param {string} thread.description    - Full OP body text
 * @param {Date}   thread.postedAt       - Parsed post date
 */
export async function sendPipelineCJobAlert({ title, url, posterUsername, description, postedAt }) {
  const channelId = config.discord.pipelineCChannelId;

  if (!channelId) {
    logger.warn('[Pipeline C] PIPELINE_C_CHANNEL_ID not set — job alert skipped.');
    return { skipped: true };
  }

  const timeStr = postedAt
    ? postedAt.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })
    : 'unknown time';

  const text = [
    `🆕 **New Job** | ${timeStr}`,
    '',
    `📌 **Title:** ${title}`,
    `👤 Poster: @${posterUsername || 'unknown'}`,
    `🔗 ${url}`,
    '',
    `📝 **Description:**`,
    description || '(no description)',
  ].join('\n');

  logger.info(`[Pipeline C] Sending job alert for: "${title?.substring(0, 60)}"`);
  return sendToChannelById(channelId, text);
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — PIPELINE D: NICHE COMMENT SCOUT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a niche + comment-angle card to the Niche Scout Discord channel.
 * Sales use this to manually comment on BHW (bot does not post).
 *
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.url
 * @param {string} [opts.posterUsername]
 * @param {string} [opts.niche]
 * @param {string} [opts.verdict]  - fit | maybe
 * @param {string} [opts.angle]   - comment_angle from classifier
 * @param {Date|string} [opts.postedAt]
 */
export async function sendNicheScoutAlert({
  title,
  url,
  posterUsername,
  niche,
  verdict,
  angle,
  postedAt,
}) {
  const channelId = config.discord.nicheScoutChannelId;

  if (!channelId) {
    logger.warn('[NicheScout] NICHE_SCOUT_CHANNEL_ID not set — alert skipped.');
    return { skipped: true };
  }

  const timeStr = postedAt
    ? new Date(postedAt).toLocaleString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: 'short',
      })
    : 'unknown time';

  const text = [
    `🎯 **Niche Scout** | ${timeStr}`,
    '',
    `📌 **Title:** ${title || '(no title)'}`,
    `👤 Poster: @${posterUsername || 'unknown'}`,
    `🏷 **Niche:** ${niche || '—'}`,
    `✅ **Verdict:** ${verdict || '—'}`,
    '',
    `💡 **Angle:**`,
    angle || '(no angle)',
    '',
    `🔗 ${url}`,
  ].join('\n');

  logger.info(`[NicheScout] Sending alert: "${(title || '').substring(0, 60)}"`);
  return sendToChannelById(channelId, text);
}

/**
 * End-of-day Niche Scout report → niche scout Discord channel.
 * Includes today + week niche job counts, plus list of skips (niche miss).
 *
 * @param {object} opts
 * @param {object} opts.today   - from getNicheScoutDayStats()
 * @param {object} opts.week    - from getNicheScoutWeekStats()
 * @param {Array}  opts.skipped - from getNicheScoutSkippedPosts()
 */
export async function sendNicheScoutDailyReport({ today = {}, week = {}, skipped = [] } = {}) {
  const channelId = config.discord.nicheScoutChannelId;
  if (!channelId) {
    logger.warn('[NicheScout] NICHE_SCOUT_CHANNEL_ID not set — daily report skipped.');
    return { skipped: true };
  }

  const dateLabel = today.date
    || new Date().toLocaleDateString('en-GB');

  const formatByNiche = (byNiche = {}) => {
    const keys = Object.keys(byNiche).sort((a, b) => {
      if (a === 'none') return 1;
      if (b === 'none') return -1;
      return a.localeCompare(b);
    });
    if (keys.length === 0) return '  (none)';
    return keys.map((k) => {
      const n = byNiche[k];
      const matched = (n.fit || 0) + (n.maybe || 0);
      return `  • **${k}**: ${matched} matched (fit ${n.fit || 0} / maybe ${n.maybe || 0}) · skip ${n.skip || 0}`;
    }).join('\n');
  };

  const skipLines = (skipped || []).slice(0, 40).map((row, i) => {
    const title = (row.title || '(no title)').substring(0, 70);
    return `${i + 1}. ${title}\n   ${row.thread_url}`;
  });

  const moreSkip = (skipped?.length || 0) > 40
    ? `\n… +${skipped.length - 40} more skips`
    : '';

  const text = [
    `📊 **Niche Scout Daily Report — ${dateLabel}**`,
    '',
    `**Today**`,
    `Total classified: ${today.total || 0}`,
    `Matched (fit+maybe): ${(today.fit || 0) + (today.maybe || 0)}  ·  fit ${today.fit || 0}  ·  maybe ${today.maybe || 0}`,
    `Skipped (no niche match): ${today.skip || 0}`,
    '',
    'By niche (today):',
    formatByNiche(today.byNiche),
    '',
    `**Last ${week.days || 7} days**`,
    `Total: ${week.total || 0}  ·  matched ${(week.fit || 0) + (week.maybe || 0)}  ·  skip ${week.skip || 0}`,
    '',
    'By niche (week):',
    formatByNiche(week.byNiche),
    '',
    `**Missed today (skip — niche did not match)** — ${(skipped || []).length}`,
    skipLines.length ? skipLines.join('\n') : '  (none)',
    moreSkip,
  ].join('\n');

  logger.info('[NicheScout] Sending end-of-day niche report…');
  return sendToChannelById(channelId, text);
}

export default {
  sendRawAlert,
  sendHandoffAlert,
  sendHotLeadAlert,
  sendCallReminder,
  sendLeadCTAAlert,
  sendSessionExpiredAlert,
  sendDailyReport,
  sendPipelineCJobAlert,
  sendNicheScoutAlert,
  sendNicheScoutDailyReport,
};
