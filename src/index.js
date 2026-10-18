import dotenv from 'dotenv';
import logger from './utils/logger.js';
import { sleep, randomDelay, shouldSendDM, isActiveHours } from './utils/helpers.js';
import { initDatabase } from './database/init.js';
import { getQualifiedLeadsToContact, getDailyStats, getDailyActionCounts, getNicheScoutDayStats, getNicheScoutWeekStats, getNicheScoutSkippedPosts } from './database/queries.js';
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
import { initDiscord } from './services/discordClient.js';
import { startThreadsOwnerOutreach } from './engines/threads-owner-outreach.js';
import { runNicheScout } from './engines/niche-scout.js';

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

  // GAP-03: Enforce daily DM cap before doing anything
  const { commentsToday, dmsToday } = await getDailyActionCounts();
  const dmCap = config.bot.dailyDmCap;

  if (dmsToday >= dmCap) {
    logger.warn(`⛔  Daily DM cap reached (${dmsToday}/${dmCap}) — skipping outreach round.`);
    return;
  }

  // Enforce 1 DM per scrape run for human pacing and safety
  const leadsToProcess = leads.slice(0, 1);
  const remainingCount = leads.length - leadsToProcess.length;

  logger.info(`    🎯  Processing ${leadsToProcess.length} lead this round (1 DM per run limit; ${remainingCount} in backlog queue) [DMs today: ${dmsToday}/${dmCap}]`);

  for (let i = 0; i < leadsToProcess.length; i++) {
    const lead = leadsToProcess[i];
    const ageCategory = lead.thread_age_category || 'fresh';
    logger.info(`\n  Lead #${lead.id}: "${lead.title?.slice(0, 60)}" by @${lead.poster_username || 'unknown'}`);

    try {
      // Step 1 — Public Comment: Paused (DM-only mode)
      if (config.bot?.commentingEnabled) {
        logger.info(`  Public comment posting enabled by config...`);
        const commentResult = await generateAndPostComment(lead, { dryRun: botState.isDryRun() });
        if (!commentResult.success) {
          logger.warn(`  Comment failed — skipping DM for lead #${lead.id}`);
          continue;
        }
        // Human pause between comment and DM if commenting was active
        const pauseMs = randomDelay(2 * 60 * 1000, 4 * 60 * 1000);
        logger.info(`  ⏳  Pausing ~${Math.round(pauseMs / 60000)} min before DM…`);
        await sleep(pauseMs);
      } else {
        logger.info(`  ℹ️  Public forum commenting is PAUSED (DM-only mode active)`);
      }

      // Step 2 — DM the poster directly
      if (lead.dm_sent === true) {
        logger.info(`  ⏭  Already sent DM to lead #${lead.id} — skipping`);
        continue;
      }

      logger.info(`  📩  Sending direct outreach DM to @${lead.poster_username || 'unknown'}…`);
      const dmResult = await generateAndSendDM(lead, { dryRun: botState.isDryRun() });

      let dmText = null;
      let followUpText = null;
      let subject = null;
      if (dmResult.success) {
        dmText = dmResult.dmText;
        followUpText = dmResult.followUpText;
        subject = dmResult.subject;
      } else {
        logger.warn(`  DM failed for lead #${lead.id}`);
      }

      // ── Discord outreach report ───────────────────────────────────────
      try {
        const reportLines = [
          `🎯 **Outreach Complete! (DM-Only)**`,
          '',
          `📌 **Post:** "${lead.title}"`,
          `🔗 **URL:** ${lead.thread_url}`,
          `👤 **Poster:** @${lead.poster_username || 'unknown'}  |  **Age:** ${ageCategory}`,
          `🤖 **AI Score:** ${Math.round((lead.niche_match_score || 0))}%`,
        ];

        if (subject) {
          reportLines.push(`📝 **Subject:** ${subject}`);
        }

        if (dmResult.reason === 'recently_dmed') {
          reportLines.push('');
          reportLines.push(`⏭ *Skipped: User was already contacted within the last 30 days.*`);
        } else if (dmResult.reason === 'privacy_blocked') {
          reportLines.push('');
          reportLines.push(`🚫 *Skipped: User direct messages are closed (privacy settings).*`);
        } else if (dmText) {
          reportLines.push('');
          reportLines.push(`📩 *Message 1 (Instant DM):*`);
          reportLines.push(dmText);
        } else {
          reportLines.push('');
          reportLines.push(`⚠️ DM send attempt finished (check logs)`);
        }

        if (followUpText && dmResult.success) {
          reportLines.push('');
          reportLines.push(`⏰ *Message 2 (Follow-Up — Scheduled for 24–72h):*`);
          reportLines.push(followUpText);
        }

        await alerts.sendOutreachReport(reportLines.join('\n')).catch(() => {});
      } catch (alertErr) {
        logger.warn(`Discord outreach report failed: ${alertErr.message}`);
      }

    } catch (err) {
      logger.error(`  Error on lead #${lead.id}: ${err.message}`);
    }

    // Random gap between leads if multiple were processed
    if (i < leadsToProcess.length - 1) {
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
  logger.info(`🔄  Scraper loop starting…${config.pipelineCOnly ? ' [Pipeline C only — anonymous, no outreach]' : ''}`);

  let runCount = 0;
  let cfFailStreak = 0; // consecutive CF blocks — drives exponential backoff

  const tick = async () => {
    // ── Randomised interval (re-rolled every tick so the pattern is never fixed) ─
    const minMs    = config.bhw.scrapeIntervalMin || 20 * 60 * 1000;
    const maxMs    = config.bhw.scrapeIntervalMax || 40 * 60 * 1000;
    let intervalMs = Math.floor(minMs + Math.random() * (maxMs - minMs));

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
      logger.info(`\n📡  Scraping BHW — checking top posts on page 1…${config.pipelineCOnly ? ' [Pipeline C only]' : ''}`);
      scrapeResult = await scraper.scrapeAndStore(1);
      newLeads     = scrapeResult.threads || [];
    } catch (err) {
      logger.error(`Scraper error: ${err.message}`);
      const nextMinStr = Math.round(intervalMs / 60000);
      await alerts.sendRawAlert([
        `❌ *SCRAPER ERROR* | Run #${runCount} | ${runTs}`,
        '',
        `Error: ${err.message}`,
        '',
        `⏭ Retrying in ~${nextMinStr} min`,
      ].join('\n')).catch(() => {});
    }

    // ── CF backoff (gentle — keep testing cycles short) ──────────────
    // Do NOT jump to 30–60 min on first fail. Use scrape-interval scale:
    // streak 1 ≈ minMs (~10m), then grow slowly, hard-cap 20 min.
    if (scrapeResult?.cloudflareBlocked) {
      cfFailStreak += 1;
      const base = Math.max(minMs, 5 * 60 * 1000); // floor 5 min
      const backedOff = Math.min(
        20 * 60 * 1000, // hard cap 20 min while we validate Pipeline C
        Math.floor(base * (1 + 0.5 * (cfFailStreak - 1)))
      );
      const jitter = Math.floor(backedOff * 0.1 * Math.random());
      intervalMs = backedOff + jitter;
      const nextMinStr = Math.round(intervalMs / 60000);

      await alerts.sendRawAlert([
        `⚠️ *CLOUDFLARE BLOCK* | Run #${runCount} | ${runTs}`,
        '',
        'BHW returned a Cloudflare challenge — posts could not be loaded.',
        '',
        `⏭ Retrying in ~${nextMinStr} min (streak: ${cfFailStreak})`,
        '⚠️ Anonymous scraper only — no login. If this keeps repeating, the server IP may be rate-limited.',
      ].join('\n')).catch(() => {});

    } else if (scrapeResult) {
      cfFailStreak = 0;

      // Main-channel summary only when NOT in Pipeline C only (C posts to its own channel)
      if (!config.pipelineCOnly && scrapeResult.newProcessed > 0) {
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
          `📊 Page: ${scrapeResult.totalFound} posts`,
          '',
          '*Top posts:*',
          ...postLines,
          '',
          `✅ AI approved: ${scrapeResult.approved}  |  ❌ Rejected: ${scrapeResult.rejected}`,
        ].join('\n')).catch(() => {});
      }
    }

    // ── Pipeline A outreach — disabled in Pipeline C only mode ────────
    if (!config.pipelineCOnly && scrapeResult && !scrapeResult.cloudflareBlocked) {
      const newQualified = newLeads.filter(t => t.qualified);
      if (newQualified.length > 0) {
        logger.info(`\n  📬  ${newQualified.length} newly qualified — starting outreach immediately`);
      }
      await processQualifiedLeads().catch(err =>
        logger.error(`Outreach error: ${err.message}`)
      );
    }

    // ── Pipeline D — Niche Comment Scout (after Hire-a-Freelancer scrape) ─
    // Runs even in Pipeline C-only mode. Never comments — Discord notify only.
    if (config.nicheScout?.enabled && scrapeResult && !scrapeResult.cloudflareBlocked) {
      await runNicheScout().catch(err =>
        logger.error(`[NicheScout] ${err.message}`)
      );
    }

    // ── Schedule next tick ────────────────────────────────────────────
    const nextMinStr = Math.round(intervalMs / 60000);
    logger.info(`\n  ⏰  Next scrape in ${nextMinStr} min${cfFailStreak ? ` (CF backoff streak ${cfFailStreak})` : ` (randomised ${Math.round(minMs / 60000)}–${Math.round(maxMs / 60000)} min window)`}`);

    // Send "Everything Okay" status alert to Discord every cycle
    if (!config.pipelineCOnly && scrapeResult && !scrapeResult.cloudflareBlocked) {
      alerts.sendScraperCycleHeartbeat({
        runCount,
        runTs,
        inspectedCount: scrapeResult.totalFound || 0,
        newLeadsCount:  scrapeResult.newProcessed || 0,
        qualifiedCount: scrapeResult.approved || 0,
        nextMinStr,
      }).catch(err => logger.warn(`[Heartbeat] Cycle heartbeat failed: ${err.message}`));
    }

    setTimeout(tick, intervalMs);
  };

  // Kick off immediately on startup
  tick();
}

