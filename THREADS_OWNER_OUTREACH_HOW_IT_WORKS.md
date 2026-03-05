# Threads Owner Outreach Module — How It Works

A complete step-by-step breakdown of the automated outreach system that finds BHW thread owners, generates personalised DMs, and manages the full follow-up sequence.

---

## Overview

The module monitors a list of BHW threads (seeded by you), scrapes each one, generates a tailored cold DM using GPT, sends it on BHW, then automatically follows up at Day 3 / Day 7 / Day 14 — all while sending you live WhatsApp updates at every stage.

**Goal:** Move thread owners from BHW DM → Telegram → paid project.

---

## Architecture — 3 Engine Files

| File | Role | When it runs |
|------|------|--------------|
| `src/engines/threads-owner-outreach.js` | Main loop — scrapes & sends initial DMs | Daily, inside active window |
| `src/engines/outreach-follow-up.js` | Sends pre-generated follow-ups when due | End of each outreach batch |
| `src/engines/outreach-inbox.js` | Checks BHW inbox for replies, sends replies | After follow-ups |

---

## Step-by-Step Flow

### Phase 1 — Seeding Targets

Before the bot does anything, you seed BHW thread URLs into the database.

```bash
node scripts/seed-outreach-targets.js targets.csv
```

**CSV format:**
```
thread_url,title
https://www.blackhatworld.com/seo/some-thread.123456/,Thread Title Here
```

The script:
1. Reads each row from the CSV
2. Extracts the numeric thread ID from the URL
3. Checks for duplicates (skips if already in `outreach_targets`)
4. Inserts new rows with `status = 'pending'`

**DB table:** `outreach_targets`

---

### Phase 2 — Active Window Check

The engine only runs during your configured active hours (UTC). This avoids sending DMs at odd hours that look robotic.

```
OUTREACH_ACTIVE_START_UTC=15   (e.g. 3pm UTC = morning US / evening PK)
OUTREACH_ACTIVE_END_UTC=7      (wraps midnight — active from 15:00 to 07:00 UTC)
OUTREACH_WINDOW_JITTER_MINUTES=30
```

If current time is outside the window → engine sleeps and rechecks every 5 minutes.

---

### Phase 3 — Fetch Pending Targets

At the start of each cycle, the engine queries the DB for the next batch:

```sql
SELECT * FROM outreach_targets
WHERE status = 'pending'
ORDER BY added_at ASC
LIMIT [dailyCap]
```

Default `dailyCap = 5` targets per cycle (configurable via `OUTREACH_DAILY_CAP`).

---

### Phase 4 — Per-Target Processing (9 Steps)

For each target, the engine runs this sequence:

#### Step 1 — Duplicate Check (Cross-Module)
Checks if this thread owner was already contacted via the **main pipeline** (the scraper/comment/DM loop). If `getLeadByPosterUsername()` returns a record with `dm_sent = true` → target is **skipped** with reason `already_contacted_main_pipeline`.

#### Step 2 — Live Thread Scrape
Uses the shared `bhwSession` (Puppeteer + CloudFlare bypass) to navigate to the thread URL and extract:
- **Description**: First post body text (`.message-body .bbWrapper`)
- **Poster username**: OP's BHW handle (`.message-name a.username`)

If scrape fails → target is **skipped** with reason `scrape_failed`. WhatsApp alert sent.

Scraped data is saved to `outreach_targets` via `updateOutreachTargetScraped()`.

#### Step 3 — Skip if No Username
If BHW username can't be extracted → skipped. Can't send a DM without knowing who to send it to.

#### Step 4 — Within-Module Duplicate Check
Now that we have the username, checks `outreach_targets` for any existing record with `status IN ('dm_sent', 'replied', 'in_conversation')` for this username. Prevents double-DM if the same person owns multiple threads in your target list.

#### Step 5 — AI Generates Initial DM
Calls `generateThreadsOwnerOutreachDM(title, description)`:
- Uses your **Zeeshan persona** (`outreachPersona.js`) as the system prompt
- References specific details from the thread title and OP text
- Returns a personalised, plain-text DM (max ~80 words, 3–5 sentences)
- Tone: casual, peer-to-peer, BHW culture — not corporate

