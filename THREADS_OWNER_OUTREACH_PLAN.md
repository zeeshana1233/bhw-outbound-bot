# Threads Owner Outreach Module — Dev Plan v2

**Module name:** `[THREADS-OWNER-OUTREACH]`  
**Status:** DRAFT v2 — incorporating review notes  
**Date:** March 4, 2026

---

## Overview

An independent outreach module that DMs owners of existing BHW threads from a pre-seeded list you provide. Every day the bot picks 5 targets, navigates to each thread using the shared BHW session, scrapes the description, generates a personalised DM, sends it at random intervals spread across the full 24 hours, runs follow-ups at day 3/7/14, and handles replies — all tracked in its own DB tables with no interference to the main pipeline.

---

## Key Architecture Decision: Session Strategy (Hybrid)

**Your question: should this be fully isolated (own browser) or hybrid (shared session)?**

**Recommendation: Hybrid — shared `bhwSession`, isolated everything else.**

Running two separate browsers simultaneously doubles CloudFlare detection risk, doubles memory consumption on the server, and doubles the chance of a session block. The existing `bhwSession` is already a singleton used by `dm.js`, `comment.js`, `follow-up.js`, and `inbox-monitor.js` — they all share it safely because they run sequentially, not in parallel.

**What is shared:**
- `bhwSession` — the one logged-in browser (app_pilot account)
- `bhwSession.navigateTo()` for thread scraping (no separate scraper browser)

**What is fully isolated (zero overlap with main pipeline):**
- DB tables (own set, no foreign keys into existing tables)
- Engine files (own scheduler, own sender, own follow-up runner, own inbox check)
- Persona file (`outreachPersona.js` — entirely separate from `zeePersona.js`)
- AI functions (own explicitly named functions — see below)
- WhatsApp alerts (all tagged with `[THREADS-OWNER-OUTREACH]`)
- No shared state variables with other engines

**Session conflict prevention:**
The outreach module checks `bhwSession.isBusy()` before starting each action. If the session is in use (another engine is mid-action), it waits and retries. All existing engines already share the session this way — outreach just joins the queue.

---

## Duplicate DM Prevention (Critical)

Never DM the same BHW user twice under any circumstances.

**Two-layer check before ANY outreach DM is sent:**

1. **Within this module**: `outreach_targets` — if a row for this `poster_username` already has `status` of `dm_sent`, `replied`, `cold`, or `skip` → skip, log `already_contacted_outreach`
2. **Cross-module check**: `leads` table — if this `poster_username` already has `dm_sent = true` (contacted by the main pipeline) → skip, log `already_contacted_main_pipeline`

Both checks run before any AI generation. If the username is not yet known (not in CSV), scrape it first, then recheck.

---

## Module File Structure

```
src/
  engines/
    threads-owner-outreach.js   ← daily loop: scheduler + DM sender + follow-up + inbox check
    outreach-follow-up.js       ← follow-up sender (called at end of each daily batch)
    outreach-inbox.js           ← reply checker (called at end of each daily batch)

  services/
    outreachPersona.js          ← BLANK SKELETON — you write the persona

database/
  outreach-schema.sql           ← 4 new tables

scripts/
  seed-outreach-targets.js      ← one-time CLI: node scripts/seed-outreach-targets.js targets.csv
```

**Files NOT touched:**
`dm.js`, `follow-up.js`, `inbox-monitor.js`, `comment.js`, `zeePersona.js`, `scraper/index.js`, `schema.sql`

---

## Database Tables

### 1. `outreach_targets`
Master list seeded from your CSV. Never auto-populated by the bot.

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| thread_id | VARCHAR(200) UNIQUE | extracted from URL |
| thread_url | TEXT NOT NULL | full BHW thread URL |
| title | TEXT | from your CSV or scraped on first visit |
| description | TEXT | OP body — scraped via session on first contact |
| poster_username | VARCHAR(100) | from your CSV or scraped on first visit |
| status | VARCHAR(30) DEFAULT 'pending' | `pending` / `dm_sent` / `replied` / `cold` / `skip` |
| skip_reason | TEXT | `no_username` / `scrape_failed` / `already_contacted_outreach` / `already_contacted_main_pipeline` |
| contacted_at | TIMESTAMP | first DM sent time |
| last_reply_at | TIMESTAMP | last time THEY replied |
| added_at | TIMESTAMP DEFAULT NOW() | when seeded |
| created_at | TIMESTAMP DEFAULT NOW() | |
| updated_at | TIMESTAMP DEFAULT NOW() | |

