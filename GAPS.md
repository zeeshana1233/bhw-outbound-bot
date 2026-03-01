# Plan vs. Code — Gap Tracker

All items are ordered by severity. Each will be implemented one by one.
Mark `[x]` when done.

---

## 🔴 CRITICAL — Account Ban Risk

### GAP-01 — Comment → DM gap is 3–8 seconds (plan requires 15–30 minutes)
- **File:** `src/index.js` line ~58
- **Plan §8.3:** After posting a comment, wait 15–30 minutes before sending the DM to avoid looking robotic.
- **Code today:** `await sleep(3000 + Math.random() * 5000)` — 3 to 8 **seconds**.
- **Fix:** Replace that sleep with a randomised 15–30 minute wait (900,000 – 1,800,000 ms).
- [ ] Implemented

---

### GAP-02 — `shouldSendDM()` exists but is never called — "old" threads get DMs illegally
- **File:** `src/index.js` — `processQualifiedLeads()`
- **Plan §6.3:** Threads aged 1–12 months → comment only, no DM. Only threads < 1 month old get a DM.
- **Code today:** `shouldSendDM()` is defined in `helpers.js` but never imported or called in `index.js`. Every qualified lead gets a DM regardless of age.
- **Fix:** Import `shouldSendDM` in `index.js`; wrap the DM step in `if (shouldSendDM(lead.thread_age_category))`.
- [ ] Implemented

---

### GAP-03 — No per-day comment / DM cap (plan: 5–8 per day each)
- **Files:** `src/index.js`, `src/database/queries.js`
- **Plan §7.3 & §8.3:** Hard limit of 5–8 comments per day AND 5–8 DMs per day. Bot must stop outreach for the day once either limit is hit.
- **Code today:** Loop processes every qualified lead in DB with no daily counter.
- **Fix:**
  1. Add `getDailyCommentCount()` and `getDailyDMCount()` queries (count rows in `leads` where `commented_at >= today` / `dm_sent_at >= today`).
  2. In `processQualifiedLeads()`, check counts before processing each lead; break once limit reached.
  3. Make limits configurable: `config.bot.maxCommentsPerDay` (default 6) and `config.bot.maxDMsPerDay` (default 6).
- [ ] Implemented

---

