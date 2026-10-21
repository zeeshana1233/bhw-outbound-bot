# Want to Buy (WTB) Outreach Module Plan

## 1. Objective
- Expand our outbound sales engine to BlackHatWorld's **"Want to Buy" (WTB)** forum:
  `https://www.blackhatworld.com/forums/want-to-buy.92/`
- **Today-Only Filter:** Strictly processes posts created **TODAY** (same as Hire-a-Freelancer `PIPELINE_A_TODAY_ONLY`). Old or multi-day backlog posts are ignored.
- **Zero Qualification Gate:** In WTB, every post is someone explicitly asking to purchase a service or product. No AI qualification filter is needed; all new posts from today are accepted directly.
- **Distinct Discord Tagging:** Every WTB alert displays a bold **`🏷️ [WTB]`** tag right at the top so the team immediately knows it's from Want to Buy and not Hire a Freelancer (HAF).
- **Dedicated Controls in `.env`:**
  - `WTB_DRY_RUN=true/false` to test messages in Discord before sending real DMs on BHW.
  - `WTB_COMMENTS_ENABLED=true/false` to keep commenting completely paused (or toggle independently).
- **Unified Infrastructure:** Reuses the existing authenticated Puppeteer session (`bhwSession`), database tables (`leads` table with `'wtb'` tag), follow-up system, and Discord client reply engine.

---

## 2. Architecture: Two Parallel Loops (Code-Accurate)

The bot runs **two completely independent timer loops** in parallel:

```
┌────────────────────────────────────────────────────────────────────────┐
│ LOOP 1: Main Scraper & Outreach Loop (Every 20–40 min)                 │
│         `startScraperAndOutreachLoop()` in src/index.js                │
├────────────────────────────────────────────────────────────────────────┤
│ 1. HAF Scrape (Hire-a-Freelancer)                                      │
│    • Scrapes Page 1                                                    │
│    • Filters today's jobs & AI qualifies                               │
│    • Sends 1 initial DM (if not dry run)                               │
│                                                                        │
│ 2. WTB Scrape (Want-to-Buy - New Module)                               │
│    • Scrapes Page 1 of want-to-buy.92/                                 │
│    • Filters today's posts (skips AI qualification)                    │
│    • If WTB_DRY_RUN=true  ──▶ Previews Message 1 & 2 in Discord [WTB]  │
│    • If WTB_DRY_RUN=false ──▶ Sends 1 initial DM & schedules Follow-Up │
│                                                                        │
│ 3. BHW Inbox Check (Client Replies)                                    │
│    • Visits BHW conversations                                          │
│    • Checks for unread client messages from both HAF & WTB clients      │
│    • If client replied    ──▶ Immediately pauses their follow-up in DB │
│    • Forwards client reply to #bhw-client-inbox with real username     │
│                                                                        │
│ 4. Niche Comment Scout (Pipeline D)                                    │
│    • Scans "What's New" discussion threads for manual sales commenting │
│                                                                        │
│ 5. Sleep & Randomize (20–40 min), then repeats Loop 1                  │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│ LOOP 2: Follow-Up System Loop (Every 30–90 min)                        │
│         `startFollowUpSystem()` in src/engines/follow-up.js            │
├────────────────────────────────────────────────────────────────────────┤
│ Runs on its own independent background clock:                          │
│ 1. Queries DB for due follow-ups:                                      │
│    `WHERE status = 'pending' AND scheduled_for <= NOW()`               │
│ 2. For each due lead (HAF and live WTB):                               │
│    • Opens their BHW conversation link.                                │
│    • Safety Guard: Checks if client replied.                           │
│        - If YES: Aborts follow-up, marks status='paused'               │
│        - If NO:  Types and sends Follow-up Message 2, status='sent'    │
│ 3. Checks for resumable cold leads (silent 3+ days).                   │
│ 4. Sleep & Randomize (30–90 min), then repeats Loop 2                  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Environment Variables (`.env`)

```env
# ── WTB Module Configuration ──────────────────────────────────
WTB_ENABLED=true                     # Master switch for Want to Buy pipeline
WTB_DRY_RUN=true                     # true = previews DMs in Discord without sending on BHW
WTB_TODAY_ONLY=true                  # true = only process threads posted TODAY
WTB_COMMENTS_ENABLED=false           # false = public commenting paused; true = comments on WTB threads
WTB_DAILY_DM_CAP=15                  # Daily safety limit for WTB outreach
WTB_MAX_PER_RUN=1                    # Send 1 DM per scrape run for human anti-bot pacing
WTB_URL=https://www.blackhatworld.com/forums/want-to-buy.92/
```

---

## 4. Dry Run vs. Live Behavior for WTB

| Feature | `WTB_DRY_RUN=true` (Safe / Preview Mode) | `WTB_DRY_RUN=false` (🔴 LIVE) |
|---|---|---|
| **BHW Thread Scraped** | Yes (Page 1, today's posts) | Yes (Page 1, today's posts) |
| **Saved to Database** | Yes (`leads` table with tag `['wtb']`) | Yes (`leads` table with tag `['wtb']`) |
| **Initial DM on BHW** | **NO** (Skipped) | **YES** (Sent via Puppeteer `bhwSession`) |
| **Follow-Up in DB** | **NO** (Not inserted; no real conversation) | **YES** (Scheduled in `follow_ups` for 1–3 days) |
| **Discord Card** | 🏷️ `[WTB] Outreach DM Preview [DRY RUN]` (Msg 1 + Msg 2) | 🎯 `[WTB] Outreach DM Sent!` |
| **Comment on Thread** | Controlled by `WTB_COMMENTS_ENABLED` (default: false) | Controlled by `WTB_COMMENTS_ENABLED` (default: false) |

---

## 5. Discord Card Formats (Clear `[WTB]` vs `[HAF]` Distinction)

### A. WTB Outreach DM Preview Card (DRY RUN)
Sent to `DISCORD_DM_ALERTS_CHANNEL_ID`:

```text
🏷️ **[WTB] Outreach DM Preview** *(DRY RUN: Safe Mode)*

