/**
 * Outreach Inbox Engine
 *
 * [THREADS-OWNER-OUTREACH] module — called at end of each daily batch.
 *
 * NOT a separate loop. Called as checkOutreachInbox() from:
 *   - threads-owner-outreach.js (end of each batch, after runOutreachFollowUps)
 *
 * Logic:
 *   1. Navigate to BHW /conversations/
 *   2. Scan all listed conversations for unread messages
 *   3. For each unread conv: is the other_username in outreach_targets?
 *      → NO: skip (main inbox-monitor.js owns it, no conflict)
 *      → YES: this module handles it
 *   4. Read full message history, save inbound DM, generate reply, send it
 *   5. Cancel all pending follow-ups for this target
 */

import logger                       from '../utils/logger.js';
import { sleep, randomDelay }       from '../utils/helpers.js';
import bhwSession                   from '../utils/bhwSession.js';
import aiEngine                     from '../services/aiEngine.js';
import alerts                       from '../services/alerts.js';
import { logActivity }              from '../database/queries.js';
import {
  getOutreachTargetByUsername,
  getOutreachConversationByTargetId,
  markOutreachTargetReplied,
  cancelOutreachFollowUps,
  createOutreachDM,
  getOutreachDMsByConversation,
  updateOutreachConversationStatus,
  incrementOutreachConversationMessages,
}                                   from '../database/queries.js';

const TAG     = '[THREADS-OWNER-OUTREACH]';
const BHW_BASE = 'https://www.blackhatworld.com';

// ─────────────────────────────────────────────────────────────────────────────
// READ ALL MESSAGES FROM AN OPEN CONVERSATION PAGE
// ─────────────────────────────────────────────────────────────────────────────

