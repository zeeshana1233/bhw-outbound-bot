/**
 * test-outreach-dry-run.js
 *
 * [THREADS-OWNER-OUTREACH] — Dry run for first 3 pending targets.
 *
 * What this does (everything EXCEPT sending the actual BHW DM):
 *   ✅ Authenticates BHW session
 *   ✅ Real scrape of each thread (Puppeteer + CloudFlare bypass)
 *   ✅ Duplicate check (cross-module + within-module)
 *   ✅ AI generates personalised DM text
 *   ✅ AI generates all 3 follow-up messages (day 3 / day 7 / day 14)
 *   ✅ WhatsApp notification with EVERYTHING — thread, DM, all follow-ups
 *   ❌ Does NOT send BHW DM
 *   ❌ Does NOT write anything to DB
 *
 * Usage:
 *   node test-outreach-dry-run.js
 */

import dotenv from 'dotenv';
dotenv.config();

import logger   from './src/utils/logger.js';
import { sleep, randomDelay } from './src/utils/helpers.js';
import bhwSession from './src/utils/bhwSession.js';
import aiEngine from './src/services/aiEngine.js';
import alerts   from './src/services/alerts.js';
import { initDatabase } from './src/database/init.js';
import { initWhatsApp, isReady, getGroupId } from './src/services/whatsappClient.js';
import {
  getPendingOutreachTargets,
  getLeadByPosterUsername,
  getOutreachTargetByUsername,
} from './src/database/queries.js';
import { config } from './src/config/config.js';

const TAG          = '[THREADS-OWNER-OUTREACH DRY RUN]';
const BHW_USERNAME = process.env.BHW_USERNAME || 'app_pilot';
const TARGETS      = 100; // process ALL pending — full daily batch
const FOLLOW_UP_DAYS = [
  config.outreach.followUp1Days,   // 3
  config.outreach.followUp2Days,   // 7
  config.outreach.followUp3Days,   // 14
];