### GAP-04 — No active-hours enforcement (plan: 9 AM – 11 PM PKT only)
- **Files:** `src/index.js`, `src/engines/inbox-monitor.js`, `src/engines/follow-up.js`
- **Plan §13.1:** Bot must only post comments, send DMs, and reply to conversations between 09:00 and 23:00 Pakistan Standard Time (UTC+5). Outside those hours all outbound actions must be skipped / queued.
- **Code today:** No time-of-day check in any loop.
- **Fix:**
  1. Add `isActiveHours()` utility in `helpers.js` — returns `true` when current PKT time is between 09:00–23:00.
  2. Gate `processQualifiedLeads()` in `index.js` behind this check.
  3. Gate the conversation reply in `inbox-monitor.js` (skip reply; mark unread so it's picked up next active window).
  4. Gate `processFollowUps()` in `follow-up.js`.
- [ ] Implemented

---

## 🟡 MEDIUM — Functional Gaps

### GAP-05 — `qualifyLead` returns `score` (0–100) instead of `confidence` (0.0–1.0)
- **File:** `src/services/openclaw.js` — `qualifyLead()`
- **Plan §6.1:** OpenClaw must return `{ qualified, confidence, reason, pitch_angle }` where `confidence` is a decimal 0.0–1.0.
- **Code today:** Prompt asks for `score` as an integer 0–100; DB column is `niche_match_score INTEGER`.
- **Fix:**
  1. Change OpenClaw prompt to return `confidence` as `0.00`–`1.00`.
  2. Update `updateLeadQualification()` call sites to pass `qualification.confidence`.
  3. Rename DB column `niche_match_score` → `qualification_confidence` as `DECIMAL(3,2)` (migration in `init.js`).
- [ ] Implemented

---

### GAP-06 — No "maybe" queue for borderline leads (confidence 0.4–0.7)
- **Files:** `src/scraper/index.js`, `src/database/queries.js`, `src/services/commandCenter.js`
- **Plan §6.2:** Leads with confidence 0.4–0.7 must NOT be auto-pitched. They go into a "maybe" queue for manual review via the Telegram command center (or a daily WhatsApp digest).
- **Code today:** All leads with `is_qualified = true` go straight to comment + DM.
- **Fix:**
  1. Add `qualification_tier` column to `leads`: `'auto'` (≥ 0.7), `'maybe'` (0.4–0.69), `'skip'` (< 0.4).
  2. In scraper qualification step: set tier accordingly; only `auto` leads are queued for outreach.
  3. Add `/maybe` Telegram command to list "maybe" leads and `/approve <id>` to promote one to `auto`.
  4. Add `getMaybeLeads()` query.
- [ ] Implemented

---

### GAP-07 — No cross-thread 30-day user dedup before DMing (§12.3)
- **File:** `src/database/queries.js`, `src/engines/dm.js`
- **Plan §12.3:** If we already sent a DM to `poster_username` within the last 30 days (from any thread), skip the DM for this new thread.
- **Code today:** Only checks `lead.dm_sent` on the same lead row — a user posting two threads in one month gets two DMs.
- **Fix:**
  1. Add `wasUserDMedRecently(username, days=30)` query: `SELECT 1 FROM leads WHERE poster_username=$1 AND dm_sent=true AND dm_sent_at >= NOW() - INTERVAL '$2 days'`.
  2. Call it in `sendDM()` before proceeding; skip + log if true.
- [ ] Implemented

---

### GAP-08 — No reply delay (plan: 20–90 min); conversation engine replies instantly
- **File:** `src/engines/inbox-monitor.js` — `checkAndReplyToInbox()`
- **Plan §13.1:** After detecting an unread message, wait a randomised 20–90 minutes before sending a reply (simulates a human reading + thinking).
- **Code today:** Inbox monitor navigates to the conversation and fires `handleConversation()` immediately.
- **Fix:** Before calling `handleConversation()`, calculate a random delay of 20–90 min and schedule the reply via `setTimeout` (or write the "reply_due_at" timestamp to the DB and process it on the next check cycle).
- [ ] Implemented

---

### GAP-09 — No night-mode queue; bot replies to messages received overnight immediately at next check
- **File:** `src/engines/inbox-monitor.js`, `src/engines/conversation.js`
- **Plan §13.1:** Messages received outside active hours (11 PM–9 AM PKT) must be queued and replied to only after 9 AM (with the 20–90 min delay on top).
- **Code today:** Inbox monitor has no time-of-day check — if a message arrives at 2 AM and the bot was restarted, it replies at 2 AM.
- **Fix:** Wrap the `handleConversation()` call in `isActiveHours()` check (from GAP-04). If outside hours, log "queued for morning" and skip; it will be picked up at the next active-hours check.
- [ ] Implemented (depends on GAP-04)

---

### GAP-10 — `botState` pause is in-memory only — lost on restart
- **Files:** `src/utils/botState.js`, `src/database/init.js`, `src/database/queries.js`
- **Plan §15:** `bhw_bot_state` table should persist pause/resume state so a server restart doesn't automatically start firing DMs.
- **Code today:** `botState.js` uses plain JS variables; restarting node resets to "running".
- **Fix:**
  1. Add `bot_state` table in `init.js` migration: `id SERIAL, key TEXT UNIQUE, value TEXT, updated_at TIMESTAMPTZ`.
  2. Add `getBotState(key)` / `setBotState(key, value)` queries.
  3. On `botState.js` init, read `is_paused` and `is_dry_run` from DB.
  4. On `pause()` / `resume()` / `setDryRun()`, write the new value to DB.
- [ ] Implemented

---

### GAP-11 — Daily stats not persisted (`bhw_daily_reports` table missing)
- **Files:** `src/database/init.js`, `src/database/queries.js`, `src/services/alerts.js`
- **Plan §15:** A `bhw_daily_reports` table should store each day's totals (threads scraped, qualified, commented, DMs sent, replies, handoffs, follow-ups sent).
- **Code today:** `getDailyStats()` queries live data on demand; nothing is snapshotted at end-of-day.
- **Fix:**
  1. Add `daily_reports` table: `id, report_date DATE UNIQUE, threads_scraped, qualified, commented, dms_sent, replies_sent, handoffs, follow_ups_sent, created_at`.
  2. Add `upsertDailyReport(date, stats)` query.
  3. Call it from `sendDailyReport()` in `alerts.js` so every 9 AM report is also written to the DB.
- [ ] Implemented

---

### GAP-12 — Lead Scoring is not a separate named OpenClaw function (§4.1)
- **File:** `src/services/openclaw.js`
- **Plan §4.1 architecture diagram:** Shows a distinct "Lead Scoring" box separate from "Qualification". Lead scoring should produce a numeric hot-lead score (1–10) independent of the binary qualified/not-qualified output.
- **Code today:** `detectUrgencyAI` does urgency only; the 0–100 score in `qualifyLead` conflates qualification + scoring.
- **Fix:** Add a `scoreLeadHotness(title, description, conversationHistory)` function that returns `{ score: 1–10, reasons: [] }`. Call it in `dm.js` after DM is sent (or in conversation engine as conversation progresses) to replace the raw `niche_match_score` hot-lead check.
- [ ] Implemented

---

## 🟠 LOW — Minor Mismatches

### GAP-13 — Follow-up intervals: code schedules day 7/14/21; plan says 7/12/21
- **File:** `src/engines/dm.js` — `scheduleFollowUps()` line ~137
- **Plan §11.1:** Follow-up sequence is day 7, day 12, day 21.
- **Code today:** `const intervals = [7, 14, 21]`
- **Fix:** Change to `[7, 12, 21]`.
- [ ] Implemented

---

### GAP-14 — `MAX_FOLLOW_UPS=5` in config; plan §11.2 says maximum 2–3
- **File:** `src/config/config.js`
- **Plan §11.2:** "Send a maximum of 2–3 follow-ups total per lead."
- **Code today:** `MAX_FOLLOW_UPS: 5` — dm.js schedules 3 (matches plan), but config misleads and allows 5 if changed.
- **Fix:** Change config default to `3`. Add guard in `scheduleFollowUps()` to enforce `follow_up_number <= config.bot.maxFollowUps`.
- [ ] Implemented

---

### GAP-15 — Min 10–20 min between consecutive comments not enforced
- **File:** `src/index.js` — `processQualifiedLeads()`
- **Plan §7.3:** Minimum 10–20 minutes between any two comments, independent of the comment-to-DM wait.
- **Code today:** Between-leads gap is 4–8 minutes total (comment + DM + gap). The comment-specific timer does not exist.
- **Fix:** After the comment step succeeds (before the DM step), record `lastCommentTime`. On the next lead, enforce `lastCommentTime + randomDelay(10min, 20min)` before allowing the next comment.
- [ ] Implemented (can be done alongside GAP-01)

---

### GAP-16 — Never comment on >2 threads in a row without a break (§7.3)
- **File:** `src/index.js` — `processQualifiedLeads()`
- **Plan §7.3:** After every 2 consecutive comment+DM actions, take a longer break (30–60 min) before the next one.
- **Code today:** No consecutive-action counter.
- **Fix:** Add `consecutiveCount` in loop; after every 2 leads insert a long pause `randomDelay(30min, 60min)` and reset count.
- [ ] Implemented

---

### GAP-17 — PM2 `ecosystem.config.js` not created (§18)
- **Plan §18:** A `ecosystem.config.js` at project root for Windows Server deployment via PM2, with the correct `node_args`, `env`, log paths, and restart policy.
- **Code today:** File does not exist.
- **Fix:** Create `ecosystem.config.js` with one app entry: script = `src/index.js`, interpreter args for ESM, env block reading from `.env`, log file paths, `restart_delay: 5000`, `max_restarts: 10`.
- [ ] Implemented

---

## Implementation Order (recommended)

1. GAP-13 — trivial one-liner (intervals fix)
2. GAP-14 — trivial config fix
3. GAP-02 — `shouldSendDM()` wire-up (2 lines)
4. GAP-01 — comment→DM gap (change one sleep value)
5. GAP-15 — inter-comment minimum gap
6. GAP-16 — consecutive-comment break
7. GAP-04 — active hours utility + all 3 loop gates
8. GAP-09 — night-mode queue (depends on GAP-04)
9. GAP-03 — per-day comment/DM cap
10. GAP-07 — cross-thread 30-day user dedup
11. GAP-08 — reply delay 20–90 min
12. GAP-05 — `confidence` field rename (score → confidence 0.0–1.0)
13. GAP-06 — "maybe" queue + Telegram `/maybe` / `/approve` commands
14. GAP-10 — `botState` DB persistence
15. GAP-11 — `daily_reports` table + end-of-day snapshot
16. GAP-12 — standalone `scoreLeadHotness()` function
17. GAP-17 — PM2 `ecosystem.config.js`
