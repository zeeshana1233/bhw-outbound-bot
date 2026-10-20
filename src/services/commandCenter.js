/**
 * Command Center — Discord Channel two-way bot control
 *
 * Zeeshan uses a Discord channel with the bot added to the server.
 * The bot listens for slash commands in the channel and replies there.
 * All alerts (handoff, hot lead, daily report …) also go to the same channel
 * via alerts.js — one place for everything.
 *
 * ── SETUP (one-time, ~5 minutes) ──────────────────────────────────────────
 *  1. Go to https://discord.com/developers/applications → New Application
 *  2. Bot tab → Add Bot → copy the token
 *  3. OAuth2 → URL Generator → scopes: bot + applications.commands
 *     Bot permissions: Send Messages, Read Message History, Use Slash Commands
 *  4. Use the generated URL to invite the bot to your server
 *  5. Right-click the control channel → Copy Channel ID (requires Developer Mode)
 *  6. Set in .env:
 *       DISCORD_BOT_TOKEN=<token>
 *       DISCORD_CHANNEL_ID=<channel-snowflake-id>
 *  7. Start the bot — slash commands auto-register on startup
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
 *  /dryrun          — toggle safe mode (option: on | off)
 *  /convert         — mark a lead as converted (option: username)
 *  /skip            — disqualify / blacklist a lead (option: username)
 *  /pausefollowup   — stop chasing a specific lead (option: username)
 *  /forcereport     — send the daily report right now
 *  /community       — community comment stats
 *  /help            — show this list
 */

import { SlashCommandBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { botState } from '../utils/botState.js';
import alerts from './alerts.js';
import bhwSession from '../utils/bhwSession.js';
import { getClient, isReady, getChannelId, registerSlashCommands } from './discordClient.js';
import { sendToChannel } from './discordClient.js';
import {
  getDailyStats,
  getHandedOffConversations,
  getLeadsFunnelStats,
  getActiveConversationsStats,
  getPendingFollowUpsStats,
  disqualifyLead,
  convertLead,
  pauseFollowUpsForUsername,
  getConversationByUsername,
  createDM,
  incrementConversationMessages,
  getNicheScoutDayStats,
  getNicheScoutWeekStats,
  getNicheScoutSkippedPosts,
} from '../database/queries.js';
import { config } from '../config/config.js';
import { query } from '../database/init.js';
import { sendConversationReply } from '../engines/conversation.js';

// ─────────────────────────────────────────────────────────────────────────────
// REPLY HELPER — sends to the Discord control channel
// ─────────────────────────────────────────────────────────────────────────────

/** Send a reply to the control channel (plain sendToChannel call) */
async function reply(text) {
  try {
    await sendToChannel(text);
  } catch (err) {
    logger.error('[CommandCenter] reply failed:', err.message);
  }
}

/**
 * Reply to a Discord interaction (slash command).
 * Uses interaction.reply() if not yet replied, else followUp().
 * Falls back to sendToChannel() if the interaction is no longer valid.
 */
async function replyToInteraction(interaction, text) {
  try {
    // Discord has a 2000-char limit — truncate if needed
    const safe = text.length > 1990 ? text.slice(0, 1990) + '…' : text;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: safe });
    } else {
      await interaction.reply({ content: safe });
    }
  } catch (err) {
    logger.warn('[CommandCenter] interaction reply failed, falling back to channel:', err.message);
    await reply(text).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reply to a client on BHW directly from Discord.
 * Usage: /reply username:<user> message:<text>
 */
async function handleReply(username, replyText) {
  if (!username || !replyText) return '⚠️ Please provide both username and message.';

  const cleanUser = username.replace(/^@/, '').trim();
  const conv = await getConversationByUsername(cleanUser);

  if (!conv || !conv.bhw_conversation_url) {
    return `⚠️ Could not find an active BHW conversation for @${cleanUser} in the database.`;
  }

  logger.info(`[CommandCenter] Sending team reply to @${cleanUser} via BHW...`);
  try {
    await bhwSession.ensureAuthenticated();
    const page = bhwSession.getPage();

    await page.goto(conv.bhw_conversation_url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await bhwSession.randomDelay ? await bhwSession.randomDelay(2000, 4000) : null;

    await sendConversationReply(page, replyText);

    // Record outbound team reply in database
    await createDM({
      leadId: conv.lead_id || null,
      conversationId: conv.id,
      messageType: 'reply',
      direction: 'outbound',
      subject: conv.lead_title || 'Direct Message',
      body: replyText,
      sentAt: new Date(),
    }).catch(() => {});

    await incrementConversationMessages(conv.id, 'outbound').catch(() => {});

    return `✅ **Reply sent to @${cleanUser} on BHW!**\n\n💬 *Message:* "${replyText}"`;
  } catch (err) {
    logger.error(`[CommandCenter] Failed sending reply to @${cleanUser}:`, err.message);
    return `❌ **Failed to send reply to @${cleanUser} on BHW:** ${err.message}`;
  }
}

async function handleStatus() {
  const state = botState.summary();
  const stats = await getDailyStats().catch(() => null);
  const sessionOk = !bhwSession.isSessionDown();

  const lines = [
    `🤖 **Bitbash BHW Bot — Status**`,
    ``,
    `🔌 Session:  ${sessionOk ? '✅ Active' : '❌ DOWN'}`,
    `⏸  Paused:   ${state.paused ? `Yes — ${state.pausedReason}` : 'No (running)'}`,
    `🧪 Mode:     ${state.dryRun ? 'DRY RUN (safe)' : '🔴 LIVE'}`,
    `⏱  Uptime:   ${state.uptime}`,
    ``,
    `📊 **Today**`,
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
  return lines.join('\n');
}

async function handleStats() {
  const stats = await getDailyStats();
  const lines = [
    `📊 **Daily Stats — ${stats.date}**`,
    ``,
    `Leads scraped:   ${stats.leadsScraped}`,
    `DMs sent:        ${stats.dmsSent}`,
    `Replied to:      ${stats.replied}`,
    `Handoffs:        ${stats.handoffs}`,
    `Conversions:     ${stats.conversions}`,
  ];
  return lines.join('\n');
}

async function handleLeads() {
  const f = await getLeadsFunnelStats();
  const lines = [
    `🎯 **Lead Funnel**`,
    ``,
    `Total scraped:  ${f.total}`,
    `Qualified:      ${f.qualified}`,
    `Commented:      ${f.commented}`,
    `DM sent:        ${f.dmSent}`,
    `Replied:        ${f.replied}`,
    `Converted 🏆:   ${f.converted}`,
  ];
  return lines.join('\n');
}

async function handleHandoffs() {
  const rows = await getHandedOffConversations();
  if (rows.length === 0) {
    return '✅ No handoffs — bot is handling everything.';
  }
  const lines = [
    `🚨 **${rows.length} Conversation(s) Waiting for You**`,
    ``,
    ...rows.slice(0, 10).map((r, i) =>
      `${i + 1}. @${r.poster_username} — "${(r.lead_title || 'no title').slice(0, 50)}"\n   📎 ${r.bhw_conversation_url || r.thread_url || 'no link'}`
    ),
    rows.length > 10 ? `\n…and ${rows.length - 10} more.` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

async function handleConvos() {
  const s = await getActiveConversationsStats();
  const lines = [
    `💬 **Conversations**`,
    ``,
    `Active (bot managing): ${s.active}`,
    `Handed off (yours):    ${s.handedOff}`,
    `Total ever:            ${s.total}`,
  ];
  return lines.join('\n');
}

async function handleFollowUps() {
  const s = await getPendingFollowUpsStats();
  const nextStr = s.nextDue
    ? s.nextDue.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
    : 'none';
  const lines = [
    `🔁 **Follow-Ups**`,
    ``,
    `Pending: ${s.pendingCount}`,
    `Next due: ${nextStr}`,
  ];
  return lines.join('\n');
}

async function handleSession() {
  const down = bhwSession.isSessionDown();
  return down
    ? '❌ **BHW Session is DOWN**\nCookies have expired. Bot is paused on BHW actions.\nCheck Discord — an alert was sent when this happened.'
    : '✅ **BHW Session is healthy.**\nCookies are valid and authenticated.';
}

async function handlePause() {
  if (botState.isPaused()) {
    return '⏸ Already paused. Send /resume to restart.';
  }
  botState.pause('manual via Discord');
  return '⏸ **Bot paused.**\nScraper, DMs, inbox replies and follow-ups are all frozen.\nSend /resume to restart.';
}

async function handleResume() {
  if (!botState.isPaused()) {
    return '▶️ Already running — nothing to resume.';
  }
  botState.resume();
  return '▶️ **Bot resumed.**\nAll engines are running again.';
}

async function handleDryRun(on) {
  botState.setDryRun(on);
  return on
    ? '🧪 **Dry-run ON** — safe mode. No real DMs or comments will be sent.'
    : '🔴 **Dry-run OFF** — LIVE mode. Real DMs and comments are now being sent!';
}

async function handleConvert(username) {
  if (!username) return 'Usage: /convert username:john23';
  const lead = await convertLead(username);
  if (!lead) return `❌ @${username} not found in leads database.`;
  return `🏆 **Converted!**\n@${username} marked as converted. Great work!`;
}

async function handleSkip(username) {
  if (!username) return 'Usage: /skip username:spammer99';
  const lead = await disqualifyLead(username);
  if (!lead) return `❌ @${username} not found in leads database.`;
  return `🚫 @${username} disqualified and skipped. Bot will no longer contact them.`;
}

async function handlePauseFollowUp(username) {
  if (!username) return 'Usage: /pausefollowup username:mike44';
  const result = await pauseFollowUpsForUsername(username);
  if (!result) return `❌ @${username} not found, or no active conversation / follow-ups.`;
  const count = Array.isArray(result) ? result.length : 1;
  return `⏸ Paused ${count} follow-up(s) for @${username}.`;
}

async function handleForceReport() {
  await reply('📊 Generating report and sending to Discord…');
  const stats = await getDailyStats();
  if (config.nicheScout?.enabled) {
    const [today, week, skipped] = await Promise.all([
      getNicheScoutDayStats(),
      getNicheScoutWeekStats(7),
      getNicheScoutSkippedPosts(new Date(), 100),
    ]);
    stats.nicheScout = { today, week };
    await alerts.sendDailyReport(stats);
    await alerts.sendNicheScoutDailyReport({ today, week, skipped });
    return '✅ Daily report + Niche Scout EOD sent to Discord.';
  }
  await alerts.sendDailyReport(stats);
  return '✅ Daily report sent to Discord.';
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
      `💬 **Community Comments**`,
      ``,
      `Total posted:  ${row.total}`,
      `Today:         ${row.today}`,
      `This week:     ${row.this_week}`,
      `Live (non-dry): ${row.live_posts}`,
      ``,
      `Next scan fires automatically every 4–6h. Max 3 comments per run.`,
    ];
    return lines.join('\n');
  } catch (err) {
    return `⚠️ Could not load community stats: ${err.message}`;
  }
}

async function handleHelp() {
  const help = [
    `🤖 **Bitbash BHW Bot — Commands**`,
    ``,
    `**Status & Data**`,
    `  /status            — full snapshot`,
    `  /stats             — today's numbers`,
    `  /leads             — lead funnel`,
    `  /handoffs          — convos needing you`,
    `  /convos            — conversation counts`,
    `  /followups         — pending follow-ups`,
    `  /session           — BHW cookie health`,
    ``,
    `**Bot Control**`,
    `  /pause             — freeze all actions`,
    `  /resume            — unfreeze`,
    `  /dryrun mode:on    — toggle safe mode`,
    `  /dryrun mode:off   — go live`,
    `  /forcereport       — send Discord report now`,
    `  /community         — community comment stats`,
    ``,
    `**Lead Actions**`,
    `  /convert username:<user>    — mark as won`,
    `  /skip username:<user>       — disqualify lead`,
    `  /pausefollowup username:<user> — stop chasing a lead`,
    `  /reply username:<user> message:<text> — reply to client on BHW`,
  ];
  return help.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// SLASH COMMAND DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

const SLASH_COMMANDS = [
  new SlashCommandBuilder().setName('status').setDescription('Full system snapshot'),
  new SlashCommandBuilder().setName('stats').setDescription("Today's numbers"),
  new SlashCommandBuilder().setName('leads').setDescription('Lead funnel overview'),
  new SlashCommandBuilder().setName('handoffs').setDescription('Conversations waiting for you'),
  new SlashCommandBuilder().setName('convos').setDescription('Active conversation counts'),
  new SlashCommandBuilder().setName('followups').setDescription('Pending follow-up count + next due'),
  new SlashCommandBuilder().setName('session').setDescription('BHW cookie health check'),
  new SlashCommandBuilder().setName('pause').setDescription('Freeze all bot actions'),
  new SlashCommandBuilder().setName('resume').setDescription('Unfreeze all bot actions'),
  new SlashCommandBuilder()
    .setName('dryrun')
    .setDescription('Toggle safe/live mode')
    .addStringOption(opt =>
      opt.setName('mode')
        .setDescription('on = safe mode, off = live')
        .setRequired(true)
        .addChoices(
          { name: 'on',  value: 'on' },
          { name: 'off', value: 'off' },
        )
    ),
  new SlashCommandBuilder()
    .setName('convert')
    .setDescription('Mark a lead as converted')
    .addStringOption(opt =>
      opt.setName('username')
        .setDescription('BHW username of the lead')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Disqualify / blacklist a lead')
    .addStringOption(opt =>
      opt.setName('username')
        .setDescription('BHW username to skip')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('pausefollowup')
    .setDescription('Stop chasing a specific lead')
    .addStringOption(opt =>
      opt.setName('username')
        .setDescription('BHW username to pause follow-ups for')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('reply')
    .setDescription('Send a reply message to a client on BHW')
    .addStringOption(opt =>
      opt.setName('username')
        .setDescription('BHW username of the client')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('message')
        .setDescription('Your reply text to send')
        .setRequired(true)
    ),
  new SlashCommandBuilder().setName('forcereport').setDescription('Send the daily report right now'),
  new SlashCommandBuilder().setName('community').setDescription('Community comment stats'),
  new SlashCommandBuilder().setName('help').setDescription('Show all commands'),
].map(cmd => cmd.toJSON());

// ─────────────────────────────────────────────────────────────────────────────
// DISCORD CHANNEL LISTENER — slash command registration
// ─────────────────────────────────────────────────────────────────────────────

let _running = false;

/**
 * Start the Discord command center.
 * Registers slash command handlers on the shared discord.js Client singleton.
 * Only processes interactions from the configured Discord channel (DISCORD_CHANNEL_ID).
 * Dispatches commands and replies to the same channel.
 *
 * Call this AFTER initDiscord() in index.js — the client must already be
 * initialized before registering handlers.
 *
 * Pass guildId to register commands instantly to a specific server
 * (recommended during setup). Omit for global registration (up to 1h delay).
 */
export async function startCommandCenter(guildId = process.env.DISCORD_GUILD_ID || null) {
  if (_running) return; // idempotent

  const channelId = getChannelId();
  logger.info(`[CommandCenter] Starting — Discord channel ID: ${channelId || '(not set)'}`);
  _running = true;

  const client = getClient();
  if (!client) {
    logger.error('[CommandCenter] Discord client not initialized — command center cannot start.');
    return;
  }

  // ── Register slash commands with Discord API ──────────────────────────────
  await registerSlashCommands(SLASH_COMMANDS, guildId);

  // ── Channel guard — only handle interactions from the configured channel ──
  const isFromChannel = (interaction) => {
    if (!channelId) return true; // dev mode: accept all channels
    const allowed = [String(channelId)];
    if (config.discord.clientInboxChannelId) allowed.push(String(config.discord.clientInboxChannelId));
    return allowed.includes(String(interaction.channelId));
  };

  // ── Interaction handler ───────────────────────────────────────────────────
  const handleInteraction = async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!isFromChannel(interaction)) return;

    const cmd = interaction.commandName;
    let responseText = null;

    try {
      switch (cmd) {
        case 'status':       responseText = await handleStatus();       break;
        case 'stats':        responseText = await handleStats();        break;
        case 'leads':        responseText = await handleLeads();        break;
        case 'handoffs':     responseText = await handleHandoffs();     break;
        case 'convos':       responseText = await handleConvos();       break;
        case 'followups':    responseText = await handleFollowUps();    break;
        case 'session':      responseText = await handleSession();      break;
        case 'pause':        responseText = await handlePause();        break;
        case 'resume':       responseText = await handleResume();       break;
        case 'forcereport':  responseText = await handleForceReport();  break;
        case 'community':    responseText = await handleCommunity();    break;
        case 'help':         responseText = await handleHelp();         break;

        case 'dryrun': {
          const mode = interaction.options.getString('mode');
          const on = mode === 'on';
          responseText = await handleDryRun(on);
          break;
        }

        case 'convert': {
          const username = interaction.options.getString('username')?.replace(/^@/, '').toLowerCase();
          responseText = await handleConvert(username);
          break;
        }

        case 'skip': {
          const username = interaction.options.getString('username')?.replace(/^@/, '').toLowerCase();
          responseText = await handleSkip(username);
          break;
        }

        case 'pausefollowup': {
          const username = interaction.options.getString('username')?.replace(/^@/, '').toLowerCase();
          responseText = await handlePauseFollowUp(username);
          break;
        }

        case 'reply': {
          await interaction.deferReply();
          const username = interaction.options.getString('username')?.replace(/^@/, '').trim();
          const message  = interaction.options.getString('message');
          responseText   = await handleReply(username, message);
          break;
        }
        default:
          responseText = `🤔 Unknown command \`/${cmd}\`.\nSend /help for the full command list.`;
      }
    } catch (err) {
      logger.error('[CommandCenter] Command handler error:', err.message);
      responseText = `⚠️ Error: ${err.message}`;
    }

    if (responseText) {
      await replyToInteraction(interaction, responseText);
    }
  };

  // Register the interaction listener on the Discord client
  client.on('interactionCreate', handleInteraction);

  logger.info('[CommandCenter] ✅ Discord slash commands registered.');

  // Startup ping (retry until bot is ready)
  const pingWhenReady = async (retries = 10) => {
    if (isReady()) {
      await reply('🟢 **Bot started.**\nSend /status for a full snapshot, or /help for commands.').catch(() => {});
      return;
    }
    if (retries > 0) setTimeout(() => pingWhenReady(retries - 1), 3000);
  };
  pingWhenReady();
}

export default { startCommandCenter };
