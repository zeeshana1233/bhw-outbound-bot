/**
 * Command Center — WhatsApp Group two-way bot control
 *
 * Replaces the Telegram command center. Zeeshan creates a WhatsApp group,
 * the bot joins via whatsapp-web.js unofficial login (QR scan once), then
 * listens for commands in that group and replies there.
 *
 * All alerts (handoff, hot lead, daily report …) also go to the same group
 * via alerts.js — one place for everything.
 *
 * ── SETUP (one-time, ~2 minutes) ──────────────────────────────────────────
 *  1. Start the bot: node src/index.js
 *  2. A QR code appears in the terminal — scan it with your phone:
 *     WhatsApp → Settings → Linked Devices → Link a Device
 *  3. Session auto-saved to .wwebjs_auth/ (never push that folder)
 *  4. Create a WhatsApp group, add the linked number, put the exact group name
 *     in .env: WA_GROUP_NAME=Bitbash BHW Bot
 *  5. All future starts auto-login — no QR needed again
 *
 * ── AVAILABLE COMMANDS ────────────────────────────────────────────────────
 *  status          — full system snapshot (session, paused, uptime, today's stats)
 *  stats           — today's numbers (same as daily report)
 *  leads           — lead funnel overview (qualified → DM'd → replied → converted)
 *  handoffs        — list conversations waiting for your attention
 *  convos          — active conversation count
 *  followups       — pending follow-up count + next due
 *  session         — BHW cookie health check
 *  pause           — freeze all bot actions (scraper, DMs, replies, follow-ups)
 *  resume          — unfreeze
 *  dryrun on       — enable dry-run (safe mode, no real sends)
 *  dryrun off      — go live (real DMs + comments sent)
 *  convert <user>  — mark a lead as converted
 *  skip <user>     — disqualify / blacklist a lead
 *  pause followup <user> — stop chasing a specific lead
 *  force report    — send the daily report right now
 *  help            — show this list
 *
 * Natural language also works — AI parses intent from plain sentences.
 * e.g. "how's the bot doing?", "show me today's numbers", "skip that guy mike22"
 */

import logger     from '../utils/logger.js';
import { botState } from '../utils/botState.js';
import alerts     from './alerts.js';
import aiEngine   from './aiEngine.js';
import bhwSession from '../utils/bhwSession.js';
import { sendToGroup, onMessage, isReady } from './whatsappClient.js';
import {
  getDailyStats,
  getHandedOffConversations,
  getLeadsFunnelStats,
  getActiveConversationsStats,
  getPendingFollowUpsStats,
  disqualifyLead,
  convertLead,
  pauseFollowUpsForUsername,
} from '../database/queries.js';
import { query } from '../database/init.js';

// ─────────────────────────────────────────────────────────────────────────────
// REPLY HELPER — sends to the WA command group
// ─────────────────────────────────────────────────────────────────────────────

