import logger from '../utils/logger.js';
import { randomDelay } from '../utils/helpers.js';
import bhwSession from '../utils/bhwSession.js';
import {
  getPendingFollowUpsWithContext,
  getResumableFollowUps,
  pauseFollowUpsForConversation,
  rescheduleFollowUp,
  markFollowUpSent,
  markFollowUpFailed,
  logActivity,
} from '../database/queries.js';
import { sendConversationReply, readConversationMessages } from './conversation.js';
import alerts from '../services/alerts.js';

// ── timing constants ──────────────────────────────────────────────────────────
const LOOP_MIN_MS = 30 * 60 * 1000;   // 30 min
const LOOP_MAX_MS = 90 * 60 * 1000;   // 90 min

function randomLoopInterval() {
  return LOOP_MIN_MS + Math.floor(Math.random() * (LOOP_MAX_MS - LOOP_MIN_MS));
}

// ── sendFollowUp ──────────────────────────────────────────────────────────────
/**
 * Navigate to the stored BHW conversation and send the pre-written follow-up.
 * Checks live conversation messages first: if the client replied, pauses follow-ups.
 * @param {object} fu   - Row from getPendingFollowUpsWithContext()
 * @param {object} opts - { dryRun: boolean }
 * @returns {boolean}
 */
async function sendFollowUp(fu, opts = {}) {
  const { id, conversation_id, lead_id, follow_up_number, message_text,
          lead_poster_username, bhw_conversation_url, lead_title } = fu;

  if (opts.dryRun) {
    logger.info(`  [DRY RUN] Follow-up Message 2 preview for @${lead_poster_username}:\n  ${message_text}`);
    await markFollowUpSent(id).catch(() => {});
    
    // Send preview card to Discord DM Alerts channel
    await alerts.sendOutreachReport([
      `⏰ *Follow-Up Message 2 Sent! [DRY RUN]*`,
      '',
      `👤 User: @${lead_poster_username}`,
      `📌 Job: "${lead_title}"`,
      `🔗 ${bhw_conversation_url || 'https://www.blackhatworld.com/conversations/'}`,
      '',
      `📩 *Message 2 (Follow-Up):*`,
      message_text,
    ].join('\n')).catch(() => {});

    return true;
  }

  if (!bhw_conversation_url) {
    logger.warn(`  ⚠️  No BHW URL stored for follow-up #${id} (conv #${conversation_id}) — skipping`);
    await markFollowUpFailed(id, 'no_bhw_url').catch(() => {});
    return false;
  }

  logger.info(`  Checking follow-up #${follow_up_number} → @${lead_poster_username}`);
  logger.info(`    "${lead_title?.slice(0, 60)}…"`);
  logger.info(`    URL: ${bhw_conversation_url}`);

  try {
    await bhwSession.ensureAuthenticated();
    const page = await bhwSession.getPage();

    await bhwSession.navigateTo(bhw_conversation_url);
    await randomDelay(2000, 4000);

    // ── Live Page Check: Did the client EVER reply? ───────────────────────
    const messages = await readConversationMessages(page).catch(() => []);
    if (messages.length > 0) {
      // Find if there is ANY message in the chat from the client
      const clientMessage = messages.find(m => !m.isOurs);
      if (clientMessage) {
        logger.info(`  ⏸️  Client @${lead_poster_username} ALREADY REPLIED! Pausing follow-up #${id}`);
        logger.info(`      Client message: "${clientMessage.text.substring(0, 100)}..."`);
        
        await pauseFollowUpById(id, 'client_replied_live').catch(() => {});
        if (lead_id) await pauseFollowUpsForLead(lead_id, 'client_replied_live').catch(() => {});
        if (conversation_id) await pauseFollowUpsForConversation(conversation_id, 'client_replied_live').catch(() => {});
        
        // Notify Discord that the client replied so Zeeshan knows
        await alerts.sendRawAlert([
          `📬 *CLIENT REPLIED ON BHW!*`,
          '',
          `👤 User: @${lead_poster_username}`,
          `📌 Job: "${lead_title}"`,
          `🔗 ${bhw_conversation_url}`,
          '',
          `💬 Message from client:`,
          `"${clientMessage.text.substring(0, 300)}"`,
          '',
          `✅ Follow-up was safely paused. Check BHW conversation!`,
        ].join('\n')).catch(() => {});

        return false;
      }
    }

    // Small human pause before typing
    await randomDelay(2000, 5000);

    await sendConversationReply(page, message_text);

    await markFollowUpSent(id);

    await logActivity({
      actionType:  'follow_up_sent',
      leadId:       lead_id,
      description: `Follow-up #${follow_up_number} sent to @${lead_poster_username}`,
      metadata:    { convUrl: bhw_conversation_url, messageLength: message_text.length },
    }).catch(() => {});

    logger.info(`  ✅  Follow-up #${follow_up_number} sent to @${lead_poster_username}`);
    return true;

  } catch (err) {
    logger.error(`  ❌  Follow-up #${id} failed: ${err.message}`);
    await markFollowUpFailed(id, err.message.slice(0, 200)).catch(() => {});
    return false;
  }
}

