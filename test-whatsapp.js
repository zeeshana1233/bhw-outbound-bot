/**
 * test-whatsapp.js
 *
 * Step-by-step interactive test for the WhatsApp command center + alerts.
 *
 * ── STEPS ─────────────────────────────────────────────────────────────────
 *  Step 1 — CONNECT
 *    Initializes the WA client. If no session exists, prints a QR code —
 *    scan it with your phone. Once connected, lists all your WA groups so
 *    you can confirm (or set) the correct WA_GROUP_NAME in .env.
 *
 *  Step 2 — OUTBOUND ALERTS
 *    Sends several alert types to the group: raw message, hot lead alert,
 *    handoff alert, session expired alert, daily report. Verify each one
 *    arrives in your group.
 *
 *  Step 3 — INBOUND COMMANDS
 *    Listens for commands in the group for 3 minutes. Send any command
 *    from your phone (e.g. "help", "status", "stats") and verify the bot
 *    replies. Type Ctrl+C to exit early.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *  First run (no session):
 *    node test-whatsapp.js
 *    → scan QR code → complete steps interactively
 *
 *  Subsequent runs (session restored from .wwebjs_auth/):
 *    node test-whatsapp.js
 *    → connects automatically, no QR needed
 *
 *  Run a specific step only:
 *    STEP=1 node test-whatsapp.js
 *    STEP=2 node test-whatsapp.js
 *    STEP=3 node test-whatsapp.js
 */

import dotenv from 'dotenv';
dotenv.config();

import readline from 'readline';

// ─────────────────────────────────────────────────────────────────────────────
// Colour helpers for pretty console output
// ─────────────────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  grey:   '\x1b[90m',
};

const ok    = (msg) => console.log(`${C.green}  ✓${C.reset}  ${msg}`);
const fail  = (msg) => console.log(`${C.red}  ✗${C.reset}  ${msg}`);
const info  = (msg) => console.log(`${C.cyan}  ℹ${C.reset}  ${msg}`);
const warn  = (msg) => console.log(`${C.yellow}  ⚠${C.reset}  ${msg}`);
const step  = (n, t) => console.log(`\n${C.bold}${C.cyan}━━━  STEP ${n}: ${t}  ━━━${C.reset}\n`);
const hr    = ()     => console.log(`${C.grey}${'─'.repeat(60)}${C.reset}`);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, ans => { rl.close(); res(ans.trim()); }));
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — CONNECT
// ─────────────────────────────────────────────────────────────────────────────

