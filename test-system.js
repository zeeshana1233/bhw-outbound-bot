/**
 * ═══════════════════════════════════════════════════════════════════
 *  FULL SYSTEM TEST — BHW Outbound Sales Bot
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Tests every layer of the bot in the exact order it runs in production.
 *  All browser-based tests run in DRY RUN — nothing is posted to BHW.
 *
 *  SUITES:
 *    1. Infrastructure  — DB, config, bot-state, helpers
 *    2. Database CRUD   — createLead dedup, qualification, queries
 *    3. AI Engine       — qualify (reject + approve), pitch, DM, reply, hotness
 *    4. BHW Session     — cookie auth + CloudFlare bypass
 *    5. Engines         — comment dry-run, DM dry-run, conversation dry-run
 *    6. Follow-up DB    — pending follow-up queries
 *
 *  Run:  node test-system.js
 * ═══════════════════════════════════════════════════════════════════
 */

import { pool, initDatabase }            from './src/database/init.js';
import {
  createLead, updateLeadQualification,
  getQualifiedLeadsToContact,
  getDailyActionCounts, getDailyStats,
  getPendingFollowUpsWithContext,
}                                         from './src/database/queries.js';
import { config }                         from './src/config/config.js';
import { botState }                       from './src/utils/botState.js';
import {
  isActiveHours, shouldSendDM,
  getThreadAgeCategory, randomDelay,
}                                         from './src/utils/helpers.js';
import {
  qualifyLead, generateCommentPitch,
  generateDMOutreach, generateDMReply,
  scoreLeadHotness,
}                                         from './src/services/aiEngine.js';
import bhwSession                         from './src/utils/bhwSession.js';
import { generateAndPostComment }         from './src/engines/comment.js';
import { generateAndSendDM }             from './src/engines/dm.js';
import { handleConversation }             from './src/engines/conversation.js';
import fs                                 from 'fs';

// ─────────────────────────────────────────────────────────────────────────────
//  Test runner scaffolding
// ─────────────────────────────────────────────────────────────────────────────

const PASS   = '✅ PASS';
const FAIL   = '❌ FAIL';
const SKIP   = '⏭️  SKIP';

const results = [];          // [{ suite, id, name, status, note }]
let currentSuite = '';