> `priority` and `notes` removed. Targets are processed FIFO by `added_at ASC`.

---

### 2. `outreach_conversations`
One row per started DM conversation.

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| target_id | INTEGER FK → outreach_targets | |
| bhw_conversation_url | TEXT | stored after first DM sent |
| status | VARCHAR(30) DEFAULT 'active' | `active` / `waiting_reply` / `replied` / `cold` / `closed` |
| message_count | INTEGER DEFAULT 0 | |
| our_message_count | INTEGER DEFAULT 0 | |
| their_message_count | INTEGER DEFAULT 0 | |
| last_response_from | VARCHAR(10) | `us` or `them` |
| started_at | TIMESTAMP DEFAULT NOW() | |
| last_message_at | TIMESTAMP DEFAULT NOW() | |
| created_at | TIMESTAMP DEFAULT NOW() | |
| updated_at | TIMESTAMP DEFAULT NOW() | |

---

### 3. `outreach_dms`
Every message in every outreach conversation.

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| target_id | INTEGER FK → outreach_targets | |
| conversation_id | INTEGER FK → outreach_conversations | |
| direction | VARCHAR(10) NOT NULL | `outbound` / `inbound` |
| message_text | TEXT NOT NULL | |
| message_type | VARCHAR(40) | `initial_pitch` / `follow_up_1` / `follow_up_2` / `follow_up_3` / `reply` |
| sent_at | TIMESTAMP DEFAULT NOW() | |
| created_at | TIMESTAMP DEFAULT NOW() | |

---

### 4. `outreach_follow_ups`
Scheduled follow-ups per target.

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| target_id | INTEGER FK → outreach_targets | |
| conversation_id | INTEGER FK → outreach_conversations | |
| follow_up_number | INTEGER NOT NULL | 1, 2, or 3 |
| scheduled_for | TIMESTAMP NOT NULL | contacted_at + 3/7/14 days |
| status | VARCHAR(20) DEFAULT 'pending' | `pending` / `sent` / `cancelled` / `failed` |
| message_text | TEXT | pre-generated at DM send time |
| sent_at | TIMESTAMP | |
| created_at | TIMESTAMP DEFAULT NOW() | |
| updated_at | TIMESTAMP DEFAULT NOW() | |

---

## One-Time Target Import

### CSV format (minimum required):
```
thread_url,title
https://www.blackhatworld.com/threads/some-thread.1234567/,Thread Title Here
```

Optional third column if you have it:
```
thread_url,title,poster_username
```

If `poster_username` is missing, the bot scrapes it from the thread page on first contact. If it still cannot find one after visiting the page, the target is marked `skip` with `skip_reason = 'no_username'`.

### Import command (run once):
```bash
node scripts/seed-outreach-targets.js /path/to/targets.csv
```

The importer:
1. Reads CSV row by row
2. Extracts `thread_id` from the URL
3. Skips duplicates already in `outreach_targets`
4. Inserts with `status = 'pending'`
5. Prints: `✅ Imported 312 new targets | ⏭ Skipped 8 duplicates`

---

## Daily Outreach Flow

### Scheduling approach

**16-hour active window, 8-hour sleep window, repeated daily.**

**Why this window:**  
Target audience is freelancers and remote workers across US, UK, and Europe. They come online from mid-morning US time onward and stay active well into the evening/night. Starting at 10:00 AM US Eastern maximises coverage across all three regions.

| Window | UTC | US East (EST) | UK (GMT) | Europe (CET) |
|--------|-----|--------------|----------|--------------|
| **Active** | 15:00 – 07:00 | 10am – 2am | 3pm – 7am | 4pm – 8am |
| **Sleep** | 07:00 – 15:00 | 2am – 10am | 7am – 3pm | 8am – 4pm |

This catches US from 10am through midnight, and UK/EU from mid-afternoon through midnight — the hours when BHW freelancers are most active. Sleep window (07:00–15:00 UTC) is their morning, the lowest-activity period on BHW.

**How it works:**

On each new active window (daily at ~08:00 UTC ± 0–30 min random jitter to avoid a detectable fixed pattern):
1. Pick 5 pending targets for the day
2. Randomly scatter 5 send-times across the 16-hour window — no two DMs closer than 90 minutes, no two further than 4 hours apart
3. Sleep until the first scheduled send-time, send that DM, sleep until the next, and so on
4. After the 5th DM is sent → run `runOutreachFollowUps()` + `checkOutreachInbox()`
5. Sleep until the next day's window starts (00:00 UTC + time until 08:00 UTC + jitter)