// ── Daily Report ─────────────────────────────────────────────────────────────
/**
 * Fires a Discord daily report at 9:00 AM every day.
 * Collects real stats from the DB for the previous period.
 */
function scheduleDailyReport() {
  const msUntilHour = (hour) => {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  };

  const fireMorningReport = async () => {
    try {
      logger.info('📊  Generating daily report…');
      const stats = await getDailyStats();
      if (config.nicheScout?.enabled) {
        const [today, week] = await Promise.all([
          getNicheScoutDayStats(),
          getNicheScoutWeekStats(7),
        ]);
        stats.nicheScout = { today, week };
      }
      await alerts.sendDailyReport(stats);
      logger.info(`📊  Daily report sent (DMs: ${stats.dmsSent}, Leads: ${stats.leadsScraped})`);
    } catch (err) {
      logger.error('Daily report failed:', err.message);
    }
    setTimeout(fireMorningReport, msUntilHour(9));
  };

  /** End-of-day Niche Scout: niche counts + list of skips (missed / no niche match). */
  const fireNicheScoutEodReport = async () => {
    try {
      if (!config.nicheScout?.enabled) {
        setTimeout(fireNicheScoutEodReport, msUntilHour(23));
        return;
      }
      logger.info('📊  Generating Niche Scout end-of-day report…');
      const [today, week, skipped] = await Promise.all([
        getNicheScoutDayStats(),
        getNicheScoutWeekStats(7),
        getNicheScoutSkippedPosts(new Date(), 100),
      ]);
      await alerts.sendNicheScoutDailyReport({ today, week, skipped });
      logger.info(`📊  Niche Scout EOD sent (matched today: ${(today.fit || 0) + (today.maybe || 0)}, skips: ${skipped.length})`);
    } catch (err) {
      logger.error('Niche Scout EOD report failed:', err.message);
    }
    setTimeout(fireNicheScoutEodReport, msUntilHour(23));
  };

  const delay9 = msUntilHour(9);
  const delay23 = msUntilHour(23);
  logger.info(`📊  Daily report scheduled — fires in ${Math.round(delay9 / 36e5 * 10) / 10}h (09:00 every day)`);
  logger.info(`📊  Niche Scout EOD scheduled — fires in ${Math.round(delay23 / 36e5 * 10) / 10}h (23:00 every day)`);
  setTimeout(fireMorningReport, delay9);
  setTimeout(fireNicheScoutEodReport, delay23);
}