// ── processFollowUps ──────────────────────────────────────────────────────────
/**
 * Core routine — one tick of the follow-up system.
 *
 * Decision tree:
 *   PENDING + due now
 *     last_response_from = 'them'  → PAUSE  (they replied; inbox-monitor will handle it)
 *     last_response_from = 'us'    → SEND   (they went cold; nudge them)
 *
 *   PAUSED + cold again (last_response_from='us', silent 3+ days)
 *     → RESCHEDULE 1–6 hrs from now (resume sequence)
 *
 * @param {object} opts - { dryRun: boolean }
 */
export async function processFollowUps(opts = {}) {
  logger.info('📨  Processing follow-ups…');

  let sent    = 0;
  let paused  = 0;
  let resumed = 0;
  let errors  = 0;

  // ── 1. Due PENDING follow-ups ────────────────────────────────────────────────
  const pending = await getPendingFollowUpsWithContext();
  logger.info(`  ${pending.length} due pending follow-up(s)`);

  for (let i = 0; i < pending.length; i++) {
    const fu = pending[i];
    try {
      if (fu.last_response_from === 'them') {
        // They replied — skip ALL pending follow-ups for this conversation.
        // No point chasing someone who is already in active dialogue.
        logger.info(`  ⏸️  Skipping follow-up #${fu.id} for @${fu.lead_poster_username} — they replied, pausing entire sequence (conv #${fu.conversation_id})`);
        await pauseFollowUpById(fu.id, 'reply_received').catch(() => {});
        if (fu.lead_id) await pauseFollowUpsForLead(fu.lead_id, 'reply_received').catch(() => {});
        if (fu.conversation_id) await pauseFollowUpsForConversation(fu.conversation_id, 'reply_received').catch(() => {});
        paused++;
        continue;
      }

      // last_response_from === 'us' (or null) → send the follow-up
      const ok = await sendFollowUp(fu, opts);
      if (ok) sent++;
      else    errors++;

      // Human-paced gap between consecutive sends
      if (i < pending.length - 1) {
        await randomDelay(5000, 15000);
      }

    } catch (err) {
      logger.error(`  Error on follow-up #${fu.id}: ${err.message}`);
      errors++;
    }
  }

  // ── 2. PAUSED follow-ups that have gone cold again ───────────────────────────
  const resumable = await getResumableFollowUps();
  logger.info(`  ${resumable.length} resumable (cold-lead) follow-up(s)`);

  for (const fu of resumable) {
    try {
      // Re-randomize: 1–6 hrs from now
      const hoursFromNow = 1 + Math.random() * 5;
      const newTime      = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);

      await rescheduleFollowUp(fu.id, newTime);
      logger.info(`  ▶️  Resumed follow-up #${fu.id} for @${fu.lead_poster_username} → ${newTime.toLocaleString()}`);
      resumed++;

    } catch (err) {
      logger.error(`  Error resuming follow-up #${fu.id}: ${err.message}`);
      errors++;
    }
  }

  const summary = `sent=${sent}, paused=${paused}, resumed=${resumed}, errors=${errors}`;
  logger.info(`  📊  Round complete — ${summary}`);
  return { sent, paused, resumed, errors };
}

// ── startFollowUpSystem ───────────────────────────────────────────────────────
/**
 * Long-running loop. Calls processFollowUps() at random 30–90 min intervals
 * so timing is never predictable to BHW's bot detectors.
 * Each interval is re-randomized independently after every tick.
 *
 * @param {object} opts - { dryRun: boolean }
 */
export async function startFollowUpSystem(opts = {}) {
  logger.info('🔁  Follow-up system started');

  // Lazy import to avoid circular deps — botState is a pure singleton
  const { botState } = await import('../utils/botState.js');

  const tick = async () => {
    if (botState.isPaused()) {
      logger.info('⏸️  Bot paused — skipping follow-up check');
    } else {
      try {
        await processFollowUps(opts);
      } catch (err) {
        logger.error(`Follow-up system tick error: ${err.message}`);
      }
    }

    const nextMs  = randomLoopInterval();
    const nextMin = Math.round(nextMs / 60000);
    logger.info(`  ⏰  Next follow-up check in ~${nextMin} min`);

    // Re-randomize every iteration — no fixed cadence
    setTimeout(tick, nextMs);
  };

  // Warm-up delay before first run (1 min after system starts)
  setTimeout(tick, 60 * 1000);
}

// kept for API compat — scheduling itself lives in dm.js → scheduleFollowUps()
export async function scheduleFollowUpSequence(lead, conversationId) {
  logger.info(`scheduleFollowUpSequence: scheduling for lead ${lead.id} is handled by dm.js`);
}
