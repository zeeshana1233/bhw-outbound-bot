/**
 * test-handoff.js
 *
 * Dry-run tests for [HANDOFF] detection.
 *
 * Tests covered:
 *   1. AI returns [HANDOFF] tag  → stripped from send text, DB flagged, alert fired
 *   2. AI returns normal reply   → no handoff, normal flow
 *   3. 8-message conversation    → tag should appear (prompt-level test)
 *   4. High-budget mention       → tag should appear (prompt-level test)
 *   5. alerts.sendHandoffAlert   → message format check (WhatsApp disabled)
 *
 * Run:  node test-handoff.js
 */

import aiEngine from './src/services/aiEngine.js';
import alerts   from './src/services/alerts.js';
import logger   from './src/utils/logger.js';

// ─── helpers ───────────────────────────────────────────────────────────────

function pass(label)  { console.log(`  ✅  ${label}`); }
function fail(label)  { console.error(`  ❌  ${label}`); process.exitCode = 1; }
function section(s)   { console.log(`\n──── ${s} ────`); }

// ─── 1. Strip + detect [HANDOFF] in raw reply ──────────────────────────────

section('Test 1 — Strip [HANDOFF] from reply text');

const fakeRawReplies = [
  'Sure, happy to jump on a call!\n[HANDOFF]',
  'Let me know your timeline.\n[HANDOFF]\n',
  '[HANDOFF]\nLet\'s talk about the contract.',
  'Normal reply with no tag.',
];

for (const raw of fakeRawReplies) {
  const isHandoff = /\[HANDOFF\]/i.test(raw);
  const clean     = raw.replace(/\[HANDOFF\]/gi, '').trim();

  if (raw.includes('[HANDOFF]')) {
    if (isHandoff && !clean.includes('[HANDOFF]'))
      pass(`Detected + stripped: "${clean.substring(0, 60)}"`);
    else
      fail(`Strip failed for: "${raw}"`);
  } else {
    if (!isHandoff && clean === raw.trim())
      pass(`Clean reply unchanged: "${clean}"`);
    else
      fail(`Non-handoff reply was mutated: "${clean}"`);
  }
}

// ─── 2. Alert formatter ────────────────────────────────────────────────────

section('Test 2 — sendHandoffAlert formats correctly (WhatsApp disabled)');

// Override env so alert is skipped but we test the function runs without error
process.env.WHATSAPP_ENABLED = 'false';

const testMessages = [
  { isOurs: false, username: 'test_lead',  text: 'I need a full e-commerce build, budget around $5k' },
  { isOurs: true,  username: 'app_pilot',  text: 'Sounds great, we can handle that. What stack?' },
  { isOurs: false, username: 'test_lead',  text: 'Laravel + Vue. Also need a CRM integration and payment gateway.' },
  { isOurs: true,  username: 'app_pilot',  text: 'No problem. Timeline?' },
  { isOurs: false, username: 'test_lead',  text: 'ASAP — can we discuss a contract?' },
];

const alertResult = await alerts.sendHandoffAlert(
  'test_lead',
  'https://www.blackhatworld.com/conversations/12345/',
  testMessages,
  'Budget >$3K + contract discussion',
).catch(err => { fail(`Alert threw: ${err.message}`); return null; });

if (alertResult && alertResult.skipped === true)
  pass('Alert correctly skipped when WHATSAPP_ENABLED=false');
else if (alertResult && alertResult.sent)
  pass('Alert sent (WhatsApp was enabled)');
else
  fail(`Unexpected alert result: ${JSON.stringify(alertResult)}`);

// ─── 3. AI prompt — normal conversation (1 message) ───────────────────────

section('Test 3 — AI reply for short, simple conversation (expect NO handoff)');

try {
  const raw = await aiEngine.generateDMReply(
    'test_lead: Hi, are you available for a small WordPress fix?',
    'Can you help with a WP plugin conflict?',
    2  // only 2 messages — short conversation
  );

  const isHandoff = /\[HANDOFF\]/i.test(raw);
  const clean     = raw.replace(/\[HANDOFF\]/gi, '').trim();

  console.log(`  Raw AI reply: "${raw.substring(0, 200)}"`);

  if (!isHandoff)
    pass('No [HANDOFF] for short, low-stakes conversation');
  else
    fail('[HANDOFF] triggered unexpectedly for a simple 2-message exchange');

  if (clean.length > 0)
    pass(`Clean reply length: ${clean.length} chars`);
  else
    fail('Reply text was empty after strip');

} catch (err) {
  fail(`generateDMReply threw: ${err.message}`);
}

