# Outreach Module — Development Plan (v2)

**Module Name:** Outreach DM (Cross-Sell to Non-Niche "Hire a Freelancer" Posters)  
**Date:** March 4, 2026 (revised)  
**Status:** Planning — approved by owner, ready to build  

---

## 1. What This Module Does

The bot already scrapes BHW's "Hire a Freelancer" section and DMs people who are looking for **custom software development** — we call that the **Niche DM** module. The AI qualifier rejects ~60–70% of posts as "not our niche" — logo design, SEO, content writing, accounts, social media management, etc.

This **Outreach DM** module takes **ALL rejected/non-niche posts** and DMs the poster with a completely different pitch. The idea:

> "Hey, I see you posted looking for [logo design / SEO / content writing]. I know this isn't my area, but I wanted to introduce myself — a lot of people in this space eventually need custom software, automation tools, or a website. If that ever comes up, I'd love to chat."

It is a **cross-sell / soft introduction** — not a hard pitch for the service they asked for.

**Confirmed decisions (from owner):**
- DM only — **no comment** on non-niche threads (commenting on a logo design post would look spammy)
- Outreach DMs go to **ALL** rejected "Hire a Freelancer" leads — no filtering by category
- Follow-up schedule: **3 follow-ups** at day 3, 7, 14 (lighter than niche)
- Daily cap: **15 outreach DMs/day** (separate from the 25/day niche DM cap)
- Persona: Zee (same `app_pilot` account), softer tone — will be updated by owner later
- No priority order between niche and outreach — just ensure proper sleep between ALL DMs

---

## 2. Naming Convention

| Module | Engine File | DB Marker | DM Type |
|---|---|---|---|
| **Niche DM** | `src/engines/dm.js` | `leads.dm_sent` | `initial_outreach` |
| **Outreach DM** | `src/engines/outreach.js` | `leads.outreach_dm_sent` | `outreach_initial` |

Both modules run from the same main loop but are **completely separate in logic, prompts, follow-ups, and conversation handling**.

---

## 3. Architecture: Fully Separate Engine

### Why fully separate:

| Concern | Niche DM (`dm.js`) | Outreach DM (`outreach.js`) |
|---|---|---|
| **Target** | Qualified leads (software dev jobs) | Rejected leads (non-niche jobs) |
| **AI Prompt** | "I build exactly this" pitch | "If you ever need software…" introduction |
| **Comment?** | Yes — comment on thread first, then DM | **No** — DM only |
| **Daily cap** | 25/day | 15/day (separate) |
| **Follow-ups** | 6 FUs over 21 days (aggressive) | 3 FUs over 14 days (lighter) |
| **Reply prompt** | `generateDMReply()` — niche context | `generateOutreachReply()` — outreach context **(NEW)** |
| **FU cancel on "not interested"** | Standard handling | **Must cancel all remaining FUs immediately** |
| **DB tracking** | `dm_sent`, `dm_sent_at` | `outreach_dm_sent`, `outreach_dm_sent_at` |
| **Conversation tag** | `is_outreach = false` | `is_outreach = true` |

### What's shared (no duplication):

- **Scraper** — same scraper, same DB. Zero changes.
- **Browser send logic** — extracted into a shared `sendBHWConversation()` function (see Phase 6). Both `dm.js` and `outreach.js` call it.
- **DB tables** — same `leads`, `conversations`, `dms`, `follow_ups` tables. New columns only.
- **Session management** — same `bhwSession.js`.
- **Follow-up execution** — same `follow-up.js` loop sends all follow-ups. It reads `is_outreach` from the conversation to decide which AI prompt to use.

---

## 4. Data Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                        EXISTING SCRAPER                              │
│  Scrape "Hire a Freelancer" → AI qualifyLead() → store in DB         │
│                                                                      │
│  qualified: true  ──► Comment Engine → Niche DM Engine (existing)    │
│  qualified: false ──► ★ OUTREACH DM ENGINE (new) ★                   │
└──────────────────────────────────────────────────────────────────────┘

MAIN LOOP (updated):
  scrape
    → processQualifiedLeads()       [niche: comment + DM]
    → sleep 3–8 min (anti-bot gap)  [NEVER back-to-back DMs]
    → processOutreachLeads()        [outreach: DM only]
    → sleep 10–20 min
    → repeat