**On bot startup mid-day:**  
If the bot restarts during an active window and some DMs for today were already sent, resume from the next scheduled one. If all 5 are done, wait for the next window.

**Pattern avoidance:**  
The ±30 min jitter on the window open time and the random scatter of send-times within the window mean BHW never sees DMs at the exact same clock times each day.

Each run picks **5 pending targets** (`status = 'pending'` ordered `added_at ASC` — FIFO, no priority).

---

### Per-Target Steps

```
Step 1 — DUPLICATE CHECK (before any work)
   a. If poster_username is known:
      → Check outreach_targets: username with status != 'pending'? Skip.
      → Check leads table: poster_username with dm_sent = true? Skip.
        Mark status = 'skip', skip_reason = 'already_contacted_main_pipeline'
        WhatsApp: "[THREADS-OWNER-OUTREACH] Skipped ⏭
                   @username — already contacted by main pipeline"
   b. If poster_username is not yet known: proceed to scrape first, then recheck

Step 2 — SCRAPE THREAD (using bhwSession — no separate scraper)
   a. bhwSession.ensureAuthenticated()
   b. bhwSession.navigateTo(thread_url)  ← app_pilot account, not a headless scraper
   c. Extract: OP body text (description), poster_username if not already in DB
   d. Save description + poster_username to outreach_targets row
   e. If scrape fails after 3 retries:
      → status = 'skip', skip_reason = 'scrape_failed', move to next target
   f. If poster_username still null after scrape:
      → status = 'skip', skip_reason = 'no_username', move to next target
   g. Re-run duplicate check (Step 1) with now-known username

Step 3 — GENERATE DM
   Call: aiEngine.generateThreadsOwnerOutreachDM(title, description)
   Using: outreachPersona (SEPARATE from zeePersona — different voice/pitch)

Step 4 — SEND DM
   Navigate to: blackhatworld.com/conversations/add?to=<poster_username>
   Send with full human simulation:
   • Character-by-character typing + random delays
   • Occasional typo + backspace
   • Thinking pauses mid-sentence
   • Natural review pause before clicking Send

Step 5 — STORE IN DB
   a. Create row in outreach_conversations
   b. Create row in outreach_dms (direction='outbound', type='initial_pitch')
   c. Capture bhw_conversation_url from page after send
   d. Save to outreach_conversations.bhw_conversation_url

Step 6 — UPDATE TARGET
   outreach_targets: status = 'dm_sent', contacted_at = NOW()

Step 7 — PRE-GENERATE ALL 3 FOLLOW-UPS NOW
   Call: aiEngine.generateThreadsOwnerOutreachFollowUps(title, description, dm_text)
   Returns 3 distinct messages: soft nudge / value-add angle / gentle closing
   Insert all 3 into outreach_follow_ups with scheduled_for:
     Follow-up 1 → contacted_at + 3 days
     Follow-up 2 → contacted_at + 7 days
     Follow-up 3 → contacted_at + 14 days

Step 8 — LOG ACTIVITY
   logActivity({ action_type: 'threads_owner_outreach_dm_sent', target_id, ... })

Step 9 — WHATSAPP ALERT
   "[THREADS-OWNER-OUTREACH] DM sent ✅
    To: @<poster_username>
    Thread: "<title>"
    Follow-ups: Day 3 / Day 7 / Day 14 scheduled"

[Repeat Steps 1–9 for remaining 4 targets, with 2–5 hour random gap between each]

Step 10 — AFTER BATCH COMPLETE
   → Call runOutreachFollowUps()   (check for due follow-ups)
   → Call checkOutreachInbox()     (check for replies)
   → Sleep 18–30 hours, start next batch
```

---

## Follow-Up System (`outreach-follow-up.js`)

**Not a separate loop.** Called as `runOutreachFollowUps()` at the end of each daily batch, and also on bot startup (catches any follow-ups due while server was down).

