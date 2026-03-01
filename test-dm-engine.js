/**
 * ============================================================
 *  DM ENGINE TEST — Dry Run
 * ============================================================
 *
 *  What this does:
 *    1. Uses the same dummy qualified lead as the pipeline test
 *    2. Generates a personalised DM with OpenClaw (GPT-4o mini)
 *    3. Shows the DM + subject in the terminal
 *    4. (DRY RUN — nothing is sent to BHW)
 *
 *  To test live sending, set DRY_RUN = false below.
 *  Make sure your cookies in bhw-cookies.json are fresh first.
 *
 * ============================================================
 */

import { generateDM, sendDM } from './src/engines/dm.js';
import { pool }               from './src/database/init.js';
import logger                 from './src/utils/logger.js';

// ── Toggle this to actually send a DM ────────────────────────
const DRY_RUN = true;

// ── Dummy lead (same as full pipeline test) ──────────────────
const DUMMY_LEAD = {
  id:                   22,
  thread_id:            'test-pipeline-dummy-001',
  thread_url:           'https://www.blackhatworld.com/seo/need-a-bot-developer.1797011/',
  title:                'Need Telegram Bot + Web Dashboard Developer URGENT',
  description: `Looking for an experienced developer to build a full Telegram bot with a web admin dashboard.

Requirements:
- Telegram bot with custom commands and inline menus
- Multi-user subscription management (free / paid tiers)
- Stripe payment integration inside bot
- Scheduled broadcast messages to all subscribers
- Web dashboard (React or simple HTML) for admin to manage users, send blasts, view stats
- Webhook-based deployment on VPS

Budget: $800–$2,000 depending on scope.
Timeline: 2 weeks max.
DM me if you have done similar work, happy to share full spec doc.`,
  poster_username:      'TestUser_BHW_Dummy',
  pitch_angle:          'Bitbash specialises in custom Telegram bots, Stripe integrations, and React admin dashboards — perfect match for this project.',
  qualification_reason: 'The project involves developing a Telegram bot and a web dashboard, which requires custom software development and coding.',
  dm_sent:              false,    // pretend it hasn't been sent so the guard passes
};

// ─────────────────────────────────────────────────────────────
function banner(title) {
  const line = '═'.repeat(61);
  logger.info('');
  logger.info(line);
  logger.info(`  ${title}`);
  logger.info(line);
}

// ─────────────────────────────────────────────────────────────
async function runTest() {
  try {
    banner('DM ENGINE TEST  │  DRY RUN');
    logger.info(`  Lead    : ${DUMMY_LEAD.title}`);
    logger.info(`  To      : @${DUMMY_LEAD.poster_username}`);
    logger.info(`  Mode    : ${DRY_RUN ? '🔒 DRY RUN (nothing sent)' : '🚀 LIVE — will send real DM!'}`);
    logger.info('');

    // ── STEP 1: Generate the DM text ──────────────────────────
    banner('STEP 1  │  Generating DM with OpenClaw');
    logger.info('  Calling GPT-4o mini...\n');

    const dmText = await generateDM(DUMMY_LEAD);

    // Subject (same logic as engine)
    const subject = DUMMY_LEAD.title.length > 60
      ? DUMMY_LEAD.title.substring(0, 57) + '...'
      : DUMMY_LEAD.title;

    logger.info('');
    logger.info('  ─────────────────────────────────────────────────────');
    logger.info(`  SUBJECT : ${subject}`);
    logger.info('  ─────────────────────────────────────────────────────');
    logger.info('  BODY:');
    dmText.split('\n').forEach(l => logger.info(`    ${l}`));
    logger.info('  ─────────────────────────────────────────────────────');
    logger.info('');

    // ── STEP 2: Send (or dry-run) ──────────────────────────────
    banner(`STEP 2  │  Sending DM  [${DRY_RUN ? 'DRY RUN' : 'LIVE'}]`);

    const result = await sendDM(DUMMY_LEAD, dmText, { dryRun: DRY_RUN });

    // ── SUMMARY ───────────────────────────────────────────────
    banner('TEST COMPLETE  ✅');
    logger.info(`  Generated  : ✅ DM text (${dmText.length} chars)`);
    logger.info(`  Sent       : ${result.dryRun ? '⏭️  Skipped (dry run)' : result.success ? '✅ Sent' : '❌ Failed'}`);
    if (!result.dryRun && result.conversationUrl) {
      logger.info(`  URL        : ${result.conversationUrl}`);
      logger.info(`  Follow-ups : scheduled at day 7, 14, 21`);
    }
    logger.info('');
    if (DRY_RUN) {
      logger.info('  To send for real: set DRY_RUN = false at top of this file.');
    }
    logger.info('');

  } catch (err) {
    logger.error('Test error:', err.message || err);
  } finally {
    try { await pool.end(); } catch (_) {}
    process.exit(0);
  }
}

runTest();
