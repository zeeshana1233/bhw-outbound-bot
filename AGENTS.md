# AGENTS.md — Bitbash BHW Outbound Sales Bot

This file documents every agent (module, engine, service) in the system:
what it does, what it consumes, what it produces, and how it connects to everything else.

Use this as the single source of truth when adding new features, debugging,
or onboarding a new developer/AI session onto this project.

---

## System Overview

The bot operates on BlackHatWorld's "Hire a Freelancer" forum on behalf of
Bitbash Software Development Agency (owner: Zeeshan Ahmad, BHW account: `app_pilot`).

**Three independent pipelines:**

```
Pipeline A — Main (Reactive)
  BHW Forum → Scraper → AI Qualifier → Comment Engine → DM Engine
                                                        → Inbox Monitor → Conversation Engine
                                                        → Follow-Up System

Pipeline B — Outreach (Proactive)
  Pre-seeded target list → Threads Owner Outreach → Outreach Follow-Up → Outreach Inbox

Pipeline C — Hire-a-Freelancer job notifier (anonymous scrape → Discord)

Pipeline D — Niche Comment Scout
  After Hire-a-Freelancer scrape → What's New → today + non-marketplace
  → Relay chatgpt classify → Discord for sales (no bot commenting)
```

**Support layer:**
```
AI Engine  →  provides all text generation for pipelines A/B
Relay      →  chatgpt gateway for Pipeline D niche classification
Personas   →  inject the correct character voice per pipeline
bhwSession →  single authenticated Puppeteer browser shared by posting engines
alerts     →  Discord notifications for all events
commandCenter → Discord channel two-way control panel
botState   →  global pause/dryRun flags
database   →  PostgreSQL via pg Pool; queries.js is the only DB interface
```

---

## Entry Point

### `src/index.js`
**Role:** Orchestrator — starts all agents, wires the main loop.

**What it does:**
- Calls `initDatabase()` to run migrations on startup
- Initialises Discord bot (`initDiscord`)
- Starts `startCommandCenter()` (Discord channel control)
- Schedules `scheduleDailyReport()` (9 AM Discord summary)
- Starts `startHeartbeat()` (6-hour alive ping)
- Runs `startScraperAndOutreachLoop()` — unified scrape + outreach tick every 10–20 min
- Conditionally starts `startThreadsOwnerOutreach()` if `OUTREACH_ENABLED=true`
- Conditionally runs `runNicheScout()` after each Hire-a-Freelancer scrape if `NICHE_SCOUT_ENABLED=true`

**Currently commented out (re-enable after first conversion):**
- `startInboxMonitor()`
- `startFollowUpSystem()`
- `startCommunityCommenter()`
- `bhwSession.startHealthCheck()`

**Inputs:** `.env` config, DB connection
**Outputs:** All other agents running

---

## Pipeline A — Main (Reactive) Agents

### `src/scraper/index.js` — BHWScraper
**Role:** Discovery agent — finds new job posts on BHW forum.

**What it does:**
1. Launches a `puppeteer-real-browser` instance with Cloudflare Turnstile bypass
2. Visits BHW homepage (warmup) then the Hire-a-Freelancer forum listing
3. Extracts top 10 thread cards (title, URL, author, post date)
4. Batch-checks DB for already-seen thread IDs (single query)
5. For each NEW thread:
   - Visits the thread page to scrape the OP body + poster username
   - Creates a DB lead row (`createLead`)
   - Calls `aiEngine.qualifyLead()` to score it
   - Updates the lead with qualification result (`updateLeadQualification`)
6. Returns `{ threads, inspectedPosts, cloudflareBlocked, approved, rejected }`

**Inputs:** BHW forum URL, `puppeteer-real-browser`, AI Engine (qualifyLead)
**Outputs:** New rows in `leads` table; returns scrape result to orchestrator
**Called by:** `src/index.js` → `startScraperAndOutreachLoop()` every 10–20 min
**Key files:** `src/scraper/index.js`

---

### `src/engines/comment.js` — Comment Engine
**Role:** First touch — posts a public reply on the BHW thread.

**What it does:**
1. Calls `aiEngine.generateCommentPitch()` to create a tailored pitch comment
2. Uses the shared `bhwSession` Puppeteer page to:
   - Navigate to the thread URL
   - Simulate reading (scroll, delay)
   - Locate the Froala reply editor
   - Type the comment character-by-character with human delays + typo simulation
   - Submit the form
   - Verify the comment appeared on the page
3. Updates DB: `markLeadCommented(leadId, commentId)`
4. After posting, calls `checkAndReplyToInbox()` opportunistically (inbox is already open)

**Guards:**
- `lead.commented === true` check (in-memory)
- Fresh DB check via `getLeadById` (prevents race conditions)
- Live-page check: scans thread DOM for our username before posting