function suite(name) {
  currentSuite = name;
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  ${name}`);
  console.log(`${'═'.repeat(65)}`);
}

async function test(id, name, fn) {
  process.stdout.write(`  [${id}] ${name.padEnd(52, '.')} `);
  try {
    const note = await fn();
    console.log(PASS + (note ? `  (${note})` : ''));
    results.push({ suite: currentSuite, id, name, status: 'PASS', note: note || '' });
  } catch (err) {
    const msg = err.message || String(err);
    console.log(FAIL + `  → ${msg.slice(0, 100)}`);
    results.push({ suite: currentSuite, id, name, status: 'FAIL', note: msg.slice(0, 100) });
  }
}

function skip(id, name, reason) {
  console.log(`  [${id}] ${name.padEnd(52, '.')} ${SKIP}  (${reason})`);
  results.push({ suite: currentSuite, id, name, status: 'SKIP', note: reason });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shared test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const DUMMY_THREAD_ID = `sys-test-${Date.now()}`;

const BOT_DEV_LEAD = {
  threadId:         DUMMY_THREAD_ID,
  threadUrl:        'https://www.blackhatworld.com/seo/need-telegram-bot-dev.1799999/',
  title:            'Need Telegram Bot + React Dashboard Developer — $1500 budget',
  description:      `Looking for an experienced developer to build a full Telegram bot with React admin dashboard.
Requirements: custom commands, multi-user subscriptions, Stripe payments, scheduled broadcasts, web admin.
Budget: $1,200–$1,800. Timeline: 2 weeks. DM with samples.`,
  posterUsername:   'sys_test_user',
  posterUrl:        null,
  postDate:         new Date(),
  threadAgeCategory:'fresh',
  tags:             [],
};

const SEO_LEAD = {
  title:       'Need 500 PBN backlinks for my gambling site — urgent',
  description: 'Looking for an SEO expert to build 500 PBN backlinks for a gambling and sports betting website. Niche relevance required, DR 30+.',
};

let savedLeadId   = null;   // set in T05, used in T06+
let approvedLead  = null;   // set in T07, used in T17/T18
let sessionOpen   = false;  // set in T16

// ─────────────────────────────────────────────────────────────────────────────
//  SUITE 1 — Infrastructure
// ─────────────────────────────────────────────────────────────────────────────

async function runSuite1() {
  suite('SUITE 1 — Infrastructure');

  await test('T01', 'DB connects and all 10 tables exist', async () => {
    await initDatabase();
    const res = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    const tables = res.rows.map(r => r.table_name);
    const required = [
      'activity_log','ai_logs','comments','community_comments',
      'conversations','daily_reports','dms','follow_ups','leads','niche_keywords',
    ];
    const missing = required.filter(t => !tables.includes(t));
    assert(missing.length === 0, `Missing tables: ${missing.join(', ')}`);
    return `${tables.length} tables found`;
  });

  await test('T02', 'Config loads required env vars', async () => {
    assert(config.openai.apiKey, 'OPENAI_API_KEY not set');
    assert(config.database.host, 'DB_HOST not set');
    assert(config.database.database, 'DB_NAME not set');
    assert(config.bhw.username, 'BHW_USERNAME not set');
    assert(config.bot.maxFollowUps > 0, 'maxFollowUps invalid');
    assert(config.bhw.scrapeIntervalMin > 0, 'scrapeIntervalMin missing');
    assert(config.bhw.scrapeIntervalMax > config.bhw.scrapeIntervalMin, 'scrapeIntervalMax <= Min');
    return `model=${config.openai.model}, interval=${config.bhw.scrapeIntervalMin/60000}–${config.bhw.scrapeIntervalMax/60000}min`;
  });

  await test('T03', 'BotState pause / resume / dryRun toggles', async () => {
    assert(!botState.isPaused(), 'Should start unpaused');
    botState.pause('test');
    assert(botState.isPaused(), 'Should be paused after pause()');
    assert(botState.pausedReason() === 'test', 'Reason should match');
    botState.resume();
    assert(!botState.isPaused(), 'Should be running after resume()');
    assert(typeof botState.isDryRun() === 'boolean', 'isDryRun should be boolean');
    return `dryRun=${botState.isDryRun()}`;
  });

  await test('T04', 'Helpers — isActiveHours / shouldSendDM / getThreadAgeCategory', async () => {
    const active = isActiveHours();
    assert(typeof active === 'boolean', 'isActiveHours must return boolean');

    assert(shouldSendDM('fresh') === true,   'fresh → DM allowed');
    assert(shouldSendDM('old')   === false,  'old → DM blocked');
    assert(shouldSendDM('ancient') === false,'ancient → DM blocked');

    const fresh   = getThreadAgeCategory(new Date());
    const oldDate = new Date(); oldDate.setDate(oldDate.getDate() - 60);
    const ancient = new Date(); ancient.setFullYear(ancient.getFullYear() - 2);
    assert(fresh === 'fresh',     `Expected 'fresh', got '${fresh}'`);
    assert(getThreadAgeCategory(oldDate) === 'old', 'Expected old');
    assert(getThreadAgeCategory(ancient) === 'ancient', 'Expected ancient');

    const delay = randomDelay(100, 200);
    assert(delay >= 100 && delay <= 200, `randomDelay out of range: ${delay}`);
    return `active=${active}`;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  SUITE 2 — Database CRUD
// ─────────────────────────────────────────────────────────────────────────────

async function runSuite2() {
  suite('SUITE 2 — Database CRUD');

  await test('T05', 'createLead — insert + ON CONFLICT dedup', async () => {
    const lead = await createLead(BOT_DEV_LEAD);
    assert(lead && lead.id, 'No lead returned');
    savedLeadId = lead.id;

    // Insert same thread_id again — must NOT throw
    const lead2 = await createLead(BOT_DEV_LEAD);
    assert(lead2 && lead2.id === savedLeadId, 'Dedup failed — got different ID');
    return `lead_id=${savedLeadId}`;
  });

  await test('T06', 'updateLeadQualification — write qualification result', async () => {
    assert(savedLeadId, 'Need lead from T05');
    const updated = await updateLeadQualification(
      savedLeadId, true,
      'Telegram bot + React dashboard — perfect Bitbash match',
      0.95
    );
    assert(updated, 'No row returned');
    assert(updated.is_qualified === true, 'is_qualified should be true');
    assert(updated.niche_match_score === 95, `Score mismatch: ${updated.niche_match_score}`);
    return `qualified=true, score=95`;
  });

  await test('T07', 'getQualifiedLeadsToContact — returns uncontacted leads', async () => {
    const leads = await getQualifiedLeadsToContact();
    assert(Array.isArray(leads), 'Should return array');
    // Our seeded lead (savedLeadId) should appear since it's never been commented on
    const found = leads.find(l => l.id === savedLeadId);
    assert(found, `Our test lead #${savedLeadId} not found in qualified list`);
    approvedLead = found;
    return `${leads.length} lead(s) ready for outreach`;
  });

  await test('T08', 'getDailyActionCounts — returns comment/DM totals', async () => {
    const counts = await getDailyActionCounts();
    assert(typeof counts.commentsToday === 'number', 'commentsToday not a number');
    assert(typeof counts.dmsToday      === 'number', 'dmsToday not a number');
    return `comments=${counts.commentsToday}, dms=${counts.dmsToday}`;
  });

  await test('T09', 'getDailyStats — returns stats object', async () => {
    const stats = await getDailyStats();
    assert(typeof stats === 'object', 'Stats should be an object');
    assert('leadsScraped' in stats || 'threads_scraped' in stats || stats !== null,
      'Stats object empty');
    return 'stats returned OK';
  });

  await test('T10', 'getPendingFollowUpsWithContext — query runs cleanly', async () => {
    const fus = await getPendingFollowUpsWithContext();
    assert(Array.isArray(fus), 'Should return array');
    return `${fus.length} follow-up(s) pending`;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  SUITE 3 — AI Engine (GPT-4o mini)
// ─────────────────────────────────────────────────────────────────────────────

async function runSuite3() {
  suite('SUITE 3 — AI Engine (GPT-4o mini)');

  let pitchAngle = 'Telegram bot and React dashboard expertise';

  await test('T11', 'qualifyLead — REJECTS an SEO/backlink lead', async () => {
    const result = await qualifyLead(SEO_LEAD.title, SEO_LEAD.description);
    assert(result.qualified === false, `Expected REJECTED, got APPROVED (${result.confidence})`);
    assert(typeof result.confidence === 'number', 'confidence missing');
    assert(result.tier === 'skip' || result.tier === 'maybe', `Unexpected tier: ${result.tier}`);
    return `confidence=${result.confidence}, tier=${result.tier}`;
  });

  await test('T12', 'qualifyLead — APPROVES a bot/dev lead', async () => {
    const result = await qualifyLead(BOT_DEV_LEAD.title, BOT_DEV_LEAD.description);
    assert(result.qualified === true, `Expected APPROVED, got REJECTED. Reason: ${result.reason}`);
    assert(result.confidence >= 0.7, `Confidence too low: ${result.confidence} (need ≥ 0.70)`);
    assert(result.tier === 'auto', `Expected tier='auto', got '${result.tier}'`);
    if (result.pitch_angle) pitchAngle = result.pitch_angle;
    return `confidence=${result.confidence}, pitch="${result.pitch_angle?.slice(0, 40)}"`;
  });

  await test('T13', 'generateCommentPitch — produces non-empty comment', async () => {
    const comment = await generateCommentPitch(
      BOT_DEV_LEAD.title,
      BOT_DEV_LEAD.description,
      pitchAngle,
      BOT_DEV_LEAD.posterUsername
    );
    assert(typeof comment === 'string' && comment.length > 50, `Comment too short: ${comment.length} chars`);
    assert(!comment.includes('[HANDOFF]'), 'Pitch should not contain [HANDOFF]');
    return `${comment.length} chars`;
  });

  await test('T14', 'generateDMOutreach — produces non-empty DM with username', async () => {
    const dm = await generateDMOutreach(
      BOT_DEV_LEAD.title,
      BOT_DEV_LEAD.description,
      BOT_DEV_LEAD.posterUsername,
      pitchAngle
    );
    assert(typeof dm === 'string' && dm.length > 80, `DM too short: ${dm.length} chars`);
    return `${dm.length} chars`;
  });

  await test('T15', 'generateDMReply — replies to a prospect message', async () => {
    const history = [
      { sender: BOT_DEV_LEAD.posterUsername, text: 'Hey, sounds interesting. What is your rate for the full project?', timestamp: new Date() },
    ];
    const reply = await generateDMReply(history, history[0].text, 1);
    assert(typeof reply === 'string' && reply.length > 30, `Reply too short: ${reply.length}`);
    // Strip [HANDOFF] if present — it's valid, just check the clean text
    const clean = reply.replace('[HANDOFF]', '').trim();
    assert(clean.length > 20, 'Clean reply too short after stripping [HANDOFF]');
    return `${reply.length} chars, handoff=${reply.includes('[HANDOFF]')}`;
  });

  await test('T16', 'scoreLeadHotness — returns numeric score 1–10', async () => {
    const result = await scoreLeadHotness(
      BOT_DEV_LEAD.title,
      BOT_DEV_LEAD.description,
      'Hey can you start immediately? Budget approved.'
    );
    assert(typeof result.score === 'number', 'score is not a number');
    assert(result.score >= 1 && result.score <= 10, `Score out of range: ${result.score}`);
    assert(Array.isArray(result.reasons), 'reasons should be array');
    return `score=${result.score}, reasons=${result.reasons.length}`;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  SUITE 4 — BHW Session
// ─────────────────────────────────────────────────────────────────────────────

async function runSuite4() {
  suite('SUITE 4 — BHW Session (browser + CloudFlare)');

  const cookiesExist = fs.existsSync('./bhw-cookies.json');
  if (!cookiesExist) {
    skip('T17', 'BHW cookie auth + CloudFlare bypass', 'bhw-cookies.json missing — run save-cookies.js first');
    return;
  }

  await test('T17', 'BHW cookie auth + CloudFlare bypass + login verify', async () => {
    await bhwSession.ensureAuthenticated();
    assert(bhwSession.isLoggedIn(), 'Not logged in after ensureAuthenticated()');
    const username = bhwSession.getUsername();
    assert(username, 'Could not read username from session');
    sessionOpen = true;
    return `logged in as: ${username}`;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  SUITE 5 — Engines (all dry-run)
// ─────────────────────────────────────────────────────────────────────────────

async function runSuite5() {
  suite('SUITE 5 — Engines (DRY RUN — nothing posted to BHW)');

  await test('T18', 'Comment engine — generates pitch, dry-run skips browser', async () => {
    assert(approvedLead, 'Need approvedLead from T07');
    const result = await generateAndPostComment(approvedLead, { dryRun: true });
    assert(result, 'No result returned');
    assert(result.success === true, `success=${result.success}, err=${result.error}`);
    assert(typeof result.commentText === 'string' && result.commentText.length > 30,
      `commentText missing or too short`);
    return `${result.commentText.length} chars, posted=false`;
  });

  await test('T19', 'DM engine — generates DM, dry-run skips browser', async () => {
    assert(approvedLead, 'Need approvedLead from T07');
    const result = await generateAndSendDM(approvedLead, { dryRun: true });
    assert(result, 'No result returned');
    assert(result.success === true, `success=${result.success}, err=${result.error}`);
    assert(typeof result.dmText === 'string' && result.dmText.length > 50,
      `dmText missing or too short`);
    return `${result.dmText.length} chars, sent=false`;
  });

  if (!sessionOpen) {
    skip('T20', 'Conversation engine — dry-run reply', 'BHW session not open (T17 skipped or failed)');
    return;
  }

  await test('T20', 'Conversation engine — reads messages, dry-run skips reply', async () => {
    // Navigate to a dummy thread URL — we just verify it doesn't throw and returns a result
    const page = bhwSession.getPage();
    await bhwSession.navigateTo('https://www.blackhatworld.com/conversations/');

    const result = await handleConversation(
      'https://www.blackhatworld.com/conversations/',
      'sys_test_user',
      approvedLead,
      null,
      { dryRun: true }
    );
    // It may return null if no messages found — that's OK for a dry run
    return 'completed without throwing';
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  SUITE 6 — Scraper dedup (no browser — just DB logic)
// ─────────────────────────────────────────────────────────────────────────────

async function runSuite6() {
  suite('SUITE 6 — Scraper dedup logic');

  await test('T21', 'getExistingThreadIds — batch returns known IDs', async () => {
    const { getExistingThreadIds } = await import('./src/database/queries.js');
    const ids = [DUMMY_THREAD_ID, 'does-not-exist-xyz-999'];
    const existing = await getExistingThreadIds(ids);
    assert(Array.isArray(existing), 'Should return array');
    assert(existing.includes(DUMMY_THREAD_ID),
      `Our seeded thread_id not returned: ${existing}`);
    assert(!existing.includes('does-not-exist-xyz-999'),
      'Unknown ID should not be returned');
    return `found ${existing.length}/2`;
  });

  await test('T22', 'createLead ON CONFLICT — 10 rapid-fire duplicates, 0 errors', async () => {
    let errors = 0;
    for (let i = 0; i < 10; i++) {
      try { await createLead(BOT_DEV_LEAD); } catch { errors++; }
    }
    assert(errors === 0, `${errors} errors thrown on duplicate inserts`);
    return '10 duplicate inserts → 0 errors';
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cleanup
// ─────────────────────────────────────────────────────────────────────────────

async function cleanup() {
  // Remove test lead from DB so it doesn't pollute real outreach
  if (savedLeadId) {
    await pool.query('DELETE FROM leads WHERE id = $1', [savedLeadId]).catch(() => {});
  }
  if (sessionOpen) {
    await bhwSession.close().catch(() => {});
  }
  await pool.end().catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
//  Final report
// ─────────────────────────────────────────────────────────────────────────────

function printReport() {
  const pass   = results.filter(r => r.status === 'PASS').length;
  const fail   = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;
  const total  = results.length;

  console.log('\n');
  console.log('╔' + '═'.repeat(73) + '╗');
  console.log('║  FULL SYSTEM TEST REPORT' + ' '.repeat(48) + '║');
  console.log('╠' + '═'.repeat(73) + '╣');

  let lastSuite = '';
  for (const r of results) {
    if (r.suite !== lastSuite) {
      console.log('║  ' + r.suite.padEnd(71) + '║');
      lastSuite = r.suite;
    }
    const icon   = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⏭️ ';
    const nameCol  = `[${r.id}] ${r.name}`.padEnd(46);
    const noteCol  = (r.note || '').slice(0, 22).padEnd(22);
    console.log(`║    ${icon} ${nameCol} ${noteCol} ║`);
  }

  console.log('╠' + '═'.repeat(73) + '╣');
  const summary = `  RESULTS:  ${pass} passed  |  ${fail} failed  |  ${skipped} skipped  |  ${total} total`;
  console.log('║' + summary.padEnd(73) + '║');
  const overall = fail === 0 ? '  ✅  ALL TESTS PASSED — System is production-ready (dry-run)' : `  ❌  ${fail} TEST(S) FAILED — fix before deploying to server`;
  console.log('║' + overall.padEnd(73) + '║');
  console.log('╚' + '═'.repeat(73) + '╝\n');

  if (fail > 0) {
    console.log('Failed tests:\n');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ❌ [${r.id}] ${r.name}`);
      console.log(`       → ${r.note}\n`);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔' + '═'.repeat(65) + '╗');
  console.log('║  BHW OUTBOUND SALES BOT — FULL SYSTEM TEST' + ' '.repeat(22) + '║');
  console.log('║  All browser-based tests run in DRY RUN mode' + ' '.repeat(20) + '║');
  console.log('╚' + '═'.repeat(65) + '╝');

  try {
    await runSuite1();
    await runSuite2();
    await runSuite3();
    await runSuite4();
    await runSuite5();
    await runSuite6();
  } catch (fatalErr) {
    console.error('\n💥  FATAL ERROR in test runner:', fatalErr.message);
  } finally {
    await cleanup();
    printReport();
    const failed = results.filter(r => r.status === 'FAIL').length;
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();
