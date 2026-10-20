# Comment Plan: Development-Only Public Comments + Full DM Outreach

## 1. Objective
- **Public Forum Comments:** Post comments **strictly on development/software jobs** (bots, scrapers, automation, APIs, web/mobile development).
- **Direct Messages (DMs):** Continue sending DMs to **100% of qualified jobs** (development, SEO, design, content, VA, etc.).
- **Discord Channel:** Delivered to the **same Discord DM Alerts channel** (`DISCORD_DM_ALERTS_CHANNEL_ID` / `sendOutreachReport`).
- **Clear Discord Visibility:** 
  - If a job **is development** $\rightarrow$ sends a **"Public Comment Posted"** card.
  - If a job **is NOT development** $\rightarrow$ sends a **"Public Comment Skipped (Non-Dev Job)"** card so the team knows commenting was intentionally skipped.

---

## 2. Changes Required

### A. Qualification Prompt Update (`src/services/aiEngine.js`)
Add `is_development` boolean and rule to `qualifyLead`:
```json
Return ONLY valid JSON — no explanation, no code fences:
{
  "qualified": true | false,
  "is_development": true | false,
  "confidence": 0.00 to 1.00,
  "reason": "one concise sentence explaining why",
  "pitch_angle": "if qualified: how Zeeshan should position himself for this job; else empty string"
}
```

**Rule added:**
```text
DEVELOPMENT CATEGORY RULE:
  "is_development": true — if the job involves coding, scripts, bots, web scrapers, APIs, web/mobile development (WordPress, Shopify, React, Node, Python, PHP, etc.), or technical software automation.
  "is_development": false — if the job is for SEO, backlinks, PBNs, content writing, graphic design, video editing, virtual assistance, data entry, social media, or other non-coding services.
```

### B. Lead Processing Logic & Discord Cards (`src/index.js`)
In `processQualifiedLeads()`:

1. **When Dev Job & Commenting Enabled:**
   - Post public comment.
   - Send Discord Card:
   ```text
   💬 **Public Comment Posted!**
   
   📌 **Post:** "Need Telegram bot that scrapes members"
   🔗 **Thread:** https://www.blackhatworld.com/seo/...
   👤 **Poster:** @username
   🤖 **AI Score:** 95% (Development Job)
   
   📝 **Comment Posted:**
   "..."
   ```

2. **When Non-Dev Job (or commenting disabled):**
   - Skip comment.
   - Send Discord Card:
   ```text
   ℹ️ **Public Comment Skipped (Non-Dev Job)**
   
   📌 **Post:** "Looking to buy SEO backlinks"
   🔗 **Thread:** https://www.blackhatworld.com/seo/...
   👤 **Poster:** @username
   🏷️ **Category:** Non-development (SEO, Design, Writing, VA)
   👉 *Proceeding to direct message (DM) outreach only.*
   ```

3. **Step 2 (Always):**
   - Proceed with normal Direct Message (DM) outreach to the client with Message 1 and Message 2.

---

## 3. Database Impact
- **Database Schema:** **Zero changes.** No new columns, no migrations.
- **Tags Integration:** If `is_development` is true, `'development'` is tagged onto the lead row's `tags` array for permanent tracking.

---

## 4. Expected Behavior Summary

| Job Type | AI Qualified? | `is_development` | Action Taken | Discord Alerts in DM Alerts Channel |
|---|---|---|---|---|
| Python Scraper / Bot | ✅ Yes | `true` | **Comment + DM** | **Card 1:** 💬 Public Comment Posted<br>**Card 2:** 🎯 Outreach DM Card (Msg 1 + Msg 2) |
| WordPress / Web App | ✅ Yes | `true` | **Comment + DM** | **Card 1:** 💬 Public Comment Posted<br>**Card 2:** 🎯 Outreach DM Card (Msg 1 + Msg 2) |
| SEO Backlinks / PBNs | ✅ Yes | `false` | **DM Only** | **Card 1:** ℹ️ Comment Skipped (Non-Dev Job)<br>**Card 2:** 🎯 Outreach DM Card (Msg 1 + Msg 2) |
| Video Editor / Design | ✅ Yes | `false` | **DM Only** | **Card 1:** ℹ️ Comment Skipped (Non-Dev Job)<br>**Card 2:** 🎯 Outreach DM Card (Msg 1 + Msg 2) |
| WTS / Selling / Spam | ❌ No | `false` | **Ignored** | None |
