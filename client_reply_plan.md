# Client Reply Plan: BHW Inbound to Discord & Two-Way DM Chatting

## 1. Objective
- **Inbound Alerts:** Whenever a BHW client replies to an outreach DM, their message is immediately forwarded to a dedicated Discord channel (`#bhw-client-inbox`).
- **Two-Way Outbound Replies:** You or your sales team can reply directly in Discord (via `/reply user:username message:...`), and the bot types and sends the message into that client's BHW conversation.
- **Human Control:** The AI does **NOT** auto-chat with the client; humans control 100% of the conversation from Discord.
- **Safety:** Active follow-ups are automatically paused for any client who replies.
- **Reporting:** Daily and weekly reports will track **Client Replies Received** and **Team Replies Sent**.

---

## 2. Discord Channel Setup
- Create a dedicated channel in your Discord server: `#bhw-client-inbox`.
- Add its Channel Snowflake ID to your `.env` file:
  ```env
  DISCORD_CLIENT_INBOX_CHANNEL_ID=1234567890123456789
  ```

---

## 3. Workflow Architecture

```
                  ┌────────────────────────────────────────┐
                  │          BHW INBOX (Client)            │
                  └───────────────────▲────────────────────┘
                                      │
                         (1) Scrape   │  (4) Send reply
                          unread msgs │   via Puppeteer
                          (every run 20–40 min) │
                  ┌───────────────────┴────────────────────┐
                  │         BOT ENGINE (VPS)               │
                  │   - inbox-monitor.js (notifyOnly: true)│
                  │   - commandCenter.js (/reply handler)  │
                  │   - bhwSession (shared Puppeteer)      │
                  └───────────────────▲────────────────────┘
                                      │
                        (2) Forward   │  (3) Human types
                         client card  │   /reply in Discord
                                      │
                  ┌───────────────────┴────────────────────┐
                  │    DISCORD CHANNEL (#bhw-client-inbox) │
                  │       (Zeeshan & Sales Team)           │
                  └────────────────────────────────────────┘
```

---

## 4. Inbound Flow (BHW $\rightarrow$ Discord)

1. **Guaranteed Inbox Check on EVERY Scrape Run (20–40 min):**
   - Directly wired into `startScraperAndOutreachLoop()` in `src/index.js`.
   - On **every single scrape tick**, after scraping new jobs, the bot calls `checkAndReplyToInbox({ notifyOnly: true })`.
   - Navigates to `https://www.blackhatworld.com/conversations/` and checks for any conversation with the unread indicator (`.is-unread`).
   - If an unread conversation exists from a contacted lead:
     - The bot opens the conversation page.
     - Reads the latest client message.
     - Automatically marks all follow-ups for that lead as **`'paused'`** (`client_replied_live`) directly by `lead_id` and `id` in the database.
     - Increments `conversations.their_message_count` and records the inbound message in the `dms` table (`direction = 'inbound'`).
     - Dispatches the client reply alert card to the dedicated `#bhw-client-inbox` channel.
   - If no unread messages exist, it completes silently and proceeds to the next cycle.

2. **Follow-Up System Live Fallback:**
   - In addition to checking every run, whenever any scheduled follow-up is about to send, the follow-up runner still checks the conversation DOM first as a secondary guarantee. If the client replied, it aborts sending the follow-up message and pauses the sequence.

3. **Discord Notification Card:**
   - Sends a dedicated notification card to `#bhw-client-inbox`:
     ```text
     📬 **NEW CLIENT REPLY!**
     
     👤 **User:** @RogueLeads
     📌 **Job:** "Adult Landing Page Design"
     🔗 **BHW Link:** https://www.blackhatworld.com/direct-messages/...
     
     💬 **Client Message:**
     "sure. we do it in afternoon indian time"
     
     👉 **To reply from Discord:**
     Type: `/reply user:RogueLeads message:Sounds good! How about 3 PM IST?`
     ```

---

## 5. Outbound Flow (Discord $\rightarrow$ BHW)

When you or your sales team send a message from Discord:

### Native Slash Command `/reply`
```text
/reply user:RogueLeads message:Sounds good! How about 3 PM IST? Can we jump on a quick call?
```

### Handler Execution (`commandCenter.js`):
1. **Lookup:** Finds the BHW conversation URL for `@RogueLeads` from the DB.
2. **Session Acquisition:** Uses the shared authenticated `bhwSession` page.
3. **Typing & Submission:**
   - Navigates to the conversation URL.
   - Types your message into the Froala editor using human typing simulation.
   - Triggers synthetic mouse events on the **"Post reply"** button (with HTML5 fallback).
4. **Confirmation in Discord:**
   - Replies to your slash command:
     `✅ Successfully sent to @RogueLeads on BHW!`
5. **Activity Logging:** Records the outbound message in `dms` with `message_type = 'reply'` and `direction = 'outbound'`.

---

## 6. Daily & Weekly Reporting Update

The 9:00 AM Daily Report (and `/stats` / `/forcereport`) will display both inbound client responses and outbound team responses:

```text
📊 **Daily Bot Report — 20/10/2026**

🔍 Leads scraped:          14
📨 DMs sent:               8
💬 Client replies:         3   <--- Inbound replies from clients today
✍️ Team replies sent:      3   <--- Replies sent by your team via Discord
🚨 Handoffs:               0
✅ Conversions:            1

📈 **Weekly Summary (Last 7 Days)**
📨 Total DMs sent:         45
💬 Total Client replies:   12
🎯 Client Response Rate:   26.6%
```

---

## 7. Implementation Checklist

| Component | File | Action |
|---|---|---|
| **Config** | `src/config/config.js` | Add `clientInboxChannelId: process.env.DISCORD_CLIENT_INBOX_CHANNEL_ID` |
| **Database Queries** | `src/database/queries.js` | Add `client_replies` (inbound) and 7-day rolling stats to `getDailyStats()` |
| **Inbox Monitor** | `src/engines/inbox-monitor.js` | Add `notifyOnly` mode — forwards messages to `#bhw-client-inbox` and logs inbound DM |
| **Command Center** | `src/services/commandCenter.js` | Register `/reply` slash command with `user` and `message` parameters |
| **Alerts Service** | `src/services/alerts.js` | Format client replies in daily/weekly report |
| **Orchestrator** | `src/index.js` | Call `checkAndReplyToInbox({ notifyOnly: true })` inside the main scrape loop |