// ── Heartbeat ────────────────────────────────────────────────────────────────
/**
 * Sends a Discord alive-ping every 6 hours so you can confirm the bot
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
    logger.info('💓  Heartbeat started — Discord ping every 6 hours');
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

    // Follow-up system active (Queue 2)
    // startInboxMonitor({ dryRun: DRY_RUN });
    startFollowUpSystem({ dryRun: DRY_RUN });
    // startCommunityCommenter({ dryRun: DRY_RUN });
    // bhwSession.startHealthCheck();
    await initDiscord();
    startCommandCenter();
    scheduleDailyReport();    // 9 AM daily summary
    startHeartbeat();         // 6-hour alive ping

    // Anonymous scraper + Pipeline C job notifier (no login)
    startScraperAndOutreachLoop();

    // ── Threads Owner Outreach — forced off in Pipeline C only mode ───────
    if (config.pipelineCOnly) {
      logger.info('   • Threads Owner Outreach: disabled (PIPELINE_C_ONLY=true)');
    } else if (config.outreach.enabled) {
      const dryRun = process.env.DRY_RUN === 'true';
      startThreadsOwnerOutreach({ dryRun });
      logger.info(`   • Threads Owner Outreach: enabled (${config.outreach.dailyCap}/day | ${dryRun ? 'DRY RUN — no BHW DMs sent' : '🔴 LIVE'})`);
    } else {
      logger.info('   • Threads Owner Outreach: disabled (set OUTREACH_ENABLED=true to enable)');
    }

    if (config.pipelineCOnly) {
      logger.info('\n✅  Bot running — Pipeline C only (anonymous job notifier)');
      logger.info('   • Scraper: anonymous (no login / no bhwSession)');
      logger.info('   • Pipeline A comment/DM: OFF');
      logger.info('   • Pipeline B outreach: OFF');
      logger.info(`   • Pipeline D Niche Scout: ${config.nicheScout?.enabled ? 'ON' : 'OFF (set NICHE_SCOUT_ENABLED=true)'}`);
      logger.info('   • Discord: Pipeline C job cards + CF alerts + 9 AM report + 6h heartbeat\n');
    } else {
      logger.info('\n✅  Bot running — full scrape + outreach mode');
      logger.info(`   • Pipeline D Niche Scout: ${config.nicheScout?.enabled ? 'ON' : 'OFF'}`);
      logger.info('   • Discord: alerts + 9 AM daily summary + 6h heartbeat\n');
    }

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