**Inputs:** DB lead row, `bhwSession` (authenticated), `aiEngine`
**Outputs:** Comment posted on BHW; `leads.commented=true` in DB
**Called by:** `src/index.js` → `processQualifiedLeads()`
**Exports:** `generateComment`, `postComment`, `generateAndPostComment`, `postToThread`

---

### `src/engines/dm.js` — DM Engine
**Role:** Second touch — sends a private message to the thread poster after commenting.

**What it does:**
1. Calls `aiEngine.generateDMOutreach()` to produce the initial DM
2. Guards against duplicate DMs (3 levels: in-memory, fresh DB check, `dm_sent` flag)
3. Uses `bhwSession` to navigate to `/conversations/add?to=USERNAME`
4. Types subject + body via `humanTypeInBrowser`, syncs Froala editor to hidden textarea
5. Submits and waits for the conversation URL redirect
6. Updates DB: `createConversation`, `createDM`, `markLeadDMSent`, schedules follow-ups
7. Post-send: calls `aiEngine.scoreLeadHotness()` — fires `sendHotLeadAlert` if score >= 8
8. Calls `aiEngine.detectUrgencyAI()` — fires `sendCallReminder` if urgent

**Follow-up scheduling (inline, day 2/3/5/7/12/21):**
- Generates all 6 follow-up messages immediately (context is fresh)
- Stores them in `follow_ups` table with scheduled timestamps + random jitter

**Inputs:** DB lead row, `bhwSession`, `aiEngine`, `alerts`
**Outputs:** DM sent on BHW; `leads.dm_sent=true`, `conversations` row, `dms` row, `follow_ups` rows
**Called by:** `src/index.js` → `processQualifiedLeads()`
**Exports:** `generateDM`, `sendDM`, `generateAndSendDM`

---

### `src/engines/inbox-monitor.js` — Inbox Monitor
**Role:** Reply agent — checks BHW DM inbox and responds to unread messages.

**What it does:**
1. Navigates to `https://www.blackhatworld.com/conversations/`
2. Scrapes the conversation list for unread items
3. For each unread conversation:
   - Looks up the lead by `poster_username` in DB
   - Skips if `is_handed_off = true` (Zeeshan is handling it)
   - Calls `handleConversation()` to generate + send a reply
   - Pauses follow-ups for that conversation (`pauseFollowUpsForConversation`)
   - Logs activity

**Trigger modes:**
- **Loop mode:** runs every 1–2 hours (randomised) via `startInboxMonitor()`
- **Opportunistic mode:** called by Comment Engine after every live post

**Inputs:** `bhwSession`, DB (leads, conversations), Conversation Engine
**Outputs:** Replies sent on BHW; `dms` rows; follow-ups paused
**Called by:** `src/index.js` (`startInboxMonitor`) + `comment.js` (opportunistic)
**Status:** Currently disabled — uncomment `startInboxMonitor()` in `index.js`
**Exports:** `checkAndReplyToInbox`, `startInboxMonitor`

---

### `src/engines/conversation.js` — Conversation Engine
**Role:** Reply brain — reads a BHW conversation thread and generates the next reply.

**What it does:**
1. Navigates to the BHW conversation URL
2. Scrapes all messages in the thread (direction, text, username)
3. Checks if the last message is already ours (skip if so)
4. Calls `aiEngine.generateDMReply()` with full conversation history
5. Detects `[HANDOFF]` tag in the AI reply → fires `sendHandoffAlert` + marks conversation
6. Detects lead CTA redirect (reply mentions @bitbashagency Telegram handle) → fires `sendLeadCTAAlert`
7. Detects urgency → fires `sendCallReminder`
8. Sends the reply via `sendConversationReply()`
9. Updates DB: `createDM`, `incrementConversationMessages`, `updateLeadStatus`

**Inputs:** BHW conversation URL, lead DB row, conversation DB row, `bhwSession`, `aiEngine`
**Outputs:** Reply posted on BHW; DB updated; Discord alerts fired as needed
**Called by:** Inbox Monitor, Follow-Up System
**Exports:** `handleConversation`, `sendConversationReply`

---

### `src/engines/follow-up.js` — Follow-Up System
**Role:** Persistence agent — sends pre-written follow-ups to cold leads.

