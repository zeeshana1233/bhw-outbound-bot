/**
 * WhatsApp Client — Shared Singleton
 *
 * Uses whatsapp-web.js (unofficial WA Web mirror via Puppeteer).
 * QR scan once on first run → session saved to .wwebjs_auth/ on disk.
 * Every subsequent start auto-restores the session — no rescan needed.
 *
 * Both commandCenter.js (inbound commands) and alerts.js (outbound alerts)
 * share this single client instance. Only one WA session is ever open.
 *
 * ── FIRST-TIME SETUP ──────────────────────────────────────────────────────
 *  1. Start the bot: node src/index.js
 *  2. A QR code prints in the terminal — scan it with WhatsApp on your phone
 *     (WhatsApp → Settings → Linked Devices → Link a Device)
 *  3. Session is saved to .wwebjs_auth/ — never commit that folder
 *  4. All future starts auto-login — no QR needed again
 *
 *  If the session expires: delete .wwebjs_auth/ and rescan the QR.
 *
 * ── ENV VARS NEEDED ───────────────────────────────────────────────────────
 *  WA_GROUP_NAME   — exact name of your WhatsApp group (e.g. "Bitbash BHW Bot")
 *                    Bot sends all messages to this group and listens here.
 */

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode-terminal';
import fs     from 'fs';
import path   from 'path';
import logger  from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Singleton state
// ─────────────────────────────────────────────────────────────────────────────

let _client     = null;
let _ready      = false;
let _groupId    = null;   // resolved once on 'ready'

/** Message listeners registered by commandCenter */
const _messageListeners = [];

// ─────────────────────────────────────────────────────────────────────────────
// Build the client
// ─────────────────────────────────────────────────────────────────────────────

function buildClient() {
  // Prefer the Chrome exe path from env (required when running as a Windows service).
  // Falls back to letting puppeteer-core auto-discover (works on local dev).
  const chromePath = process.env.BHW_CHROME_PROFILE_PATH || null;

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      ...(chromePath ? { executablePath: chromePath } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
    webVersionCache: {
      type: 'none',
    }
  });

  // ── QR code ───────────────────────────────────────────────────────────────
  client.on('qr', (qr) => {
    logger.info('\n[WhatsApp] 📱  Scan this QR with WhatsApp → Settings → Linked Devices:\n');
    qrcode.generate(qr, { small: true });
    logger.info('[WhatsApp] Waiting for scan…');

    // Also write a scannable HTML file — open C:\bhw-bot\qr.html in Chrome on server
    try {
      const htmlPath = path.resolve('qr.html');
      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>BHW Bot — Scan WhatsApp QR</title>
<style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;background:#111;color:#fff;}
h2{margin-bottom:8px;}p{color:#aaa;margin:4px 0;}canvas{margin-top:20px;border:16px solid #fff;border-radius:8px;}</style>
</head><body>
<h2>📱 Scan with WhatsApp</h2>
<p>WhatsApp → Settings → Linked Devices → Link a Device</p>
<p style="color:#f90">QR expires in ~60s — refresh page if expired (restart bot service)</p>
<canvas id="qr"></canvas>
<script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>
<script>QRCode.toCanvas(document.getElementById('qr'),'${qr.replace(/'/g, "\\'")}',{width:320,margin:2},function(e){if(e)document.body.innerHTML+='<p style=color:red>'+e+'</p>';});</script>
</body></html>`;
      fs.writeFileSync(htmlPath, html, 'utf8');
      logger.info(`[WhatsApp] 🌐  QR also saved → ${htmlPath}  (open in Chrome on this machine)`);
    } catch (e) {
      // non-fatal — log continues to work regardless
    }
  });

  // ── Ready ─────────────────────────────────────────────────────────────────
  client.on('ready', async () => {
    _ready = true;
    logger.info('[WhatsApp] ✅  Client ready — session active.');

    // Resolve the command group ID once, cache it
    const groupName = process.env.WA_GROUP_NAME || 'Bitbash BHW Bot';
    try {
      const chats = await client.getChats();
      const group = chats.find(c => c.isGroup && c.name === groupName);
      if (group) {
        _groupId = group.id._serialized;
        logger.info(`[WhatsApp] ✅  Command group resolved: "${groupName}" (${_groupId})`);
      } else {
        logger.warn(`[WhatsApp] ⚠️  Group "${groupName}" not found. Set WA_GROUP_NAME in .env to the exact group name.`);
        logger.warn('[WhatsApp] Available groups: ' + chats.filter(c => c.isGroup).map(c => `"${c.name}"`).join(', '));
      }
    } catch (err) {
      logger.error('[WhatsApp] Could not resolve group:', err.message);
    }
  });

  // ── Auth failure ──────────────────────────────────────────────────────────
  client.on('auth_failure', (msg) => {
    logger.error('[WhatsApp] Auth failed:', msg);
    logger.error('[WhatsApp] Delete .wwebjs_auth/ and restart to rescan QR.');
    _ready = false;
  });

  client.on('disconnected', (reason) => {
    logger.warn('[WhatsApp] Disconnected:', reason);
    _ready = false;
  });

  // ── Inbound messages — fan out to all registered listeners ────────────────
  client.on('message', async (msg) => {
    for (const fn of _messageListeners) {
      try { await fn(msg); } catch (err) {
        logger.error('[WhatsApp] Message listener error:', err.message);
      }
    }
  });

  return client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize the WhatsApp client. Called once from index.js main().
 * Idempotent — safe to call multiple times.
 */
export async function initWhatsApp() {
  if (_client) return _client;
  logger.info('[WhatsApp] Initializing client… (first run: scan QR code)');
  _client = buildClient();
  await _client.initialize();
  return _client;
}

/**
 * Send a message to the configured command group.
 * If the client isn't ready, logs a warning and returns gracefully.
 */
export async function sendToGroup(text) {
  if (!_ready || !_client) {
    logger.warn('[WhatsApp] Client not ready — message queued but not sent:', text.slice(0, 80));
    return { skipped: true };
  }

  if (!_groupId) {
    logger.warn('[WhatsApp] Group ID not resolved yet — cannot send:', text.slice(0, 80));
    return { skipped: true };
  }

  try {
    await _client.sendMessage(_groupId, text);
    return { sent: true };
  } catch (err) {
    logger.error('[WhatsApp] sendToGroup failed:', err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Register a listener for inbound WhatsApp messages.
 * The listener receives the raw whatsapp-web.js Message object.
 */
export function onMessage(fn) {
  _messageListeners.push(fn);
}

/** Returns true when the WA client is connected and ready */
export function isReady() { return _ready; }

/** Returns the resolved group chat ID (or null if not found yet) */
export function getGroupId() { return _groupId; }

export default { initWhatsApp, sendToGroup, onMessage, isReady, getGroupId };
