/**
 * ============================================================
 *  FOLLOW-UP ENGINE — Full End-to-End Dry Run Test
 * ============================================================
 *
 *  What this does (in order):
 *
 *  PHASE 1 — BHW Inbox Scrape
 *    Opens BHW with your saved session.
 *    Reads the real conversation list (your actual inbox users).
 *    Takes the first MAX_USERS conversations as test subjects.
 *
 *  PHASE 2 — Seed DB with test follow-ups
 *    For each real inbox user:
 *      → Upserts a test lead + conversation record
 *      → Saves the BHW conversation URL
 *      → Sets last_response_from = 'us' (we sent last, no reply yet)
 *      → Generates a real follow-up message via OpenClaw AI
 *      → Creates a due follow-up record (scheduled 1 hr in the past)
 *
 *  PHASE 3 — processFollowUps (DRY RUN)
 *    Runs the actual follow-up engine.
 *    DRY RUN: reads + prints every message but does NOT send anything.
 *    Shows the decision tree in action (SEND / PAUSE / RESUME).
 *
 *  PHASE 4 — Cleanup
 *    Removes all test records from the DB so the test is repeatable.
 *
 * ============================================================
 */

import bhwSession    from './src/utils/bhwSession.js';
import logger        from './src/utils/logger.js';
import { pool, initDatabase } from './src/database/init.js';
import { query }     from './src/database/init.js';
import {
  createLead,
  getLeadByPosterUsername,
  createConversation,
  getConversationByLeadId,
  updateConversationBhwUrl,
  scheduleFollowUp,
} from './src/database/queries.js';
import { generateFollowUp } from './src/services/aiEngine.js';
import { processFollowUps } from './src/engines/follow-up.js';

// ── config ────────────────────────────────────────────────────────────────────
const MAX_USERS    = 5;   // how many inbox users to use as test subjects
const TEST_PREFIX  = 'test-followup-';  // prefix for thread_id to identify test data
const BHW_INBOX    = 'https://www.blackhatworld.com/conversations/';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function banner(title) {
  const line = '═'.repeat(63);
  logger.info('');
  logger.info(line);
  logger.info(`  ${title}`);
  logger.info(line);
}

