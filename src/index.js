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
import { initTelegram } from './services/telegramClient.js';
import { startThreadsOwnerOutreach } from './engines/threads-owner-outreach.js';

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

      // Step 1 — Comment on the thread (fresh posts only — <30 days)
      const ageCategory = lead.thread_age_category || 'fresh';
      if (ageCategory !== 'fresh') {
        logger.info(`  ⏭  Skipping comment — thread is "${ageCategory}" (comments for fresh threads only)`);
        continue;
      }

      // Duplicate guard: already commented on this thread? (DB query already filters,
      // but guard here catches any race between two loop invocations)
      if (lead.commented === true) {
        logger.info(`  ⏭  Already commented on lead #${lead.id} — skipping`);
        continue;
      }

      const commentResult = await generateAndPostComment(lead, { dryRun: botState.isDryRun() });
      if (!commentResult.success) {
        logger.warn(`  Comment failed — skipping DM for lead #${lead.id}`);
        continue;
      }
      commentsSent++;

      let dmText = null;

      // GAP-02: Only DM posters on fresh threads (<30 days)
      if (!shouldSendDM(ageCategory)) {
        logger.info(`  ⏭  Skipping DM — thread is "${ageCategory}" (DMs for fresh threads only)`);

      } else if (lead.dm_sent === true) {
        logger.info(`  ⏭  Already sent DM to lead #${lead.id} — skipping`);

      } else if (dmsSent >= dmCap) {
        logger.warn(`  ⛔  DM cap (${dmCap}) reached — skipping DM for lead #${lead.id}`);

      } else {
        // Short human pause between comment and DM — 2 to 4 minutes
        const pauseMs  = randomDelay(2 * 60 * 1000, 4 * 60 * 1000);
        const pauseMin = Math.round(pauseMs / 60000);
        logger.info(`  ⏳  Pausing ~${pauseMin} min before DM (human gap)…`);
        await sleep(pauseMs);

        // Step 2 — DM the poster
        const dmResult = await generateAndSendDM(lead, { dryRun: botState.isDryRun() });
        if (dmResult.success) {
          dmText = dmResult.dmText;
          dmsSent++;
        }
      }

      // ── WA full outreach report ───────────────────────────────────────
      // Fires after comment (and DM if sent) — gives full visibility
      try {
        const reportLines = [
          `🎯 *Outreach Complete!*`,
          '',
          `📌 *Post:* "${lead.title}"`,
          `🔗 ${lead.thread_url}`,
          `👤 Poster: @${lead.poster_username || 'unknown'}  |  Age: ${ageCategory}`,
          `🤖 AI Score: ${Math.round((lead.niche_match_score || 0))}%`,
          '',
          `💬 *Comment posted:*`,
          commentResult.commentText || '(text not available)',
        ];

        if (dmText) {
          reportLines.push('');
          reportLines.push(`📩 *DM sent:*`);
          reportLines.push(dmText);
        } else {
          reportLines.push('');
          reportLines.push(`📩 DM: scheduled (fires ~2-4 min after comment)`);
        }

        await alerts.sendRawAlert(reportLines.join('\n')).catch(() => {});
      } catch (alertErr) {
        logger.warn(`WA outreach report failed: ${alertErr.message}`);
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
      logger.info('\n📡  Scraping BHW — checking top 5 posts on page 1…');
      scrapeResult = await scraper.scrapeAndStore(1);
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

    // ── WhatsApp status ping — only fires when new jobs are found ───────
    if (scrapeResult?.cloudflareBlocked) {
      await alerts.sendRawAlert([
        `⚠️ *CLOUDFLARE BLOCK* | Run #${runCount} | ${runTs}`,
        '',
        'BHW returned a Cloudflare challenge — posts could not be loaded.',
        '',
        `⏭ Auto-retrying in ~${nextMinStr} min`,
        '⚠️ If this repeats, the server IP may be rate-limited by BHW.',
      ].join('\n')).catch(() => {});

    } else if (scrapeResult && scrapeResult.newProcessed > 0) {
      // Only ping when there are actually new posts worth reporting
      const statusIcon = (s) => {
        if (s === 'seen')            return '🔄';
        if (s === 'new-approved')    return '✅';
        if (s === 'new-rejected')    return '❌';
        if (s === 'skipped-ancient') return '⏳';
        if (s === 'skipped-pinned')  return '📌';
        return '❓';
      };

      const postLines = (scrapeResult.inspectedPosts || []).map((p, i) => {
        const icon  = statusIcon(p.status);
        const label = p.status === 'seen'            ? 'Already tracked'
                    : p.status === 'new-approved'    ? `AI APPROVED (${Math.round((p.confidence || 0) * 100)}%)`
                    : p.status === 'new-rejected'    ? `AI rejected (${Math.round((p.confidence || 0) * 100)}%)`
                    : p.status === 'skipped-ancient' ? 'Skipped — too old'
                    : p.status === 'skipped-pinned'  ? 'Skipped — pinned'
                    : 'Pending';
        return `${icon} ${i + 1}. "${p.title?.substring(0, 50)}" — ${label}`;
      });

      await alerts.sendRawAlert([
        `🆕 *New Job Found! Run #${runCount}* | ${runTs}`,
        '',
        `📊 Page: ${scrapeResult.totalFound} posts  |  Checked: top 5`,
        '',
        '*Top 5 posts:*',
        ...postLines,
        '',
        `✅ AI approved: ${scrapeResult.approved}  |  ❌ Rejected: ${scrapeResult.rejected}`,
        '',
        `⏭ Starting outreach now…`,
      ].join('\n')).catch(() => {});
    }
    // If nothing new — stay silent (no noise on every cycle)

    // ── Outreach — always live ────────────────────────────────────────
    if (scrapeResult && !scrapeResult.cloudflareBlocked) {
      const newQualified = newLeads.filter(t => t.qualified);
      if (newQualified.length > 0) {
        logger.info(`\n  📬  ${newQualified.length} newly qualified — starting outreach immediately`);
      }
      await processQualifiedLeads().catch(err =>
        logger.error(`Outreach error: ${err.message}`)
      );
    }

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

// ── Heartbeat ────────────────────────────────────────────────────────────────
/**
 * Sends a WA alive-ping every 6 hours so you can confirm the bot
 * is still running during the 24h test without checking logs manually.
 */
function startHeartbeat() {
  const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

  const ping = async () => {
    try {
      const { commentsToday, dmsToday } = await getDailyActionCounts();
      const now = new Date().toLocaleString('en-GB', {
        timeZone: 'Asia/Karachi',
        hour: '2-digit', minute: '2-digit',
        day: '2-digit', month: 'short',
      });
      await alerts.sendRawAlert([
        `💓 *Bot Alive* | ${now}`,
        '',
        `💬 Comments today: ${commentsToday}`,
        `📩 DMs today: ${dmsToday}`,
        `🔄 Scraping every 10–20 min`,
        `✅ No issues detected`,
      ].join('\n')).catch(() => {});
    } catch (err) {
      logger.warn(`Heartbeat ping failed: ${err.message}`);
    }
    setTimeout(ping, INTERVAL_MS);
  };

  setTimeout(ping, INTERVAL_MS); // first ping after 6h
    logger.info('💓  Heartbeat started — Telegram ping every 6 hours');
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

    // ACTIVE: Scraper + comment + DM + daily report
    // Follow-up/inbox/community disabled until first conversion confirmed
    // startInboxMonitor({ dryRun: DRY_RUN });
    // startFollowUpSystem({ dryRun: DRY_RUN });
    // startCommunityCommenter({ dryRun: DRY_RUN });
    // bhwSession.startHealthCheck();
    await initTelegram();
    startCommandCenter();
    scheduleDailyReport();    // 9 AM WA daily summary
    startHeartbeat();         // 6-hour alive ping

    // Scraper + immediate outreach — one unified loop
    startScraperAndOutreachLoop();

    // ── Threads Owner Outreach Module ─────────────────────────────────────
    // Independent module: DMs BHW thread owners from a pre-seeded list.
    // Runs its own 16h active window (15:00–07:00 UTC), 5 DMs/day.
    // Controlled by OUTREACH_ENABLED=true in .env
    if (config.outreach.enabled) {
      const dryRun = process.env.DRY_RUN === 'true';
      startThreadsOwnerOutreach({ dryRun });
      logger.info(`   • Threads Owner Outreach: enabled (${config.outreach.dailyCap}/day | ${dryRun ? 'DRY RUN — no BHW DMs sent' : '🔴 LIVE'})`);
    } else {
      logger.info('   • Threads Owner Outreach: disabled (set OUTREACH_ENABLED=true to enable)');
    }

    logger.info('\n✅  Bot running — 24h test mode');
    logger.info('   • Scrape BHW every 10–20 min (anonymous, no session)');
    logger.info('   • Comment posted immediately on new approved posts');
    logger.info('   • DM sent ~2-4 min after comment (human gap)');
    logger.info('   • No duplicate comment/DM — triple-guarded at DB + loop + engine level');
    logger.info('   • Telegram: new job alert + outreach report + 9 AM daily summary + 6h heartbeat\n');

  } catch (error) {
    logger.error('❌  Fatal error starting bot:', error);
    process.exit(1);
  }
}

// ── Graceful shutdown ───────────────────────────────────────────────────────────
process.on('SIGINT',  () => { logger.info('Shutting down…'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('Shutting down…'); process.exit(0); });
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err.message);
  process.exit(1);
});

main();

