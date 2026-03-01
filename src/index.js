import dotenv from 'dotenv';
import logger from './utils/logger.js';
import { sleep, randomDelay, shouldSendDM, isActiveHours } from './utils/helpers.js';
import { initDatabase } from './database/init.js';
import { getQualifiedLeadsToContact, getDailyStats, getDailyActionCounts } from './database/queries.js';
import { BHWScraper } from './scraper/index.js';
import { generateAndPostComment } from './engines/comment.js';
import { config } from './config/config.js';
import { generateAndSendDM } from './engines/dm.js';
import { startInboxMonitor } from './engines/inbox-monitor.js';
import { startFollowUpSystem } from './engines/follow-up.js';
import { startCommunityCommenter } from './engines/community-commenter.js';
import alerts from './services/alerts.js';
import bhwSession from './utils/bhwSession.js';
import { botState } from './utils/botState.js';
import { startCommandCenter } from './services/commandCenter.js';
import { initWhatsApp } from './services/whatsappClient.js';

dotenv.config();

// DRY RUN guard — set DRY_RUN=false in .env to go live
const DRY_RUN = process.env.DRY_RUN !== 'false'; // default: true

// Gap between processing two consecutive leads (anti-bot pacing)
const BETWEEN_LEADS_MIN_MS = 3 * 60 * 1000;  // 3 min
const BETWEEN_LEADS_MAX_MS = 8 * 60 * 1000;  // 8 min

// ── processQualifiedLeads ────────────────────────────────────────────────────
/**
 * Reads qualified leads that haven't been commented on yet,
 * then for each: posts a comment -> sends a DM.
 *
 * Called immediately after every scrape cycle so outreach fires as
 * soon as a new lead lands in the DB — no separate timer needed.
 */
async function processQualifiedLeads() {
  const leads = await getQualifiedLeadsToContact();

  if (leads.length === 0) {
    logger.info('    No new qualified leads this round.');
    return;
  }

  // GAP-03: Enforce daily caps before doing anything
  const { commentsToday, dmsToday } = await getDailyActionCounts();
  const commentCap = config.bot.dailyCommentCap;
  const dmCap      = config.bot.dailyDmCap;

  if (commentsToday >= commentCap) {
    logger.warn(`⛔  Daily comment cap reached (${commentsToday}/${commentCap}) — skipping outreach round.`);
    return;
  }

  logger.info(`    🎯  ${leads.length} qualified lead(s) to contact  [comments today: ${commentsToday}/${commentCap} | DMs: ${dmsToday}/${dmCap}]`);

  let commentsSent = commentsToday;
  let dmsSent      = dmsToday;

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    logger.info(`\n  [${i + 1}/${leads.length}] Lead #${lead.id}: "${lead.title?.slice(0, 60)}"`);

    try {
      // GAP-03: Hard-stop when cap hit mid-loop
      if (commentsSent >= commentCap) {
        logger.warn(`⛔  Comment cap (${commentCap}) reached mid-loop — stopping outreach.`);
        break;
      }

      // Step 1 — Comment on the thread
      const commentResult = await generateAndPostComment(lead, { dryRun: botState.isDryRun() });
      if (!commentResult.success) {
        logger.warn(`  Comment failed — skipping DM for lead #${lead.id}`);
        continue;
      }
      commentsSent++;

      // GAP-02: Only DM posters on fresh threads (<30 days)
      const ageCategory = lead.thread_age_category || 'fresh';
      if (!shouldSendDM(ageCategory)) {
        logger.info(`  ⏭  Skipping DM — thread is "${ageCategory}" (DMs for fresh threads only)`);

      } else if (dmsSent >= dmCap) {
        logger.warn(`  ⛔  DM cap (${dmCap}) reached — skipping DM for lead #${lead.id}`);

      } else {
        // GAP-01: Human pause between comment and DM — 15 to 30 minutes
        const pauseMs  = randomDelay(15 * 60 * 1000, 30 * 60 * 1000);
        const pauseMin = Math.round(pauseMs / 60000);
        logger.info(`  ⏳  Pausing ~${pauseMin} min before DM (human gap)…`);
        await sleep(pauseMs);

        // Step 2 — DM the poster
        await generateAndSendDM(lead, { dryRun: botState.isDryRun() });
        dmsSent++;
      }

    } catch (err) {
      logger.error(`  Error on lead #${lead.id}: ${err.message}`);
    }

    // Random gap between leads — looks natural, avoids bot detection
    if (i < leads.length - 1) {
      const pauseMs  = BETWEEN_LEADS_MIN_MS + Math.random() * (BETWEEN_LEADS_MAX_MS - BETWEEN_LEADS_MIN_MS);
      const pauseMin = Math.round(pauseMs / 60000);
      logger.info(`\n  ⏳  Waiting ~${pauseMin} min before next lead…`);
      await sleep(pauseMs);
    }
  }

  logger.info('\n  ✅  Outreach round complete.');
}

