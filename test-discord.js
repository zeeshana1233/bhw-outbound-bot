// Quick Discord connectivity test — node test-discord.js
// Tests: REST API token validity (getMe), then sends a test message to the channel.
//
// Usage:
//   DISCORD_BOT_TOKEN=<token> DISCORD_CHANNEL_ID=<id> node test-discord.js
//   — or — set the vars in .env and run: node -r dotenv/config test-discord.js

import https from 'https';

const TOKEN     = process.env.DISCORD_BOT_TOKEN;
const CHANNEL   = process.env.DISCORD_CHANNEL_ID;
const API_BASE  = 'discord.com';
const API_VER   = '/api/v10';

if (!TOKEN) {
  console.error('ERROR: DISCORD_BOT_TOKEN is not set.');
  process.exit(1);
}

console.log('--- Discord connectivity test ---');
console.log(`Token: ${TOKEN.slice(0, 10)}…`);
console.log(`Channel ID: ${CHANNEL || '(not set — message send test will be skipped)'}`);
console.log('');

// ─── Helper: Discord REST request ─────────────────────────────────────────

function discordRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: API_BASE,
      port:     443,
      path:     API_VER + path,
      method,
      headers: {
        'Authorization': `Bot ${TOKEN}`,
        'User-Agent':    'BitbashBot/1.0 (https://bitbash.co.uk)',
        ...(payload ? {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out after 10s')); });
    req.on('error',   (e) => reject(e));

    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Test 1: Token validity (GET /users/@me) ──────────────────────────────

console.log('[1] Testing token — GET /users/@me …');

try {
  const res = await discordRequest('GET', '/users/@me');
  if (res.status === 200) {
    console.log(`[1] ✅ Token valid — logged in as: ${res.body.username}#${res.body.discriminator} (id: ${res.body.id})`);
  } else {
    console.error(`[1] ❌ Token invalid — HTTP ${res.status}:`, JSON.stringify(res.body));
    process.exit(1);
  }
} catch (err) {
  console.error('[1] ❌ Connection failed:', err.message);
  process.exit(1);
}

// ─── Test 2: Send test message to channel ─────────────────────────────────

if (!CHANNEL) {
  console.log('[2] Skipped — DISCORD_CHANNEL_ID not set.');
  process.exit(0);
}

console.log(`\n[2] Sending test message to channel ${CHANNEL} …`);

try {
  const res = await discordRequest('POST', `/channels/${CHANNEL}/messages`, {
    content: '✅ **Discord connectivity test passed.** Bot token and channel ID are correctly configured.',
  });

  if (res.status === 200 || res.status === 201) {
    console.log('[2] ✅ Message sent successfully.');
    console.log(`    Message ID: ${res.body.id}`);
    console.log('\n✅ All tests passed — Discord is fully configured.');
    process.exit(0);
  } else {
    console.error(`[2] ❌ Message send failed — HTTP ${res.status}:`, JSON.stringify(res.body));
    if (res.status === 403) {
      console.error('    Hint: Bot is missing "Send Messages" permission in that channel.');
    } else if (res.status === 404) {
      console.error('    Hint: Channel not found — check DISCORD_CHANNEL_ID is correct.');
    }
    process.exit(1);
  }
} catch (err) {
  console.error('[2] ❌ Request failed:', err.message);
  process.exit(1);
}