📌 **Job:** "Looking to buy bulk Gmail accounts"
🔗 **Thread:** https://www.blackhatworld.com/seo/...
👤 **Poster:** @username
📅 **Posted:** Today
🏷️ **Category:** Want to Buy (WTB) Section

📨 **Message 1 (Initial DM):**
"Hey @username, saw your WTB post regarding bulk Gmail accounts..."

📩 **Message 2 (Scheduled Follow-up):**
"Hey @username, following up on your WTB post..."
```

### B. WTB Outreach DM Sent Card (LIVE)
```text
🎯 **[WTB] Outreach DM Sent!**

📌 **Job:** "Looking to buy bulk Gmail accounts"
🔗 **Thread:** https://www.blackhatworld.com/seo/...
👤 **Poster:** @username
📅 **Posted:** Today
🏷️ **Category:** Want to Buy (WTB) Section

📨 **DM Sent:**
"Hey @username, saw your WTB post regarding bulk Gmail accounts..."
```

### C. WTB Public Comment Card (When `WTB_COMMENTS_ENABLED=true`)
```text
💬 **[WTB] Public Comment Posted!**

📌 **Thread:** "Need custom Telegram scraping script"
🔗 **URL:** https://www.blackhatworld.com/seo/...
👤 **Poster:** @username
🏷️ **Category:** Want to Buy (WTB) Section

📝 **Comment Posted:**
"Hey @username, we can help fulfill this for you..."
```

### D. Unified Scraper Cycle Heartbeat Card (Option A: Combined Clean Reporting)
Sent to your main control channel at the end of every scrape cycle:

```text
🟢 **Everything Okay | Scraper Cycle Completed**

⏱ **Run:** #8 | 21 Oct, 14:19
📌 **HAF:** 21 Inspected | 0 New | 0 AI Approved
🏷️ **WTB:** 15 Inspected | 2 Today | 1 Outreach (Dry Run)
⏰ **Next Cycle:** in ~37 minutes (randomized window)
```

---

## 6. Implementation Checklist & Affected Files

| Step | Component | File | Action |
|---|---|---|---|
| **1** | **Config** | `src/config/config.js` | Add `wtb` config object (`enabled`, `dryRun`, `todayOnly`, `commentsEnabled`, `dailyCap`, `url`) |
| **2** | **Scraper** | `src/scraper/wtbScraper.js` *(New File)* | Uses authenticated `bhwSession` (members-only access) to scrape Page 1 of `want-to-buy.92/`, filters for posts created today, saves with `tags: ['wtb']` |
| **3** | **Lead Processor** | `src/index.js` | Add `processWtbLeads()` with 1 DM per run pacing and independent `WTB_DRY_RUN` check |
| **4** | **Alerts** | `src/services/alerts.js` | Add dedicated `[WTB]` header formatters for WTB preview and sent cards |
| **5** | **Loop Integration**| `src/index.js` | Call WTB scraping and outreach inside Loop 1 right after HAF |

---

## 7. Safety, Anti-Clash & Pacing Guarantees
1. **Zero Database Clashes:** Every thread on BHW has a unique numeric ID. WTB leads are stored in the existing `leads` table with `tags: ['wtb']`.
2. **Independent DRY RUN:** `WTB_DRY_RUN=true` allows full review of message tone and accuracy in Discord without touching real BHW users.
3. **Independent Comment Toggle:** `WTB_COMMENTS_ENABLED=false` keeps public commenting completely disabled while DM testing is underway.
4. **Today-Only Filter:** Never wastes resources or messages old dead requests; only reaches out to fresh WTB posts from today.
5. **Human Anti-Bot Pacing:** Maximum 1 WTB DM per scrape cycle (20–40 min interval) to keep XenForo rate-limit flags at zero.
6. **Automatic Two-Way Discord Chat:** When a WTB client replies, the bot automatically pauses follow-ups, alerts `#bhw-client-inbox`, and your team can reply via `/reply user:<username> message:<text>`.