OUTREACH FLOW DETAIL:
  1. Query DB: leads WHERE is_qualified = false 
                     AND outreach_dm_sent = false
                     AND dm_sent = false            ← cross-module dedup
                     AND poster_username IS NOT NULL
                     AND poster_username != 'unknown'
                     AND thread_age_category = 'fresh'
  2. Enforce daily outreach cap (15)
  3. For each lead:
     a. Generate outreach DM text (aiEngine.generateOutreachDM)
     b. Send via shared sendBHWConversation() 
     c. Create conversation with is_outreach = true
     d. Mark lead outreach_dm_sent = true
     e. Schedule 3 lighter follow-ups (day 3, 7, 14)
     f. WhatsApp notification (tagged as "Outreach")
     g. Sleep 3–8 min before next outreach DM
```

---

## 5. CRITICAL: Conversation & Follow-Up Isolation

This is the most important part of the plan. Outreach conversations and niche conversations must **never mix** — they use different prompts, different follow-up strategies, and different cancellation rules.

### 5.1 How the system knows which type a conversation is

Every `conversations` row gets an `is_outreach` boolean:
- Niche DM creates conversation → `is_outreach = false` (default)
- Outreach DM creates conversation → `is_outreach = true`

This flag is **permanent** — it never changes for the lifetime of the conversation.

### 5.2 Inbox Monitor: Routing replies to the correct handler

When `inbox-monitor.js` finds an unread conversation and calls `handleConversation()`:

```
CURRENT FLOW (broken for outreach):
  inbox-monitor → handleConversation() → aiEngine.generateDMReply() ← ALWAYS uses niche prompt

UPDATED FLOW:
  inbox-monitor → look up conversation in DB → check is_outreach flag
    → is_outreach = false → handleConversation() with aiEngine.generateDMReply()     [niche prompt]
    → is_outreach = true  → handleConversation() with aiEngine.generateOutreachReply() [outreach prompt]
```

**Implementation:** `handleConversation()` gets a new `options.isOutreach` parameter. When true, it calls `generateOutreachReply()` instead of `generateDMReply()`.

### 5.3 New AI function: `generateOutreachReply()`

Different from `generateDMReply()` because:
- The original DM was a soft intro, not a direct pitch
- The person didn't ask for software — they might be confused why we DMed them
- We must NOT pitch hard or get pushy
- If they say "not interested" or "I don't need software" → reply gracefully and cancel follow-ups
- If they show interest → engage normally but don't over-sell

**Prompt core:**
```
You are Zee. You previously sent this person a friendly introduction DM — they posted about 
[their job, e.g. logo design] on BHW and you introduced yourself as a software developer 
in case they ever need tech work.

They have now replied. Respond naturally.

