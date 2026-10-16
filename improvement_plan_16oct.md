# Improvement Plan — 16 Oct 2026

## Overview
This plan addresses 5 key improvements for Pipeline A outbound lead generation and alerting:
1. **Rejection Alerts in DM Channel**: When a scraped thread is not qualified by AI, send an alert to the new DM Channel (`DISCORD_DM_ALERTS_CHANNEL_ID`) showing the post details, post URL, and the explicit AI rejection reason.
2. **Subject Generation in Zeeshan Persona Prompt**: Update `zeePersona.js` and `aiEngine.js` so the AI explicitly generates an optimal, natural BHW conversation subject `<subject>...</subject>` along with `<message_1>` and `<message_2>`.
3. **Include Post URL in Discord DM Cards**: Ensure the thread URL is clearly displayed and clickable in all Discord previews and messages.
4. **Heartbeat / "Everything Okay" Ping Every Scrape Run**: Send a lightweight confirmation message to Discord after every scrape run confirming that the scraper ran successfully, is healthy, and showing the randomized wait time until the next cycle.
5. **Update Lead Qualification Rules**: Fix the over-strict qualifier to treat "WTB" (Want to Buy) and link/service purchasing requests as valid leads (only reject actual sellers).

---

## Detailed Changes

### 1. Rejection Alert to DM Channel
- **Current Behavior**: Rejected leads are only logged to console and summarized in the raw scraper batch summary.
- **New Behavior**: In `src/scraper/index.js` (or `processQualifiedLeads`), whenever a newly inspected post from today is rejected by AI (`qualification.qualified === false`), dispatch a clean Discord card to `DISCORD_DM_ALERTS_CHANNEL_ID`:
  - ❌ **Job Disqualified**
  - Title & Poster username
  - Clickable Thread URL
  - Rejection Reason (why AI rejected it)
  - Confidence Score

### 2. Zee Prompt with Subject Line (`<subject>`)
- **Current Behavior**:
  - `zeePersona.js` output tags: `<thoughts>`, `<message_1>`, `<message_2>`.
  - Subject in `dm.js` is just truncated thread title (`lead.title.substring(0, 57)`).
- **New Behavior**:
  - Add `<subject>` tag to `ZEESHAN_AHMAD_SYSTEM_PROMPT` in `src/services/zeePersona.js`.
  - Rules for Subject: Short, natural subject line for the BHW private message (e.g., lowercase / natural English referencing the role/project, max 50 chars, no spammy words).
  - Update `generateDMOutreach` in `src/services/aiEngine.js` to extract and return `subject`.
  - In `src/engines/dm.js`, use `generatedSubject || lead.title` when filling the subject field on BHW.
  - Include the Subject in the Discord Message 1 & 2 preview card.

### 3. Ensure Thread URL in All DM Cards & Alerts
- Review `sendOutreachReport` and Discord DM card generators in `src/services/alerts.js` and `src/index.js`.
- Make sure the URL is prominently formatted at the top of the card: `🔗 Post URL: https://www.blackhatworld.com/...`.

### 4. Heartbeat / "Everything Okay" Message Every Cycle
- **Current Behavior**: Bot only logs to `pm2-out.log` and sleeps for 20–40 min; Discord ping was only every 6 hours.
- **New Behavior**: At the end of every scrape cycle in `src/index.js`, send a clean status alert to Discord:
  - 🟢 **Everything Okay | Scraper Cycle Completed**
  - Inspected posts count, new leads found, qualified count.
  - Next scheduled cycle in ~X minutes (randomized window).

### 5. Qualification Rule Update (WTB & Link Buying)
- In `src/services/aiEngine.js` (`qualifyLead`) and `qualify_prompt.md`:
  - Explicitly permit and qualify **WTB** (Want to Buy) threads, PBNs, sidebar links, guest posts, and purchasing services.
  - Clarify that buying services counts as hiring. Only reject sellers (`[WTS]`, service providers advertising).

---

## Files to Modify
1. `src/services/zeePersona.js` — Add `<subject>` instructions and tag to persona.
2. `src/services/aiEngine.js` — Update `qualifyLead` prompt (allow WTB/links) and `generateDMOutreach` (extract `<subject>`).
3. `src/engines/dm.js` — Use AI generated subject when creating BHW conversation.
4. `src/scraper/index.js` — Send rejection notification to DM channel when post is rejected.
5. `src/services/alerts.js` — Add rejection alert helper, format post URL prominently, add cycle heartbeat helper.
6. `src/index.js` — Send the cycle completion ("Everything Okay") ping to Discord after each run.
7. `qualify_prompt.md` — Keep prompt documentation updated.