function separator() { logger.info('  ' + '─'.repeat(59)); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: scrape real inbox, return [{url, subject, username, isUnread}]
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeInbox(page) {
  const convs = await page.evaluate(() => {
    const items = [];
    document.querySelectorAll('.structItem--conversation, .p-body-main .structItem').forEach(row => {
      const titleEl    = row.querySelector('.structItem-title a, a.structItem-title');
      const usernameEl = row.querySelector(
        '.structItem-parts .username, .structItem-cell--user .username'
      );
      if (!titleEl) return;

      const url      = titleEl.href;
      const subject  = titleEl.innerText?.trim() || '';
      const username = usernameEl ? usernameEl.innerText.trim() : null;
      const isUnread = row.classList.contains('is-unread') ||
                       row.classList.contains('structItem--unread') ||
                       !!row.querySelector('.is-unread, .structItem-unreadCount');

      if (url && username) items.push({ url, subject, username, isUnread });
    });
    return items;
  });

  return convs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upsert a test lead for the given inbox username.
 * Returns the lead row.
 */
async function upsertTestLead(username, subject) {
  // Check if we already have a lead for this username
  let lead = await getLeadByPosterUsername(username);
  if (lead) {
    logger.info(`  Lead already exists for @${username} (id=${lead.id})`);
    return lead;
  }

  // Create a fresh test lead — thread_id is namespaced so cleanup is safe
  lead = await createLead({
    threadId:          `${TEST_PREFIX}${username}`,
    threadUrl:         `https://www.blackhatworld.com/search?username=${username}`,
    title:             subject || `Conversation with @${username} (follow-up test)`,
    description:       `Test record created by test-follow-up.js for @${username}.`,
    posterUsername:    username,
    posterUrl:         null,
    postDate:          new Date(),
    threadAgeCategory: 'fresh',
    tags:              ['test'],
  });

  logger.info(`  Created test lead id=${lead.id} for @${username}`);
  return lead;
}

/**
 * Upsert a test conversation for the lead, storing bhw_conversation_url.
 * Also force last_response_from = 'us' so decision tree fires SEND.
 */
async function upsertTestConversation(lead, bhwUrl) {
  let conv = await getConversationByLeadId(lead.id);
  if (!conv) {
    conv = await createConversation(lead.id);
    logger.info(`  Created conversation id=${conv.id}`);
  } else {
    logger.info(`  Conversation already exists id=${conv.id}`);
  }

  // Store the real BHW URL
  await updateConversationBhwUrl(conv.id, bhwUrl);

  // Force last_response_from = 'us' — simulates: we sent a DM, they haven't replied
  await query(
    `UPDATE conversations
        SET last_response_from = 'us',
            last_message_at    = NOW() - INTERVAL '8 days',
            updated_at         = NOW()
      WHERE id = $1`,
    [conv.id]
  );

  logger.info(`  Conversation URL saved: ${bhwUrl}`);
  return conv;
}

/**
 * Delete any existing due test follow-ups for this lead, then create a fresh one.
 * scheduled_for = 1 hr in the past so it's immediately due.
 */
async function seedFollowUp(lead, conv, followUpText, followUpNumber = 1) {
  // Remove existing test follow-ups for this lead to avoid duplicates
  await query(
    `DELETE FROM follow_ups WHERE lead_id = $1 AND status IN ('pending','paused')`,
    [lead.id]
  );

  const dueNow = new Date(Date.now() - 60 * 60 * 1000); // 1 hr ago = due now

  const fu = await scheduleFollowUp({
    leadId:         lead.id,
    conversationId: conv.id,
    scheduledFor:   dueNow,
    followUpNumber: followUpNumber,
    messageText:    followUpText,
  });

  logger.info(`  ✅  Follow-up #${followUpNumber} seeded (due: ${dueNow.toLocaleTimeString()})`);
  return fu;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: cleanup test records
// ─────────────────────────────────────────────────────────────────────────────
async function cleanupTestData(seededLeadIds) {
  if (seededLeadIds.length === 0) return;

  logger.info(`  Removing ${seededLeadIds.length} test lead(s) and associated records…`);
  for (const leadId of seededLeadIds) {
    // follow_ups and dms cascade-delete; conversations do not in all setups → manual
    await query('DELETE FROM follow_ups   WHERE lead_id = $1', [leadId]);
    await query('DELETE FROM dms          WHERE lead_id = $1', [leadId]);
    await query('DELETE FROM conversations WHERE lead_id = $1', [leadId]);
    await query('DELETE FROM leads        WHERE id       = $1', [leadId]);
  }
  logger.info('  Cleanup complete — test data removed.');
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function runFollowUpTest() {
  const seededLeadIds = [];   // track so we can clean up

  try {

    // Run migrations first (adds bhw_conversation_url, paused_reason if missing)
    await initDatabase();
    logger.info('  DB migrations applied\n');

    // ══════════════════════════════════════════════════════════
    //  PHASE 1 — Scrape real BHW inbox
    // ══════════════════════════════════════════════════════════
    banner('PHASE 1  │  BHW Inbox Scrape  (real session)');

    logger.info('  Authenticating with BHW session cookies…');
    await bhwSession.ensureAuthenticated();
    logger.info('  ✅  Authenticated\n');

    logger.info(`  Navigating to inbox: ${BHW_INBOX}`);
    await bhwSession.navigateTo(BHW_INBOX);
    await sleep(2000);

    const page  = await bhwSession.getPage();
    const allConvs = await scrapeInbox(page);

    if (allConvs.length === 0) {
      logger.warn('  ⚠️  No conversations found in inbox.');
      logger.warn('  Check that bhw-cookies.json is fresh and your inbox is not empty.');
      process.exit(1);
    }

    const convs = allConvs.slice(0, MAX_USERS);
    logger.info(`  Found ${allConvs.length} conversation(s) — using first ${convs.length}:\n`);

    convs.forEach((c, i) => {
      logger.info(`  ${i + 1}. @${c.username?.padEnd(25)} ${c.isUnread ? '[UNREAD]' : '       '} — "${c.subject}"`);
      logger.info(`       URL: ${c.url}`);
    });


    // ══════════════════════════════════════════════════════════
    //  PHASE 2 — Seed test follow-ups in DB
    // ══════════════════════════════════════════════════════════
    banner('PHASE 2  │  Seeding Test Follow-ups  (DB)');

    for (let i = 0; i < convs.length; i++) {
      const conv = convs[i];
      separator();
      logger.info(`\n  [${i + 1}/${convs.length}] @${conv.username}`);
      logger.info(`  Subject : "${conv.subject}"`);

      // Lead
      const lead   = await upsertTestLead(conv.username, conv.subject);

      // Only track newly-created test leads for cleanup
      if (lead.thread_id?.startsWith(TEST_PREFIX)) {
        seededLeadIds.push(lead.id);
      }

      // Conversation + URL
      const dbConv = await upsertTestConversation(lead, conv.url);

      // Generate AI follow-up for this user (day 7 scenario)
      logger.info('  Generating follow-up message with OpenClaw…');
      let followUpText;
      try {
        followUpText = await generateFollowUp(
          lead.title,
          lead.description || '',
          7,                               // days since last contact (test scenario)
          `Outbound DM to @${conv.username}\n(simulated for follow-up test)`
        );
      } catch (err) {
        logger.warn(`  OpenClaw error: ${err.message} — using placeholder text`);
        followUpText = `Hey @${conv.username}, just circling back on my earlier message! 

I mentioned we help with bot development, automation, and full-stack builds. Have you had a chance to review it?

If now isn't the right time just let me know — happy to reconnect whenever works for you.`;
      }

      logger.info(`  Generated follow-up (${followUpText.length} chars):`);
      logger.info('  ┌' + '─'.repeat(57));
      followUpText.split('\n').forEach(line => logger.info(`  │ ${line}`));
      logger.info('  └' + '─'.repeat(57));

      // Seed the follow-up as immediately due
      await seedFollowUp(lead, dbConv, followUpText, 1);

      await sleep(500); // brief pause between AI calls
    }


    // ══════════════════════════════════════════════════════════
    //  PHASE 3 — processFollowUps (DRY RUN)
    // ══════════════════════════════════════════════════════════
    banner('PHASE 3  │  processFollowUps  ⚡  DRY RUN  ⚡');
    logger.info('  DRY RUN = true — messages will be SHOWN but NOT sent\n');
    logger.info('  Decision tree: last_response_from=\'us\' → SEND (dry)\n');

    const result = await processFollowUps({ dryRun: true });

    separator();
    logger.info('');
    logger.info(`  📊  Follow-up engine results:`);
    logger.info(`       Sent (dry):  ${result.sent}`);
    logger.info(`       Paused:      ${result.paused}`);
    logger.info(`       Resumed:     ${result.resumed}`);
    logger.info(`       Errors:      ${result.errors}`);


    // ══════════════════════════════════════════════════════════
    //  PHASE 4 — Cleanup test data
    // ══════════════════════════════════════════════════════════
    banner('PHASE 4  │  Cleanup');

    if (seededLeadIds.length > 0) {
      logger.info(`  Cleaning up ${seededLeadIds.length} test lead(s) created by this test…`);
      await cleanupTestData(seededLeadIds);
    } else {
      logger.info('  No newly-created test leads to clean up (all leads already existed in DB).');
    }

    banner('TEST COMPLETE ✅');
    logger.info('  Follow-up engine dry-run passed successfully.');
    logger.info('  To go live: call processFollowUps({ dryRun: false })');
    logger.info('  Or start the loop: startFollowUpSystem({ dryRun: false })\n');

  } catch (err) {
    logger.error(`\nTest failed: ${err.message}`);
    logger.error(err.stack);

    // Still try to clean up on error
    if (seededLeadIds.length > 0) {
      logger.info('\nAttempting cleanup after error…');
      await cleanupTestData(seededLeadIds).catch(() => {});
    }

    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
    process.exit(0);
  }
}

runFollowUpTest();