// ── Unified scrape + outreach loop ───────────────────────────────────────────
/**
 * One loop handles both scraping and outreach:
 *
 *   1. Scrape BHW for new threads (scraper auto-qualifies each one via AI)
 *   2. Immediately call processQualifiedLeads() — fires right after new leads land
 *   3. Sleep a random 10–20 min, repeat
 *
 * Zero lag between "lead discovered" and "comment+DM sent".
 */
async function startScraperAndOutreachLoop() {
  logger.info('🔄  Scraper + outreach loop starting…');

  let runCount = 0;

  const tick = async () => {
    // ── Randomised interval (re-rolled every tick so the pattern is never fixed) ─
    const minMs      = config.bhw.scrapeIntervalMin || 10 * 60 * 1000;
    const maxMs      = config.bhw.scrapeIntervalMax || 20 * 60 * 1000;
    const intervalMs = Math.floor(minMs + Math.random() * (maxMs - minMs));
    const nextMinStr = Math.round(intervalMs / 60000);

    if (botState.isPaused()) {
      logger.info('⏸️  Bot paused — skipping scrape cycle');
      setTimeout(tick, intervalMs);
      return;
    }

    // GAP-04: Active hours guard — only operate 9 AM–11 PM PKT
    if (!isActiveHours()) {
      logger.info('🌙  Outside active hours (9 AM–11 PM PKT) — sleeping until next cycle');
      setTimeout(tick, intervalMs);
      return;
    }

    runCount++;
    const runTs = new Date().toLocaleString('en-GB', {
      timeZone: 'Asia/Karachi',
      hour: '2-digit', minute: '2-digit',
      day: '2-digit', month: 'short',
    });

    // ── Scrape ──────────────────────────────────────────────────────
    const scraper    = new BHWScraper();
    let scrapeResult = null;
    let newLeads     = [];
    try {
      logger.info('\n📡  Scraping BHW for new threads (max 3 newest per cycle)…');
      scrapeResult = await scraper.scrapeAndStore(1, 3);
      newLeads     = scrapeResult.threads;
    } catch (err) {
      logger.error(`Scraper error: ${err.message}`);
      await alerts.sendRawAlert([
        `❌ *SCRAPER ERROR* | Run #${runCount} | ${runTs}`,
        '',
        `Error: ${err.message}`,
        '',
        `⏭ Retrying in ~${nextMinStr} min`,
      ].join('\n')).catch(() => {});
    }

    // ── WhatsApp status ping after every run ─────────────────────────
    if (scrapeResult) {
      if (scrapeResult.cloudflareBlocked) {
        // Cloudflare challenge couldn't be bypassed
        await alerts.sendRawAlert([
          `⚠️ *CLOUDFLARE BLOCK* | Run #${runCount} | ${runTs}`,
          '',
          'BHW returned a Cloudflare challenge — posts could not be loaded.',
          'Challenge was NOT bypassed after 30s wait.',
          '',
          `📊 Posts visible: 0`,
          `⏭ Auto-retrying in ~${nextMinStr} min`,
          '',
          '⚠️ If this repeats, the server IP may be rate-limited by BHW.',
        ].join('\n')).catch(() => {});

      } else if (scrapeResult.newProcessed === 0) {
        // Healthy run, nothing new
        await alerts.sendRawAlert([
          `🔎 *Scraper Run #${runCount}* | ${runTs}`,
          '',
          `📊 Posts on page: ${scrapeResult.totalFound}  |  🔄 Already tracked: ${scrapeResult.alreadyExisted}`,
          `🆕 New posts: 0 — all already seen`,
          `✅ Bot is healthy`,
          '',
          `⏭ Next run in ~${nextMinStr} min`,
        ].join('\n')).catch(() => {});

      } else {
        // New posts found — include AI breakdown
        const approvedLines = newLeads
          .filter(t => t.qualified)
          .map(t => `  • "${t.title?.substring(0, 55)}" — ${Math.round((t.qualificationScore || 0) * 100)}%`);
        const rejectedLines = newLeads
          .filter(t => !t.qualified)
          .map(t => `  • "${t.title?.substring(0, 55)}"`);

        const lines = [
          `🔎 *Scraper Run #${runCount}* | ${runTs}`,
          '',
          `📊 Posts on page: ${scrapeResult.totalFound}  |  🔄 Already tracked: ${scrapeResult.alreadyExisted}`,
          `🆕 New this run: ${scrapeResult.newProcessed}`,
          '',
        ];

        if (approvedLines.length > 0) {
          lines.push(`✅ AI Approved (${approvedLines.length}):`);
          approvedLines.forEach(l => lines.push(l));
        }
        if (rejectedLines.length > 0) {
          lines.push(`❌ AI Rejected (${rejectedLines.length}):`);
          rejectedLines.forEach(l => lines.push(l));
        }

        lines.push('');
        lines.push(`⏭ Next run in ~${nextMinStr} min`);

        await alerts.sendRawAlert(lines.join('\n')).catch(() => {});
      }
    }

    // ── Outreach ─────────────────────────────────────────────────────
    // Even if scraper found nothing new, check DB for any previously
    // qualified leads not yet contacted (e.g. after a restart).
    const newQualified = newLeads.filter(t => t.qualified);
    if (newQualified.length > 0) {
      logger.info(`\n  📬  ${newQualified.length} newly qualified — starting outreach immediately`);
    }

    await processQualifiedLeads().catch(err =>
      logger.error(`Outreach error: ${err.message}`)
    );

    // ── Schedule next tick ────────────────────────────────────────────
    logger.info(`\n  ⏰  Next scrape in ${nextMinStr} min (randomised ${Math.round(minMs/60000)}–${Math.round(maxMs/60000)} min window)`);
    setTimeout(tick, intervalMs);
  };

  // Kick off immediately on startup
  tick();
}