**What it does:**
1. Runs every 30–90 min (randomised) via `startFollowUpSystem()`
2. Fetches all DUE pending follow-ups from DB (`getPendingFollowUpsWithContext`)
3. Decision tree per follow-up:
   - `last_response_from = 'them'` → pause entire sequence (they're in dialogue)
   - `last_response_from = 'us'` → send the pre-written message via `sendConversationReply`
4. Fetches PAUSED follow-ups that went cold again (`getResumableFollowUps`)
   - Cold = `last_response_from='us'` + silent 3+ days
   - Reschedules 1–6 hours from now

**Inputs:** `follow_ups` table, `bhwSession`, Conversation Engine
**Outputs:** Follow-ups sent on BHW; `follow_ups.status='sent'`
**Called by:** `src/index.js` (`startFollowUpSystem`)
**Status:** Currently disabled — uncomment `startFollowUpSystem()` in `index.js`
**Exports:** `processFollowUps`, `startFollowUpSystem`

---

### `src/engines/community-commenter.js` — Community Commenter
**Role:** Reputation agent — posts helpful organic replies on BHW discussion threads (no sales pitch).

**What it does:**
1. Scans BHW sub-forums for relevant discussion threads
2. Calls `aiEngine.classifyThreadRelevance()` to score relevance (0–10)
3. If score >= 6: calls `aiEngine.generateCommunityComment()` with knowledge-base tips
4. Posts the comment via `postToThread()` (comment engine)
5. Tracks in `community_comments` table to avoid double-posting

**Policy:** Zero promotion — no Bitbash name, no contact info, no DM nudges.
           Pure value contribution for account reputation.

**Inputs:** BHW forum sub-URLs, `aiEngine`, `knowledge-base.json`, `bhwSession`
**Outputs:** Organic comments on BHW; `community_comments` rows
**Called by:** `src/index.js` (`startCommunityCommenter`) — currently disabled
**Exports:** `startCommunityCommenter`

---

## Pipeline B — Outreach (Proactive) Agents

### `src/engines/threads-owner-outreach.js` — Threads Owner Outreach
**Role:** Proactive outreach agent — DMs a pre-seeded list of BHW thread owners who haven't been contacted yet.

**What it does:**
1. Activates during the 16-hour window: 15:00–07:00 UTC (±30-min jitter)
2. Picks up to 5 pending targets FIFO from `outreach_targets` table
3. Scatters send-times randomly across the window (min 90-min gap, max 4-hour gap)
4. For each target at its scheduled time:
   - Duplicate guard: skip if main pipeline or another outreach row already DM'd this user
   - Scrapes the BHW thread (poster username + OP body)
   - Calls `aiEngine.generateThreadsOwnerOutreachDMAndFollowUps()` — one API call generates the DM + 3 follow-ups
   - Sends the DM via `sendOutreachDM()` (uses shared `bhwSession`)
   - Creates `outreach_conversations` row, `outreach_dms` row
   - Marks target as `dm_sent`
   - Schedules 3 follow-ups in `outreach_follow_ups` (day 3, 7, 14)
   - Sends Discord preview/alert
   - After every DM: runs `checkOutreachInbox` + `runOutreachFollowUps(limit=1)`
5. After full batch: final `runOutreachFollowUps` sweep
6. Sleeps until next daily window

**Persona:** Uses `outreachPersona.js` (Zeeshan as independent Top Rated Plus Upwork dev)
**Controlled by:** `OUTREACH_ENABLED=true` in `.env`
**Inputs:** `outreach_targets` table, `bhwSession`, `aiEngine`, `alerts`
**Outputs:** DMs sent on BHW; `outreach_targets`, `outreach_conversations`, `outreach_dms`, `outreach_follow_ups` rows
**Called by:** `src/index.js` (`startThreadsOwnerOutreach`)
**Exports:** `startThreadsOwnerOutreach`

---

### `src/engines/outreach-follow-up.js` — Outreach Follow-Up Runner
**Role:** Follow-up executor for Pipeline B targets.

**What it does:**
1. Fetches due pending follow-ups from `outreach_follow_ups` via `getDueOutreachFollowUps()`
2. For each due follow-up:
   - Skips if `last_response_from = 'them'` (cancel all follow-ups for this target)
   - Sends the pre-written follow-up text via `bhwSession`
   - Updates `outreach_follow_ups.status='sent'`
3. Checks for cold targets (all 3 follow-ups sent, no reply, 7 days since last) → `markOutreachTargetCold`

**Inputs:** `outreach_follow_ups` table, `bhwSession`
**Outputs:** Follow-ups sent; DB status updates
**Called by:** `threads-owner-outreach.js` (after each DM + final sweep)
**Exports:** `runOutreachFollowUps`

---

### `src/engines/outreach-inbox.js` — Outreach Inbox Checker
**Role:** Reply handler for Pipeline B — reads replies from outreach targets.

**What it does:**
1. Navigates to BHW conversations
2. Finds conversations from outreach targets that have unread messages
3. Matches by `poster_username` to `outreach_targets` table
4. Generates a contextual reply via `aiEngine.generateThreadsOwnerOutreachReply()`
5. Sends the reply
6. Updates `outreach_conversations` + `outreach_targets` status
7. Cancels pending follow-ups for targets who replied (`cancelOutreachFollowUps`)

**Inputs:** `bhwSession`, `outreach_targets`, `outreach_conversations`, `aiEngine`
**Outputs:** Replies sent; DB status updates; follow-ups cancelled
**Called by:** `threads-owner-outreach.js` (after each DM)
**Exports:** `checkOutreachInbox`

---

## Pipeline D — Niche Comment Scout

### `src/engines/niche-scout.js` — Niche Comment Scout
**Role:** Find today's non-marketplace BHW discussion posts and classify them for sales so humans can comment (signature / reputation). The bot never posts comments.

**What it does:**
1. Runs immediately after each successful Hire-a-Freelancer scrape tick (`NICHE_SCOUT_ENABLED=true`)
2. Scrapes What's New listing (`NICHE_SCOUT_WHATS_NEW_URL`, default `/whats-new/posts/`) via anonymous `BHWScraper` browser
3. Keeps posts dated today only; drops URLs containing `/marketplace/`
4. Dedups against `niche_scout_posts.thread_id`
5. Fetches OP title + body (capped by `NICHE_SCOUT_MAX_PER_RUN`)
6. Classifies via Relay `chatgpt` using [`src/prompts/nicheScoutPrompt.js`](src/prompts/nicheScoutPrompt.js) (user-supplied niches/prompt)
7. Inserts rows; Discord-notifies `fit` / `maybe` to `NICHE_SCOUT_CHANNEL_ID`

**Inputs:** What's New URL, anonymous scraper, Relay API, niche scout prompt file  
**Outputs:** `niche_scout_posts` rows; Discord niche/angle cards  
**Called by:** `src/index.js` → `startScraperAndOutreachLoop()` after Hire-a-Freelancer scrape  
**Exports:** `runNicheScout`

### `src/services/relayClient.js` — Relay Client
**Role:** Thin Node HTTP client for the Bitbash Relay AI gateway (`submit` / poll / `get_result` / `run`).

### `src/prompts/nicheScoutPrompt.js` — Niche Scout Prompt
**Role:** System prompt placeholder + `buildNicheScoutFullPrompt(posts)`. Replace `NICHE_SCOUT_SYSTEM_PROMPT` with the real niches prompt when ready.

---

## AI Engine

### `src/services/aiEngine.js` — AI Engine
**Role:** Brain — all text generation and classification for both pipelines.

**Core infrastructure:**
- `callAI(systemPrompt, userPrompt, options)` — OpenAI `gpt-4o-mini` with 3-attempt retry, token logging to `ai_logs` table, JSON fence stripping

**Functions (13 total):**

| Function | Purpose | Used by |
|---|---|---|
| `qualifyLead(title, desc)` | Score a BHW post 0–1; returns `{qualified, confidence, tier, reason, pitch_angle}` | Scraper |
| `generateCommentPitch(title, desc, pitchAngle, username)` | Public forum comment | Comment Engine |
| `generateDMOutreach(title, desc, username, pitchAngle)` | Initial outreach DM | DM Engine |
| `generateDMReply(history, latestMsg, msgCount)` | Reply to a BHW DM | Conversation Engine |
| `generateFollowUp(title, desc, days, prevMsgs)` | Follow-up text (tone shifts by day) | DM Engine (scheduling) |
| `detectUrgencyAI(text)` | Two-stage keyword + AI urgency detector | DM Engine, Conversation Engine |
| `scoreLeadHotness(title, desc, history)` | 1–10 hotness score for Discord alert threshold | DM Engine |
| `classifyThreadRelevance(title, snippet)` | Community thread relevance classifier | Community Commenter |
| `generateCommunityComment(title, snippet, tips, category)` | Organic forum reply (no promo) | Community Commenter |
| `generateThreadsOwnerOutreachDMAndFollowUps(title, desc, username)` | All 4 messages in one API call for Pipeline B | Threads Owner Outreach |
| `generateThreadsOwnerOutreachReply(title, desc, history)` | Contextual reply for Pipeline B | Outreach Inbox |
| `callAI(system, user, opts)` | Raw AI call — internal use only | (AI Engine internal) |

**Personas injected:**
- Pipeline A functions → `zeePersona.buildSystemPrompt()` (Bitbash agency voice)
- Pipeline B functions → `outreachPersona.buildOutreachSystemPrompt()` (independent dev voice)

**Inputs:** OpenAI API, persona files
**Outputs:** Generated text strings or parsed JSON objects

---

## Persona Files

### `src/services/zeePersona.js` — Zee Persona (Pipeline A)
**Role:** Voice definition for the main pipeline.

Defines Zeeshan / Bitbash identity:
- UK-registered software agency, 8+ years, 200+ projects
- Telegram: `@bitbashagency`
- Services: bots, scrapers, automation, web/mobile apps, SaaS
- Tone: professional but human, never corporate

**Exports:** `buildSystemPrompt(functionInstructions)`, `ZEE_SYSTEM_PROMPT`

---

### `src/services/outreachPersona.js` — Outreach Persona (Pipeline B)
**Role:** Voice definition for the Threads Owner Outreach module.

Defines Zeeshan as independent freelance developer:
- Upwork Top Rated Plus, $150k+ earned, 5-star reviews
- Telegram: `@@devpilot1`
- 8+ years experience, specialises in automation, bots, SaaS
- Tone: peer-to-peer developer, no agency framing

**Exports:** `buildOutreachSystemPrompt(functionInstructions)`

---

## Session & Browser

### `src/utils/bhwSession.js` — BHW Session Singleton
**Role:** Authenticated browser session — shared by all engines that post to BHW.

**What it does:**
- Maintains a single Puppeteer browser instance authenticated as `app_pilot`
- Loads session cookies from `bhw-cookies.json`
- `ensureAuthenticated()` — checks cookie validity, re-authenticates if needed
- `navigateTo(url)` — navigation with retry + Cloudflare bypass
- `startHealthCheck()` — periodic cookie validity check, fires `sendSessionExpiredAlert` if down
- `isSessionDown()` / `getPage()` / `getUsername()` — accessors

**Why singleton:** All engines (comment, DM, inbox, follow-up, outreach) share one browser window. Prevents multiple simultaneous BHW logins from the same IP, which would trigger security flags.

**Inputs:** `bhw-cookies.json`, `.env` (BHW_USERNAME)
**Outputs:** Authenticated `page` object used by all posting engines

---

## Notifications & Control

### `src/services/alerts.js` — Alerts Service
**Role:** Discord notification dispatcher — sends all bot events to Zeeshan's Discord channel.

**Alert types:**

| Function | Trigger |
|---|---|
| `sendRawAlert(text)` | Generic — used for scrape results, outreach previews, heartbeat |
| `sendHandoffAlert(username, url, messages, reason)` | Conversation flagged for Zeeshan |
| `sendLeadCTAAlert(username, url, lead, messages, reply)` | Lead directed to Telegram sales handle (@bitbashagency) — alerts Zeeshan to expect an inbound message |
| `sendSessionExpiredAlert()` | BHW cookies expired |
| `sendHotLeadAlert(lead, dmText)` | Lead hotness score >= 8 |
| `sendCallReminder(username, url, urgentLine, context)` | Urgency detected |
| `sendDailyReport(stats)` | 9 AM daily summary |
| `sendPipelineCJobAlert(...)` | Pipeline C today-job card → `PIPELINE_C_CHANNEL_ID` |
| `sendNicheScoutAlert(...)` | Pipeline D niche + angle card → `NICHE_SCOUT_CHANNEL_ID` |

**Transport:** `sendToChannel()` / `sendToChannelById()` from `discordClient.js` (discord.js v14)

---

### `src/services/commandCenter.js` — Command Center
**Role:** Two-way Discord control panel — listens for slash commands in the Discord channel.

**Available commands:**

| Command | Handler |
|---|---|
| `/status` | Full system snapshot (session, pause, mode, today's stats) |
| `/stats` | Today's numbers |
| `/leads` | Lead funnel (scraped → qualified → commented → DM'd → replied → converted) |
| `/handoffs` | Conversations waiting for Zeeshan |
| `/convos` | Active conversation counts |
| `/followups` | Pending follow-up count + next due |
| `/session` | BHW cookie health |
| `/pause` / `/resume` | Freeze/unfreeze all engines |
| `/dryrun on/off` | Toggle safe/live mode |
| `/forcereport` | Send daily report immediately |
| `/community` | Community comment stats |
| `/convert <user>` | Mark lead as converted |
| `/skip <user>` | Disqualify a lead |
| `/pausefollowup <user>` | Stop chasing a specific lead |
| `/help` | Command list |

Native Discord slash commands — registered via REST API on startup using `SlashCommandBuilder`.

**Inputs:** Discord interactions, DB queries, `botState`, `bhwSession`
**Outputs:** Discord ephemeral replies; DB mutations (convert, skip, pause follow-ups)

---

### `src/services/discordClient.js` — Discord Client
**Role:** Shared discord.js v14 singleton used by alerts and command center.

- No session file, no QR scan — stateless bot token auth
- `initDiscord()` — starts Discord client via WebSocket gateway
- `sendToChannel(text)` — sends message (Discord Markdown) to the configured channel; auto-splits at 2000-char limit
- `onMessage(handler)` — registers message listener (used by command center)
- `getClient()` — returns the `Client` instance
- `isReady()` / `getChannelId()` / `getBotId()` — state accessors
- `registerSlashCommands(commands, guildId?)` — registers slash commands via REST API; guild-scoped (instant) if `guildId` provided, global (up to 1h) otherwise
- `normalizeMarkdown(text)` — converts legacy `*bold*` (single asterisk) → `**bold**` (double asterisk) for Discord rendering

---

## State & Utilities

### `src/utils/botState.js` — Bot State Singleton
**Role:** Global runtime flags shared across all engines.

**State:**
- `_paused` — when true, all engine tick loops skip their work
- `_dryRun` — when true, comment/DM engines print but do not send
- `_pausedReason` / `_pausedAt` — for status reporting

**Methods:** `isPaused()`, `isDryRun()`, `pause(reason)`, `resume()`, `setDryRun(val)`, `summary()`

**Gap (GAP-10):** State is in-memory only — lost on service restart.
Service restart always begins in running mode regardless of whether it was paused.

---

### `src/utils/helpers.js` — Helpers
**Role:** Shared utility functions used across engines.

| Function | Purpose |
|---|---|
| `sleep(ms)` | Promise-based delay |
| `randomDelay(min, max)` | Random int between min and max (ms or count) |
| `shouldSendDM(ageCategory)` | Returns true only for 'fresh' threads |
| `isActiveHours()` | Time-of-day gate (not used — GAP-04 won't-do) |
| `extractThreadId(url)` | Extracts numeric thread ID from a BHW URL |
| `sanitizeText(text)` | Strips unsafe Unicode characters |
| `getThreadAgeCategory(date)` | Returns 'fresh' / 'old' / 'ancient' based on post date |

---

### `src/utils/logger.js` — Logger
**Role:** Winston logger with console + file transports.

Log files: `logs/combined.log`, `logs/error.log`
Level: `info` in production, `debug` if `LOG_LEVEL=debug`

---

## Database Layer

### `src/database/init.js` — DB Init + Migrations
**Role:** DB connection pool + idempotent migration runner.

- Creates `pg.Pool` from `config.database`
- `initDatabase()` runs all `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` and `CREATE TABLE IF NOT EXISTS` migrations on startup
- `query(text, params)` — thin wrapper with query timing log
- `getClient()` — for transactions (rarely used)

**Tables created/migrated:**
`leads`, `dms`, `conversations`, `follow_ups`, `activity_log`,
`niche_keywords`, `ai_logs`, `community_comments`,
`outreach_targets`, `outreach_conversations`, `outreach_dms`, `outreach_follow_ups`,
`niche_scout_posts`

---

### `src/database/queries.js` — Query Functions
**Role:** Single DB interface — all SQL lives here. No raw queries anywhere else.

**Query groups:**

| Group | Key functions |
|---|---|
| Leads | `createLead`, `updateLeadQualification`, `getQualifiedLeadsToContact`, `markLeadCommented`, `markLeadDMSent`, `getExistingThreadIds` |
| DMs | `createDM`, `getDMsByConversation` |
| Conversations | `createConversation`, `updateConversationStatus`, `markConversationHandedOff`, `getHandedOffConversations` |
| Follow-ups | `scheduleFollowUp`, `getPendingFollowUpsWithContext`, `getResumableFollowUps`, `pauseFollowUpsForConversation`, `rescheduleFollowUp`, `markFollowUpSent` |
| Activity Log | `logActivity` |
| Stats | `getDailyStats`, `getDailyActionCounts`, `getLeadsFunnelStats`, `getActiveConversationsStats`, `getPendingFollowUpsStats`, `getAIStats` |
| Operator | `disqualifyLead`, `convertLead`, `pauseFollowUpsForUsername` |
| Outreach targets | `getPendingOutreachTargets`, `markOutreachTargetDMSent`, `skipOutreachTarget`, `getOutreachProgress` |
| Outreach convos | `createOutreachConversation`, `updateOutreachConversationUrl`, `updateOutreachConversationStatus` |
| Outreach DMs | `createOutreachDM`, `getOutreachDMsByConversation` |
| Outreach follow-ups | `createOutreachFollowUps`, `getDueOutreachFollowUps`, `markOutreachFollowUpSent`, `cancelOutreachFollowUps`, `getOutreachColdTargets` |
| Niche Scout (D) | `getExistingNicheScoutThreadIds`, `createNicheScoutPost`, `markNicheScoutDiscordSent`, `getPendingNicheScoutDiscordSends` |

---

## Configuration

### `src/config/config.js` — Centralised Config
**Role:** Single source of all runtime configuration from `.env`.

Key config groups:
- `config.database` — PostgreSQL connection
- `config.openai` — model, API key, log prompts
- `config.bhw` — username, scrape intervals, base URL
- `config.bot` — typing speeds, daily caps, follow-up days
- `config.discord` — bot token, channel ID, guild ID, pipelineCChannelId, nicheScoutChannelId
- `config.outreach` — OUTREACH_ENABLED, daily cap, active window, follow-up days
- `config.nicheScout` — NICHE_SCOUT_ENABLED, whatsNewUrl, maxPerRun
- `config.relay` — RELAY_API_KEY, RELAY_BASE_URL, RELAY_SERVICE_ID (chatgpt)

---

## Data Files

### `src/data/knowledge-base.json`
Structured tips per category (web_scraping, automation, wordpress, etc.)
Used by Community Commenter to inject relevant examples into `generateCommunityComment()`.

### `bhw-cookies.json`
Active BHW session cookies (gitignored). Refreshed by running `node save-cookies.js` on the server.

### `targets.csv`
Source CSV for the Threads Owner Outreach target list.
Imported once via `node scripts/seed-outreach-targets.js targets.csv`.

---

## Agent Interaction Map

```
index.js (orchestrator)
  │
  ├─► BHWScraper ─────────────────► aiEngine.qualifyLead
  │       └── new qualified leads
  │
  ├─► processQualifiedLeads()
  │       ├─► Comment Engine ──────► aiEngine.generateCommentPitch
  │       │       └── opportunistic ► Inbox Monitor
  │       │
  │       └─► DM Engine ───────────► aiEngine.generateDMOutreach
  │                                ► aiEngine.scoreLeadHotness
  │                                ► aiEngine.detectUrgencyAI
  │                                ► aiEngine.generateFollowUp (x6)
  │
  ├─► Inbox Monitor (disabled) ────► Conversation Engine
  │       └─► handleConversation ──► aiEngine.generateDMReply
  │                                ► alerts (handoff, telegram, urgency)
  │
  ├─► Follow-Up System (disabled) ─► Conversation Engine (sendConversationReply)
  │
  ├─► Threads Owner Outreach ──────► aiEngine.generateThreadsOwnerOutreachDMAndFollowUps
  │       ├─► Outreach Follow-Up
  │       └─► Outreach Inbox ──────► aiEngine.generateThreadsOwnerOutreachReply
  │
  ├─► Niche Scout (Pipeline D) ────► relayClient.run (chatgpt)
  │                                ► alerts.sendNicheScoutAlert
  │
  ├─► Command Center ──────────────► botState (pause/resume/dryRun)
  │                                ► DB queries (convert, skip, stats)
  │
  ├─► alerts (Discord) ────────────► discordClient.sendToChannel / sendToChannelById
  │
  └─► botState ────────────────────► all engines check isPaused() each tick
```

---

## Known Gaps

### Pending

| Gap | File(s) | Description |
|---|---|---|
| GAP-05 | `aiEngine.js`, `queries.js` | DB column is `niche_match_score INTEGER`; AI returns `confidence FLOAT 0–1`. Migration needed. |
| GAP-06 | `scraper/index.js`, `queries.js`, `commandCenter.js` | Leads with confidence 0.40–0.69 (tier='maybe') treated same as auto. Need manual review queue. |
| GAP-10 | `utils/botState.js`, `database/init.js`, `queries.js` | `botState` pause is in-memory — lost on service restart. Should persist to a `bot_state` DB table. |
| GAP-11 | `database/queries.js`, `services/alerts.js` | `sendDailyReport()` sends stats via Discord but never writes them to the `daily_reports` table. |

### Resolved

| Gap | File(s) | Resolution |
|---|---|---|
| ~~GAP-07~~ | `queries.js`, `engines/dm.js` | ✅ `wasUserDMedRecently(username, 30)` added to `queries.js` (checks both Pipeline A `leads` + Pipeline B `outreach_targets`); guard wired into `sendDM()` in `dm.js`. |

---

## Deployment

**Production server:** Ubuntu 24.04 VPS at `161.97.118.235`
**Access:** SSH as `root`
**Process manager:** PM2 (`bhw-bot` process), config at `deploy/ecosystem.config.cjs`
**Bot path:** `/root/bhw-bot/`
**Logs:** `/root/bhw-bot/logs/` + `pm2 logs bhw-bot`

**Server environment (as of 2026-04-09):**
- OS: Ubuntu 24.04 (kernel 6.8.0-106-generic)
- Node.js: v22.22.2
- npm: 10.9.7
- PM2: 6.0.14
- PostgreSQL: 16.13
- Chromium: `/usr/bin/chromium-browser`
- Xvfb: `/usr/bin/Xvfb` (virtual display for headless Puppeteer)

**Database:**
- Host: `localhost:5432`
- Database: `bhw_bot`
- User: `bhwbot`
- Password: stored in `/root/bhw-bot/.env` on server

**GitHub repo:** `https://github.com/zeeshana1233/bhw-outbound-bot.git`

**Deploy flow — push code updates:**
```bash
ssh root@161.97.118.235
cd /root/bhw-bot
git pull origin main
npm install --omit=dev
pm2 restart bhw-bot --update-env
pm2 save
```

**Or use the deploy script (from the server):**
```bash
bash /root/bhw-bot/deploy/deploy.sh --update
```

**SCP a single file from local machine:**
```bash
scp src/some/file.js root@161.97.118.235:/root/bhw-bot/src/some/file.js
pm2 restart bhw-bot --update-env   # then SSH and restart
```

**Useful PM2 commands (run on server):**
```bash
pm2 status                         # process status
pm2 logs bhw-bot                   # tail live logs
pm2 logs bhw-bot --lines 50 --nostream   # last 50 lines
pm2 restart bhw-bot --update-env   # restart with fresh .env
pm2 stop bhw-bot                   # stop
pm2 save                           # persist process list across reboots
```

**To enable Threads Owner Outreach on production:**
Set `OUTREACH_ENABLED=true` in `/root/bhw-bot/.env` on the server and restart:
```bash
pm2 restart bhw-bot --update-env
```

**To enable Inbox Monitor + Follow-Up System:**
Uncomment the three lines in `src/index.js`:
```js
startInboxMonitor({ dryRun: DRY_RUN });
startFollowUpSystem({ dryRun: DRY_RUN });
```

**Known DB fix applied on 2026-04-09:**
The `activity_log` table was missing `action_type` and `metadata` columns (schema predated `queries.js`).
Fixed by running migrations directly and adding to `src/database/init.js`:
```sql
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS action_type VARCHAR(100);
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS metadata JSONB;
```
These are now part of `initDatabase()` and will auto-run on any fresh deploy.

---

## OpenCode Agent Routing

This project uses specialised OpenCode agents in `.opencode/agents/`. Each agent has deep context for its domain. **Never ask the user which agent to use — auto-route based on the keyword table below.**

### Keyword → Agent Routing Table

| Keywords / Topic | Agent file |
|---|---|
| scraper, Cloudflare, puppeteer, bhwSession, cookies, session, `save-cookies`, forum scrape | `scraper-dev.md` |
| comment engine, DM engine, inbox monitor, follow-up, conversation engine, community commenter, Pipeline A, `src/index.js` | `pipeline-a-dev.md` |
| threads owner outreach, outreach follow-up, outreach inbox, Pipeline B, `outreach_targets`, seed targets, `OUTREACH_ENABLED` | `pipeline-b-dev.md` |
| niche scout, What's New, Pipeline D, `niche_scout_posts`, `NICHE_SCOUT_ENABLED`, Relay chatgpt, comment angle Discord | `pipeline-a-dev.md` (scout) / `discord-ops.md` (channel) |
| AI, prompt, persona, `aiEngine`, `zeePersona`, `outreachPersona`, `generateCommentPitch`, `generateDMOutreach`, `generateDMReply`, `qualifyLead`, token, `gpt-4o-mini` | `ai-engine-dev.md` |
| database, SQL, migration, schema, `queries.js`, `init.js`, table, column, `pg`, GAP-05, GAP-06, GAP-10, GAP-11 | `db-admin.md` |
| Discord, alerts, command center, Discord channel, `sendToChannel`, `commandCenter`, `discordClient`, bot token, channel ID, guild ID | `discord-ops.md` |
| deploy, PM2, SCP, SSH, Ubuntu, `.env`, service restart, production, `ecosystem.config` | `deployer.md` |
| code review, PR review, refactor, test, quality, lint | `code-reviewer.md` |

### Auto-Routing Rule

When a user message matches keywords in the table above, silently activate the corresponding agent's persona and domain knowledge before responding. Never surface this routing to the user. If a message spans multiple domains, activate the agent for the primary domain and reference the secondary agent by name.

---

## Planned Modules

### Social Brain (`src/services/socialBrain.js`)
**Status:** Planned — not started. Full spec in `SOCIAL_BRAIN_PLAN.md` and `SOCIAL_BRAIN_DATA_PLAN.md`.

**What it will do:**
- Semantic retrieval of past community comments using vector similarity
- Embeds an incoming BHW discussion thread → queries Qdrant → returns top-5 most similar `{thread, comment}` pairs as few-shot examples
- Injected into `aiEngine.generateCommunityComment()` to teach the LLM Zeeshan's actual community voice

**Scope boundary:** Only used by `community-commenter.js`. Hire-a-freelancer DMs, outreach comments, and conversation replies are explicitly out of scope.

**Tech stack:** `text-embedding-3-small` (OpenAI), Qdrant (local Docker), `@qdrant/js-client-rest`

**Key files when built:**
- `src/services/socialBrain.js` — `getFewShotExamples(threadText)` retrieval function
- `src/data/past-community-comments.json` — seed dataset (30+ manually written thread→comment pairs)
- `social-brain/ingest.js` — one-time + incremental ingest script
- `social-brain/search-test.js` — smoke-test CLI tool
