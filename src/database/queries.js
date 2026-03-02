import { query } from './init.js';

// =====================================================
// LEADS QUERIES
// =====================================================

export async function createLead(leadData) {
  const sql = `
    INSERT INTO leads (
      thread_id, thread_url, title, description, poster_username,
      poster_url, post_date, thread_age_category, tags
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (thread_id) DO NOTHING
    RETURNING *
  `;
  const values = [
    leadData.threadId,
    leadData.threadUrl,
    leadData.title,
    leadData.description,
    leadData.posterUsername,
    leadData.posterUrl,
    leadData.postDate,
    leadData.threadAgeCategory,
    leadData.tags || []
  ];
  const result = await query(sql, values);
  // ON CONFLICT DO NOTHING returns 0 rows — fetch the existing row instead
  if (result.rows[0]) return result.rows[0];
  const existing = await query('SELECT * FROM leads WHERE thread_id = $1', [leadData.threadId]);
  return existing.rows[0];
}

export async function updateLeadQualification(leadId, isQualified, reason, score) {
  // score may be passed as 0.0–1.0 (confidence) or 0–100 (legacy) — normalise to integer
  const normScore = score <= 1 && score > 0 ? Math.round(score * 100) : Math.round(score || 0);
  const sql = `
    UPDATE leads 
    SET is_qualified = $1, qualification_reason = $2, niche_match_score = $3, updated_at = CURRENT_TIMESTAMP
    WHERE id = $4
    RETURNING *
  `;
  const result = await query(sql, [isQualified, reason, normScore, leadId]);
  return result.rows[0];
}

export async function checkThreadExists(threadId) {
  const sql = 'SELECT id FROM leads WHERE thread_id = $1';
  const result = await query(sql, [threadId]);
  return result.rows.length > 0;
}

/**
 * Check which thread IDs already exist in database (batch check)
 * Returns array of thread IDs that are already in database
 */
export async function getExistingThreadIds(threadIds) {
  if (!threadIds || threadIds.length === 0) {
    return [];
  }
  
  // Normalize: match numeric IDs against both exact thread_id and
  // legacy full-URL thread_ids (e.g. 'https://...slug.1796371/')
  // Uses PostgreSQL regexp to extract trailing numeric ID from stored URLs
  const sql = `
    SELECT DISTINCT thread_id,
      COALESCE(
        (regexp_match(thread_id, '\\.(\\d+)\\/?$'))[1],
        thread_id
      ) AS normalized_id
    FROM leads
    WHERE thread_id = ANY($1)
       OR COALESCE(
            (regexp_match(thread_id, '\\.(\\d+)\\/?$'))[1],
            thread_id
          ) = ANY($1)
  `;
  const result = await query(sql, [threadIds]);
  // Return the input IDs that were found (using normalized comparison)
  const normalizedSet = new Set(result.rows.map(r => r.normalized_id));
  return threadIds.filter(id => normalizedSet.has(id));
}

export async function markLeadCommented(leadId, commentId) {
  const sql = `
    UPDATE leads 
    SET commented = true, commented_at = CURRENT_TIMESTAMP, comment_id = $1, updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING *
  `;
  const result = await query(sql, [commentId, leadId]);
  return result.rows[0];
}

export async function markLeadDMSent(leadId) {
  const sql = `
    UPDATE leads 
    SET dm_sent = true, dm_sent_at = CURRENT_TIMESTAMP, status = 'contacted', updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING *
  `;
  const result = await query(sql, [leadId]);
  return result.rows[0];
}

export async function updateLeadStatus(leadId, status) {
  const sql = `
    UPDATE leads 
    SET status = $1, last_interaction = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING *
  `;
  const result = await query(sql, [status, leadId]);
  return result.rows[0];
}

export async function getLeadById(leadId) {
  const sql = 'SELECT * FROM leads WHERE id = $1';
  const result = await query(sql, [leadId]);
  return result.rows[0];
}

export async function getLeadByPosterUsername(posterUsername) {
  const sql = `SELECT * FROM leads WHERE poster_username = $1 ORDER BY discovered_at DESC LIMIT 1`;
  const result = await query(sql, [posterUsername]);
  return result.rows[0] || null;
}

