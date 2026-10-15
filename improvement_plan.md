# Improvement Plan: Pipeline A Modernization & Safety Enhancements

## 1. Overview & Objectives
Update **Pipeline A** (Main Reactive Pipeline) with the exact requirements and guidelines specified by the Team Lead:
1. **Fresh-First Queue Priority (LIFO / Newest-First)**:
   - If a scrape run discovers new jobs, the bot **immediately prioritizes newly discovered jobs first**.
   - If multiple jobs are discovered in one run, send **1 DM** and leave the remainder in the pending queue.
   - On subsequent runs:
     - If **new jobs** are found $\rightarrow$ process the new job immediately.
     - If **no new jobs** are found in that run $\rightarrow$ pick the most recent pending job from the backlog queue.
2. **Target Only Today's Jobs**:
   - Only process, qualify, and queue jobs posted **today**.
3. **Loop Interval**:
   - Extend scrape/tick intervals from **10–20 minutes** to **20–40 minutes**.
4. **DM-Only Mode (Comments Paused)**:
   - Skip public forum commenting completely and skip the 2–4 min post-comment delay; send the DM directly.
5. **Exact Prompt & XML Structure Implementation**:
   - Adopt the provided **Zeeshan Ahmad persona prompt** (7 years exp, 70+ projects, Upwork Top Rated, $100K+, Telegram `@devpilot1`, Calendar link).
   - Generates:
     - `<message_1>`: Instant Outreach DM.
     - `<message_2>`: Follow-up message scheduled for **1 day later** (24–72 hours).
   - Parsed from XML `<thoughts>`, `<message_1>`, `<message_2>`.
6. **Automatic Reply Detection**:
   - Verify and maintain the existing rule: If an incoming DM is received from that user, the pending follow-up is automatically cancelled/paused.
7. **Pipeline Isolation**:
   - Ensure zero disruption or breaking changes to **Pipeline B, C, or D**.

---

## 2. Technical Design & Architecture

### A. Queue Logic: "Fresh First, Backlog on Idle"
To achieve the requirement where newly discovered jobs take immediate precedence over pending queued jobs:
1. When a scrape run finishes:
   - Newly discovered qualified jobs for today are inserted into `leads` table with `dm_sent = false`.
2. Selection query in `getQualifiedLeadsToContact()`:
   ```sql
   SELECT * FROM leads 
   WHERE is_qualified = true 
     AND dm_sent = false 
     AND post_date >= CURRENT_DATE
   ORDER BY discovered_at DESC
   LIMIT 1;
   ```
   * **Why `discovered_at DESC` works:**
     - If a brand-new job was just discovered in the current tick, its `discovered_at` is the newest timestamp, so it is picked **first**!
     - In the next tick, if *another* new job arrives, it is also newest, so it gets processed immediately.
     - If in a subsequent tick **no new jobs** are found, the query naturally picks the most recent pending job waiting in the queue!
   * This completely solves the starvation problem without requiring complex state machines.

### B. "Posted Today Only" Filter & Comment Pausing
* **Location:** `src/scraper/index.js` and `src/index.js` -> `processQualifiedLeads()`.
* Check `isToday(basicData.postedAt)`. If not posted today, skip thread page fetch and skip AI qualification.
* In `processQualifiedLeads()`:
  - Skip `generateAndPostComment(lead)`.
  - Skip the 2–4 min human pause.
  - Send the DM immediately.
  - Limit to `leadsToContact.slice(0, 1)`.

### C. Prompt Implementation (Zeeshan Ahmad Persona & XML Parser)
* **Location:** `src/services/aiEngine.js` -> `generateLeadDMAndFollowUp(title, description, posterUsername)`.
* Inject the exact prompt provided:
  - Role: Zeeshan Ahmad from Lahore, Pakistan (7 years exp, 70+ projects).
  - Fixed Upwork link: `https://www.upwork.com/freelancers/~0180a61cf01f9bc71d`
  - Fixed Calendar link: `https://calendar.app.google/j64bZGd6prrkALrQ7`
  - Fixed Telegram: `@devpilot1`
  - Slot analysis (`ROLE`, `GOAL`, `PEER GROUP`, `WORK AREA`, `VALUE`, `CALL TOPIC`).
  - Output format:
    ```xml
    <thoughts>...</thoughts>
    <message_1>Message 1 content</message_1>
    <message_2>Message 2 content</message_2>
    ```
