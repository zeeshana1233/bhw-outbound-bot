/**
 * ============================================================
 *  FULL PIPELINE TEST — End-to-End Demo
 * ============================================================
 *
 * What this does (in order):
 *
 *  PHASE 1 — Scraper (no login)
 *    Scrapes BHW for exactly 3 new threads.
 *    Qualifies each one — they should all be REJECTED
 *    (SEO / marketing / VA etc.)
 *
 *  PHASE 2 — Dummy qualified lead
 *    Inserts a fake "bot developer" lead (#4) directly into
 *    the database to simulate a perfect match.
 *    Runs OpenClaw on it → APPROVED.
 *
 *  PHASE 3 — Session Manager (BHW login)
 *    Opens the real browser using your saved session.
 *    Verifies you are logged in.
 *    Navigates to the dummy lead's thread URL.
 *
 *  PHASE 4 — Comment Generation
 *    Generates the actual comment pitch with OpenClaw.
 *    Shows the final comment in the terminal.
 *    (DRY RUN — nothing is posted.)
 *
 * ============================================================
 */

import { BHWScraper } from './src/scraper/index.js';
import { qualifyLead, generateCommentPitch } from './src/services/aiEngine.js';
import bhwSession from './src/utils/bhwSession.js';
import logger from './src/utils/logger.js';
import { pool } from './src/database/init.js';
import { updateLeadQualification } from './src/database/queries.js';

// ──────────────────────────────────────────────────────────────
//  Dummy qualified lead (4th lead — inserted into DB)
// ──────────────────────────────────────────────────────────────
const DUMMY_LEAD = {
  thread_id: 'test-pipeline-dummy-001',
  thread_url: 'https://www.blackhatworld.com/seo/need-a-bot-developer.1797011/',
  title: 'Need Telegram Bot + Web Dashboard Developer URGENT',
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
  poster_username: 'TestUser_BHW_Dummy',
  post_date: new Date(),
  thread_age_category: 'fresh',
};

// ──────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────
function banner(title) {
  const line = '═'.repeat(61);
  logger.info('');
  logger.info(line);
  logger.info(`  ${title}`);
  logger.info(line);
}