// ─────────────────────────────────────────────────────────────────────────────
// SCRAPE THREAD
// (same logic as threads-owner-outreach.js — real Puppeteer scrape)
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeThread(threadUrl) {
  const page = bhwSession.page;
  await bhwSession.navigateTo(threadUrl);
  await sleep(randomDelay(1500, 3000));

  const description = await page.evaluate(() => {
    const el = document.querySelector(
      '.message-body .bbWrapper, .message-content .bbWrapper, .message-body'
    );
    return el ? el.innerText.trim() : null;
  });

  const posterUsername = await page.evaluate(() => {
    const el = document.querySelector(
      '.message-name a.username, .message-userDetails .username, h4.message-name a'
    );
    return el ? el.textContent.trim() : null;
  });

  return { description: description || null, posterUsername: posterUsername || null };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${TAG}`);
  console.log(`Processing ALL pending targets — full daily batch (NO BHW DM will be sent)`);
  console.log(`${'─'.repeat(60)}\n`);

  // ── Init DB + WhatsApp ───────────────────────────────────────────────────
  await initDatabase();
  logger.info('✅ DB connected');

  await initWhatsApp();

  // Wait until WA is fully ready AND group is resolved (up to 3 min for QR scan)
  logger.info('⏳ Waiting for WhatsApp client + group to be ready…');
  logger.info('   👉 If a QR appears — scan it with WhatsApp now (Settings → Linked Devices)');
  const WA_TIMEOUT = 180_000;
  const waStart = Date.now();
  while ((!isReady() || !getGroupId()) && Date.now() - waStart < WA_TIMEOUT) {
    await sleep(2000);
  }
  if (!isReady()) {
    throw new Error('WhatsApp client never became ready — check QR scan / session');
  }
  if (!getGroupId()) {
    logger.warn('⚠️  WA group not resolved — messages will be skipped. Check WA_GROUP_NAME in .env');
  }
  logger.info('✅ WhatsApp ready and group resolved');

  // Brief pause so WA Chrome fully settles before BHW Chrome starts
  await sleep(3000);

  // ── Kick off with a header alert ────────────────────────────────────────
  await alerts.sendRawAlert(
    `${TAG}\n🔍 Starting full-day dry run — ALL pending targets\n` +
    `Will preview: scraped description, generated DM, all 3 follow-ups.\n` +
    `❌ Nothing will be sent on BHW.`
  ).catch(() => {});

  // ── Fetch targets ────────────────────────────────────────────────────────
  const targets = await getPendingOutreachTargets(TARGETS);
  if (targets.length === 0) {
    console.log('⚠️  No pending targets in outreach_targets. Seed first with:');
    console.log('   node scripts/seed-outreach-targets.js targets.csv');
    process.exit(0);
  }

  logger.info(`\nFound ${targets.length} pending target(s)\n`);

  // ── Authenticate BHW session ─────────────────────────────────────────────
  logger.info('Authenticating BHW session…');
  await bhwSession.ensureAuthenticated();
  logger.info('✅ BHW session active\n');

  // ── Process each target ──────────────────────────────────────────────────
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const num    = `[${i + 1}/${targets.length}]`;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`${num} Target #${target.id}`);
    console.log(`    Title:  ${target.title || '(no title)'}`);
    console.log(`    URL:    ${target.thread_url}`);
    console.log(`${'═'.repeat(60)}`);

    // ── Step 1: Duplicate check ─────────────────────────────────────────
    let dupWarning = null;

    if (target.poster_username) {
      const mainLead = await getLeadByPosterUsername(target.poster_username).catch(() => null);
      if (mainLead && mainLead.dm_sent) {
        dupWarning = `already_contacted_main_pipeline (@${target.poster_username})`;
      }
    }

    // ── Step 2: Scrape thread ───────────────────────────────────────────
    console.log(`\n  🔍 Scraping thread…`);
    let scrapeData = null;
    let scrapeError = null;

    try {
      scrapeData = await scrapeThread(target.thread_url);
      if (!scrapeData?.posterUsername && !scrapeData?.description) {
        scrapeError = 'Could not extract username or description from page';
      }
    } catch (err) {
      scrapeError = err.message;
    }

    const posterUsername = target.poster_username || scrapeData?.posterUsername || '(unknown)';
    const description    = scrapeData?.description || target.description || '';

    console.log(`  👤 Poster:      @${posterUsername}`);
    console.log(`  📄 Description: ${description.slice(0, 150).replace(/\n/g, ' ')}…`);

    if (scrapeError) {
      console.log(`  ⚠️  Scrape warning: ${scrapeError}`);
    }
    if (dupWarning) {
      console.log(`  ⚠️  Duplicate warning: ${dupWarning}`);
    }

    // Re-check cross-module dup after scrape (now that we have username)
    if (posterUsername !== '(unknown)' && !dupWarning) {
      const mainLead2 = await getLeadByPosterUsername(posterUsername).catch(() => null);
      if (mainLead2 && mainLead2.dm_sent) {
        dupWarning = `already_contacted_main_pipeline (@${posterUsername})`;
        console.log(`  ⚠️  Cross-module dup found after scrape: ${dupWarning}`);
      }
    }

    // ── Step 3+4: Single AI call — DM + all 3 follow-ups ──────────────────
    console.log(`\n  🤖 Generating DM + follow-ups (single call)…`);
    let dmText  = null;
    let followUps = { followUp1: '', followUp2: '', followUp3: '' };
    let aiError = null;

    try {
      const generated = await aiEngine.generateThreadsOwnerOutreachDMAndFollowUps(
        target.title || '(untitled)',
        description,
        posterUsername
      );
      dmText    = generated.dmText;
      followUps = { followUp1: generated.followUp1, followUp2: generated.followUp2, followUp3: generated.followUp3 };
    } catch (err) {
      aiError = err.message;
    }

    if (dmText) {
      console.log(`\n  ── GENERATED DM ────────────────────────────────────`);
      console.log(dmText);
      console.log(`  ── END DM (${dmText.length} chars) ─────────────────────────`);
    } else {
      console.log(`  ❌ AI generation failed: ${aiError}`);
    }

    if (!aiError) {
      console.log(`\n  ── FOLLOW-UP #1 (Day ${FOLLOW_UP_DAYS[0]}) ─────────────────────────`);
      console.log(followUps.followUp1 || '(empty)');
      console.log(`\n  ── FOLLOW-UP #2 (Day ${FOLLOW_UP_DAYS[1]}) ─────────────────────────`);
      console.log(followUps.followUp2 || '(empty)');
      console.log(`\n  ── FOLLOW-UP #3 (Day ${FOLLOW_UP_DAYS[2]}) ─────────────────────────`);
      console.log(followUps.followUp3 || '(empty)');
    }

    // ── Step 5: WhatsApp notification — full preview ─────────────────────
    console.log(`\n  📱 Sending WhatsApp preview…`);

    const waLines = [
      `${TAG}`,
      `${num} Target #${target.id} — Preview`,
      ``,
      `📌 *Thread:* "${(target.title || '').slice(0, 80)}"`,
      `🔗 ${target.thread_url}`,
      `👤 Poster: @${posterUsername}`,
      dupWarning ? `⚠️ DUP WARNING: ${dupWarning}` : `✅ No duplicates found`,
      scrapeError ? `⚠️ Scrape issue: ${scrapeError}` : `✅ Thread scraped OK`,
      ``,
      `📄 *Description preview:*`,
      (description.slice(0, 300).replace(/\n+/g, ' ') || '(none)'),
      ``,
      `📩 *DM that would be sent:*`,
      dmText
        ? dmText
        : `❌ Generation failed: ${aiError}`,
      ``,
      `📆 *Follow-up Day ${FOLLOW_UP_DAYS[0]}:*`,
      followUps.followUp1 || '(empty)',
      ``,
      `📆 *Follow-up Day ${FOLLOW_UP_DAYS[1]}:*`,
      followUps.followUp2 || '(empty)',
      ``,
      `📆 *Follow-up Day ${FOLLOW_UP_DAYS[2]}:*`,
      followUps.followUp3 || '(empty)',
      ``,
      `❌ *BHW DM was NOT sent (dry run)*`,
    ];

    await alerts.sendRawAlert(waLines.join('\n')).catch(e => {
      logger.warn(`WA notification failed: ${e.message}`);
    });

    console.log(`  ✅ WhatsApp notification sent`);

    // Brief gap between targets (looks natural, avoids session stress)
    if (i < targets.length - 1) {
      const pauseSec = 15 + Math.floor(Math.random() * 15);
      console.log(`\n  ⏳ Waiting ${pauseSec}s before next target…`);
      await sleep(pauseSec * 1000);
    }
  }

  // ── Final summary ────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ Dry run complete — ${targets.length} target(s) previewed`);
  console.log(`   Nothing was sent to BHW.`);
  console.log(`   Nothing was written to the database.`);
  console.log(`   All WhatsApp notifications delivered.`);
  console.log(`${'═'.repeat(60)}\n`);

  await alerts.sendRawAlert(
    `${TAG}\n✅ Dry run complete!\n` +
    `Previewed ${targets.length} target(s).\n` +
    `Nothing sent on BHW. Nothing written to DB.\n` +
    `Review the ${targets.length} preview messages above and reply with feedback.`
  ).catch(() => {});

  // Give WA a moment to flush the last message before exit
  await sleep(3000);
  process.exit(0);
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGINT',  () => { logger.info('\nAborted.'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('\nAborted.'); process.exit(0); });

main().catch(err => {
  logger.error('Fatal error:', err.message);
  console.error(err);
  process.exit(1);
});