export async function getQualifiedLeadsToContact() {
  const sql = `
    SELECT * FROM leads 
    WHERE is_qualified = true 
    AND commented = false 
    AND thread_age_category IN ('fresh', 'old')
    ORDER BY discovered_at ASC
    LIMIT 10
  `;
  const result = await query(sql);
  return result.rows;
}

// =====================================================
// DMS QUERIES
// =====================================================

export async function createDM(dmData) {
  const sql = `
    INSERT INTO dms (
      lead_id, conversation_id, direction, message_text, 
      message_type, generated_by, prompt_used
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `;
  const values = [
    dmData.leadId,
    dmData.conversationId,
    dmData.direction,
    dmData.messageText,
    dmData.messageType,
    dmData.generatedBy,
    dmData.promptUsed
  ];
  const result = await query(sql, values);
  return result.rows[0];
}

export async function getDMsByConversation(conversationId) {
  const sql = `
    SELECT * FROM dms 
    WHERE conversation_id = $1 
    ORDER BY sent_at ASC
  `;
  const result = await query(sql, [conversationId]);
  return result.rows;
}

// =====================================================
// CONVERSATIONS QUERIES
// =====================================================

export async function createConversation(leadId) {
  const sql = `
    INSERT INTO conversations (lead_id)
    VALUES ($1)
    RETURNING *
  `;
  const result = await query(sql, [leadId]);
  return result.rows[0];
}

export async function updateConversationStatus(conversationId, status) {
  const sql = `
    UPDATE conversations 
    SET status = $1, updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING *
  `;
  const result = await query(sql, [status, conversationId]);
  return result.rows[0];
}

export async function incrementConversationMessages(conversationId, direction) {
  const field = direction === 'outbound' ? 'our_message_count' : 'their_message_count';
  const sql = `
    UPDATE conversations 
    SET message_count = message_count + 1,
        ${field} = ${field} + 1,
        last_message_at = CURRENT_TIMESTAMP,
        last_response_from = $1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING *
  `;
  const lastResponseFrom = direction === 'outbound' ? 'us' : 'them';
  const result = await query(sql, [lastResponseFrom, conversationId]);
  return result.rows[0];
}

export async function getConversationByLeadId(leadId) {
  const sql = 'SELECT * FROM conversations WHERE lead_id = $1';
  const result = await query(sql, [leadId]);
  return result.rows[0];
}

export async function updateConversationBhwUrl(conversationId, bhwUrl) {
  const sql = `
    UPDATE conversations
    SET bhw_conversation_url = $1, updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING *
  `;
  const result = await query(sql, [bhwUrl, conversationId]);
  return result.rows[0];
}

/**
 * Mark a conversation as handed off to Zeeshan.
 * After this, the inbox-monitor will skip it entirely — no more auto-replies.
 *
 * @param {number} conversationId
 * @param {string} [reason] - Short description of why it was handed off
 */
export async function markConversationHandedOff(conversationId, reason = '') {
  const sql = `
    UPDATE conversations
    SET is_handed_off  = TRUE,
        handed_off_at  = CURRENT_TIMESTAMP,
        handoff_reason = $1,
        status         = 'handed_off',
        updated_at     = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING *
  `;
  const result = await query(sql, [reason, conversationId]);
  return result.rows[0];
}

/**
 * Get all conversations that have been handed off (for admin dashboard / reporting).
 */
export async function getHandedOffConversations() {
  const sql = `
    SELECT c.*, l.poster_username, l.thread_url, l.title AS lead_title
    FROM conversations c
    LEFT JOIN leads l ON l.id = c.lead_id
    WHERE c.is_handed_off = TRUE
    ORDER BY c.handed_off_at DESC
  `;
  const result = await query(sql);
  return result.rows;
}

// =====================================================
// FOLLOW-UPS QUERIES
// =====================================================