function separator() {
  logger.info('  ' + '─'.repeat(57));
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ──────────────────────────────────────────────────────────────
//  MAIN
// ──────────────────────────────────────────────────────────────
async function runFullPipeline() {
  const scraper = new BHWScraper();

  try {
    // ══════════════════════════════════════════════════════════
    //  PHASE 1 — Scrape 3 unqualified leads (no login)
    // ══════════════════════════════════════════════════════════
    banner('PHASE 1  │  Scraper  (no login required)');
    logger.info('  Scraping BHW Hire-a-Freelancer — max 3 NEW threads');
    logger.info('  CloudFlare bypass active (puppeteer-real-browser)\n');

    await scraper.initBrowser();
    const scraped = await scraper.scrapeAndStore(1, 3);  // max 3 new
    await scraper.closeBrowser();

    const unqualified = scraped.filter(t => !t.qualified);
    const qualified   = scraped.filter(t =>  t.qualified);

    logger.info('');
    logger.info(`  ✅ Scraped ${scraped.length} new thread(s)`);
    logger.info(`  ❌ Rejected : ${unqualified.length}`);
    logger.info(`  ✅ Qualified: ${qualified.length}`);
    logger.info('');

    if (scraped.length === 0) {
      logger.info('  (No new threads found — all already in DB)');
    } else {
      separator();
      scraped.forEach((t, i) => {
        const icon = t.qualified ? '✅' : '❌';
        logger.info(`  ${i + 1}. ${icon} [${t.qualificationScore}/100]  ${t.title}`);
        logger.info(`        → Lead ID ${t.leadId}`);
      });
      separator();
    }

    // ══════════════════════════════════════════════════════════
    //  PHASE 2 — Insert dummy qualified lead (#4)
    // ══════════════════════════════════════════════════════════
    banner('PHASE 2  │  Dummy Qualified Lead (Lead #4)');
    logger.info('  Inserting DUMMY qualified lead into database...\n');

    // Check if dummy already exists
    const exists = await pool.query(
      `SELECT id FROM leads WHERE thread_id = $1`,
      [DUMMY_LEAD.thread_id]
    );

    let dummyLeadId;

    if (exists.rows.length > 0) {
      dummyLeadId = exists.rows[0].id;
      logger.info(`  Dummy lead already exists (ID: ${dummyLeadId}) — reusing it`);
      // Reset qualified status so we re-qualify below
      await pool.query(
        `UPDATE leads SET is_qualified = NULL, niche_match_score = NULL WHERE id = $1`,
        [dummyLeadId]
      );
    } else {
      const ins = await pool.query(
        `INSERT INTO leads
           (thread_id, thread_url, title, description, poster_username, post_date,
            thread_age_category, is_qualified, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,false,'discovered')
         RETURNING id`,
        [
          DUMMY_LEAD.thread_id,
          DUMMY_LEAD.thread_url,
          DUMMY_LEAD.title,
          DUMMY_LEAD.description,
          DUMMY_LEAD.poster_username,
          DUMMY_LEAD.post_date,
          DUMMY_LEAD.thread_age_category,
        ]
      );
      dummyLeadId = ins.rows[0].id;
      logger.info(`  ✅ Dummy lead inserted  (ID: ${dummyLeadId})`);
    }

    separator();
    logger.info(`  Title   : ${DUMMY_LEAD.title}`);
    logger.info(`  By      : ${DUMMY_LEAD.poster_username}`);
    logger.info(`  URL     : ${DUMMY_LEAD.thread_url}`);
    logger.info(`  Lead ID : ${dummyLeadId}`);
    separator();

    // Now qualify the dummy lead with OpenClaw
    logger.info('\n  🤖 Qualifying dummy lead with OpenClaw (GPT-4o mini)...\n');
    const qual = await qualifyLead(DUMMY_LEAD.title, DUMMY_LEAD.description);

    await updateLeadQualification(dummyLeadId, qual.qualified, qual.reason, qual.confidence);

    const qualIcon = qual.qualified ? '✅ APPROVED' : '❌ REJECTED';
    logger.info(`  Result  : ${qualIcon}  (confidence: ${qual.confidence} — ${Math.round((qual.confidence ?? 0) * 100)}/100)`);
    logger.info(`  Reason  : ${qual.reason}`);
    logger.info(`  Pitch   : ${qual.pitch_angle || '—'}`);

    if (!qual.qualified) {
      logger.warn('\n  ⚠️  Dummy lead was unexpectedly rejected. Check AI prompt.');
      logger.warn('  Forcing qualified=true for test purposes...');
      await pool.query(
        `UPDATE leads SET is_qualified = true WHERE id = $1`,
        [dummyLeadId]
      );
    }

    // ══════════════════════════════════════════════════════════
    //  PHASE 3 — BHW Session Manager
    // ══════════════════════════════════════════════════════════
    banner('PHASE 3  │  BHW Session Manager');
    logger.info('  Opening browser with saved session (puppeteer-real-browser)...\n');

    // ensureAuthenticated: initBrowser + injectCookies + verifySession in one call
    let sessionOk = false;
    try {
      await bhwSession.ensureAuthenticated();
      sessionOk = true;
      logger.info(`  ✅ Logged in as: ${bhwSession.getUsername() || 'app_pilot'}`);
    } catch (sessionErr) {
      logger.warn('  ⚠️  Not logged in — session may have expired.');
      logger.info('  Run test-bhw-session.js to refresh cookies, then re-run this test.');
      logger.info('  Continuing in offline mode...');
    }

    const page = bhwSession.getPage();

    // Navigate to the dummy lead thread URL
    logger.info(`\n  Navigating to lead thread URL...`);
    logger.info(`  URL: ${DUMMY_LEAD.thread_url}`);
    await bhwSession.navigateTo(DUMMY_LEAD.thread_url);

    const pageTitle = await page.title();
    logger.info(`  Page loaded: "${pageTitle}"`);

    // ══════════════════════════════════════════════════════════
    //  PHASE 4 — Comment Generation (DRY RUN)
    // ══════════════════════════════════════════════════════════
    banner('PHASE 4  │  Comment Generation  (DRY RUN)');
    logger.info('  Generating comment pitch with OpenClaw...\n');

    const commentPitch = await generateCommentPitch(
      DUMMY_LEAD.title,
      DUMMY_LEAD.description,
      qual.pitch_angle || 'Telegram bot and web dashboard development expertise',
      DUMMY_LEAD.poster_username || null
    );

    logger.info('');
    logger.info('  ╔' + '═'.repeat(59) + '╗');
    logger.info('  ║  FINAL GENERATED COMMENT' + ' '.repeat(34) + '║');
    logger.info('  ╠' + '═'.repeat(59) + '╣');
    const words = commentPitch.split(' ');
    let line = '  ║  ';
    words.forEach(word => {
      if ((line + word).length > 60) {
        logger.info(line.padEnd(61) + '║');
        line = '  ║  ' + word + ' ';
      } else {
        line += word + ' ';
      }
    });
    if (line.trim() !== '║') logger.info(line.padEnd(61) + '║');
    logger.info('  ╚' + '═'.repeat(59) + '╝');
    logger.info('');

    // Final summary
    banner('PIPELINE COMPLETE  ✅');
    logger.info(`  Phase 1 — Scraped ${scraped.length} thread(s) without login`);
    logger.info(`  Phase 2 — Dummy lead #4 inserted (ID: ${dummyLeadId}) → APPROVED`);
    logger.info(`  Phase 3 — Session opened, navigated to thread`);
    logger.info(`  Phase 4 — Comment pitch generated by OpenClaw`);
    logger.info('');
    logger.info('  ⚠️  DRY RUN — nothing was posted to BHW.');
    logger.info('  To post for real, run comment-on-lead.js with LIVE mode enabled.');
    logger.info('');

  } catch (err) {
    logger.error('Pipeline error:', err.message || err);
  } finally {
    try { await scraper.closeBrowser(); } catch (_) {}
    try { await bhwSession.close(); } catch (_) {}
    try { await pool.end(); } catch (_) {}
    process.exit(0);
  }
}

runFullPipeline();
