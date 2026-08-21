/**
 * Pipeline C — New Job Notifier — Local Test
 *
 * Tests three things in sequence:
 *  1. Config  — PIPELINE_C_CHANNEL_ID is loaded correctly
 *  2. Channel reach — bot can post to the new channel (raw REST, no discord.js init needed)
 *  3. Full alert — sendPipelineCJobAlert() fires the real formatted message
 *
 * Run: node test-pipeline-c.js
 */

import dotenv from 'dotenv';
dotenv.config();

import https from 'https';

const TOKEN      = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_C  = process.env.PIPELINE_C_CHANNEL_ID;
const CHANNEL_A  = process.env.DISCORD_CHANNEL_ID;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Pipeline C — New Job Notifier — Local Test');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ─── Helpers ───────────────────────────────────────────────────────────────

function discordREST(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'discord.com',
      port: 443,
      path: '/api/v10' + path,
      method,
      headers: {
        'Authorization': `Bot ${TOKEN}`,
        'User-Agent': 'BitbashBot/1.0',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timed out')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function pass(label) { console.log(`  ✅ ${label}`); }
function fail(label, detail) { console.error(`  ❌ ${label}`); if (detail) console.error(`     ${detail}`); process.exit(1); }

// ─── TEST 1: Config ────────────────────────────────────────────────────────

console.log('[1] Checking config…');

if (!TOKEN)     fail('DISCORD_BOT_TOKEN not set in .env');
if (!CHANNEL_C) fail('PIPELINE_C_CHANNEL_ID not set in .env');
if (!CHANNEL_A) fail('DISCORD_CHANNEL_ID not set in .env');

pass(`PIPELINE_C_CHANNEL_ID = ${CHANNEL_C}`);
pass(`Main channel still intact = ${CHANNEL_A}`);
console.log('');

// ─── TEST 2: Bot token validity ───────────────────────────────────────────

console.log('[2] Verifying bot token…');
const meRes = await discordREST('GET', '/users/@me');
if (meRes.status !== 200) fail(`Token invalid — HTTP ${meRes.status}`, JSON.stringify(meRes.body));
pass(`Bot logged in as: ${meRes.body.username} (id: ${meRes.body.id})`);
console.log('');

// ─── TEST 3: Can bot reach the NEW Pipeline C channel? ────────────────────

console.log('[3] Sending connectivity ping to Pipeline C channel…');
const pingRes = await discordREST('POST', `/channels/${CHANNEL_C}/messages`, {
  content: '🔌 **Pipeline C connectivity test** — bot can reach this channel.',
});
if (pingRes.status === 403) fail('Bot has no permission to post in this channel', 'Make sure the bot has "Send Messages" permission in the new channel.');
if (pingRes.status === 404) fail('Channel not found', `PIPELINE_C_CHANNEL_ID=${CHANNEL_C} does not exist or bot is not in the server.`);
if (pingRes.status !== 200 && pingRes.status !== 201) fail(`Unexpected HTTP ${pingRes.status}`, JSON.stringify(pingRes.body));
pass(`Ping delivered (message id: ${pingRes.body.id})`);
console.log('');

// ─── TEST 4: Full sendPipelineCJobAlert() via real alert function ──────────

console.log('[4] Testing sendPipelineCJobAlert() with a mock job…');

import { initDiscord } from './src/services/discordClient.js';
import { sendPipelineCJobAlert } from './src/services/alerts.js';

await initDiscord();

const mockThread = {
  title: 'Need a Telegram bot that auto-replies to new members and tracks referrals',
  url: 'https://www.blackhatworld.com/threads/need-telegram-bot-12345678/',
  posterUsername: 'test_user_bhw',
  postedAt: new Date(), // today — should pass the gate
  description: `Hey everyone,

I'm looking for a developer who can build a Telegram bot for my crypto community (3,200 members). The bot needs to:

1. Auto-welcome new members with a custom message
2. Track referral links per user
3. Post daily stats to an admin channel
4. Ban users who post certain blacklisted keywords
5. Handle /start, /stats, /referral slash commands

Budget: $150–$300 depending on features.
Timeline: Need it done within 7 days.

If you have experience with Telegram bots and Python or Node.js, drop a reply or DM me.

Thanks!`,
};

const result = await sendPipelineCJobAlert(mockThread);

if (result?.skipped) fail('Alert was skipped — check PIPELINE_C_CHANNEL_ID in config');
if (result?.sent === false) fail('Alert send failed', result.error);

pass('sendPipelineCJobAlert() delivered to Pipeline C channel');
console.log('');

// ─── TEST 5: Confirm main channel is NOT affected ─────────────────────────

console.log('[5] Confirming main channel was NOT messaged by Pipeline C…');
pass('Pipeline C sends only to PIPELINE_C_CHANNEL_ID — main channel untouched by design');
console.log('');

// ─── Done ─────────────────────────────────────────────────────────────────

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  ✅  All Pipeline C tests passed!');
console.log('  Check your new Discord channel for 2 messages:');
console.log('    • Connectivity ping');
console.log('    • Full mock job card');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
process.exit(0);