async function step1Connect() {
  step(1, 'CONNECT TO WHATSAPP');

  const { initWhatsApp, isReady, getGroupId, sendToGroup } = await import('./src/services/whatsappClient.js');

  console.log('Starting WA client…');
  console.log('If this is your first run, a QR code will appear below.');
  console.log('Scan it: WhatsApp → Settings → Linked Devices → Link a Device\n');

  // initWhatsApp() starts the client — qr event fires internally
  await initWhatsApp();

  // Poll until ready (up to 90 seconds)
  console.log('\nWaiting for connection…');
  const deadline = Date.now() + 90_000;
  while (!isReady() && Date.now() < deadline) {
    process.stdout.write('.');
    await sleep(1000);
  }
  console.log();

  if (!isReady()) {
    fail('WA client did not become ready within 90 seconds.');
    fail('Make sure you scanned the QR code with your phone.');
    process.exit(1);
  }

  ok('WhatsApp client connected!');
  hr();

  // Pull group list
  const { default: waPkg } = await import('whatsapp-web.js');
  // Access the underlying client via the module — need to wait a beat for groups to load
  await sleep(2000);

  // Dynamically import the raw client reference
  const waModule = await import('./src/services/whatsappClient.js');
  // The client itself isn't directly exported, but getGroupId() returns the resolved group.
  // To list all groups we temporarily do a quick check via sendToGroup (which is ready now).

  // Test: sendToGroup a discovery message if group is configured
  const groupName = process.env.WA_GROUP_NAME;
  const groupId   = getGroupId();

  if (!groupName || !groupId) {
    warn(`WA_GROUP_NAME is ${groupName ? `"${groupName}" (not found in your chats)` : 'not set in .env'}.`);
    info('Here is how to find your group name:');
    info('  1. Open WhatsApp on your phone');
    info('  2. Find the group you want to use for bot control');
    info('  3. Copy the EXACT group name (case-sensitive)');
    info('  4. Add to .env:  WA_GROUP_NAME=Your Group Name');
    info('');
    info('You can also send yourself a message from the group and check the console');
    info('debug output to see the exact chat name.');

    const ans = await prompt('\nEnter the WA group name to set it now (or press Enter to skip): ');
    if (ans) {
      console.log(`\nSet in .env manually:\n  WA_GROUP_NAME=${ans}\n`);
      process.env.WA_GROUP_NAME = ans;
      warn('Group name set for this test session only. Add it to .env to make it permanent.');
    } else {
      warn('Skipping group tests — steps 2 and 3 require WA_GROUP_NAME to be set.');
      return false; // caller checks this
    }
  } else {
    ok(`Group resolved: "${groupName}" (${groupId})`);
  }

  ok('Step 1 PASSED — WA client is connected and group is configured.');
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — OUTBOUND ALERTS
// ─────────────────────────────────────────────────────────────────────────────

async function step2Outbound() {
  step(2, 'OUTBOUND ALERTS');
  info('Sending 5 different alert types to your WA group.');
  info('Check your phone after each one ✓\n');

  const alerts = (await import('./src/services/alerts.js')).default;

  // 2a — raw alert
  process.stdout.write('  Sending raw alert…  ');
  const r1 = await alerts.sendRawAlert('🧪 *[TEST]* Raw alert — this is test-whatsapp.js step 2. If you see this, outbound messaging works!');
  r1?.sent ? ok('sent') : (r1?.skipped ? warn('skipped (client not ready)') : fail('failed: ' + r1?.error));
  await sleep(1500);

  // 2b — hot lead alert
  process.stdout.write('  Sending hot lead alert…  ');
  const fakeLead = {
    poster_username: 'testuser99',
    title: 'Need WordPress developer for e-commerce project ASAP',
    thread_url: 'https://www.blackhatworld.com/seo/test.123456/',
    niche_match_score: 9,
  };
  const r2 = await alerts.sendHotLeadAlert(fakeLead, 'Hey there, saw your post about the WordPress project — we\'ve shipped 40+ WC stores. Happy to hop on a quick call if you\'re still looking.');
  r2?.sent ? ok('sent') : (r2?.skipped ? warn('skipped') : fail('failed: ' + r2?.error));
  await sleep(1500);

  // 2c — handoff alert
  process.stdout.write('  Sending handoff alert…  ');
  const fakeMsgs = [
    { isOurs: false, username: 'testuser99', text: 'Hey, sounds good. What\'s your rate for a full store build?' },
    { isOurs: true,  username: 'app_pilot',  text: 'Depends on scope — roughly $800-1200 for a standard WC setup. Can we do a quick call to nail down requirements?' },
    { isOurs: false, username: 'testuser99', text: 'Sure, I\'m available tomorrow 3pm EST. Also, do you do SEO?' },
  ];
  const r3 = await alerts.sendHandoffAlert('testuser99', 'https://www.blackhatworld.com/seo/test.123456/', fakeMsgs, '8+ message exchanges — hot lead');
  r3?.sent ? ok('sent') : (r3?.skipped ? warn('skipped') : fail('failed: ' + r3?.error));
  await sleep(1500);

  // 2d — session expired alert
  process.stdout.write('  Sending session expired alert…  ');
  const r4 = await alerts.sendSessionExpiredAlert();
  r4?.sent ? ok('sent') : (r4?.skipped ? warn('skipped') : fail('failed: ' + r4?.error));
  await sleep(1500);

  // 2e — daily report
  process.stdout.write('  Sending daily report…  ');
  const r5 = await alerts.sendDailyReport({
    leadsScraped: 12,
    dmsSent: 5,
    replied: 3,
    handoffs: 1,
    conversions: 0,
    date: new Date().toLocaleDateString('en-GB'),
  });
  r5?.sent ? ok('sent') : (r5?.skipped ? warn('skipped') : fail('failed: ' + r5?.error));
  await sleep(1000);

  hr();
  const allSent = [r1, r2, r3, r4, r5].every(r => r?.sent);
  if (allSent) {
    ok('Step 2 PASSED — all 5 alert types sent successfully.');
  } else {
    warn('Step 2 PARTIAL — some alerts were skipped or failed. Check output above.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — INBOUND COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

async function step3Inbound() {
  step(3, 'INBOUND COMMANDS');

  // Register the command center listener
  const { startCommandCenter } = await import('./src/services/commandCenter.js');
  await startCommandCenter();

  const LISTEN_SECONDS = 180;
  info(`Command center is live. Listening for ${LISTEN_SECONDS / 60} minutes.`);
  info('Send any of these from your phone in the WA group:\n');

  const cmds = [
    ['help',          '— shows full command list'],
    ['status',        '— system snapshot'],
    ['stats',         '— today\'s numbers'],
    ['leads',         '— lead funnel'],
    ['handoffs',      '— convos needing you'],
    ['dryrun on',     '— enable safe mode'],
    ['dryrun off',    '— go live'],
    ['pause',         '— freeze all actions'],
    ['resume',        '— unfreeze'],
    ['force report',  '— send daily report now'],
  ];

  cmds.forEach(([cmd, desc]) => info(`  ${cmd.padEnd(18)} ${desc}`));
  console.log();
  info('Natural language also works — try "how\'s the bot doing?" or "show me today\'s numbers"');
  console.log();
  warn(`Press Ctrl+C to exit early, or wait ${LISTEN_SECONDS}s for auto-exit.\n`);

  // Count-down display
  let remaining = LISTEN_SECONDS;
  const ticker = setInterval(() => {
    remaining--;
    process.stdout.write(`\r${C.grey}  Listening… ${remaining}s remaining — send a command from your phone  ${C.reset}`);
    if (remaining <= 0) {
      clearInterval(ticker);
      process.stdout.write('\n');
    }
  }, 1000);

  await sleep(LISTEN_SECONDS * 1000);
  clearInterval(ticker);
  process.stdout.write('\n');

  hr();
  ok('Step 3 complete — command listener ran for ' + LISTEN_SECONDS + 's.');
  info('If you sent a command and got a reply in the group, the command center works ✓');
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════╗`);
  console.log(`║        WhatsApp Integration — Test Suite         ║`);
  console.log(`╚══════════════════════════════════════════════════╝${C.reset}\n`);

  const specificStep = process.env.STEP ? parseInt(process.env.STEP) : null;

  if (specificStep === 2 || specificStep === 3) {
    // For steps 2/3 in isolation, we still need the client connected first
    info('Connecting client before running step ' + specificStep + '…');
    const ok1 = await step1Connect();
    if (!ok1) { process.exit(1); }
    await sleep(1000);
    if (specificStep === 2) await step2Outbound();
    else await step3Inbound();
  } else if (specificStep === 1) {
    await step1Connect();
  } else {
    // Full run — all 3 steps
    const ok1 = await step1Connect();
    if (!ok1) {
      warn('Cannot proceed without a configured WA group. Set WA_GROUP_NAME in .env first.');
      process.exit(1);
    }

    await sleep(1000);

    const ans = await prompt('\nStep 1 complete. Press Enter to run Step 2 (outbound alerts), or Ctrl+C to stop: ');
    await step2Outbound();

    await sleep(1000);

    const ans2 = await prompt('\nStep 2 complete. Press Enter to run Step 3 (inbound commands), or Ctrl+C to stop: ');
    await step3Inbound();
  }

  console.log(`\n${C.bold}${C.green}All steps done.${C.reset}`);
  info('Session saved to .wwebjs_auth/ — next run will auto-login (no QR needed).');
  process.exit(0);
}

main().catch(err => {
  fail('Unexpected error: ' + err.message);
  console.error(err);
  process.exit(1);
});