```
runOutreachFollowUps():

1. Query: outreach_follow_ups WHERE status = 'pending' AND scheduled_for <= NOW()

2. For each due follow-up:
   a. Check outreach_conversations.last_response_from for this target
      → If 'them': follow-up is no longer needed
        UPDATE status = 'cancelled'
        (their reply was already handled by checkOutreachInbox)
        Continue to next follow-up

   b. bhwSession.navigateTo(bhw_conversation_url)
   c. Send pre-generated follow-up message (human typing)
   d. outreach_follow_ups: status = 'sent', sent_at = NOW()
   e. outreach_conversations: last_message_at = NOW(), our_message_count++
   f. logActivity({ action_type: 'threads_owner_outreach_follow_up_sent', ... })
   g. WhatsApp alert:
      "[THREADS-OWNER-OUTREACH] Follow-up #<N> sent ✅
       To: @<poster_username>
       Thread: "<title>""

3. Cold detection (checked each run):
   If all 3 follow-ups are 'sent' AND outreach_conversations.last_response_from = 'us'
   AND follow_up 3 sent_at is > 7 days ago:
   → outreach_targets.status = 'cold'
   → outreach_conversations.status = 'cold'
   → WhatsApp alert:
     "[THREADS-OWNER-OUTREACH] Marked cold ❄️
      @<poster_username> — no reply after all 3 follow-ups
      Thread: "<title>""
```

### Follow-up tone (soft, non-pushy)
All 3 generated by `generateThreadsOwnerOutreachFollowUps()` using `outreachPersona`:
- **Follow-up 1 (day 3)**: One sentence. "Making sure this didn't get buried" energy. No pitch repeat.
- **Follow-up 2 (day 7)**: Add new value — a relevant capability or quick insight. Brief.
- **Follow-up 3 (day 14)**: Gentle close. Leave door open, zero pressure. "If timing isn't right, no worries" energy.

---

## Reply Handling (`outreach-inbox.js`)

**Not a separate loop.** Called as `checkOutreachInbox()` at the end of each daily batch, right after `runOutreachFollowUps()`.

```
checkOutreachInbox():

1. Navigate to: blackhatworld.com/conversations/
2. Scan all listed conversations

3. For each unread conversation:
   a. Extract: other_username, conversation_url, subject line
   b. Is other_username a row in outreach_targets?
      → NO: skip entirely — main inbox-monitor.js owns it, no conflict
      → YES: this module handles it

4. For matched outreach conversations:
   a. Navigate to conversation URL
   b. Read full message history (all messages on page)
   c. Save their message: outreach_dms (direction='inbound')
   d. Update outreach_targets:
        status = 'replied', last_reply_at = NOW()
   e. Update outreach_conversations:
        last_response_from = 'them', their_message_count++, status = 'replied'
   f. CANCEL all pending follow-ups for this target:
        UPDATE outreach_follow_ups SET status = 'cancelled'
        WHERE target_id = ? AND status = 'pending'
   g. Generate contextual reply:
        aiEngine.generateThreadsOwnerOutreachReply(title, description, conversation_history)
        CTA in reply: push towards Telegram (handled in outreachPersona)
   h. Send reply with human typing
   i. Save reply: outreach_dms (direction='outbound', type='reply')
   j. Update outreach_conversations: our_message_count++, last_response_from = 'us'
   k. logActivity({ action_type: 'threads_owner_outreach_reply_sent', ... })
   l. WhatsApp alert:
      "[THREADS-OWNER-OUTREACH] Reply received & answered 💬
       From: @<poster_username>
       Thread: "<title>"
       Their message: "<first 100 chars>..."
       Our reply: sent ✅ (Telegram CTA included)"
```

---

## AI Functions — Explicit Naming

All three functions use the full module name as prefix to avoid any collision with other modules also named "outreach":

| Function | Called when | Uses |
|----------|-------------|------|
| `generateThreadsOwnerOutreachDM(title, description)` | Step 3 of per-target flow | `outreachPersona` |
| `generateThreadsOwnerOutreachFollowUps(title, description, dmText)` | Step 7 of per-target flow | `outreachPersona` |
| `generateThreadsOwnerOutreachReply(title, description, history)` | Reply handling | `outreachPersona` |

Added to `src/services/aiEngine.js` after all existing functions, under a clearly labelled comment block:
```
// ── THREADS OWNER OUTREACH MODULE ─────────────────────────────────────────
```

---

## Persona (`outreachPersona.js`) — Blank Skeleton

Structure mirrors `zeePersona.js` so it plugs into the AI engine identically. You fill in the content before Phase 2 starts.

```javascript
// src/services/outreachPersona.js
// ⚠️  CONTENT BLANK — Zeeshan to define before Phase 2 build

export const OUTREACH_SYSTEM_PROMPT = `
[YOU WRITE THIS]
- Who is writing (voice/character)?
- What service is being pitched?
- Tone, vocabulary, things to avoid
- Length rules
- CTA: push towards Telegram
`;

export function buildOutreachSystemPrompt(functionInstructions) {
  return `${OUTREACH_SYSTEM_PROMPT}\n\n${functionInstructions}`;
}
```

---

## WhatsApp Notification Tag Reference

