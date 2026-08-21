/**
 * Discord Client — Shared Singleton
 *
 * Uses discord.js (official Discord Bot API).
 * No QR scan, no session file, no auth hassle — just a bot token.
 * The bot must already be created via the Discord Developer Portal and
 * added to your server with the correct permissions.
 *
 * Both commandCenter.js (inbound slash commands) and alerts.js (outbound alerts)
 * share this single discord.js Client instance. Only one bot connection is ever open.
 *
 * ── SETUP (one-time, ~5 minutes) ──────────────────────────────────────────
 *  1. Go to https://discord.com/developers/applications → New Application
 *  2. Bot tab → Add Bot → copy the token
 *  3. OAuth2 → URL Generator → scopes: bot + applications.commands
 *     Bot permissions: Send Messages, Read Message History, Use Slash Commands
 *  4. Use the generated URL to invite the bot to your server
 *  5. Get the channel ID: right-click the channel in Discord → Copy Channel ID
 *     (requires Developer Mode: User Settings → Advanced → Developer Mode)
 *  6. Set env vars:
 *       DISCORD_BOT_TOKEN=<your-bot-token>
 *       DISCORD_CHANNEL_ID=<your-channel-id>  (e.g. 1234567890123456789)
 *  7. Start the bot: node src/index.js
 *  No QR, no session, no re-auth ever needed.
 *
 * ── ENV VARS NEEDED ───────────────────────────────────────────────────────
 *  DISCORD_BOT_TOKEN   — bot token from Discord Developer Portal
 *  DISCORD_CHANNEL_ID  — snowflake ID of the control channel
 *  DISCORD_PROXY_URL   — (optional) HTTP/SOCKS5 proxy (not natively supported
 *                        by discord.js; configure at the OS/network level instead)
 */

import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import logger from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Singleton state
// ─────────────────────────────────────────────────────────────────────────────

let _client    = null;
let _ready     = false;
let _channelId = null;
let _botId     = null;

/** Message listeners registered by commandCenter */
const _messageListeners = [];

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize the Discord bot. Called once from index.js main().
 * Idempotent — safe to call multiple times.
 */
export async function initDiscord() {
  if (_client && _ready) return _client;

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    logger.error('[Discord] DISCORD_BOT_TOKEN is not set in .env — cannot start Discord bot.');
    return null;
  }

  _channelId = process.env.DISCORD_CHANNEL_ID || null;
  if (!_channelId) {
    logger.warn('[Discord] DISCORD_CHANNEL_ID is not set — alerts will be skipped until configured.');
  }

  logger.info('[Discord] Initializing bot…');

  _client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
    ],
  });

  // ── Inbound messages — fan out to all registered listeners ────────────────
  _client.on('messageCreate', async (message) => {
    if (message.author.bot) return; // ignore other bots
    for (const fn of _messageListeners) {
      try { await fn(message); } catch (err) {
        logger.error('[Discord] Message listener error:', err.message);
      }
    }
  });

  // ── Error handler ────────────────────────────────────────────────────────
  _client.on('error', (err) => {
    logger.error('[Discord] Client error:', err.message);
  });

  // ── Connect ───────────────────────────────────────────────────────────────
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() =>
        reject(new Error('Connection timeout after 15s')), 15000
      );

      _client.once('ready', (c) => {
        clearTimeout(timeout);
        _botId = c.user.id;
        logger.info(`[Discord] Connected as ${c.user.tag} (id: ${c.user.id})`);
        _ready = true;
        resolve(c);
      });

      _client.login(token).catch(reject);
    });

    logger.info('[Discord] Bot launched and ready.');
  } catch (err) {
    logger.error(`[Discord] Failed to connect to Discord API: ${err.message}`);
    logger.warn('[Discord] Bot will continue without Discord — alerts/commands disabled.');
    _client = null;
    _ready  = false;
    return null;
  }

  if (_channelId) {
    logger.info(`[Discord] Control channel ID: ${_channelId}`);
  }

  // ── Graceful shutdown hooks ───────────────────────────────────────────────
  process.once('SIGINT',  () => _client && _client.destroy());
  process.once('SIGTERM', () => _client && _client.destroy());

  return _client;
}

/**
 * Send a message to the configured control channel.
 * Discord natively renders **bold**, _italic_, and `code` Markdown.
 * Converts legacy *bold* (single asterisk) to **bold** (double) before sending.
 * If the bot isn't ready, logs a warning and returns gracefully.
 */