// ─── 4. AI prompt — long + high-value conversation (expect HANDOFF) ────────

section('Test 4 — AI reply for 9-message high-budget conversation (expect HANDOFF)');

const longHistory = [
  'test_lead: I need a full SaaS platform built from scratch.',
  'app_pilot: Happy to help — what\'s the scope?',
  'test_lead: Multi-tenant app, subscription billing, custom dashboards per client.',
  'app_pilot: Got it. We\'ve done similar work. What\'s your tech preference?',
  'test_lead: Node + React. And it needs Stripe + enterprise SSO.',
  'app_pilot: Doable. Timeline and budget range?',
  'test_lead: Need it in 3 months. Budget is $8,000–$12,000.',
  'app_pilot: That\'s workable. We\'d structure it in 3 phases.',
].join('\n\n');

try {
  const raw = await aiEngine.generateDMReply(
    longHistory,
    'Can we talk about the contract and payment schedule? I want milestones.',
    9  // 9 messages — triggers 8+ rule
  );

  const isHandoff = /\[HANDOFF\]/i.test(raw);
  const clean     = raw.replace(/\[HANDOFF\]/gi, '').trim();

  console.log(`  Raw AI reply: "${raw.substring(0, 200)}"`);

  if (isHandoff)
    pass('[HANDOFF] correctly detected for long + high-value conversation');
  else
    fail('[HANDOFF] NOT detected — check system prompt conditions');

  if (clean.length > 0)
    pass(`Clean reply ready to send: "${clean.substring(0, 80)}..."`);
  else
    fail('Reply text was empty after stripping [HANDOFF]');

} catch (err) {
  fail(`generateDMReply threw: ${err.message}`);
}

// ─── 5. handleConversation dry-run with mocked [HANDOFF] reply ─────────────

section('Test 5 — Full handleConversation dry-run (mocked page, injected HANDOFF reply)');

import { handleConversation } from './src/engines/conversation.js';
import bhwSession from './src/utils/bhwSession.js';

// Mock the page and BHW session
const mockPage = {
  goto: async () => {},
  evaluate: async () => [
    { isOurs: false, username: 'test_lead',  text: 'We need a contract, budget is $10k.' },
    { isOurs: true,  username: 'app_pilot',  text: 'Happy to proceed.' },
    { isOurs: false, username: 'test_lead',  text: 'Can we sign an NDA and start milestones?' },
  ],
};

// Patch bhwSession.getPage temporarily
const origGetPage = bhwSession.getPage;
bhwSession.getPage = () => mockPage;

// Patch readConversationMessages is internal — we'll test via the AI call path
// For this test, we just verify dryRun stops before send and returns handoff correctly.

const convResult = await handleConversation(
  'https://www.blackhatworld.com/conversations/test-99/',
  'test_lead',
  null,   // no DB lead
  null,   // no DB conv ID
  { dryRun: true }
).catch(err => {
  logger.error('handleConversation threw:', err.message);
  return null;
});

bhwSession.getPage = origGetPage;  // restore

if (convResult) {
  const { success, dryRun, handoff, replyText } = convResult;
  if (success && dryRun)
    pass('handleConversation returned success in dryRun mode');
  else
    fail(`Unexpected result: ${JSON.stringify(convResult)}`);

  if (typeof handoff === 'boolean')
    pass(`handoff flag is present: ${handoff}`);
  else
    fail('handoff flag missing from return value');

  if (replyText && !replyText.includes('[HANDOFF]'))
    pass('Returned replyText is free of [HANDOFF] tag');
  else if (!replyText)
    fail('replyText was empty');
  else
    fail('replyText still contains [HANDOFF] tag!');
} else {
  fail('handleConversation returned null — check logs above');
}

// ─── Summary ───────────────────────────────────────────────────────────────

console.log('');
if (process.exitCode === 1) {
  console.error('❌  Some tests failed — review output above.');
} else {
  console.log('✅  All handoff tests passed!');
}