All alerts from this module start with `[THREADS-OWNER-OUTREACH]` to distinguish them from `[DM]`, `[COMMENT]`, `[FOLLOW-UP]` and other module alerts.

| Event | Alert |
|-------|-------|
| DM sent | `[THREADS-OWNER-OUTREACH] DM sent ✅\nTo: @username\nThread: "title"\nFollow-ups: Day 3/7/14 scheduled` |
| Follow-up sent | `[THREADS-OWNER-OUTREACH] Follow-up #N sent ✅\nTo: @username\nThread: "title"` |
| Reply received + answered | `[THREADS-OWNER-OUTREACH] Reply received & answered 💬\nFrom: @username\nThread: "title"\nTheir msg: "..."\nOur reply: sent ✅` |
| Marked cold | `[THREADS-OWNER-OUTREACH] Marked cold ❄️\n@username — no reply after 3 follow-ups\nThread: "title"` |
| Skipped (duplicate) | `[THREADS-OWNER-OUTREACH] Skipped ⏭\n@username — already_contacted_main_pipeline` |

---

## Configuration (`.env` additions)

```env
# ── Threads Owner Outreach Module ──────────────────────────────
OUTREACH_ENABLED=true
OUTREACH_DAILY_CAP=5               # DMs per day
OUTREACH_ACTIVE_START_UTC=15       # Window open hour (UTC) — 10:00 AM US Eastern / 3:00 PM UK
OUTREACH_ACTIVE_END_UTC=7          # Window close hour (UTC) — 2:00 AM US Eastern / 7:00 AM UK
OUTREACH_WINDOW_JITTER_MINUTES=30  # Random jitter on window open time (anti-pattern)
OUTREACH_MIN_GAP_MINUTES=90        # Min minutes between any two DMs in a batch
OUTREACH_FOLLOWUP1_DAYS=3
OUTREACH_FOLLOWUP2_DAYS=7
OUTREACH_FOLLOWUP3_DAYS=14
```

Active 16 hours/day (15:00–07:00 UTC = 10am–2am US Eastern), sleeping 8 hours (07:00–15:00 UTC). Jitter prevents fixed-time fingerprinting.

---

## Integration with `src/index.js`

Only one new import and one new call:

```javascript
import { startThreadsOwnerOutreach } from './engines/threads-owner-outreach.js';

// In main():
if (config.outreach.enabled) {
  startThreadsOwnerOutreach();
  // ↑ This single call contains the full cycle:
  //   daily DMs → runOutreachFollowUps() → checkOutreachInbox() → sleep → repeat
}
```

No separate `startOutreachFollowUpSystem()` or `startOutreachInboxMonitor()` wire-ups — they are called internally at the end of each batch.

---

## Build Phases

| Phase | What gets built | Blocked on |
|-------|----------------|-----------|
| **Phase 1** | `outreach-schema.sql`, DB init update, `seed-outreach-targets.js`, outreach query functions in `queries.js` | Nothing — can start now |
| **Phase 2** | `outreachPersona.js` content + 3 AI functions in `aiEngine.js` | **You write the persona** |
| **Phase 3** | `threads-owner-outreach.js` — loop, scrape via session, DM send | Phase 1 done |
| **Phase 4** | `outreach-follow-up.js` + `outreach-inbox.js` | Phase 3 done |
| **Phase 5** | Config, `index.js` wiring, DRY_RUN local test | Phase 4 done |

---

## Files Created / Modified

| File | Action |
|------|--------|
| `database/outreach-schema.sql` | CREATE |
| `scripts/seed-outreach-targets.js` | CREATE |
| `src/services/outreachPersona.js` | CREATE (skeleton — you fill in) |
| `src/engines/threads-owner-outreach.js` | CREATE |
| `src/engines/outreach-follow-up.js` | CREATE |
| `src/engines/outreach-inbox.js` | CREATE |
| `src/services/aiEngine.js` | MODIFY — add 3 new functions |
| `src/database/queries.js` | MODIFY — add outreach query functions |
| `src/database/init.js` | MODIFY — run outreach schema migration |
| `src/config/config.js` | MODIFY — add `outreach.*` config block |
| `src/index.js` | MODIFY — one new module start |
| `.env.example` | MODIFY — document new vars |

**Existing files NOT touched:**
`dm.js`, `follow-up.js`, `inbox-monitor.js`, `comment.js`, `zeePersona.js`, `scraper/index.js`, `schema.sql`

---

*Write the persona content whenever you're ready — that unblocks Phase 2. Phase 1 can start immediately.*
