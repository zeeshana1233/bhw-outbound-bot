/**
 * Command Center — Telegram Group two-way bot control
 *
 * Zeeshan uses a Telegram group with the bot added as admin.
 * The bot listens for slash commands in the group and replies there.
 * All alerts (handoff, hot lead, daily report …) also go to the same group
 * via alerts.js — one place for everything.
 *
 * ── SETUP (one-time, ~2 minutes) ──────────────────────────────────────────
 *  1. Create a bot via @BotFather on Telegram → copy the token
 *  2. Create a Telegram group, add the bot, give it admin rights
 *  3. Get the group chat ID (use @userinfobot or Telegram API)
 *  4. Set in .env:
 *       TELEGRAM_BOT_TOKEN=<token>
 *       TELEGRAM_GROUP_ID=<chat-id>  (negative number, e.g. -5054203181)
 *  5. Start the bot — no QR, no auth, just works
 *
 * ── AVAILABLE SLASH COMMANDS ─────────────────────────────────────────────
 *  /status          — full system snapshot (session, paused, uptime, today's stats)
 *  /stats           — today's numbers (same as daily report)
 *  /leads           — lead funnel overview (qualified → DM'd → replied → converted)
 *  /handoffs        — list conversations waiting for your attention
 *  /convos          — active conversation count
 *  /followups       — pending follow-up count + next due
 *  /session         — BHW cookie health check
 *  /pause           — freeze all bot actions (scraper, DMs, replies, follow-ups)
 *  /resume          — unfreeze
 *  /dryrun on       — enable dry-run (safe mode, no real sends)
 *  /dryrun off      — go live (real DMs + comments sent)
 *  /convert <user>  — mark a lead as converted
 *  /skip <user>     — disqualify / blacklist a lead
 *  /pausefollowup <user> — stop chasing a specific lead
 *  /forcereport     — send the daily report right now
 *  /community       — community comment stats
 *  /help            — show this list
 */

import logger from '../utils/logger.js';
import { botState } from '../utils/botState.js';
import alerts from './alerts.js';
import bhwSession from '../utils/bhwSession.js';
import { getBot, isReady } from './telegramClient.js';
import { sendToGroup } from './telegramClient.js';
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
// REPLY HELPER — sends to the Telegram control group
// ─────────────────────────────────────────────────────────────────────────────

/** Send a reply to the control group (plain sendToGroup call) */
async function reply(text) {
  try {
    await sendToGroup(text);
  } catch (err) {
    logger.error('[CommandCenter] reply failed:', err.message);
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
    `⏸  Paused:   ${state.paused ? `Yes — ${state.pausedReason}` : 'No (running)'}`,
    `🧪 Mode:     ${state.dryRun ? 'DRY RUN (safe)' : '🔴 LIVE'}`,
    `⏱  Uptime:   ${state.uptime}`,
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
    ? '❌ *BHW Session is DOWN*\nCookies have expired. Bot is paused on BHW actions.\nCheck Telegram — an alert was sent when this happened.'
    : '✅ *BHW Session is healthy.*\nCookies are valid and authenticated.');
}