export async function scheduleFollowUp(followUpData) {
  const sql = `
    INSERT INTO follow_ups (
      lead_id, conversation_id, scheduled_for, follow_up_number, message_text
    ) VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `;
  const values = [
    followUpData.leadId,
    followUpData.conversationId,
    followUpData.scheduledFor,
    followUpData.followUpNumber,
    followUpData.messageText
  ];
  const result = await query(sql, values);
  return result.rows[0];
}

export async function getPendingFollowUps() {
  const sql = `
    SELECT * FROM follow_ups 
    WHERE status = 'pending' 
    AND scheduled_for <= CURRENT_TIMESTAMP
    ORDER BY scheduled_for ASC
  `;
  const result = await query(sql);
  return result.rows;
}

/**
 * Get all DUE pending follow-ups joined with lead + conversation context.
 * Used by the follow-up engine to decide what to send.
 */
export async function getPendingFollowUpsWithContext() {
  const sql = `
    SELECT
      fu.*,
      l.title           AS lead_title,
      l.description     AS lead_description,
      l.poster_username AS lead_poster_username,
      l.thread_url      AS lead_thread_url,
      c.bhw_conversation_url,
      c.last_response_from,
      c.last_message_at,
      c.status          AS conv_status
    FROM follow_ups fu
    JOIN leads l ON l.id = fu.lead_id
    LEFT JOIN conversations c ON c.id = fu.conversation_id
    WHERE fu.status = 'pending'
      AND fu.scheduled_for <= CURRENT_TIMESTAMP
    ORDER BY fu.scheduled_for ASC
  `;
  const result = await query(sql);
  return result.rows;
}

/**
 * Get PAUSED follow-ups where the lead has gone cold again:
 * - last_response_from = 'us'  (we replied but they didn't)
 * - last_message_at older than 3 days
 * These are ready to be rescheduled and resumed.
 */
export async function getResumableFollowUps() {
  const sql = `
    SELECT
      fu.*,
      l.title           AS lead_title,
      l.description     AS lead_description,
      l.poster_username AS lead_poster_username,
      l.thread_url      AS lead_thread_url,
      c.bhw_conversation_url,
      c.last_response_from,
      c.last_message_at
    FROM follow_ups fu
    JOIN leads l ON l.id = fu.lead_id
    LEFT JOIN conversations c ON c.id = fu.conversation_id
    WHERE fu.status = 'paused'
      AND (
        c.last_response_from = 'us'
        AND c.last_message_at < (CURRENT_TIMESTAMP - INTERVAL '3 days')
      )
    ORDER BY c.last_message_at ASC
  `;
  const result = await query(sql);
  return result.rows;
}

/**
 * Pause all pending follow-ups for a conversation.
 * Called when an inbound reply is received — we don't chase someone
 * who is actively talking to us.
 */
export async function pauseFollowUpsForConversation(conversationId, reason = 'reply_received') {
  const sql = `
    UPDATE follow_ups
    SET status = 'paused', paused_reason = $1, updated_at = CURRENT_TIMESTAMP
    WHERE conversation_id = $2
      AND status = 'pending'
    RETURNING id
  `;
  const result = await query(sql, [reason, conversationId]);
  return result.rows;
}

/**
 * Reschedule a single paused follow-up to a new future time.
 * Used by resume logic when a lead goes cold again after replying.
 */
export async function rescheduleFollowUp(followUpId, newScheduledFor) {
  const sql = `
    UPDATE follow_ups
    SET status = 'pending',
        scheduled_for = $1,
        paused_reason = NULL,
        updated_at    = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING *
  `;
  const result = await query(sql, [newScheduledFor, followUpId]);
  return result.rows[0];
}

export async function markFollowUpSent(followUpId) {
  const sql = `
    UPDATE follow_ups 
    SET status = 'sent', sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING *
  `;
  const result = await query(sql, [followUpId]);
  return result.rows[0];
}

export async function markFollowUpFailed(followUpId, errorMessage) {
  const sql = `
    UPDATE follow_ups
    SET status = 'failed', paused_reason = $1, updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING *
  `;
  const result = await query(sql, [errorMessage, followUpId]);
  return result.rows[0];
}