#### Step 6 — AI Pre-generates All 3 Follow-ups
Calls `generateThreadsOwnerOutreachFollowUps(title, description, dmText)`:
- Generates all 3 follow-ups **at DM-send time** (not when they're due)
- Stored in DB immediately so they're ready regardless of AI availability later

| Follow-up | Day | Tone |
|-----------|-----|------|
| Follow-up 1 | Day 3 | 1 sentence — "making sure this didn't get buried" |
| Follow-up 2 | Day 7 | 2–3 sentences — new angle + soft Telegram mention |
| Follow-up 3 | Day 14 | 1–2 sentences — gentle close, zero pressure |

#### Step 7 — Send DM on BHW
Navigates to `https://www.blackhatworld.com/conversations/add?to=[username]`, fills in subject + body, submits.

Conversation URL is saved to `outreach_conversations`.

> ⚠️ **In dry-run mode** (`dryRun=true`) this step is skipped entirely — everything else runs normally.

#### Step 8 — Save to Database
Writes:
- `outreach_conversations` — new conversation record
- `outreach_dms` — the initial DM text + direction = `outbound`
- `outreach_follow_ups` — all 3 follow-ups with scheduled `due_at` dates
- `outreach_targets.status` → `'dm_sent'`
- `outreach_targets.contacted_at` → now

#### Step 9 — WhatsApp Alert
Sends a summary to your **Bitbash BHW Bot** WhatsApp group:
```
[THREADS-OWNER-OUTREACH] ✅ DM Sent
Target #X | [1/5]
Thread: "..."
Poster: @username
DM: [full text]
Follow-ups scheduled: Day 3 / Day 7 / Day 14
```

---

### Phase 5 — Follow-up Runner (after each batch)

After the main batch completes, `runOutreachFollowUps()` is called automatically.

1. Queries `outreach_follow_ups` for rows where `due_at <= NOW()` and `status = 'pending'`
2. For each due follow-up:
   - Checks if we already got a reply (`last_response_from = 'them'`) → skips gracefully
   - Navigates to BHW conversation URL and sends pre-generated text
   - Updates `outreach_follow_ups.status` → `'sent'`
   - Sends WhatsApp alert with follow-up text

**Cold detection:** If a target has sent all 3 follow-ups with no reply → `outreach_targets.status` → `'cold'`. You get a WhatsApp alert listing all cold targets.

---

### Phase 6 — Inbox Monitor (after follow-ups)

`checkOutreachInbox()` runs after follow-ups to catch any replies.

1. Navigates to `https://www.blackhatworld.com/conversations/`
2. Finds unread conversations
3. Matches them against `outreach_targets` by username
4. If matched → reads the reply
5. Calls `generateThreadsOwnerOutreachReply(title, description, conversationHistory)`:
   - Reads full conversation history from DB
   - Generates a contextual, natural reply
   - For interested leads: builds rapport + nudges to Telegram (`@zeeshanahmad4`)
6. Sends the reply on BHW
7. Updates `outreach_conversations.last_response_from` → `'them'`
8. Sends WhatsApp handoff alert if conversation is getting complex

---

## Database Tables

```
outreach_targets          — Master list of threads to contact
  id, thread_id, thread_url, title, poster_username, description
  status: pending | dm_sent | replied | in_conversation | cold | skipped

outreach_conversations    — One per target once DM is sent
  id, target_id, conversation_url, status, last_response_from
  messages_sent, messages_received

outreach_dms              — Every message (in/out) per conversation
  id, target_id, conversation_id, direction, message_text, message_type

outreach_follow_ups       — Pre-generated follow-up schedule
  id, target_id, conversation_id, follow_up_number (1/2/3)
  message_text, due_at, status: pending | sent | cancelled | failed
```

---

## Configuration (.env)

| Variable | Default | Description |
|----------|---------|-------------|
| `OUTREACH_ENABLED` | `false` | Master on/off switch |
| `OUTREACH_DAILY_CAP` | `5` | Max DMs per cycle |
| `OUTREACH_ACTIVE_START_UTC` | `15` | Hour to start (UTC) |
| `OUTREACH_ACTIVE_END_UTC` | `7` | Hour to stop (UTC, wraps midnight) |
| `OUTREACH_WINDOW_JITTER_MINUTES` | `30` | Random delay to window edges |
| `OUTREACH_MIN_GAP_MINUTES` | `90` | Min gap between cycles |
| `OUTREACH_FOLLOWUP1_DAYS` | `3` | Days after DM for follow-up 1 |
| `OUTREACH_FOLLOWUP2_DAYS` | `7` | Days after DM for follow-up 2 |
| `OUTREACH_FOLLOWUP3_DAYS` | `14` | Days after DM for follow-up 3 |

---

## Adding More Targets

1. Add rows to `targets.csv` (or a new CSV):
   ```
   thread_url,title
   https://www.blackhatworld.com/seo/some-thread.123456/,Title
   ```
2. Run the seeder:
   ```bash
   node scripts/seed-outreach-targets.js targets.csv
   ```
3. New targets appear in DB with `status = 'pending'` — engine picks them up automatically on next cycle.

---

## Dry Run (Testing Without Sending)

Test the full pipeline — scrape, AI generation, WhatsApp previews — without sending anything on BHW:

```bash
node test-outreach-dry-run.js
```

Processes first 3 pending targets. Sends full preview to WhatsApp group. Writes nothing to DB.

---

## Enabling Live Mode

Once dry-run looks good and persona is reviewed:

```env
OUTREACH_ENABLED=true
```

Then restart the bot — `startThreadsOwnerOutreach()` will be called automatically from `src/index.js`.

---

## WhatsApp Alerts Reference

| Alert | When |
|-------|------|
| `✅ DM Sent` | After each successful DM send |
| `⏭ Target Skipped` | Duplicate / scrape fail / no username |
| `📆 Follow-up Sent` | Each follow-up delivered |
| `❄️ Cold Targets` | End of batch — list of no-reply targets |
| `💬 Reply Received` | Inbox monitor found a reply |
| `🚨 Handoff Alert` | Complex conversation — needs your attention |

---

## Persona & Voice

Defined in `src/services/outreachPersona.js`.

- **Identity:** Zeeshan Ahmad — independent automation developer, Top Rated Plus Upwork, $150k+ earned
- **Portfolio:** 13 YouTube demos linked (Instagram, Facebook, Reddit, Twitter, Android, Spotify bots)
- **CTA path:** BHW DM → Telegram `@zeeshanahmad4` → scoping call → project
- **Tone:** Casual, peer-to-peer, BHW culture — no hype, no corporate speak, no emoji

---

*Last updated: Phase 12 — March 2026*