export async function sendToChannel(text) {
  if (!_ready || !_client) {
    logger.warn(`[Discord] Bot not ready — message skipped: ${text.slice(0, 80)}`);
    return { skipped: true };
  }

  if (!_channelId) {
    logger.warn('[Discord] DISCORD_CHANNEL_ID not set — message skipped:', text.slice(0, 80));
    return { skipped: true };
  }

  try {
    const channel = await _client.channels.fetch(_channelId);
    if (!channel) {
      logger.warn('[Discord] Channel not found:', _channelId);
      return { skipped: true };
    }

    // Convert legacy single-asterisk *bold* → **bold** (Discord Markdown)
    const formatted = normalizeMarkdown(text);

    // Discord has a 2000-char limit per message — split if needed
    const chunks = splitMessage(formatted, 2000);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }

    return { sent: true };
  } catch (err) {
    logger.error('[Discord] sendToChannel failed:', err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Register a listener for inbound Discord messages and slash command interactions.
 * Receives either a discord.js Message or a ChatInputCommandInteraction.
 */
export function onMessage(fn) {
  _messageListeners.push(fn);
}

/**
 * Send a message to an arbitrary channel ID.
 * Used by Pipeline C (job notifier) so it can target a dedicated channel
 * without touching the main DISCORD_CHANNEL_ID config.
 *
 * @param {string} channelId - Discord snowflake channel ID
 * @param {string} text      - Message content (Discord Markdown)
 */
export async function sendToChannelById(channelId, text) {
  if (!_ready || !_client) {
    logger.warn(`[Discord] Bot not ready — Pipeline C message skipped: ${text.slice(0, 80)}`);
    return { skipped: true };
  }

  if (!channelId) {
    logger.warn('[Discord] sendToChannelById — no channelId provided, message skipped.');
    return { skipped: true };
  }

  try {
    const channel = await _client.channels.fetch(channelId);
    if (!channel) {
      logger.warn('[Discord] Channel not found:', channelId);
      return { skipped: true };
    }

    const formatted = normalizeMarkdown(text);
    const chunks    = splitMessage(formatted, 2000);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }

    return { sent: true };
  } catch (err) {
    logger.error('[Discord] sendToChannelById failed:', err.message);
    return { sent: false, error: err.message };
  }
}

/** Returns the discord.js Client instance */
export function getClient() { return _client; }

/** Returns true when the Discord bot is connected and ready */
export function isReady() { return _ready; }

/** Returns the configured control channel ID */
export function getChannelId() { return _channelId; }

/** Returns the bot's own user ID (used by commandCenter to filter self-messages) */
export function getBotId() { return _botId; }

/**
 * Register application (slash) commands with Discord's API.
 * Call this after the client is ready so the bot token is valid.
 *
 * @param {Array}  commands  - Array of SlashCommandBuilder .toJSON() definitions
 * @param {string} guildId   - Optional: register to a specific guild (instant update).
 *                             Omit to register globally (up to 1h propagation delay).
 */
export async function registerSlashCommands(commands, guildId = null) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || !_botId) {
    logger.warn('[Discord] Cannot register slash commands — bot not ready.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    if (guildId) {
      await rest.put(
        Routes.applicationGuildCommands(_botId, guildId),
        { body: commands }
      );
      logger.info(`[Discord] Slash commands registered to guild ${guildId}.`);
    } else {
      await rest.put(
        Routes.applicationCommands(_botId),
        { body: commands }
      );
      logger.info('[Discord] Slash commands registered globally (may take up to 1h to propagate).');
    }
  } catch (err) {
    logger.error('[Discord] Failed to register slash commands:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert legacy single-asterisk *bold* to Discord **bold**
 * (double asterisk). Discord natively renders _italic_ and `code` already.
 * Does NOT escape anything — Discord does not use an HTML parse mode.
 */
function normalizeMarkdown(text) {
  if (!text) return '';
  // *bold* → **bold** (single asterisk that isn't already doubled)
  // Use a negative lookahead/lookbehind to avoid doubling already-doubled **
  return text.replace(/(?<!\*)\*(?!\*)([^\n*]+)\*(?!\*)/g, '**$1**');
}

/**
 * Split a long string into chunks no longer than maxLen characters,
 * preferring to split at newlines to keep formatting intact.
 */
function splitMessage(text, maxLen = 2000) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Try to split at the last newline before the limit
    const splitAt = remaining.lastIndexOf('\n', maxLen);
    const cutAt   = splitAt > 0 ? splitAt : maxLen;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export default { initDiscord, sendToChannel, sendToChannelById, onMessage, getClient, isReady, getChannelId, getBotId, registerSlashCommands };