CRITICAL RULES:
  • If they say they're not interested, don't need software, or ask you to stop:
    Reply gracefully ("No worries at all, just wanted to put it on your radar. 
    Good luck with your project!") and append [CANCEL_FOLLOWUPS] on its own final line.
  • If they're curious or ask questions: answer genuinely, keep it conversational.
  • If they have a real project need: engage normally, offer details, nudge toward Telegram.
  • NEVER be pushy. This was a cold intro — respect their space.
  • 40–120 words max.
```

### 5.4 Follow-Up Handling: Outreach vs Niche

**Follow-up engine (`follow-up.js`) changes:**

The follow-up engine sends pre-written messages from the `follow_ups` table. Currently it doesn't care about conversation type. With outreach:

1. **When a reply comes in** (inbox-monitor detects unread):
   - Look up `conversations.is_outreach` for the conversation
   - If `is_outreach = true`:
     - Parse the reply for rejection signals (AI-detected `[CANCEL_FOLLOWUPS]` tag)
     - If `[CANCEL_FOLLOWUPS]` → cancel ALL remaining follow-ups for this conversation (mark `status = 'cancelled'`)
     - If reply is a real conversation → pause follow-ups (same as niche behavior)
   - If `is_outreach = false`:
     - Existing niche behavior (unchanged)

2. **When generating follow-ups at schedule time** (in outreach.js `scheduleOutreachFollowUps`):
   - Use `aiEngine.generateOutreachFollowUp()` — lighter tone
   - Store with `message_type = 'outreach_follow_up'` in the DMs table
   - 3 follow-ups only: day 3, 7, 14

3. **Resumable (cold) follow-up detection** — works the same for both types, no change needed.

### 5.5 Cancellation Flow: "Not Interested" Handling

```
Person replies to outreach DM:
  → inbox-monitor picks it up
  → checks DB: is_outreach = true
  → calls handleConversation(... { isOutreach: true })
  → AI generates reply using outreach prompt
  → AI output contains [CANCEL_FOLLOWUPS]?
      YES → strip tag, send graceful reply, cancel all pending follow-ups
      NO  → send reply normally, pause follow-ups (standard behavior)
```

This is critical because outreach generates **high volume** of conversations. Many will reply "not interested." We must:
- Reply gracefully (not ghost them)
- Immediately cancel all scheduled follow-ups (not badger them)
- Never send another follow-up after they said no

---

## 6. Detailed Implementation Plan

### Phase 1: Database Changes

**New columns on `leads` table:**
```sql
ALTER TABLE leads ADD COLUMN outreach_dm_sent BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN outreach_dm_sent_at TIMESTAMP;
```

**New column on `conversations` table:**
```sql
ALTER TABLE conversations ADD COLUMN is_outreach BOOLEAN DEFAULT FALSE;
```

**No schema change needed for `dms` or `follow_ups`** — we use `message_type` to tag outreach messages (`'outreach_initial'`, `'outreach_follow_up'`, `'outreach_reply'`).

**New DB queries** (in `queries.js`):
```
getRejectedLeadsForOutreach()    — WHERE is_qualified = false 
                                    AND outreach_dm_sent = false
                                    AND dm_sent = false
                                    AND poster_username IS NOT NULL 
                                    AND poster_username != 'unknown'
                                    AND thread_age_category = 'fresh'
                                    ORDER BY discovered_at DESC
markLeadOutreachDMSent(leadId)   — SET outreach_dm_sent = true, outreach_dm_sent_at = NOW()
getDailyOutreachDMCount()        — COUNT where action_type = 'outreach_dm' AND created_at > today
getConversationIsOutreach(convId)— SELECT is_outreach FROM conversations WHERE id = $1
cancelFollowUpsForConversation(convId) — UPDATE follow_ups SET status = 'cancelled' 
                                          WHERE conversation_id = $1 AND status = 'pending'
```

---

### Phase 2: AI Engine — 3 New Functions

#### 2a. `generateOutreachDM(title, description, username)` — Initial cold DM

**Prompt differences from niche DM:**

| Aspect | Niche DM (`generateDMOutreach`) | Outreach DM (`generateOutreachDM`) |
|---|---|---|
| Opening | "I saw your post about [X]. This lines up with what I do." | "Hey @username, I came across your post about [X]." |
| Core pitch | "Here's exactly how I can build this for you" | "I know this isn't what you posted about, but I wanted to introduce myself. A lot of folks who hire for [their service] eventually need software or automation tools too." |
| Capabilities | Specific to their job | General Bitbash overview |
| CTA | "DM me for demo videos" / "Send me your requirements" | "If you ever need software work, keep me in mind." |
| Tone | Direct, confident | Friendly, low-pressure |
| Length | 150–350 words | 80–180 words |

**Job title + description are injected** into the prompt so the AI can acknowledge what they actually posted about.

**Prompt structure:**
```
You are Zeeshan Ahmad ("Zee"), founder of Bitbash — a software development agency.

This person posted on BHW "Hire a Freelancer" looking for: [their job title/description].
This is NOT a software development job — they are looking for something else entirely.

Your goal: Send a friendly, low-pressure DM introducing yourself. You're NOT pitching for 
the job they posted. You're planting a seed — if they ever need software development, 
automation, web scraping, bots, websites, or any tech work, you want to be their go-to.

RULES:
  • DO NOT pretend you can do the service they posted about
  • DO acknowledge what they posted about briefly  
  • DO transition naturally: "I noticed a lot of people in [their space] also end up needing..."
  • Keep it SHORT (80–180 words)
  • Soft CTA: "If you ever need [software/automation/web development], feel free to reach out"
  • Sound human. Sound genuine. No spam energy.
  • No markdown formatting. No pricing.
```

#### 2b. `generateOutreachReply(conversationHistory, latestMessage, messageCount)` — Reply to outreach conversation

```
You are Zee. You previously sent this person a friendly introduction DM — they posted about 
[their job] on BHW and you introduced yourself as a software developer in case they ever 
need tech work. They have now replied.

RULES:
  • If they say they're not interested / don't need software / ask you to stop:
    Reply gracefully and append [CANCEL_FOLLOWUPS] on its own final line.
  • If they're curious or ask questions: answer genuinely, keep it conversational.
  • If they have a real project need: engage, offer details, nudge toward Telegram.
  • NEVER be pushy. This was a cold intro — respect their space.
  • 40–120 words max. No markdown.

[HANDOFF] rule: Same as niche (8+ messages, budget > $3k, complex scope) — append [HANDOFF].
[CANCEL_FOLLOWUPS] rule: Append when they clearly decline interest. Both tags can appear.
```

#### 2c. `generateOutreachFollowUp(title, description, daysSinceLastContact, previousMessages)` — Lighter follow-ups

Tones:
- **Day 3:** Ultra-brief check-in. "Did you find someone for [their job]? If you ever need tech help, I'm around."
- **Day 7:** Add a thin value hook. "A lot of [SEO/design/content] folks I've worked with ended up needing custom tools. If that ever comes up, happy to chat."
- **Day 14 (final):** Graceful close. "Last ping from me — don't want to bug you. If software dev or automation ever comes up, you know where to find me."

---

### Phase 3: Extract Shared Browser Send Logic from `dm.js`

**Current problem:** `sendDM()` in `dm.js` does two things:
1. Browser automation (navigate, fill form, type, submit) — generic
2. DB updates (markLeadDMSent, scheduleFollowUps, scoreLeadHotness) — niche-specific

**Solution:** Extract the browser part into a shared function:

```javascript
// src/engines/dm.js — NEW exported function
export async function sendBHWConversation(username, subject, messageText, opts = {}) {
  // Pure browser automation:
  // 1. Ensure BHW session
  // 2. Navigate to /conversations/add?to=USERNAME
  // 3. Fill subject + message (human typing)
  // 4. Submit
  // 5. Verify redirect
  // 6. Return { success, conversationUrl, bhwConversationId }
  // NO DB writes — caller handles that
}
```

Then:
- `dm.js` → `sendDM()` calls `sendBHWConversation()` + does niche-specific DB writes
- `outreach.js` → `sendOutreachDM()` calls `sendBHWConversation()` + does outreach-specific DB writes

This keeps the 10-step Puppeteer flow in ONE place (no code duplication).

---

### Phase 4: Outreach Engine (`src/engines/outreach.js`)

**New file.** Full structure:

```javascript
import { sendBHWConversation } from './dm.js';
import aiEngine from '../services/aiEngine.js';
import { getRejectedLeadsForOutreach, markLeadOutreachDMSent, 
         createConversation, createDM, updateConversationBhwUrl,
         scheduleFollowUp, getDailyOutreachDMCount } from '../database/queries.js';
import { config } from '../config/config.js';

export async function processOutreachLeads(opts = {}) {
  // 1. Check daily outreach cap
  const { outreachDmsToday } = await getDailyOutreachDMCount();
  if (outreachDmsToday >= config.bot.dailyOutreachDmCap) return;

  // 2. Query rejected leads eligible for outreach
  const leads = await getRejectedLeadsForOutreach();
  if (leads.length === 0) return;

  // 3. For each lead:
  for (const lead of leads) {
    if (outreachDmsToday >= cap) break;

    // a. Generate outreach DM text
    const dmText = await aiEngine.generateOutreachDM(lead.title, lead.description, lead.poster_username);

    // b. Send via shared browser function
    const result = await sendBHWConversation(lead.poster_username, subject, dmText, opts);
    if (!result.success) continue;

    // c. Create conversation with is_outreach = true
    const conv = await createConversation(lead.id, { isOutreach: true });
    if (result.conversationUrl) await updateConversationBhwUrl(conv.id, result.conversationUrl);

    // d. Create outbound DM record
    await createDM({ leadId: lead.id, conversationId: conv.id, direction: 'outbound',
                     messageText: dmText, messageType: 'outreach_initial', generatedBy: 'aiEngine' });

    // e. Mark lead
    await markLeadOutreachDMSent(lead.id);

    // f. Schedule lighter follow-ups (day 3, 7, 14)
    await scheduleOutreachFollowUps(lead, conv.id, dmText);

    // g. WhatsApp notification
    await alerts.sendRawAlert(`📤 *Outreach DM Sent*\n...`);

    // h. Human pacing: 3–8 min sleep
    await sleep(randomDelay(3 * 60 * 1000, 8 * 60 * 1000));
  }
}

async function scheduleOutreachFollowUps(lead, conversationId, dmText) {
  const intervals = [3, 7, 14]; // days
  for (let i = 0; i < intervals.length; i++) {
    const days = intervals[i];
    const jitterMs = Math.floor(Math.random() * 24 * 60 * 60 * 1000);
    const scheduledFor = new Date(Date.now() + days * 24 * 60 * 60 * 1000 + jitterMs);
    const text = await aiEngine.generateOutreachFollowUp(lead.title, lead.description, days, `Outreach DM:\n${dmText}`);
    await scheduleFollowUp({ leadId: lead.id, conversationId, scheduledFor, followUpNumber: i + 1, messageText: text });
  }
}
```

---

### Phase 5: Inbox Monitor & Conversation Engine Updates

**`inbox-monitor.js` changes:**

Before calling `handleConversation()`, look up the conversation's `is_outreach` flag:

```javascript
// EXISTING: just calls handleConversation()
// UPDATED:
const dbConv = lead ? await getConversationByLeadId(lead.id) : null;
const isOutreach = dbConv?.is_outreach === true;

const result = await handleConversation(conv.url, conv.username, lead, dbConv?.id, {
  ...opts,
  isOutreach,  // NEW — passed through to conversation engine
});

// After reply:
if (result.success && result.cancelFollowUps) {
  // Outreach: person said "not interested" — cancel ALL follow-ups
  await cancelFollowUpsForConversation(dbConv.id);
  logger.info(`  ❌ All follow-ups cancelled for outreach conv #${dbConv.id} (lead declined)`);
}
```

**`conversation.js` changes:**

`handleConversation()` receives `opts.isOutreach`:

```javascript
// EXISTING: always calls aiEngine.generateDMReply()
// UPDATED:
const rawReply = opts.isOutreach
  ? await aiEngine.generateOutreachReply(historyStr, latestText, messages.length)
  : await aiEngine.generateDMReply(historyStr, latestText, messages.length);

// Check for [CANCEL_FOLLOWUPS] tag (outreach only)
const cancelFollowUps = /\[CANCEL_FOLLOWUPS\]/i.test(rawReply);
const replyText = rawReply
  .replace(/\[CANCEL_FOLLOWUPS\]/gi, '')
  .replace(/\[HANDOFF\]/gi, '')
  .trim();

return { success: true, replyText, handoff: isHandoff, cancelFollowUps };
```

---

### Phase 6: Config Changes

**New config values** (in `config.js` / `.env`):
```
DAILY_OUTREACH_DM_CAP=15          # Max outreach DMs per day (separate from niche 25)
OUTREACH_FOLLOW_UP_DAYS=3,7,14    # Lighter follow-up schedule
OUTREACH_ENABLED=true             # Kill switch — disable without touching code
```

---

### Phase 7: Main Loop Integration (`src/index.js`)

```
UPDATED FLOW:
  scrape
    → processQualifiedLeads()             [niche: comment + DM]
    → sleep 3–8 min                       [MANDATORY gap — never back-to-back DMs]
    → processOutreachLeads()              [outreach: DM only]  
    → sleep 10–20 min
    → repeat
```

**Critical sleeps:**
- Between niche outreach and outreach DMs: **3–8 min mandatory sleep** — the BHW account must never send two DMs back-to-back without a gap
- Between individual outreach DMs: **3–8 min** each (inside `processOutreachLeads()`)
- The overall cycle sleep (10–20 min) remains unchanged
- These sleeps are calibrated so a single cycle can't take so long that the next scrape cycle gets blocked — with cap=15 at ~5 min avg gap, worst case is ~75 min for all outreach DMs, well within the 10–20 min + next cycle window

**Key safeguards (query-level, not logic-level):**
- `is_qualified = false` — only rejected leads
- `outreach_dm_sent = false` — never re-send
- `dm_sent = false` — never outreach someone we already niche-DMed
- `poster_username IS NOT NULL AND != 'unknown'` — can't DM without a username
- `thread_age_category = 'fresh'` — only recent posts (< 30 days)

---

### Phase 8: Follow-Up Engine Updates (`follow-up.js`)

The follow-up engine runs on a separate timer (every 30–90 min). Changes:

1. **`processFollowUps()` must check `is_outreach`** before sending:
   - Query the conversation for each pending follow-up
   - If `is_outreach = true` → use outreach follow-up text (already stored in `message_text`)
   - No prompt change needed at send time — text was pre-generated by `generateOutreachFollowUp()` at schedule time

2. **Cancellation integration:**
   - When inbox-monitor detects `[CANCEL_FOLLOWUPS]` → calls `cancelFollowUpsForConversation(convId)`
   - `processFollowUps()` simply skips cancelled follow-ups (they have `status = 'cancelled'`, not `'pending'`)

3. **No mixing:** Follow-ups for outreach conversations never use niche prompts and vice versa. The text is baked-in at schedule time.

---

### Phase 9: Alerts & Reporting

- WhatsApp notification template for outreach DMs:
  ```
  📤 *Outreach DM Sent*
  
  📌 *Post:* "[their job title]"
  👤 Poster: @username
  🏷️ Type: Outreach (non-niche)
  
  📩 *DM sent:*
  [dm text preview]
  ```
- Daily report includes: `Outreach DMs sent: X / 15`
- Command center `/stats` includes outreach counts
- Follow-up cancellation logged to activity_log: `action_type = 'outreach_followup_cancelled'`

---

### Phase 10: Duplicate Protection (Comprehensive)

| Scenario | Guard | Level |
|---|---|---|
| Same lead gets niche DM + outreach DM | `dm_sent = false` check in outreach query | DB query |
| Same lead gets outreach DM twice | `outreach_dm_sent = false` check | DB query |
| Same user posts multiple threads, gets multiple outreach DMs | `wasUserOutreachDMedRecently(username, 30)` — new query checks if ANY lead with this `poster_username` has `outreach_dm_sent = true` in last 30 days | DB query |
| Niche DM + outreach DM sent back-to-back (no sleep) | Mandatory 3–8 min sleep between `processQualifiedLeads()` and `processOutreachLeads()` | Main loop |
| Two outreach DMs sent back-to-back | 3–8 min sleep inside `processOutreachLeads()` loop | Outreach engine |
| Follow-up sent after person said "not interested" | `[CANCEL_FOLLOWUPS]` tag → `cancelFollowUpsForConversation()` | Inbox monitor |
| Outreach reply uses niche prompt (wrong context) | `conversations.is_outreach` flag → routes to correct AI function | Conversation engine |
| Niche reply uses outreach prompt | Same flag — `is_outreach = false` → existing niche prompt | Conversation engine |
| Crash between DM send and DB update | Same crash-recovery pattern as niche: fresh DB check before sending | Outreach engine |

---

## 7. File Changes Summary

| File | Change Type | Description |
|---|---|---|
| `src/engines/outreach.js` | **NEW** | Outreach engine — generate + send cross-sell DMs, schedule follow-ups |
| `src/services/aiEngine.js` | MODIFY | Add `generateOutreachDM()`, `generateOutreachReply()`, `generateOutreachFollowUp()` |
| `src/engines/dm.js` | MODIFY | Extract `sendBHWConversation()` shared function; existing `sendDM()` calls it |
| `src/engines/conversation.js` | MODIFY | Accept `isOutreach` option; route to correct AI reply function; handle `[CANCEL_FOLLOWUPS]` tag |
| `src/engines/inbox-monitor.js` | MODIFY | Look up `is_outreach` flag before calling `handleConversation()`; handle follow-up cancellation |
| `src/engines/follow-up.js` | MINOR | No logic change — cancelled follow-ups are already skipped by the `status = 'pending'` query |
| `src/database/queries.js` | MODIFY | Add `getRejectedLeadsForOutreach()`, `markLeadOutreachDMSent()`, `getDailyOutreachDMCount()`, `cancelFollowUpsForConversation()`, `getConversationIsOutreach()`, `wasUserOutreachDMedRecently()`, update `createConversation()` to accept `isOutreach` |
| `src/database/init.js` | MODIFY | Add migration for new columns |
| `src/config/config.js` | MODIFY | Add `dailyOutreachDmCap`, `outreachFollowUpDays`, `outreachEnabled` |
| `src/index.js` | MODIFY | Wire `processOutreachLeads()` into main loop with mandatory sleep gap |
| `src/services/alerts.js` | MODIFY | Add outreach DM notification template, outreach stats in daily report |
| `.env.example` | MODIFY | Add new outreach env vars |
| `test-outreach.js` | **NEW** | End-to-end test script for outreach module |

---

## 8. Implementation Order

```
Step 1:  Database migrations (new columns)                       ~ 30 min
Step 2:  DB query functions (6 new queries)                      ~ 45 min
Step 3:  AI engine — generateOutreachDM() prompt                 ~ 1 hr
Step 4:  AI engine — generateOutreachReply() prompt              ~ 45 min
Step 5:  AI engine — generateOutreachFollowUp() prompt           ~ 30 min
Step 6:  dm.js refactor — extract sendBHWConversation()          ~ 1 hr
Step 7:  outreach.js engine (core logic + follow-up scheduling)  ~ 2 hr
Step 8:  conversation.js — isOutreach routing + [CANCEL_FOLLOWUPS] ~ 1 hr
Step 9:  inbox-monitor.js — is_outreach lookup + cancel wiring   ~ 45 min
Step 10: Config + env updates                                    ~ 15 min
Step 11: index.js — main loop integration + mandatory sleeps     ~ 30 min
Step 12: Alerts + reporting updates                              ~ 30 min
Step 13: Test script (test-outreach.js)                          ~ 30 min
Step 14: Concurrent scenario testing (see §9)                    ~ 1 hr
                                                            ─────────────
                                                     TOTAL   ~ 10–11 hours
```

---

## 9. Testing Plan

### 9.1 Unit Tests (dry-run, no browser)

| Test | What it verifies |
|---|---|
| `generateOutreachDM()` returns valid text, 80–180 words, no markdown | AI prompt quality |
| `generateOutreachReply()` with "not interested" input → includes `[CANCEL_FOLLOWUPS]` | Cancellation detection |
| `generateOutreachReply()` with curious question → no cancel tag | Normal reply path |
| `generateOutreachFollowUp()` day 3/7/14 → correct tone, short | Follow-up text quality |
| `getRejectedLeadsForOutreach()` excludes niche-DMed, outreach-DMed, unknown usernames | DB query correctness |
| `cancelFollowUpsForConversation()` sets status to 'cancelled' for all pending | Cancellation SQL |

### 9.2 Concurrent Scenario Tests (CRITICAL)

These tests verify that niche and outreach never interfere with each other:

| Scenario | Expected behavior |
|---|---|
| **Same cycle has both a niche lead AND an outreach lead** | Niche comment+DM fires first → 3–8 min sleep → outreach DM fires. Never back-to-back. No crash, no double-send. |
| **Person gets niche DM, then their other post is picked up for outreach** | Outreach query sees `dm_sent = true` on other post AND `wasUserOutreachDMedRecently()` blocks → skipped |
| **Outreach DM sent, person replies "not interested"** | Inbox monitor routes to outreach reply prompt → reply sent → all follow-ups cancelled → no more messages ever |
| **Outreach DM sent, person replies with genuine interest** | Inbox monitor routes to outreach reply prompt → normal conversation → follow-ups paused (same as niche) |
| **Outreach follow-up fires for conversation where person already replied** | Follow-up engine sees `last_response_from = 'them'` → pauses follow-up (same logic as niche) |
| **Bot crashes after sending outreach DM but before DB update** | On restart, `outreach_dm_sent` is still false → bot tries again → `sendBHWConversation()` navigates to compose page → BUT fresh DB check catches it (same crash-recovery pattern as niche) |
| **Niche reply comes in while outreach reply is being processed** | Only one conversation is handled at a time (inbox-monitor processes sequentially) — no race condition |
| **Daily caps: 25 niche + 15 outreach = 40 total DMs from one account** | Both caps enforced independently. Worst case 40 DMs/day — acceptable for BHW if paced properly. |

### 9.3 Test Script (`test-outreach.js`)

```javascript
// 1. Generate an outreach DM for a mock rejected lead → print text
// 2. Generate an outreach reply for "not interested" → verify [CANCEL_FOLLOWUPS]
// 3. Generate an outreach reply for "tell me more" → verify no cancel tag
// 4. Generate outreach follow-ups for day 3, 7, 14 → print all 3
// 5. Query getRejectedLeadsForOutreach() → verify correct filtering
// 6. Dry-run processOutreachLeads({ dryRun: true }) → verify full pipeline
```

---

## 10. Risk Assessment (Comprehensive)

| Risk | Severity | Mitigation |
|---|---|---|
| **BHW account flagged for mass non-relevant DMs** | 🔴 HIGH | Cap at 15/day. 3–8 min between DMs. Short, genuine messages. Never pitch for their service. Acknowledge their post. Soft CTA only. |
| **Person reports outreach DM as spam** | 🔴 HIGH | Keep message ≤180 words. Non-pushy tone. Always acknowledge what they posted. If they say "not interested," cancel follow-ups immediately (no further contact). Graceful exit. |
| **Total DM volume too high (25 niche + 15 outreach = 40/day)** | 🟡 MEDIUM | Monitor BHW account health weekly. If warnings appear, reduce outreach cap first (it's the lower-value stream). Add `/outreach pause` command to kill switch remotely. |
| **Niche and outreach prompts get mixed (wrong context in reply)** | 🔴 HIGH | `conversations.is_outreach` flag is permanent and set at creation time. Every reply checks this flag. Tested in concurrent scenario tests (§9.2). |
| **Follow-ups keep sending after "not interested"** | 🔴 HIGH | `[CANCEL_FOLLOWUPS]` tag detected in AI reply → `cancelFollowUpsForConversation()` sets ALL pending to 'cancelled'. Follow-up engine query only fetches `status = 'pending'`. Double-guarded. |
| **Double DM: same person gets niche + outreach** | 🟡 MEDIUM | Query-level guard: `dm_sent = false` in outreach query. Plus `wasUserOutreachDMedRecently()` cross-thread dedup. |
| **Two DMs sent back-to-back with no gap** | 🟡 MEDIUM | Mandatory 3–8 min sleep between niche outreach and outreach module in main loop. 3–8 min sleep between individual outreach DMs. |
| **Outreach DM sleep causes next scrape cycle to overlap** | 🟠 LOW | Max 15 outreach DMs × 5 min avg = ~75 min. Scrape cycle is 10–20 min. Worst case delays next scrape by 1 cycle — acceptable. Bot is 24/7, no urgency. |
| **Low conversion rate (people don't need software)** | 🟠 LOW | Expected. This is a volume play / brand awareness. Even 1–2% reply rate is valuable. Track metrics to decide if cap should increase or decrease. |
| **Bot crash during outreach causes duplicate** | 🟡 MEDIUM | Same crash-recovery pattern as niche: fresh DB check before sending. If crash happens after BHW send but before DB write, the conversation exists on BHW but DB is stale → on restart, bot skips because of fresh check. |

---

## 11. Success Metrics

| Metric | How to track | Target |
|---|---|---|
| **Outreach DMs sent/day** | `activity_log` where `action_type = 'outreach_dm'` | 10–15 (near cap) |
| **Reply rate** | Outreach conversations with `their_message_count > 0` / total outreach convs | 5–15% (cold intro rate) |
| **Positive interest rate** | Outreach replies that led to real project discussion | 1–3% |
| **Cancellation rate** | Follow-ups cancelled via `[CANCEL_FOLLOWUPS]` / total outreach FUs | Track — high is expected and healthy |
| **Report/warning rate** | BHW account warnings or restrictions | 0 — any warning = reduce cap immediately |
| **Telegram conversion** | Outreach conversations that moved to Telegram | Track — any is a bonus |
