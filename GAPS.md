# Plan vs. Code — Gap Tracker

All items are ordered by severity. Each will be implemented one by one.
Mark `[x]` when done. Items marked `[~]` are accepted as-is or won't-do by design.

---

## 🔴 CRITICAL — Account Ban Risk

### GAP-01 — Comment → DM gap
- **Status:** Comment→DM gap is 2–4 min. Accepted as final timing.
- [x] Resolved (accepted as-is)

---

### GAP-02 — `shouldSendDM()` exists but is never called — "old" threads get DMs illegally
- [x] Implemented

---

### GAP-03 — No per-day comment / DM cap (plan: 5–8 per day each)
- [x] Implemented (caps: 25 comments, 25 DMs per day)

---

### GAP-04 — No active-hours enforcement (plan: 9 AM – 11 PM PKT only)
- **Status:** Won't do — bot runs 24/7 by design.
- [~] Won't do

---

## 🟡 MEDIUM — Functional Gaps

### GAP-05 — `qualifyLead` returns `score` (0–100) instead of `confidence` (0.0–1.0)
- **File:** `src/services/aiEngine.js`, `src/database/queries.js`
- AI engine returns `confidence: 0.0–1.0` but DB column is still `niche_match_score INTEGER (0–100)`. Schema migration needed.
- [ ] Implemented

---

### GAP-06 — No "maybe" queue for borderline leads (confidence 0.4–0.7)
- **Files:** `src/scraper/index.js`, `src/database/queries.js`, `src/services/commandCenter.js`
- AI computes `tier: 'maybe'` but those leads are treated same as `'auto'`. Should go into manual-review queue.
- [ ] Implemented

---

### GAP-07 — No cross-thread 30-day user dedup before DMing (§12.3)
- **File:** `src/database/queries.js`, `src/engines/dm.js`
- Same poster on multiple threads within 30 days can get multiple DMs. Need `wasUserDMedRecently()` guard.
- [x] Implemented — `wasUserDMedRecently(username, 30)` added to `queries.js` (checks both Pipeline A `leads` + Pipeline B `outreach_targets`); guard added to `sendDM()` in `dm.js`

---

### GAP-08 — No reply delay; conversation engine replies instantly
- **Status:** Won't do — instant replies are accepted as current technique.
- [~] Won't do

---

### GAP-09 — No night-mode queue
- **Status:** Won't do — bot runs 24/7, no night-mode needed.
- [~] Won't do

---

### GAP-10 — `botState` pause is in-memory only — lost on restart
- **Files:** `src/utils/botState.js`, `src/database/init.js`, `src/database/queries.js`
- Restarting the service always starts in "running" mode. Should persist to DB.
- [ ] Implemented

---

### GAP-11 — Daily stats not persisted (`bhw_daily_reports` table missing)
- **Files:** `src/database/init.js`, `src/database/queries.js`, `src/services/alerts.js`
- `daily_reports` table exists in schema but nothing writes to it. 9 AM report should snapshot stats.
- [ ] Implemented

---

### GAP-12 — Lead Scoring (`scoreLeadHotness`)
- [x] Implemented — `scoreLeadHotness()` added to `aiEngine.js`, wired into `dm.js`

---

## 🟠 LOW — Minor Mismatches

### GAP-13 — Follow-up intervals
- [x] Implemented — Changed to `[7, 12, 21]`

---

### GAP-14 — MAX_FOLLOW_UPS
- [x] Implemented — Set to `3`

---

### GAP-15 — Min 10–20 min between consecutive comments
- **Status:** Won't do — current between-leads gap (3–8 min) is accepted as desired pacing.
- [~] Won't do

---

### GAP-16 — Consecutive-comment break rule
- **Status:** Won't do — no consecutive-comment break needed.
- [~] Won't do

---

### GAP-17 — PM2 `ecosystem.config.js`
- [x] Implemented — `deploy/ecosystem.config.cjs` exists

---

## Summary

| Status | Count |
|--------|-------|
| ✅ Done | 8 (GAP-01, 02, 03, 07, 12, 13, 14, 17) |
| ❌ Won't do | 5 (GAP-04, 08, 09, 15, 16) |
| ⏳ Pending | 4 (GAP-05, 06, 10, 11) |
