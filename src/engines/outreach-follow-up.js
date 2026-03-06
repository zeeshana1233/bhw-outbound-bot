/**
 * Outreach Follow-Up Engine
 *
 * [THREADS-OWNER-OUTREACH] module — called at end of each daily batch.
 *
 * NOT a separate loop. Called as runOutreachFollowUps() from:
 *   - threads-owner-outreach.js (end of each batch)
 *   - bot startup (catches follow-ups due while server was down)
 *
 * Logic:
 *   1. Query outreach_follow_ups WHERE status='pending' AND scheduled_for <= NOW()
 *   2. For each due follow-up:
 *      - If last_response_from = 'them' → cancel (they replied, inbox handles it)
 *      - Else → send pre-generated message, mark sent
 *   3. Cold detection: all 3 sent + no reply + FU3 sent >7 days ago → mark cold
 */

import logger                       from '../utils/logger.js';
import { sleep, randomDelay }       from '../utils/helpers.js';
import bhwSession                   from '../utils/bhwSession.js';
import alerts                       from '../services/alerts.js';
import { logActivity }              from '../database/queries.js';
import {
  getDueOutreachFollowUps,
  markOutreachFollowUpSent,
  markOutreachFollowUpFailed,
  cancelOutreachFollowUps,
  updateOutreachConversationStatus,
  incrementOutreachConversationMessages,
  markOutreachTargetCold,
  getOutreachColdTargets,
}                                   from '../database/queries.js';

const TAG = '[THREADS-OWNER-OUTREACH]';

// ─────────────────────────────────────────────────────────────────────────────
// SEND A PRE-GENERATED FOLLOW-UP MESSAGE
// ─────────────────────────────────────────────────────────────────────────────

async function sendFollowUpMessage(bhwConversationUrl, messageText, dryRun = false) {
  if (dryRun) {
    logger.info(`  [DRY RUN] Would send follow-up to: ${bhwConversationUrl}`);
    logger.info(`  [DRY RUN] Text (${messageText.length} chars): ${messageText.slice(0, 80)}...`);
    return { success: true, dryRun: true };
  }

  if (!bhwConversationUrl) {
    return { success: false, error: 'No bhw_conversation_url stored — cannot navigate to conversation' };
  }

  const page = bhwSession.page;

  try {
    await bhwSession.navigateTo(bhwConversationUrl);
    await sleep(randomDelay(1500, 3000));

    // Click reply box — Froala editor
    const editorSelectors = [
      '.fr-element[contenteditable="true"]',
      '.messageTextEditor [contenteditable="true"]',
      'div[contenteditable="true"]',
    ];
    let editorFound = false;
    for (const sel of editorSelectors) {
      const el = await page.$(sel);
      if (el) {
        await page.evaluate((s) => {
          const e = document.querySelector(s);
          if (e) e.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, sel);
        await sleep(randomDelay(600, 1200));
        await el.click();
        editorFound = true;
        break;
      }
    }
    if (!editorFound) throw new Error('Reply editor not found on conversation page');

    await sleep(randomDelay(400, 800));

    // Type message with human simulation
    for (const char of messageText) {
      await page.keyboard.type(char);
      await sleep(randomDelay(45, 130));
    }

    await sleep(randomDelay(1500, 3500));

    // Submit
    const submitSelectors = [
      'button.button--primary[type="submit"]',
      'button[type="submit"]',
    ];
    let submitted = false;
    for (const sel of submitSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.scrollIntoView().catch(() => {});
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

export async function runOutreachFollowUps(opts = {}) {
  const dryRun = opts.dryRun !== undefined ? opts.dryRun : (process.env.DRY_RUN !== 'false');
  const limit  = opts.limit  !== undefined ? opts.limit  : Infinity; // pass limit:1 for per-DM mode

  logger.info(`${TAG} Running follow-ups check… (limit: ${limit === Infinity ? 'all' : limit})`);

  // ── 1. Get all due pending follow-ups ───────────────────────────────────
  const allDue       = await getDueOutreachFollowUps();
  const dueFollowUps = limit === Infinity ? allDue : allDue.slice(0, limit);

  if (allDue.length === 0) {
    logger.info(`${TAG} No follow-ups due.`);
  } else {
    logger.info(`${TAG} ${allDue.length} follow-up(s) due — processing ${dueFollowUps.length}`);
  }

  for (const fu of dueFollowUps) {
    const username = fu.poster_username || `target#${fu.target_id}`;
    logger.info(`  Follow-up #${fu.follow_up_number} for @${username}`);

    // ── 2a: If they already replied — cancel this follow-up ──────────────
    if (fu.last_response_from === 'them') {
      await cancelOutreachFollowUps(fu.target_id);
      logger.info(`  ⏭ @${username} already replied — cancelling pending follow-ups`);
      continue;
    }

    // ── 2b: No message text — skip gracefully ───────────────────────────
    if (!fu.message_text || fu.message_text.trim().length < 5) {
      await markOutreachFollowUpFailed(fu.id);
      logger.warn(`  ⚠️ No pre-generated message for follow-up #${fu.follow_up_number} — skipping`);
      continue;
    }

    // ── 2c: Send the follow-up ───────────────────────────────────────────
    await bhwSession.ensureAuthenticated();

    const result = await sendFollowUpMessage(fu.bhw_conversation_url, fu.message_text, dryRun);

    if (result.success) {
      await markOutreachFollowUpSent(fu.id);
      await incrementOutreachConversationMessages(fu.conversation_id, 'outbound');
      await updateOutreachConversationStatus(fu.conversation_id, 'waiting_reply', 'us');

      await logActivity({
        actionType:  'threads_owner_outreach_follow_up_sent',
        leadId:      null,
        metadata:    {
          target_id:        fu.target_id,
          conversation_id:  fu.conversation_id,
          follow_up_number: fu.follow_up_number,
          dry_run:          dryRun,
        },
      }).catch(() => {});

      await alerts.sendRawAlert(
        `${TAG} Follow-up #${fu.follow_up_number} sent ✅\n` +
        `To: @${username}\n` +
        `Thread: "${(fu.title || '').slice(0, 80)}"` +
        (dryRun ? '\n⚠️ DRY RUN' : '')
      ).catch(() => {});

      logger.info(`  ✅ Follow-up #${fu.follow_up_number} sent to @${username}`);
    } else {
      await markOutreachFollowUpFailed(fu.id);
      logger.error(`  ❌ Follow-up #${fu.follow_up_number} failed for @${username}: ${result.error}`);
    }

    // Brief gap between follow-ups
    await sleep(randomDelay(30000, 90000));
  }

  // ── 3. Cold detection ────────────────────────────────────────────────────
  const coldTargets = await getOutreachColdTargets();
  for (const cold of coldTargets) {
    await markOutreachTargetCold(cold.target_id);
    await updateOutreachConversationStatus(cold.target_id, 'cold').catch(() => {});

    await alerts.sendRawAlert(
      `${TAG} Marked cold ❄️\n` +
      `@${cold.poster_username} — no reply after all 3 follow-ups\n` +
      `Thread: "${(cold.title || '').slice(0, 80)}"`
    ).catch(() => {});

    logger.info(`${TAG} ❄️ @${cold.poster_username} marked cold (no reply after 3 follow-ups)`);
  }

  logger.info(`${TAG} Follow-ups check complete.`);
}