async function handlePause() {
  if (botState.isPaused()) {
    return reply('⏸ Already paused. Send /resume to restart.');
  }
  botState.pause('manual via Telegram');
  await reply('⏸ *Bot paused.*\nScraper, DMs, inbox replies and follow-ups are all frozen.\nSend /resume to restart.');
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

async function handleConvert(username) {
  if (!username) return reply('Usage: /convert <username>\nExample: /convert john23');
  const lead = await convertLead(username);
  if (!lead) return reply(`❌ @${username} not found in leads database.`);
  await reply(`🏆 *Converted!*\n@${username} marked as converted. Great work!`);
}

async function handleSkip(username) {
  if (!username) return reply('Usage: /skip <username>\nExample: /skip spammer99');
  const lead = await disqualifyLead(username);
  if (!lead) return reply(`❌ @${username} not found in leads database.`);
  await reply(`🚫 @${username} disqualified and skipped. Bot will no longer contact them.`);
}

async function handlePauseFollowUp(username) {
  if (!username) return reply('Usage: /pausefollowup <username>\nExample: /pausefollowup mike44');
  const result = await pauseFollowUpsForUsername(username);
  if (!result) return reply(`❌ @${username} not found, or no active conversation / follow-ups.`);
  const count = Array.isArray(result) ? result.length : 1;
  await reply(`⏸ Paused ${count} follow-up(s) for @${username}.`);
}

async function handleForceReport() {
  await reply('📊 Generating report and sending to Telegram…');
  const stats = await getDailyStats();
  await alerts.sendDailyReport(stats);
  await reply('✅ Daily report sent to Telegram.');
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
      `Next scan fires automatically every 4–6h. Max 3 comments per run.`,
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
    `  /status            — full snapshot`,
    `  /stats             — today's numbers`,
    `  /leads             — lead funnel`,
    `  /handoffs          — convos needing you`,
    `  /convos            — conversation counts`,
    `  /followups         — pending follow-ups`,
    `  /session           — BHW cookie health`,
    ``,
    `*Bot Control*`,
    `  /pause             — freeze all actions`,
    `  /resume            — unfreeze`,
    `  /dryrun on         — toggle safe mode`,
    `  /dryrun off        — go live`,
    `  /forcereport       — send Telegram report now`,
    `  /community         — community comment stats`,
    ``,
    `*Lead Actions*`,
    `  /convert <user>    — mark as won`,
    `  /skip <user>       — disqualify lead`,
    `  /pausefollowup <user> — stop chasing a lead`,
  ];
  await reply(help.join('\n'));
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM GROUP LISTENER — slash command registration
// ─────────────────────────────────────────────────────────────────────────────

let _running = false;

/**
 * Start the Telegram command center.
 * Registers slash command handlers on the shared Telegraf bot singleton.
 * Only processes messages from the configured Telegram group (TELEGRAM_GROUP_ID).
 * Dispatches commands and replies to the same group.
 *
 * Call this AFTER initTelegram() in index.js — the bot must already be
 * initialized before registering handlers.
 */
export async function startCommandCenter() {
  if (_running) return; // idempotent

  const groupId = process.env.TELEGRAM_GROUP_ID || null;
  logger.info(`[CommandCenter] Starting — Telegram group ID: ${groupId || '(not set)'}`);
  _running = true;

  const bot = getBot();
  if (!bot) {
    logger.error('[CommandCenter] Telegraf bot not initialized — command center cannot start.');
    return;
  }

  // ── Group-only guard ──────────────────────────────────────────────────────
  // All commands must come from the configured group
  const isFromGroup = (ctx) => {
    if (!groupId) return true; // if no group set, accept all (dev mode)
    return String(ctx.chat?.id) === String(groupId);
  };

  const wrap = (handler) => async (ctx) => {
    if (!isFromGroup(ctx)) return;
    try {
      await handler(ctx);
    } catch (err) {
      logger.error('[CommandCenter] Command handler error:', err.message);
      await reply(`⚠️ Error: ${err.message}`).catch(() => {});
    }
  };

  // ── Slash command bindings ────────────────────────────────────────────────
  bot.command('status',      wrap(() => handleStatus()));
  bot.command('stats',       wrap(() => handleStats()));
  bot.command('leads',       wrap(() => handleLeads()));
  bot.command('handoffs',    wrap(() => handleHandoffs()));
  bot.command('convos',      wrap(() => handleConvos()));
  bot.command('followups',   wrap(() => handleFollowUps()));
  bot.command('session',     wrap(() => handleSession()));
  bot.command('pause',       wrap(() => handlePause()));
  bot.command('resume',      wrap(() => handleResume()));
  bot.command('forcereport', wrap(() => handleForceReport()));
  bot.command('community',   wrap(() => handleCommunity()));
  bot.command('help',        wrap(() => handleHelp()));
  bot.command('start',       wrap(() => handleHelp())); // /start for when bot first added

  // ── Parameterised commands ────────────────────────────────────────────────
  bot.command('dryrun', wrap((ctx) => {
    const arg = (ctx.message?.text || '').split(' ')[1]?.toLowerCase();
    if (arg === 'on' || arg === 'true' || arg === 'enable') return handleDryRun(true);
    if (arg === 'off' || arg === 'false' || arg === 'disable' || arg === 'live') return handleDryRun(false);
    return reply('Usage: /dryrun on  or  /dryrun off');
  }));

  bot.command('convert', wrap((ctx) => {
    const username = (ctx.message?.text || '').split(' ')[1]?.replace(/^@/, '').toLowerCase();
    return handleConvert(username);
  }));

  bot.command('skip', wrap((ctx) => {
    const username = (ctx.message?.text || '').split(' ')[1]?.replace(/^@/, '').toLowerCase();
    return handleSkip(username);
  }));

  bot.command('pausefollowup', wrap((ctx) => {
    const username = (ctx.message?.text || '').split(' ')[1]?.replace(/^@/, '').toLowerCase();
    return handlePauseFollowUp(username);
  }));

  // ── Unknown text messages in the group ───────────────────────────────────
  // Only respond if it looks like an intentional command attempt (starts with /)
  bot.on('text', wrap((ctx) => {
    const text = (ctx.message?.text || '').trim();
    if (!text.startsWith('/')) return; // ignore normal chat
    return reply(`🤔 Unknown command.\nSend /help for the full command list.`);
  }));

  logger.info('[CommandCenter] ✅ Telegram slash commands registered.');

  // Startup ping (retry until bot is ready)
  const pingWhenReady = async (retries = 10) => {
    if (isReady()) {
      await reply('🟢 *Bot started.*\nSend /status for a full snapshot, or /help for commands.').catch(() => {});
      return;
    }
    if (retries > 0) setTimeout(() => pingWhenReady(retries - 1), 3000);
  };
  pingWhenReady();
}

export default { startCommandCenter };