async function readConversationMessages(page) {
  return await page.evaluate(() => {
    const messages = [];
    const articles = document.querySelectorAll('article.message, .message--post');
    articles.forEach(art => {
      const usernameEl = art.querySelector('.message-name a.username, .message-userDetails .username');
      const bodyEl     = art.querySelector('.bbWrapper, .message-body .bbWrapper, .message-content');
      if (bodyEl) {
        messages.push({
          username: usernameEl ? usernameEl.textContent.trim() : 'unknown',
          text:     bodyEl.innerText.trim(),
        });
      }
    });
    return messages;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SCAN INBOX FOR UNREAD CONVERSATIONS
// ─────────────────────────────────────────────────────────────────────────────

async function getUnreadConversations(page) {
  try {
    await bhwSession.navigateTo(`${BHW_BASE}/conversations/`);
    await sleep(randomDelay(1500, 3000));

    return await page.evaluate(() => {
      const results = [];
      const items   = document.querySelectorAll('.conversation-item, .structItem--conversation');
      items.forEach(item => {
        // Check for unread indicator
        const isUnread  = item.classList.contains('is-unread') ||
                          item.querySelector('.structItem-cell--unread, .unreadIndicator');
        if (!isUnread) return;

        // Extract conversation URL
        const linkEl   = item.querySelector('a[href*="/conversations/"]');
        const convUrl  = linkEl ? linkEl.href : null;

        // Extract the other participant's username (not our own)
        const userEls = item.querySelectorAll('.username');
        const names   = Array.from(userEls).map(e => e.textContent.trim()).filter(Boolean);
        const subject = item.querySelector('.structItem-title a, .conversation-title a');

        if (convUrl) {
          results.push({
            conversationUrl: convUrl,
            participants:    names,
            subject:         subject ? subject.textContent.trim() : '',
          });
        }
      });
      return results;
    });
  } catch (err) {
    logger.warn(`${TAG} Error scanning inbox: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND A REPLY ON AN OPEN CONVERSATION PAGE
// ─────────────────────────────────────────────────────────────────────────────

async function sendConversationReply(page, replyText, dryRun = false) {
  if (dryRun) {
    logger.info(`  [DRY RUN] Would send reply: ${replyText.slice(0, 80)}...`);
    return { success: true, dryRun: true };
  }

  try {
    const editorSelectors = [
      '.fr-element[contenteditable="true"]',
      '.messageTextEditor [contenteditable="true"]',
      'div[contenteditable="true"]',
    ];
    let clickTarget = null;
    for (const sel of editorSelectors) {
      const el = await page.$(sel);
      if (el) { clickTarget = el; break; }
    }
    if (!clickTarget) throw new Error('Reply editor not found');

    await page.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), clickTarget);
    await sleep(randomDelay(500, 1000));
    await clickTarget.click();
    await sleep(randomDelay(400, 800));

    for (const char of replyText) {
      await page.keyboard.type(char);
      await sleep(randomDelay(45, 130));
    }

    await sleep(randomDelay(1500, 3500));

    const submitSelectors = ['button.button--primary[type="submit"]', 'button[type="submit"]'];
    let submitted = false;
    for (const sel of submitSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        await page.evaluate(el => el.scrollIntoView({ behavior: 'smooth' }), btn);
        await sleep(randomDelay(300, 700));
        await btn.click();
        submitted = true;
        break;
      }
    }
    if (!submitted) throw new Error('Submit button not found');

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 }).catch(() => {});
    await sleep(randomDelay(800, 2000));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export async function checkOutreachInbox(opts = {}) {
  const dryRun     = opts.dryRun !== undefined ? opts.dryRun : (process.env.DRY_RUN !== 'false');
  const ourUsername = process.env.BHW_USERNAME || 'app_pilot';

  logger.info(`${TAG} Checking inbox for outreach replies…`);

  await bhwSession.ensureAuthenticated();
  const page = bhwSession.page;

  // ── 1. Scan inbox for unread conversations ─────────────────────────────
  const unreadConvs = await getUnreadConversations(page);
  logger.info(`${TAG} ${unreadConvs.length} unread conversation(s) found`);

  for (const conv of unreadConvs) {
    // ── 2. Identify the other participant ─────────────────────────────────
    const otherUsername = conv.participants.find(u => u !== ourUsername);
    if (!otherUsername) continue;

    // ── 3. Does this username belong to an outreach target? ───────────────
    const target = await getOutreachTargetByUsername(otherUsername).catch(() => null);
    if (!target) {
      // Not an outreach target — main inbox-monitor.js owns this conversation
      logger.debug(`${TAG} @${otherUsername} not in outreach_targets — skipping (main pipeline owns it)`);
      continue;
    }

    logger.info(`${TAG} Reply detected from @${otherUsername} — handling…`);

    // ── 4. Navigate to conversation and read full history ─────────────────
    try {
      await bhwSession.navigateTo(conv.conversationUrl);
      await sleep(randomDelay(1500, 3000));

      const messages = await readConversationMessages(page);
      const lastMsg  = messages[messages.length - 1];

      // Is the last message from THEM? (If it's ours, nothing to reply to)
      if (!lastMsg || lastMsg.username === ourUsername) {
        logger.info(`  ⏭ Last message is ours — nothing to reply`);
        continue;
      }

      const theirLastMessage = lastMsg.text;

      // Get or create conversation row
      let dbConv = await getOutreachConversationByTargetId(target.id).catch(() => null);
      if (!dbConv) {
        logger.warn(`${TAG} No outreach_conversations row for target #${target.id} — skipping`);
        continue;
      }

      // ── 4a. Save their inbound message ───────────────────────────────────
      await createOutreachDM({
        targetId:       target.id,
        conversationId: dbConv.id,
        direction:      'inbound',
        messageText:    theirLastMessage,
        messageType:    'reply',
      });
      await incrementOutreachConversationMessages(dbConv.id, 'inbound');

      // ── 4b. Update target status ──────────────────────────────────────────
      await markOutreachTargetReplied(target.id);

      // ── 4c. Cancel all pending follow-ups ─────────────────────────────────
      await cancelOutreachFollowUps(target.id);

      // ── 4d. Generate contextual reply ────────────────────────────────────
      const dbDMs = await getOutreachDMsByConversation(dbConv.id).catch(() => messages.map(m => ({
        direction:    m.username === ourUsername ? 'outbound' : 'inbound',
        message_text: m.text,
      })));

      const replyText = await aiEngine.generateThreadsOwnerOutreachReply(
        target.title  || '(untitled)',
        target.description || '',
        dbDMs
      );

      if (!replyText || replyText.trim().length < 10) {
        logger.warn(`${TAG} AI returned empty reply for @${otherUsername} — skipping`);
        continue;
      }

      // ── 4e. Send reply ────────────────────────────────────────────────────
      const sendResult = await sendConversationReply(page, replyText, dryRun);

      if (sendResult.success) {
        await createOutreachDM({
          targetId:       target.id,
          conversationId: dbConv.id,
          direction:      'outbound',
          messageText:    replyText,
          messageType:    'reply',
        });
        await incrementOutreachConversationMessages(dbConv.id, 'outbound');
        await updateOutreachConversationStatus(dbConv.id, 'replied', 'us');

        await logActivity({
          action_type: 'threads_owner_outreach_reply_sent',
          lead_id:     null,
          metadata:    JSON.stringify({
            target_id:       target.id,
            poster_username: otherUsername,
            conversation_id: dbConv.id,
            dry_run:         dryRun,
          }),
        }).catch(() => {});

        await alerts.sendRawAlert(
          `${TAG} Reply received & answered 💬\n` +
          `From: @${otherUsername}\n` +
          `Thread: "${(target.title || '').slice(0, 80)}"\n` +
          `Their message: "${theirLastMessage.slice(0, 100)}…"\n` +
          `Our reply: sent ✅ (Telegram CTA included)` +
          (dryRun ? '\n⚠️ DRY RUN' : '')
        ).catch(() => {});

        logger.info(`${TAG} ✅ Replied to @${otherUsername}`);
      } else {
        logger.error(`${TAG} Reply send failed for @${otherUsername}: ${sendResult.error}`);
      }
    } catch (err) {
      logger.error(`${TAG} Error handling reply from @${otherUsername}: ${err.message}`);
    }

    // Brief gap between handling multiple replies
    await sleep(randomDelay(20000, 60000));
  }

  logger.info(`${TAG} Inbox check complete.`);
}