* XML extractor parses `<message_1>` for the instant DM and `<message_2>` for the follow-up.
* Schedule `<message_2>` in `follow_ups` with:
  `scheduledFor = new Date(Date.now() + randomDelay(24 * 3600 * 1000, 72 * 3600 * 1000))`.

### D. Reply Detection & Follow-up Cancellation Check
* **Status: Already active in codebase.**
  - `src/engines/inbox-monitor.js` calls `pauseFollowUpsForConversation(dbConv.id, 'reply_received')` upon reading an unread DM.
  - `src/engines/follow-up.js` verifies `fu.last_response_from !== 'them'` before sending.

---

## 3. Phased Implementation Plan

### Phase 1: Configuration & Scrape Interval Adjustment
- [ ] Update default intervals in `src/config/config.js`, `src/index.js`, and `.env.example`:
  - `BHW_SCRAPE_INTERVAL_MIN=1200000` (20 min)
  - `BHW_SCRAPE_INTERVAL_MAX=2400000` (40 min)
- [ ] Add configuration flags to `config.js`:
  - `commentingEnabled: false` (DM-only mode)
  - `todayOnly: true` (only today's jobs)

### Phase 2: Today-Only Filter & Queue Priority Query
- [ ] In `src/scraper/index.js`:
  - Enforce `isToday(basicData.postedAt)` for Pipeline A before opening thread details or qualifying.
- [ ] In `src/database/queries.js` -> `getQualifiedLeadsToContact()`:
  - Update query to `ORDER BY discovered_at DESC LIMIT 1` and filter for today's jobs (`post_date >= CURRENT_DATE`).
  - This ensures new jobs are always handled first, while backlog jobs are consumed whenever no new jobs arrive.

### Phase 3: Pause Public Commenting & DM-Only Flow
- [ ] In `src/index.js` -> `processQualifiedLeads()`:
  - Bypass Step 1 (`generateAndPostComment`).
  - Remove the 2–4 minute sleep delay.
  - Limit execution to at most 1 lead per tick run (`leads.slice(0, 1)`).
  - Send the DM directly.

### Phase 4: Zeeshan Ahmad Prompt & XML Parser in AI Engine
- [ ] In `src/services/aiEngine.js`:
  - Add the new system prompt with full slot-filling guidelines and constraints.
  - Implement `generateLeadDMAndFollowUp(title, description, posterUsername)`.
  - Add XML parsing utility to cleanly extract `<message_1>` and `<message_2>`.
- [ ] In `src/engines/dm.js`:
  - Call `generateLeadDMAndFollowUp()`.
  - Send `<message_1>` as the initial outreach DM.
  - Store `<message_2>` in `follow_ups` scheduled for 24–72 hours later.
  - Retire the old 6-iteration loop `scheduleFollowUps()`.

### Phase 5: Verification, Dry-Run & Edge Cases
- [ ] Run test with `DRY_RUN=true` to verify:
  - Scrape interval logs 20–40 min.
  - Only today's jobs are inspected.
  - When 2 jobs arrive, Job 2 gets DM'd, Job 1 stays pending. On next run with 0 new jobs, Job 1 is processed.
  - XML tags `<message_1>` and `<message_2>` parse cleanly with no leftover markdown or XML tags.
  - Pipeline B, C, and D remain completely unaffected.

---

## 4. Risks & Mitigations

| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| **Old Queue Starvation** | If new jobs keep appearing in *every* run, a pending job from earlier today could wait multiple cycles. | With the 20–40m interval, forum job frequency is typically 0–2 jobs per hour; backlog will easily clear during idle runs. Also, "today-only" naturally cleans up at midnight. |
| **XML Output Variations** | If LLM misses closing tags (e.g. `<message_1>...`), regex parsing might fail. | Implement robust fallback regex that extracts contents even if tags are partially formatted. |
| **Shared Scraper Pacing** | Pipeline C Discord alerts will arrive on a 20–40 min cadence instead of 10–20 min. | Accepted by team lead per previous discussion. |
