/**
 * Inbox Monitor
 *
 * Two ways this runs:
 *
 *  1. HOURLY LOOP  (via startInboxMonitor)
 *     Called once at bot startup; runs checkAndReplyToInbox() every hour.
 *
 *  2. POST-COMMENT HOOK  (via checkAndReplyToInbox exported directly)
 *     The comment engine calls this after every successful live post so
 *     we never leave a BHW reply sitting unanswered while the bot is active.
 *
 * What checkAndReplyToInbox does:
 *  - Navigates to https://www.blackhatworld.com/conversations/
 *  - Finds all conversations marked as unread
 *  - Skips any whose last reply was from us (nothing to answer)
 *  - For each conversation that needs a reply:
 *      → looks up the lead in the DB by poster_username
 *      → calls conversation engine to generate + send the reply
 *      → saves the reply to the DB
 */

import logger from '../utils/logger.js';
import { botState } from '../utils/botState.js';
import { sleep, randomDelay } from '../utils/helpers.js';
import bhwSession from '../utils/bhwSession.js';
import { handleConversation } from './conversation.js';
import {
  getLeadByPosterUsername,
  getConversationByLeadId,
  createDM,
  incrementConversationMessages,
  logActivity,
  pauseFollowUpsForConversation,
} from '../database/queries.js';

const BHW_CONVERSATIONS_URL = 'https://www.blackhatworld.com/conversations/';

// ─────────────────────────────────────────────────
// INBOX SCRAPING
// ─────────────────────────────────────────────────

/**
 * Scrape the BHW conversations list page.
 * Returns an array of conversation items the bot needs to reply to.
 *
 * XenForo 2 conversation list structure:
 *   .structItem--conversation   — each row
 *   .structItem--unread         — unread marker class
 *   .structItem-title a         — conversation URL + subject
 *   .structItem-parts .username — other person's username
 *
 * We also check conversations from the last 30 days even if marked read,
 * in case a reply slipped by (last message from them, not us).
 */
async function scrapeConversationList(page) {
  const conversations = await page.evaluate(() => {
    const items = [];
    document.querySelectorAll('.structItem--conversation, .p-body-main .structItem').forEach(row => {
      const titleEl    = row.querySelector('.structItem-title a, a.structItem-title');
      const usernameEl = row.querySelector('.structItem-parts .username, .structItem-cell--user .username');
      if (!titleEl) return;

      const url      = titleEl.href;
      const subject  = titleEl.innerText.trim();
      const username = usernameEl ? usernameEl.innerText.trim() : null;
      const isUnread = row.classList.contains('is-unread') ||
                       row.classList.contains('structItem--unread') ||
                       !!row.querySelector('.is-unread, .structItem-unreadCount');

      items.push({ url, subject, username, isUnread });
    });
    return items;
  });

  return conversations;
}

// ─────────────────────────────────────────────────
// MAIN: Check + reply to all pending conversations
// ─────────────────────────────────────────────────

/**
 * Check BHW inbox and reply to any conversations where the other
 * person sent the last message.
 *
 * This is exported and called from two places:
 *  - startInboxMonitor()       → every hour
 *  - comment engine            → immediately after every live post
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun] - generate replies but do not send
 */
