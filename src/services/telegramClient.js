/**
 * Telegram Client — Shared Singleton
 *
 * Uses Telegraf (official Telegram Bot API).
 * No QR scan, no session file, no auth hassle — just a bot token.
 * The bot must already be created via @BotFather and added to your group.
 *
 * Both commandCenter.js (inbound slash commands) and alerts.js (outbound alerts)
 * share this single Telegraf instance. Only one bot connection is ever open.
 *
 * ── SETUP (one-time, ~2 minutes) ──────────────────────────────────────────
 *  1. Create bot via @BotFather on Telegram → get the token
 *  2. Create a Telegram group, add the bot to it, give it admin rights
 *  3. Get the group chat ID (use @userinfobot or check Telegram API)
 *  4. Set env vars:
 *       TELEGRAM_BOT_TOKEN=<your-bot-token>
 *       TELEGRAM_GROUP_ID=<your-group-chat-id>  (e.g. -5054203181)
 *  5. Start the bot: node src/index.js
 *  No QR, no session, no re-auth ever needed.
 *
 * ── ENV VARS NEEDED ───────────────────────────────────────────────────────
 *  TELEGRAM_BOT_TOKEN  — bot token from @BotFather
 *  TELEGRAM_GROUP_ID   — numeric chat ID of the control group (negative for groups)
 */

import { Telegraf } from 'telegraf';
import logger from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Singleton state
// ─────────────────────────────────────────────────────────────────────────────

let _bot     = null;
let _ready   = false;
let _groupId = null;

/** Message listeners registered by commandCenter */
const _messageListeners = [];

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize the Telegram bot. Called once from index.js main().
 * Idempotent — safe to call multiple times.
 */
export async function initTelegram() {
  if (_bot) return _bot;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.error('[Telegram] TELEGRAM_BOT_TOKEN is not set in .env — cannot start Telegram bot.');
    return null;
  }

  _groupId = process.env.TELEGRAM_GROUP_ID || null;
  if (!_groupId) {
    logger.warn('[Telegram] TELEGRAM_GROUP_ID is not set — alerts will be skipped until configured.');
  }

  logger.info('[Telegram] Initializing bot…');
  _bot = new Telegraf(token);

  // ── Inbound messages — fan out to all registered listeners ────────────────
  _bot.on('message', async (ctx) => {
    for (const fn of _messageListeners) {
      try { await fn(ctx); } catch (err) {
        logger.error('[Telegram] Message listener error:', err.message);
      }
    }
  });

  // ── Error handler ────────────────────────────────────────────────────────
  _bot.catch((err) => {
    logger.error('[Telegram] Bot error:', err.message);
  });

  // ── Launch (long-polling) ─────────────────────────────────────────────────
  // bot.launch() runs indefinitely — do NOT await it directly.
  // Verify connection with getMe() first (10s timeout), then launch in background.
  // If Telegram is unreachable the bot keeps running — alerts are just skipped.
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Connection timeout after 10s')), 10000)
    );
    const me = await Promise.race([_bot.telegram.getMe(), timeout]);
    logger.info(`[Telegram] Connected as @${me.username} (id: ${me.id})`);

    // Launch long-polling in background (intentionally NOT awaited)
    _bot.launch().catch((err) => {
      logger.error(`[Telegram] Long-polling crashed: ${err.message}`);
    });

    _ready = true;
    logger.info('[Telegram] Bot launched and ready.');
  } catch (err) {
    logger.error(`[Telegram] Failed to connect to Telegram API: ${err.message}`);
    logger.warn('[Telegram] Bot will continue without Telegram — alerts/commands disabled.');
    _bot = null;
    _ready = false;
    return null;
  }

  if (_groupId) {
    logger.info(`[Telegram] Control group ID: ${_groupId}`);
  }

  // ── Graceful shutdown hooks ───────────────────────────────────────────────
  process.once('SIGINT',  () => _bot && _bot.stop('SIGINT'));
  process.once('SIGTERM', () => _bot && _bot.stop('SIGTERM'));

  return _bot;
}

/**
 * Send a message to the configured control group.
 * Uses HTML parse mode so bold/italic markup works in alerts.
 * Markdown asterisks (*bold*) are auto-converted to HTML (<b>bold</b>).
 * If the bot isn't ready, logs a warning and returns gracefully.
 */
export async function sendToGroup(text) {
  if (!_ready || !_bot) {
    logger.warn('[Telegram] Bot not ready — message skipped:', text.slice(0, 80));
    return { skipped: true };
  }

  if (!_groupId) {
    logger.warn('[Telegram] TELEGRAM_GROUP_ID not set — message skipped:', text.slice(0, 80));
    return { skipped: true };
  }

  try {
    // Convert WhatsApp-style *bold* to Telegram HTML <b>bold</b> for compatibility
    const html = markdownToHtml(text);
    await _bot.telegram.sendMessage(_groupId, html, { parse_mode: 'HTML' });
    return { sent: true };
  } catch (err) {
    logger.error('[Telegram] sendToGroup failed:', err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Register a listener for inbound Telegram messages/commands.
 * The listener receives the full Telegraf context object (ctx).
 */
export function onMessage(fn) {
  _messageListeners.push(fn);
}

/** Returns the Telegraf bot instance (for registering slash commands in commandCenter) */
export function getBot() { return _bot; }

/** Returns true when the Telegram bot is connected and ready */
export function isReady() { return _ready; }

/** Returns the configured group chat ID */
export function getGroupId() { return _groupId; }

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert WhatsApp/Markdown-style *bold* and _italic_ to Telegram HTML.
 * Also escapes characters that break Telegram HTML parse mode.
 */
function markdownToHtml(text) {
  if (!text) return '';

  // Escape HTML special chars first (before we add any HTML tags)
  let out = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // *bold* → <b>bold</b>  (must not cross newlines)
  out = out.replace(/\*([^\n*]+)\*/g, '<b>$1</b>');

  // _italic_ → <i>italic</i>
  out = out.replace(/_([^\n_]+)_/g, '<i>$1</i>');

  // `code` → <code>code</code>
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');

  return out;
}

export default { initTelegram, sendToGroup, onMessage, getBot, isReady, getGroupId };