// ── Daily Report ─────────────────────────────────────────────────────────────
/**
 * Fires a WhatsApp daily report at 9:00 AM every day.
 * Collects real stats from the DB for the previous period.
 */
function scheduleDailyReport() {
  const msUntil9am = () => {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1); // missed today's 9am → schedule tomorrow
    return next - now;
  };

  const fireReport = async () => {
    try {
      logger.info('📊  Generating daily report…');
      const stats = await getDailyStats();
      await alerts.sendDailyReport(stats);
      logger.info(`📊  Daily report sent (DMs: ${stats.dmsSent}, Leads: ${stats.leadsScraped})`);
    } catch (err) {
      logger.error('Daily report failed:', err.message);
    }
    // Reschedule for the next 9am (24h)
    setTimeout(fireReport, msUntil9am());
  };

  const delay = msUntil9am();
  const hrsUntil = Math.round(delay / 1000 / 60 / 60 * 10) / 10;
  logger.info(`📊  Daily report scheduled — fires in ${hrsUntil}h (09:00 AM every day)`);
  setTimeout(fireReport, delay);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  try {
    const mode = DRY_RUN ? 'DRY RUN (safe)' : '🔴 LIVE';
    logger.info(`🚀  Starting Bitbash BHW Outbound Sales Bot… [${mode}]`);
    if (DRY_RUN) logger.info('    Set DRY_RUN=false in .env to go live.\n');

    // Apply DB migrations
    await initDatabase();
    logger.info('✅  Database connected\n');

    // Inbox monitor and follow-up run on their own independent timers
    startInboxMonitor({ dryRun: DRY_RUN });
    startFollowUpSystem({ dryRun: DRY_RUN });
    startCommunityCommenter({ dryRun: DRY_RUN });
    scheduleDailyReport();
    bhwSession.startHealthCheck();
    await initWhatsApp();     // QR scan once → session auto-saved to .wwebjs_auth/
    startCommandCenter();     // WhatsApp group two-way command interface

    // Scraper + immediate outreach — one unified loop
    startScraperAndOutreachLoop();

    logger.info('\n✅  All systems operational');
    logger.info('   • Scrape + outreach — every 2 min; comment+DM fires right after each scrape');
    logger.info('   • Inbox monitor     — reply check every 1–2 hr random');
    logger.info('   • Follow-ups        — due-check every 30–90 min random');
    logger.info('   • Daily report      — WhatsApp summary every day at 09:00 AM');
    logger.info('   • Session health    — verified every 30 min; WhatsApp alert if expired');
    logger.info('   • Community comments — organic BHW replies every 4–6h (max 3/run)');
    logger.info('   • Command center    — WhatsApp group (send \'help\' in your group)\n');

  } catch (error) {
    logger.error('❌  Fatal error starting bot:', error);
    process.exit(1);
  }
}

// ── Graceful shutdown ───────────────────────────────────────────────────────────
process.on('SIGINT',  () => { logger.info('Shutting down…'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('Shutting down…'); process.exit(0); });

main();