/** Send a reply to the command group */
async function reply(text) {
  try {
    await sendToGroup(text);
  } catch (err) {
    logger.error('[CommandCenter] reply failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INTENT PARSER — keyword fast-path then OpenClaw AI fallback
// ─────────────────────────────────────────────────────────────────────────────

const KEYWORD_PATTERNS = [
  // Exact / simple keywords first (cheapest — no AI call)
  { intent: 'status',        re: /^(status|ping|health|how.?s?\s+the\s+bot)/i },
  { intent: 'stats',         re: /^(stats?|report|numbers?|today|daily|show\s+me)/i },
  { intent: 'pause',         re: /^pause$/i },
  { intent: 'resume',        re: /^(resume|unpause|start|go)$/i },
  { intent: 'leads',         re: /^leads?(\s|$)/i },
  { intent: 'handoffs',      re: /^hand.?offs?/i },
  { intent: 'convos',        re: /^conv(os?|ersations?)/i },
  { intent: 'followups',     re: /^follow.?ups?/i },
  { intent: 'session',       re: /^session/i },
  { intent: 'force_report',  re: /^force.?report/i },
  { intent: 'community',     re: /^community|organic.?comment/i },
  { intent: 'help',          re: /^(help|commands?|\?+)$/i },
  { intent: 'dryrun_on',     re: /^dry.?run\s+(on|enable|true)/i },
  { intent: 'dryrun_off',    re: /^dry.?run\s+(off|disable|false|live)/i },
  // Parameterised commands — capture username
  { intent: 'convert',       re: /^convert\s+@?(\S+)/i,         param: 1 },
  { intent: 'skip',          re: /^(skip|disqualify|block)\s+@?(\S+)/i, param: 2 },
  { intent: 'pause_followup',re: /^pause\s+follow.?up\s+@?(\S+)/i, param: 1 },
];

async function parseIntent(text) {
  const t = text.trim();

  // Fast-path keyword matching (free, instant)
  for (const { intent, re, param } of KEYWORD_PATTERNS) {
    const m = t.match(re);
    if (m) {
      const params = param && m[param] ? { username: m[param].toLowerCase() } : {};
      return { intent, params };
    }
  }

  // AI fallback — parse natural language (costs a small fraction of a cent)
  const systemPrompt = `You parse commands for a BHW sales bot controller.
Return ONLY valid JSON with { "intent": string, "params": {} }.

Intents: status, stats, pause, resume, leads, handoffs, convos, followups,
session, force_report, dryrun_on, dryrun_off, help, unknown.
Parameterised: convert, skip, pause_followup — all need { "username": "the_name" }.

Map casual language:
"how is the bot" → status
"show me numbers" → stats
"stop everything" → pause
"who needs attention" → handoffs
"mark john23 as closed deal" → convert, username="john23"
"stop following up with mike" → pause_followup, username="mike"
"ignore that user sarah99" → skip, username="sarah99"

No code fences. No explanation. Only the JSON object.`;

  try {
    const raw = await aiEngine.callAI(systemPrompt, t, { temperature: 0.1, max_tokens: 80 });
    const cleaned = raw.replace(/^```[\w]*\n?/m, '').replace(/```$/m, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { intent: 'unknown', params: {} };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

async function handleStatus() {
  const state = botState.summary();
  const stats = await getDailyStats().catch(() => null);
  const sessionOk = !bhwSession.isSessionDown();

  const lines = [
    `🤖 *Bitbash BHW Bot — Status*`,
    ``,
    `🔌 Session:  ${sessionOk ? '✅ Active' : '❌ DOWN'}`,
    `⏸️  Paused:   ${state.paused ? `Yes — ${state.pausedReason}` : 'No (running)'}`,
    `🧪 Mode:     ${state.dryRun ? 'DRY RUN (safe)' : '🔴 LIVE'}`,
    `⏱️  Uptime:   ${state.uptime}`,
    ``,
    `📊 *Today*`,
    stats
      ? [
          `   Scraped:  ${stats.leadsScraped}`,
          `   DMs sent: ${stats.dmsSent}`,
          `   Replied:  ${stats.replied}`,
          `   Handoffs: ${stats.handoffs}`,
          `   Closed:   ${stats.conversions}`,
        ].join('\n')
      : '   (stats unavailable)',
  ];
  await reply(lines.join('\n'));
}

async function handleStats() {
  const stats = await getDailyStats();
  const lines = [
    `📊 *Daily Stats — ${stats.date}*`,
    ``,
    `Leads scraped:   ${stats.leadsScraped}`,
    `DMs sent:        ${stats.dmsSent}`,
    `Replied to:      ${stats.replied}`,
    `Handoffs:        ${stats.handoffs}`,
    `Conversions:     ${stats.conversions}`,
  ];
  await reply(lines.join('\n'));
}

async function handleLeads() {
  const f = await getLeadsFunnelStats();
  const lines = [
    `🎯 *Lead Funnel*`,
    ``,
    `Total scraped:  ${f.total}`,
    `Qualified:      ${f.qualified}`,
    `Commented:      ${f.commented}`,
    `DM sent:        ${f.dmSent}`,
    `Replied:        ${f.replied}`,
    `Converted 🏆:   ${f.converted}`,
  ];
  await reply(lines.join('\n'));
}

async function handleHandoffs() {
  const rows = await getHandedOffConversations();
  if (rows.length === 0) {
    return reply('✅ No handoffs — bot is handling everything.');
  }
  const lines = [
    `🚨 *${rows.length} Conversation(s) Waiting for You*`,
    ``,
    ...rows.slice(0, 10).map((r, i) =>
      `${i + 1}. @${r.poster_username} — "${(r.lead_title || 'no title').slice(0, 50)}"\n   📎 ${r.bhw_conversation_url || r.thread_url || 'no link'}`
    ),
    rows.length > 10 ? `\n…and ${rows.length - 10} more.` : '',
  ];
  await reply(lines.filter(Boolean).join('\n'));
}

async function handleConvos() {
  const s = await getActiveConversationsStats();
  const lines = [
    `💬 *Conversations*`,
    ``,
    `Active (bot managing): ${s.active}`,
    `Handed off (yours):    ${s.handedOff}`,
    `Total ever:            ${s.total}`,
  ];
  await reply(lines.join('\n'));
}

async function handleFollowUps() {
  const s = await getPendingFollowUpsStats();
  const nextStr = s.nextDue
    ? s.nextDue.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
    : 'none';
  const lines = [
    `🔁 *Follow-Ups*`,
    ``,
    `Pending: ${s.pendingCount}`,
    `Next due: ${nextStr}`,
  ];
  await reply(lines.join('\n'));
}

async function handleSession() {
  const down = bhwSession.isSessionDown();
  await reply(down
    ? '❌ *BHW Session is DOWN*\nCookies have expired. Bot is paused on BHW actions.\nCheck WhatsApp — an alert was sent when this happened.'
    : '✅ *BHW Session is healthy.*\nCookies are valid and authenticated.');
}

async function handlePause() {
  if (botState.isPaused()) {
    return reply('⏸️ Already paused. Send `resume` to restart.');
  }
  botState.pause('manual via WhatsApp');
  await reply('⏸️ *Bot paused.*\nScraper, DMs, inbox replies and follow-ups are all frozen.\nSend `resume` to restart.');
}

async function handleResume() {
  if (!botState.isPaused()) {
    return reply('▶️ Already running — nothing to resume.');
  }
  botState.resume();
  await reply('▶️ *Bot resumed.*\nAll engines are running again.');
}

async function handleDryRun(on) {
  botState.setDryRun(on);
  const msg = on
    ? '🧪 *Dry-run ON* — safe mode. No real DMs or comments will be sent.'
    : '🔴 *Dry-run OFF* — LIVE mode. Real DMs and comments are now being sent!';
  await reply(msg);
}

async function handleConvert({ username }) {
  if (!username) return reply('Usage: `convert <username>`\nExample: `convert john23`');
  const lead = await convertLead(username);
  if (!lead) return reply(`❌ @${username} not found in leads database.`);
  await reply(`🏆 *Converted!*\n@${username} marked as converted. Great work!`);
}

async function handleSkip({ username }) {
  if (!username) return reply('Usage: `skip <username>`\nExample: `skip spammer99`');
  const lead = await disqualifyLead(username);
  if (!lead) return reply(`❌ @${username} not found in leads database.`);
  await reply(`🚫 @${username} disqualified and skipped. Bot will no longer contact them.`);
}

async function handlePauseFollowUp({ username }) {
  if (!username) return reply('Usage: `pause followup <username>`\nExample: `pause followup mike44`');
  const result = await pauseFollowUpsForUsername(username);
  if (!result) return reply(`❌ @${username} not found, or no active conversation / follow-ups.`);
  const count = Array.isArray(result) ? result.length : 1;
  await reply(`⏸️ Paused ${count} follow-up(s) for @${username}.`);
}

async function handleForceReport() {
  await reply('📊 Generating report and sending to WhatsApp…');
  const stats = await getDailyStats();
  await alerts.sendDailyReport(stats);
  await reply('✅ Daily report sent to WhatsApp.');
}

async function handleCommunity() {
  try {
    const result = await query(`
      SELECT
        COUNT(*)                                                AS total,
        COUNT(*) FILTER (WHERE dry_run = false)                AS live_posts,
        COUNT(*) FILTER (WHERE posted_at > NOW() - INTERVAL '24 hours') AS today,
        COUNT(*) FILTER (WHERE posted_at > NOW() - INTERVAL '7 days')   AS this_week
      FROM community_comments
      WHERE comment_url IS NOT NULL
    `);
    const row = result.rows[0];
    const lines = [
      `💬 *Community Comments*`,
      ``,
      `Total posted:  ${row.total}`,
      `Today:         ${row.today}`,
      `This week:     ${row.this_week}`,
      `Live (non-dry): ${row.live_posts}`,
      ``,
      `_Next scan fires automatically every 4–6h. Max 3 comments per run._`,
    ];
    await reply(lines.join('\n'));
  } catch (err) {
    await reply(`⚠️ Could not load community stats: ${err.message}`);
  }
}

async function handleHelp() {
  const help = [
    `🤖 *Bitbash BHW Bot — Commands*`,
    ``,
    `*Status & Data*`,
    `  \`status\`               — full snapshot`,
    `  \`stats\`                — today's numbers`,
    `  \`leads\`                — lead funnel`,
    `  \`handoffs\`             — convos needing you`,
    `  \`convos\`               — conversation counts`,
    `  \`followups\`            — pending follow-ups`,
    `  \`session\`              — BHW cookie health`,
    ``,
    `*Bot Control*`,
    `  \`pause\`                — freeze all actions`,
    `  \`resume\`               — unfreeze`,
    `  \`dryrun on/off\`        — toggle safe/live mode`,
    `  \`force report\`         — send WhatsApp report now`,    `  \`community\`            \u2014 community comment stats`,    ``,
    `*Lead Actions*`,
    `  \`convert <user>\`       — mark as won`,
    `  \`skip <user>\`          — disqualify lead`,
    `  \`pause followup <user>\`— stop chasing a lead`,
    ``,
    `Natural language also works 👍`,
    `e.g. _"how's the bot?"_, _"show me today's numbers"_`,
  ];
  await reply(help.join('\n'));
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCH
// ─────────────────────────────────────────────────────────────────────────────

async function dispatch(text) {
  const { intent, params } = await parseIntent(text);
  logger.info(`[CommandCenter] Intent: ${intent} | params: ${JSON.stringify(params)}`);

  switch (intent) {
    case 'status':         return handleStatus();
    case 'stats':          return handleStats();
    case 'leads':          return handleLeads();
    case 'handoffs':       return handleHandoffs();
    case 'convos':         return handleConvos();
    case 'followups':      return handleFollowUps();
    case 'session':        return handleSession();
    case 'pause':          return handlePause();
    case 'resume':         return handleResume();
    case 'dryrun_on':      return handleDryRun(true);
    case 'dryrun_off':     return handleDryRun(false);
    case 'convert':        return handleConvert(params);
    case 'skip':           return handleSkip(params);
    case 'pause_followup': return handlePauseFollowUp(params);
    case 'force_report':   return handleForceReport();
    case 'community':      return handleCommunity();
    case 'help':           return handleHelp();
    default:
      return reply(
        `🤔 I didn't understand that.\nSend \`help\` for the full command list.`
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP GROUP LISTENER
// ─────────────────────────────────────────────────────────────────────────────

let _running = false;

/**
 * Start the WhatsApp command center.
 * Registers a message listener on the shared whatsappClient singleton.
 * Only processes messages from the configured WA group (WA_GROUP_NAME).
 * Dispatches commands and replies to the same group.
 *
 * Call this AFTER initWhatsApp() in index.js — the client must already be
 * initialized before registering listeners (though queueing still works).
 */
export async function startCommandCenter() {
  if (_running) return; // idempotent

  const groupName = process.env.WA_GROUP_NAME || 'Bitbash BHW Bot';

  logger.info(`[CommandCenter] ✅ Started — listening for WhatsApp commands in group "${groupName}"`);
  _running = true;

  // Register inbound message handler on the shared client
  onMessage(async (msg) => {
    // Only process group messages (ignore private DMs to the linked number)
    if (!msg.from.endsWith('@g.us')) return;

    const { getGroupId } = await import('./whatsappClient.js');
    const groupId = getGroupId();

    // Only accept messages from our configured command group
    if (groupId && msg.from !== groupId) return;

    // Ignore messages sent by the bot itself
    if (msg.fromMe) return;

    const text = (msg.body || '').trim();
    if (!text) return;

    logger.info(`[CommandCenter] Received: "${text.substring(0, 80)}"`);

    // Fire and forget — don't let one slow command stall the listener
    dispatch(text).catch(err =>
      reply(`⚠️ Error handling command: ${err.message}`).catch(() => {})
    );
  });

  // Startup ping — wait briefly for the WA client to be ready if needed
  const pingWhenReady = async (retries = 10) => {
    if (isReady()) {
      await reply('🟢 *Bot started.*\nSend `status` for a full snapshot, or `help` for commands.').catch(() => {});
      return;
    }
    if (retries > 0) setTimeout(() => pingWhenReady(retries - 1), 3000);
  };
  pingWhenReady();
}

export default { startCommandCenter };