export async function checkAndReplyToInbox(opts = {}) {
  logger.info('📬 Inbox check started...');

  try {
    // Ensure BHW session is active
    await bhwSession.ensureAuthenticated();
    const page = bhwSession.getPage();

    // Navigate to conversations list
    logger.info('  Navigating to BHW conversations...');
    await page.goto(BHW_CONVERSATIONS_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await sleep(randomDelay(2000, 3500));

    // Scrape the list
    const conversations = await scrapeConversationList(page);
    logger.info(`  Found ${conversations.length} conversation(s) in inbox.`);

    if (conversations.length === 0) {
      logger.info('  Inbox empty — nothing to do.');
      return { checked: 0, replied: 0 };
    }

    const unread = conversations.filter(c => c.isUnread);
    logger.info(`  Unread: ${unread.length}`);

    if (unread.length === 0) {
      logger.info('  No unread conversations — nothing to reply to.');
      return { checked: conversations.length, replied: 0 };
    }

    let replied = 0;

    for (const conv of unread) {
      if (!conv.username) {
        logger.warn(`  Skipping conversation with unknown username: ${conv.url}`);
        continue;
      }

      logger.info('');
      logger.info(`  Processing: "${conv.subject}" with @${conv.username}`);

      // Look up lead in DB
      const lead   = await getLeadByPosterUsername(conv.username);
      const dbConv = lead ? await getConversationByLeadId(lead.id) : null;

      // Skip conversations that Zeeshan is now handling manually after a [HANDOFF]
      if (dbConv && dbConv.is_handed_off) {
        logger.info(`  ⏭️  Skipping @${conv.username} — conversation handed off to Zeeshan (manual).`);
        continue;
      }

      if (!lead) {
        logger.info(`  @${conv.username} not in leads DB — replying anyway (no DB link).`);
      }

      // Handle the conversation (navigate → read → generate → send)
      try {
        const result = await handleConversation(
          conv.url,
          conv.username,
          lead   || null,
          dbConv ? dbConv.id : null,
          opts
        );

        if (result.success && !result.dryRun) {
          replied++;

          if (result.handoff) {
            logger.warn(`  🚨 Handoff complete — @${conv.username} is now with Zeeshan.`);
            // Pause all follow-ups indefinitely — Zeeshan handles it from here
            if (dbConv) {
              await pauseFollowUpsForConversation(dbConv.id, 'handed_off').catch(() => {});
              logger.info(`  ⏸️  Paused follow-ups for conversation #${dbConv.id} (handed off)`);
            }
          } else {
            // Normal reply — pause follow-ups temporarily (they replied, no need to nudge)
            if (dbConv) {
              await pauseFollowUpsForConversation(dbConv.id, 'reply_received').catch(() => {});
              logger.info(`  ⏸️  Paused follow-ups for conversation #${dbConv.id} (reply received)`);
            }
          }

          // Log activity
          if (lead) {
            await logActivity({
              actionType:  result.handoff ? 'handoff_reply' : 'dm_reply',
              leadId:       lead.id,
              description: result.handoff
                ? `Final auto-reply + handoff triggered for @${conv.username}`
                : `Replied to @${conv.username} via inbox monitor`,
              metadata:    { convUrl: conv.url, replyLength: result.replyText?.length },
            }).catch(() => {});
          }
        } else if (result.reason === 'last_is_ours') {
          logger.info(`  Skipped — last message in this thread is already ours.`);
        } else if (result.reason === 'no_messages') {
          logger.info(`  Skipped — no messages found.`);
        }

        // Small pause between conversations (looks natural)
        await sleep(randomDelay(3000, 8000));

      } catch (convErr) {
        logger.error(`  Error handling conversation with @${conv.username}:`, convErr.message);
      }
    }

    logger.info('');
    logger.info(`📬 Inbox check complete — replied to ${replied} conversation(s).`);
    return { checked: conversations.length, replied };

  } catch (err) {
    logger.error('Inbox check failed:', err.message);
    return { checked: 0, replied: 0 };
  }
}

// ─────────────────────────────────────────────────
// RANDOM INTERVAL LOOP
// ─────────────────────────────────────────────────

// Randomise between minMs and maxMs (inclusive)
function randomInterval(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/**
 * Start the inbox monitor loop.
 *
 * Each wait is re-randomised AFTER every check completes, so BHW
 * never sees a predictable pattern. Range: 1 hour – 2 hours.
 *
 * Called once from src/index.js at bot startup.
 */
export function startInboxMonitor(opts = {}) {
  const MIN_MS = 60  * 60 * 1000; // 1 hour
  const MAX_MS = 120 * 60 * 1000; // 2 hours

  async function scheduleNext() {
    const waitMs  = randomInterval(MIN_MS, MAX_MS);
    const waitMin = Math.round(waitMs / 60000);
    logger.info(`📬 Inbox monitor: next check in ${waitMin} minutes`);

    setTimeout(async () => {
      if (botState.isPaused()) {
        logger.info('⏸️  Bot paused — skipping inbox check');
      } else {
        await checkAndReplyToInbox(opts);
      }
      scheduleNext(); // re-randomise after every check
    }, waitMs);
  }

  logger.info('📬 Inbox monitor started (random interval: 1–2 hours)');
  scheduleNext();
}

export default { checkAndReplyToInbox, startInboxMonitor };