// =====================================================
// ACTIVITY LOG QUERIES
// =====================================================

export async function logActivity(activityData) {
  const sql = `
    INSERT INTO activity_log (
      action_type, lead_id, description, metadata, status, error_message
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `;
  const values = [
    activityData.actionType,
    activityData.leadId || null,
    activityData.description,
    activityData.metadata ? JSON.stringify(activityData.metadata) : null,
    activityData.status || 'success',
    activityData.errorMessage || null
  ];
  const result = await query(sql, values);
  return result.rows[0];
}

// =====================================================
// REPORTING / STATS QUERIES
// =====================================================

/**
 * Collect today's activity stats for the daily WhatsApp report.
 * All counts are scoped to the calendar day in the DB server's timezone.
 *
 * @param {Date} [date=new Date()] - The day to report on
 * @returns {{ leadsScraped, dmsSent, replied, handoffs, conversions }}
 */
export async function getDailyStats(date = new Date()) {
  const day = date.toISOString().slice(0, 10); // 'YYYY-MM-DD'

  const sql = `
    SELECT
      (SELECT COUNT(*)
         FROM leads
        WHERE DATE(discovered_at) = $1
      ) AS leads_scraped,

      (SELECT COUNT(*)
         FROM leads
        WHERE dm_sent = true
          AND DATE(dm_sent_at) = $1
      ) AS dms_sent,

      (SELECT COUNT(*)
         FROM dms
        WHERE direction = 'outbound'
          AND message_type = 'reply'
          AND DATE(sent_at) = $1
      ) AS replied,

      (SELECT COUNT(*)
         FROM conversations
        WHERE is_handed_off = true
          AND DATE(handed_off_at) = $1
      ) AS handoffs,

      (SELECT COUNT(*)
         FROM leads
        WHERE status = 'converted'
          AND DATE(updated_at) = $1
      ) AS conversions
  `;
  const result = await query(sql, [day]);
  const row = result.rows[0];
  return {
    leadsScraped: parseInt(row.leads_scraped)  || 0,
    dmsSent:      parseInt(row.dms_sent)       || 0,
    replied:      parseInt(row.replied)        || 0,
    handoffs:     parseInt(row.handoffs)       || 0,
    conversions:  parseInt(row.conversions)    || 0,
    date:         new Date(date).toLocaleDateString('en-GB'),
  };
}

// =====================================================
// COMMAND CENTER STATS QUERIES
// =====================================================

/**
 * Full lead funnel: qualified → commented → DM'd → replied → converted
 */
export async function getLeadsFunnelStats() {
  const sql = `
    SELECT
      COUNT(*)                                       AS total,
      COUNT(*) FILTER (WHERE is_qualified = true)    AS qualified,
      COUNT(*) FILTER (WHERE commented    = true)    AS commented,
      COUNT(*) FILTER (WHERE dm_sent      = true)    AS dm_sent,
      COUNT(*) FILTER (WHERE status = 'replied')     AS replied,
      COUNT(*) FILTER (WHERE status = 'converted')   AS converted
    FROM leads
  `;
  const result = await query(sql);
  const r = result.rows[0];
  return {
    total:     parseInt(r.total)     || 0,
    qualified: parseInt(r.qualified) || 0,
    commented: parseInt(r.commented) || 0,
    dmSent:    parseInt(r.dm_sent)   || 0,
    replied:   parseInt(r.replied)   || 0,
    converted: parseInt(r.converted) || 0,
  };
}

/**
 * Active conversations (not handed off, not ended) + total count.
 */
export async function getActiveConversationsStats() {
  const sql = `
    SELECT
      COUNT(*) FILTER (WHERE is_handed_off = false AND status NOT IN ('ended','converted'))  AS active,
      COUNT(*)                                                                                AS total,
      COUNT(*) FILTER (WHERE is_handed_off = true)                                           AS handed_off
    FROM conversations
  `;
  const result = await query(sql);
  const r = result.rows[0];
  return {
    active:    parseInt(r.active)    || 0,
    total:     parseInt(r.total)     || 0,
    handedOff: parseInt(r.handed_off) || 0,
  };
}

/**
 * Pending follow-up count and when the next one fires.
 */
export async function getPendingFollowUpsStats() {
  const sql = `
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')                     AS pending_count,
      MIN(scheduled_for) FILTER (WHERE status = 'pending')           AS next_due
    FROM follow_ups
  `;
  const result = await query(sql);
  const r = result.rows[0];
  return {
    pendingCount: parseInt(r.pending_count) || 0,
    nextDue:      r.next_due ? new Date(r.next_due) : null,
  };
}

/**
 * Disqualify (skip) a lead by poster username.
 * Sets is_qualified=false, qualification_reason='skipped'.
 */
export async function disqualifyLead(posterUsername) {
  const lead = await getLeadByPosterUsername(posterUsername);
  if (!lead) return null;
  const sql = `
    UPDATE leads
    SET is_qualified = false, qualification_reason = 'skipped by operator',
        niche_match_score = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING *
  `;
  const result = await query(sql, [lead.id]);
  return result.rows[0];
}

/**
 * Mark a lead as converted by poster username.
 */
export async function convertLead(posterUsername) {
  const lead = await getLeadByPosterUsername(posterUsername);
  if (!lead) return null;
  return updateLeadStatus(lead.id, 'converted');
}

/**
 * Pause all follow-ups for a lead identified by poster username.
 */
export async function pauseFollowUpsForUsername(posterUsername) {
  const lead = await getLeadByPosterUsername(posterUsername);
  if (!lead) return null;
  const conv = await getConversationByLeadId(lead.id);
  if (!conv) return null;
  return pauseFollowUpsForConversation(conv.id, 'paused by operator');
}

// =====================================================
// NICHE KEYWORDS QUERIES
// =====================================================

export async function getAllNicheKeywords() {
  const sql = 'SELECT * FROM niche_keywords WHERE is_active = true';
  const result = await query(sql);
  return result.rows;
}

// =====================================================
// AI ENGINE LOGGING QUERIES
// =====================================================

/**
 * Log one AI API call.
 * Fire-and-forget — callers should .catch(() => {}) so a log failure
 * never interrupts the main flow.
 */
export async function logAICall({
  functionName,
  tokensIn     = 0,
  tokensOut    = 0,
  latencyMs    = 0,
  success      = true,
  errorMessage = null,
  leadId       = null,
}) {
  const sql = `
    INSERT INTO ai_logs (function_name, tokens_in, tokens_out, latency_ms, success, error_message, lead_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `;
  await query(sql, [functionName, tokensIn, tokensOut, latencyMs, success, errorMessage, leadId]);
}

/**
 * Aggregate AI usage stats over the last N days.
 * Used by the /stats Telegram command.
 */
export async function getAIStats(days = 7) {
  const sql = `
    SELECT
      function_name,
      COUNT(*)                                    AS total_calls,
      SUM(tokens_in + tokens_out)                 AS total_tokens,
      ROUND(AVG(latency_ms))                      AS avg_latency_ms,
      ROUND(
        100.0 * SUM(CASE WHEN success THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)
      , 1)                                        AS success_rate_pct
    FROM ai_logs
    WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
    GROUP BY function_name
    ORDER BY total_calls DESC
  `;
  const result = await query(sql, [days]);
  return result.rows;
}

/**
 * Returns how many comments and DMs have been sent today.
 * Used to enforce the daily action caps (GAP-03).
 * Counts from the `leads` table using the commented_at / dm_sent_at timestamps.
 */
export async function getDailyActionCounts() {
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  const sql = `
    SELECT
      (SELECT COUNT(*) FROM leads WHERE commented    = true AND DATE(commented_at)  = $1) AS comments_today,
      (SELECT COUNT(*) FROM leads WHERE dm_sent      = true AND DATE(dm_sent_at)    = $1) AS dms_today
  `;
  const result = await query(sql, [today]);
  const row = result.rows[0];
  return {
    commentsToday: parseInt(row.comments_today) || 0,
    dmsToday:      parseInt(row.dms_today)      || 0,
  };
}
