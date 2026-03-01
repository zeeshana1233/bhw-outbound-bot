# Bitbash BHW Outbound Sales Bot — Development Plan

**Project:** BlackHatWorld Outbound Lead Automation Bot
**Owner:** Zeeshan Ahmad / Bitbash Software Development Agency
**BHW Account:** app_pilot
**Version:** 1.0
**Date:** February 27, 2026

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [How This Project Works — Developer Onboarding](#2-how-this-project-works--developer-onboarding)
3. [Business Context — What We Learned From The Data](#3-business-context--what-we-learned-from-the-data)
4. [System Architecture](#4-system-architecture)
5. [BHW Scraper — Job Discovery Engine](#5-bhw-scraper--job-discovery-engine)
6. [Niche Qualification — LLM-Based Filtering](#6-niche-qualification--llm-based-filtering)
7. [Comment Engine — Public Thread Pitching](#7-comment-engine--public-thread-pitching)
8. [DM Engine — Private Outreach](#8-dm-engine--private-outreach)
9. [Conversation Engine — DM Reply Handler](#9-conversation-engine--dm-reply-handler)
10. [The Golden Rule: Never Reveal The Bot](#10-the-golden-rule-never-reveal-the-bot)
11. [Follow-Up System — DM Nurturing](#11-follow-up-system--dm-nurturing)
12. [Duplication Prevention](#12-duplication-prevention)
13. [Anti-Bot Detection — Human Behavior Simulation](#13-anti-bot-detection--human-behavior-simulation)
14. [WhatsApp Alerts & Daily Reports](#14-whatsapp-alerts--daily-reports)
15. [Database Design](#15-database-design)
16. [Browser Automation — Chrome Profile & Puppeteer](#16-browser-automation--chrome-profile--puppeteer)
17. [Admin Interface](#17-admin-interface)
18. [Windows Server Deployment](#18-windows-server-deployment)
19. [Security & Access Control](#19-security--access-control)
20. [Development Phases & Timeline](#20-development-phases--timeline)
21. [Testing Plan](#21-testing-plan)
22. [Launch Checklist](#22-launch-checklist)
23. [Post-Launch Monitoring](#23-post-launch-monitoring)
24. [Appendix A: Niche Keywords & Qualification Rules](#appendix-a-niche-keywords--qualification-rules)
25. [Appendix B: Pitch Style Reference](#appendix-b-pitch-style-reference)
26. [Appendix C: DM Conversation Patterns](#appendix-c-dm-conversation-patterns)

---

## 1. Executive Summary

Bitbash currently hunts for outbound leads on BlackHatWorld's "Hire a Freelancer" section manually. Zeeshan checks the forum, identifies jobs that match Bitbash's niche, comments on the thread with a pitch, DMs the poster with a detailed proposal, and then nurtures the conversation until the lead moves to Telegram or closes a deal.

This bot automates the entire flow:

1. **Scrapes** the BHW Hire a Freelancer page every 2 minutes for new job posts
2. **Qualifies** each post using GPT-4o mini — is this in our niche?
3. **Comments** on qualified threads with a tailored pitch (as app_pilot)
4. **DMs** the poster with a detailed, LLM-generated proposal
5. **Monitors** the BHW inbox for replies and responds intelligently
6. **Follows up** on cold DMs at proper intervals for up to a month
7. **Pushes leads toward Telegram** for deeper conversation
8. **Reports** daily activity and hot leads to WhatsApp

The bot uses Puppeteer with a real Chrome profile (already logged in as app_pilot) to interact with BHW. It behaves exactly like a human — random delays, natural typing, varied pitches, no patterns.

**What it is NOT:** A spam bot. It only pitches jobs that genuinely match what Bitbash does. Every pitch is custom-generated based on the specific job post. The poster should believe Zeeshan personally read their post and responded.

---

## Project Log — Recent Updates (automated)

- **2026-02-28:** Tab prevention fixed in `src/utils/bhwSession.js` — new tabs are now monitored and closed automatically; tab prevention verified with `test-tab-prevention.js` (only 1 tab remains open).
- **2026-02-28:** Scraper updated to process all threads (removed TESTING_MODE limit) in `src/scraper/index.js` and enhanced CloudFlare handling; `find-qualified-leads.js` added to run scraping without a login session.
- **2026-02-28:** OpenClaw (GPT-4o mini) used for qualification and pitch generation; generated DRY RUN comment for a qualified lead.
- **2026-02-28:** Found a qualified lead: "Need a bot developer" (fresh, Score: 95/100). DRY RUN comment generated: "Hey @username, I’ve been building custom bots and extensions for years... DM me if you want to discuss..." (no posting performed).
- **2026-02-28:** `comment-on-lead.js` created to generate DRY RUN comments from the most recent qualified lead (requires login to post live).

Status: Tab prevention and scraping/testing were run locally and verified. Next actionable items: (1) review generated DRY RUN comment, (2) log into BHW with `test-bhw-session.js` to enable live posting, (3) enable LIVE posting mode when ready.

## 2. How This Project Works — Developer Onboarding

### 2.1 The Big Picture

This bot has two main loops running continuously:

**Loop 1: Discovery & Outreach (every 2 minutes)**
```
Scrape BHW "Hire a Freelancer" page 1
    → For each thread:
        Is it already in our database? → Skip (duplication prevention)
        Is it older than 1 year? → Skip entirely
        Pass title + description to GPT-4o mini → "Is this our niche?"
        Not our niche → Log and skip
        Our niche → Queue for action:
            If thread < 1 month old → Comment + DM
            If thread 1 month–1 year old → Comment only (no DM)
```

**Loop 2: Inbox Monitoring & Reply (every 5 minutes)**
```
Check BHW inbox for new/unread messages
    → For each new message:
        Is this a conversation we're tracking? → Route to conversation engine
        Is this a new inbound DM from someone? → Create lead, respond
        Generate reply via GPT-4o mini (as Zee)
        If conversation is warm → Offer Telegram
        If lead went cold → Schedule follow-up
```

### 2.2 How OpenClaw Fits In

OpenClaw is the AI brain. It generates all the text — pitches, DMs, replies, follow-ups. The browser automation (Puppeteer) is the hands and eyes — it reads the page and performs actions. They work together:

```
Puppeteer scrapes job post → sends to OpenClaw for qualification
OpenClaw says "qualified" → Puppeteer comments + DMs
Lead replies → Puppeteer reads reply → sends to OpenClaw for response generation
OpenClaw generates reply → Puppeteer types and sends it
```

### 2.3 File Structure

```
C:\BitbashBHW\
├── scraper/                            # BHW page scraper
│   ├── index.js                        # Main scrape loop
│   ├── parser.js                       # Extract thread data from page
│   └── thread-fetcher.js              # Fetch individual thread details
├── browser/                            # Puppeteer automation
│   ├── index.js                        # Browser session manager
│   ├── comment-poster.js              # Posts comments on threads
│   ├── dm-sender.js                   # Sends DMs to users
│   ├── inbox-reader.js                # Reads inbox for new messages
│   ├── dm-replier.js                  # Types and sends DM replies
│   └── human-behavior.js             # Random delays, mouse movements, typing
├── ai/                                 # OpenClaw / LLM integration
│   ├── qualifier.js                   # "Is this our niche?" decision
│   ├── pitch-generator.js            # Generates comment pitches
│   ├── dm-generator.js               # Generates DM proposals
│   ├── reply-generator.js            # Generates DM reply messages
│   ├── followup-generator.js         # Generates follow-up messages
│   └── system-prompts/
│       ├── qualifier.md               # Qualification prompt
│       ├── commenter.md              # Comment generation prompt
│       ├── dm-outreach.md            # First DM prompt
│       ├── dm-reply.md               # DM conversation prompt
│       └── followup.md               # Follow-up prompt
├── engine/                             # Core logic
│   ├── pipeline.js                    # Main orchestration
│   ├── scheduler.js                   # Cron jobs (scrape, inbox check, follow-ups)
│   ├── dedup.js                       # Duplication prevention
│   └── lead-tracker.js               # Lead state management
├── alerts/                             # WhatsApp reporting
│   ├── whatsapp.js                    # Send alerts via OpenClaw WhatsApp
│   └── daily-report.js               # Daily summary generator
├── admin-panel/                        # Web dashboard
│   ├── server.js
│   ├── public/
│   └── routes/
├── database/
│   ├── migrations/
│   ├── seeds/
│   └── config.js
├── scripts/
│   └── backup.ps1
├── logs/
├── .env
├── package.json
└── README.md
```

### 2.4 Key Documentation to Read

- Puppeteer docs: `https://pptr.dev/` — headless Chrome automation
- OpenClaw skills: `https://docs.openclaw.ai/skills/`
- BHW forum structure: `https://www.blackhatworld.com/forums/hire-a-freelancer.76/`

---

## 3. Business Context — What We Learned From The Data

### 3.1 Pitch Analysis (from 10 real comment pitches)

From analyzing all of Zee's BHW comments, here are the patterns:

**Comment pitch structure (what the bot must replicate):**
1. **Opener** — Casual greeting, sometimes addresses poster by @username
2. **Relevance claim** — "I can help you out" / "This lines up with what I do"
3. **Capability statement** — What Zee can specifically do for this job
4. **Social proof** — Mentions years of experience, demo videos, past projects
5. **Call to action** — "DM me" or "PM to see demo videos"
6. **Signature** — Auto-appended by BHW (not generated by bot)

**Pitch length varies by complexity:**
- Simple/clear jobs: 1-3 sentences (85-210 chars)
- Complex/specific jobs: 4-8 sentences with bullet points (300-900 chars)
- Technical jobs (front-end, scraping): Detailed approach explanation with live URLs

**Key phrases Zee uses in comments:**
- "I can help you out"
- "This lines up really well with what I do"
- "I have been building [X] for years"
- "DM me to get more information and to see the demo videos"
- "I have sent you a detailed proposal"
- "PM to see demo videos"

**Important:** 3 out of 10 pitches address the poster by @username. 7 out of 10 mention DM/PM. 6 out of 10 mention demo videos. The bot should vary this naturally — not every pitch should follow the exact same formula.

### 3.2 DM Analysis (from 16 real DM conversations)

**Two types of DMs:**

**Type A: Outreach DM (Zee initiates — 4 conversations)**
These are detailed, structured proposals:
```
"Hey @[username], I just saw your post about [topic]. This project lines up 
really well with what I do.

I can help:
- [specific capability 1]
- [specific capability 2]
- [specific capability 3]

Let me know your exact needs."
```

**Type B: Reply DM (lead initiated from comment — 12 conversations)**
These are warmer, shorter:
```
"Hello there, Thanks for reaching out. Yes I can help you out."
"Please let me know your exact features and requirements."
```

**DM conversation flow patterns:**
1. First DM → Capability + ask for requirements
2. Lead responds with details → Zee provides technical approach
3. Technical discussion → 2-5 exchanges
4. Scope alignment → Quote or "Let's have a meeting"
5. Redirect to Telegram when deal gets serious

**Telegram redirect happens:**
- When the lead asks for contact info
- When Zee wants a deeper conversation
- When deal scope is established
- Average: after 3-5 DM exchanges

**Follow-up patterns:**
- Zee follows up on cold DMs with: "Hello there, I hope you are doing good, is there any updates on your end"
- Follows up on cold DMs: "Hello there, Is there any updates on your end."
- Follow-up timing: 7-14 days after last message
- Max 2-3 follow-ups before stopping

### 3.3 Niche Analysis — What Bitbash Pitches vs Skips

From the 10 threads Zee pitched on vs the 20 job listings (most of which are NOT Bitbash's niche):

**Pitchable (our niche):**
- Social media automation (Instagram, TikTok, YouTube, Snapchat, Reddit, Twitter)
- Bots and scrapers (any platform)
- Phone farms and device automation
- Telegram bot development
- Email automation / infrastructure
- Custom software development (web, mobile)
- Front-end / full-stack development
- Data scraping projects
- AI agents and automation workflows

**NOT our niche (skip):**
- SEO services (link building, backlinks, guest posts, keyword ranking)
- Gambling/casino SEO
- Google Ads management
- SMM panel services (we build tools, not sell followers)
- Content writing / copywriting
- Graphic design / motion design (unless it's a web project)
- GMB verification
- Forbes placements / PR

**Edge cases (pitch if the post has a technical/build component):**
- "Need WordPress redesign" → pitch if it's development work
- "Looking for SMM provider" → pitch if they want a custom tool built
- "Mass DM service" → pitch because we build the automation, not sell the service

### 3.4 Competitor Analysis (from other_people_pitch data)

Average 3-5 other people pitch on each qualified thread. Common competitor patterns:
- Many use generic copy-paste pitches
- Some are service providers (sell followers/likes) not developers
- A few competitors also mention Telegram for communication
- Some are aggressive ("I can do this, DM me now")

**Zee's advantage:** His pitches are specific to the post, mention actual capabilities, and offer demo videos. The bot must maintain this quality gap.

---

## 4. System Architecture

### 4.1 High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│              BLACKHATWORLD WEBSITE                                │
│         https://www.blackhatworld.com/forums/                    │
│                  hire-a-freelancer.76/                            │
└────────────────┬──────────────────────────────────┬──────────────┘
                 │                                  │
        (Scrape page 1)                    (Read inbox / Post)
                 │                                  │
                 ▼                                  ▼
┌─────────────────────────┐    ┌───────────────────────────────────┐
│    SCRAPER MODULE        │    │   BROWSER AUTOMATION (Puppeteer)  │
│  (headless, no login)    │    │   (Chrome profile, logged in)     │
│                          │    │                                   │
│  Every 2 min:            │    │   - Post comments as app_pilot    │
│  - Fetch page 1          │    │   - Send DMs as app_pilot         │
│  - Extract threads       │    │   - Read inbox                    │
│  - Check for new ones    │    │   - Reply to DMs                  │
└────────────┬─────────────┘    └────────────┬──────────────────────┘
             │                               │
             ▼                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                    OPENCLAW + GPT-4o mini                         │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────┐│
│  │ Qualifier    │  │ Pitch Gen    │  │ DM Conversation Engine   ││
│  │ "Our niche?" │  │ Comment text │  │ Reply generation         ││
│  └─────────────┘  └──────────────┘  └──────────────────────────┘│
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────┐│
│  │ DM Outreach │  │ Follow-Up    │  │ Lead Scoring             ││
│  │ Generator   │  │ Generator    │  │ (Hot lead detection)     ││
│  └─────────────┘  └──────────────┘  └──────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
             │                               │
             ▼                               ▼
┌─────────────────────────┐    ┌───────────────────────────────────┐
│       DATABASE           │    │   WHATSAPP ALERTS (OpenClaw)      │
│    (PostgreSQL)          │    │   - Hot lead notifications         │
│                          │    │   - Daily activity report          │
│  threads │ comments      │    │   - Deal progress alerts           │
│  dms │ leads │ followups │    └───────────────────────────────────┘
│  daily_reports           │
└─────────────────────────┘
```

### 4.2 Tech Stack

| Component | Technology | Reason |
|-----------|-----------|--------|
| AI Brain | OpenClaw + GPT-4o mini | LLM for qualification, pitch gen, conversations |
| Page Scraping | Puppeteer (headless mode) OR plain HTTP + cheerio | Scrape forum page — no login needed for reading |
| Browser Actions | Puppeteer with real Chrome profile | Comment, DM, inbox — requires logged-in session |
| Database | PostgreSQL | Thread tracking, conversations, dedup, reporting |
| Scheduler | node-cron | 2-min scrape loop, 5-min inbox check, daily reports |
| WhatsApp | OpenClaw native WhatsApp channel | Team alerts and daily reports |
| Admin Panel | Express.js + HTML | Controls, monitoring, configuration |
| Hosting | Windows Server | Same server as inbound bot |

---

## 5. BHW Scraper — Job Discovery Engine

### 5.1 What It Scrapes

**Target URL:** `https://www.blackhatworld.com/forums/hire-a-freelancer.76/`

The scraper fetches **page 1 only** (this page updates constantly as new threads are posted and old ones get bumped).

**For each thread on page 1, extract:**
- Thread ID (from URL — unique identifier)
- Thread title / heading
- Thread URL
- Author username
- Post date / last activity date
- Reply count
- Whether it's a sticky/pinned thread (skip these)

### 5.2 Getting Thread Description

Many threads on BHW have just a title with no visible description on the listing page. The bot needs to click into threads to get the full description for proper LLM qualification.

**Strategy:**
- For NEW threads (not in database): fetch the thread page and extract the first post content (the job description)
- For KNOWN threads (already in database): skip fetching, we already have the data
- Cache the description in the database so we never fetch the same thread twice

### 5.3 Scraping Method

**Option A (Recommended): Headless Puppeteer without login**
- BHW's Hire a Freelancer page is publicly readable
- No login needed to read thread titles and descriptions
- Use a separate headless browser instance (not the logged-in profile)
- Faster, less risk to the app_pilot account

**Option B: HTTP + Cheerio**
- Plain HTTP requests to fetch HTML
- Parse with Cheerio (jQuery for Node.js)
- Fastest option, but may get blocked if BHW has anti-scrape measures
- If blocked, fall back to Option A

### 5.4 Scrape Loop

```
Every 2 minutes:
    1. Fetch page 1 of Hire a Freelancer
    2. Extract all thread listings (typically 20-30 per page)
    3. Filter out:
        - Sticky/pinned threads (ads, forum rules)
        - Threads already in our database
    4. For each NEW thread:
        a. Fetch the full thread page to get description
        b. Save to database (thread_id, title, description, author, date, url)
        c. Send to qualification engine (Section 6)
    5. For EXISTING threads that were bumped:
        a. Update last_activity timestamp
        b. Check if we already commented — if not and it qualifies, queue for action
    6. Log: "Scraped page 1: [X] threads found, [Y] new, [Z] qualified"
```

---

## 6. Niche Qualification — LLM-Based Filtering

### 6.1 How It Works

Every new thread gets evaluated by GPT-4o mini with the following prompt:

```markdown
You are a niche-matching assistant for Bitbash, a software development agency that specializes in:
- Social media automation bots (Instagram, TikTok, YouTube, Snapchat, Reddit, Twitter, Telegram)
- Web scraping and data extraction tools
- Phone farm and device automation systems
- Custom bot development (any platform)
- Email automation infrastructure
- AI agents and workflow automation
- Full-stack web and mobile development
- Browser automation and extension development
- API development and reverse engineering

Bitbash does NOT do:
- SEO services (link building, backlinks, keyword ranking, guest posts)
- Content writing or copywriting
- Graphic design or motion design
- Social media management as a service (buying/selling followers, likes, etc.)
- Google Ads management
- PR placements
- GMB verification

Given the following job post from a freelancer marketplace, decide if Bitbash should pitch on it.

TITLE: {thread_title}
DESCRIPTION: {thread_description}

Respond with ONLY a JSON object:
{
  "qualified": true/false,
  "confidence": 0.0-1.0,
  "reason": "one sentence explaining why",
  "pitch_angle": "if qualified, how should Bitbash position itself for this job"
}
```

### 6.2 Qualification Thresholds

| Confidence | Action |
|-----------|--------|
| 0.0 – 0.4 | Skip — not our niche |
| 0.4 – 0.7 | Log as "maybe" — review in admin panel, don't auto-pitch |
| 0.7 – 1.0 | Qualified — auto-pitch (comment + DM if under 1 month old) |

### 6.3 Thread Age Rules

| Thread Age | Qualified? | Comment? | DM? |
|-----------|-----------|---------|-----|
| 0 – 1 month | Yes | Yes | Yes |
| 1 month – 1 year | Yes | Yes | No |
| > 1 year | No | No | No |

Threads can appear on page 1 at any age if someone bumps them with a comment. The bot must check the ORIGINAL post date, not the last activity date.

---

## 7. Comment Engine — Public Thread Pitching

### 7.1 Comment Generation

Every qualified thread gets a custom comment generated by GPT-4o mini. The prompt:

```markdown
You are Zee (Zeeshan Ahmad), posting a comment on a BlackHatWorld forum thread in the "Hire a Freelancer" section. You run Bitbash, a software development agency.

CRITICAL RULES:
- You ARE Zee. Never mention bots, AI, automation of this response, or anything that suggests this is not a human typing.
- Your comment will have a signature auto-appended by the forum. Do NOT include any signature, links, or contact info in your comment — the forum handles that.
- Keep it natural and varied. Don't use the same opening or structure every time.
- Never be salesy or desperate. Be confident and specific.
- BHW has rules against openly selling/soliciting in comments. Frame your pitch as offering help and expertise, not hard-selling a service.

THE JOB POST:
Title: {thread_title}
Description: {thread_description}
Author: {author_username}
Pitch Angle: {from qualifier}

YOUR STYLE (based on real comment history):
- Sometimes address the poster by @username, sometimes don't (vary it)
- Sometimes mention you've "sent a detailed proposal" (when you'll also DM)
- Sometimes offer demo videos, sometimes don't (match to what's relevant)
- Short pitches for clear jobs (1-3 sentences)
- Detailed pitches for complex/technical jobs (bullet points okay)
- Phrases you use: "I can help you out", "this lines up with what I do", "I have been building [X] for years", "DM me", "PM to see demo videos"
- Never use corporate speak. Keep it casual and direct.

EXAMPLES OF YOUR REAL COMMENTS:
1. "Hi there, I can set up an automated system for you for Reddit Mass DM's. I have already built some automated systems for Reddit and other platforms. PM to see demo videos"
2. "I have sent you a detailed proposal and explained how can I help you with demo videos as well."
3. "Hey @Arkoid, I can help you build a tool that automatically finds the exact subreddits you're looking for based on title/caption prompts. I've worked on multiple Reddit automation and scraping projects."
4. "I can help building you your very own automated system for Mass DM, I have been building such automation systems for years, DM me to get more information on how can I set it up for you and see the demo videos."

Generate ONLY the comment text. No signature. No links. No contact info.
```

### 7.2 Comment Posting Flow

```
1. Open the thread URL in the logged-in Chrome profile
2. Scroll down to the comment box (natural scroll, not instant jump)
3. Click the comment/reply box
4. Type the comment character by character (with human-like speed variation)
5. Wait 2-5 seconds (review pause)
6. Click "Post Reply"
7. Wait for page confirmation
8. Log: thread_id, comment_text, timestamp
9. Mark thread as "commented" in database
```

### 7.3 Comment Limits

- Maximum 5-8 comments per day (BHW may flag aggressive posting)
- Minimum 10-20 minutes between comments (natural spacing)
- Never comment on more than 2 threads in a row without a break
- Vary the time of day — don't always comment at the same hour

---

## 8. DM Engine — Private Outreach

### 8.1 DM Generation

For threads under 1 month old, after commenting, the bot also sends a DM to the thread author. The DM is more detailed than the comment:

```markdown
You are Zee (Zeeshan Ahmad), sending a private message to someone who posted a job on BlackHatWorld. You've already commented on their thread. Now you're following up with a detailed proposal in their DMs.

CRITICAL RULES:
- You ARE Zee. No AI/bot references. Ever.
- Your DM should be a genuine, helpful proposal — not a copy of your comment.
- Be specific about HOW you'd solve their problem.
- If you have relevant demo videos, mention them (use the product catalog to match).
- Keep it professional but casual — this is BHW, not LinkedIn.
- Don't include your signature or links to your services page — you can share Telegram if it feels natural later.
- If the job is complex, outline your approach with bullet points.
- If the job is simple, keep the DM short and direct.

THE JOB POST:
Title: {thread_title}
Description: {thread_description}
Author: {author_username}

YOUR PRODUCT CATALOG (match relevant demos):
{matched products with demo URLs from product catalog}

EXAMPLES OF YOUR REAL FIRST DMs:
1. "Hey @SMMXX, I just saw your post about Instagram Automation for real android devices. This project lines up really well with what I do. I can help: [specific bullet points]"
2. "Hello there, Thanks for reaching out. Yes I can help you out and let me brief it you how it works actually. Basically this is not a service and in fact I am a software developer running a software automation agency."
3. "Hey, This project lines up really well with what I do. I design and scale long-term cold email sending infrastructure that runs daily volume without burning domains. Here's how I'd handle this: [bullet points]"

Generate the DM text. Include relevant demo video links if applicable.
```

### 8.2 DM Sending Flow

```
1. Navigate to BHW messaging/conversation page
2. Start new conversation with the thread author's username
3. Type the DM with human-like speed
4. Click send
5. Log: thread_id, recipient, dm_text, timestamp
6. Mark thread as "dm_sent" in database
```

### 8.3 DM Limits

- Maximum 5-8 DMs per day (BHW may flag mass messaging)
- At least 15-30 minutes after posting the comment (don't DM immediately after commenting)
- Never DM and comment on the same thread within 5 minutes
- Space DMs to different users by at least 10-15 minutes

---

## 9. Conversation Engine — DM Reply Handler

### 9.1 How It Works

The bot checks the BHW inbox every 5 minutes for new messages. When a lead replies to a DM, the bot generates a contextual response.

### 9.2 Reply Generation

```markdown
You are Zee (Zeeshan Ahmad), replying to a message in your BlackHatWorld DM inbox. You are having a conversation with a potential client.

CRITICAL RULES:
- You ARE Zee. Never reveal you're a bot/AI.
- Keep replies natural and conversational.
- Answer their questions directly and specifically.
- If they ask about pricing, give ranges based on the pricing guidelines.
- If the conversation is getting detailed/complex, suggest moving to Telegram: "Hey, let's move this to Telegram for easier chat — @devpilot1"
- If they ask for a call/meeting, say something like "Sure, hit me up on Telegram @devpilot1 and we can set up a time"
- If you're not confident about a technical answer, say "Let me check on that and get back to you" (this pauses the bot for human review)
- Match their energy — casual if they're casual, professional if they're professional.

CONVERSATION HISTORY:
{full DM thread}

THEIR LATEST MESSAGE:
{latest message}

YOUR PRODUCT CATALOG:
{relevant products}

PRICING GUIDELINES:
- Small bots: $200–$500
- Mid-range automation: $500–$1,500
- Full systems: $1,500–$3,000
- Monthly retainers: $2,000–$3,000/mo

Generate your reply. If you think the conversation should be handed off to the real Zee, end with [HANDOFF].
```

### 9.3 Telegram Redirect Strategy

The bot should naturally push leads toward Telegram after:
- 2-3 DM exchanges (if the lead seems engaged)
- The lead asks for contact info
- The conversation gets into detailed scope/pricing
- The lead asks for a call or meeting

Natural redirect phrases:
- "Let's continue on Telegram for easier chat — @devpilot1"
- "Here's my Telegram: @devpilot1 — easier to share files and demos there"
- "Hit me up on Telegram @devpilot1, I'll share the demo videos there"

### 9.4 Handoff to Real Zee

Same principle as the inbound bot — when the LLM outputs `[HANDOFF]`, the bot:
1. Sends the final message (with tag stripped)
2. Stops auto-responding to this conversation
3. Sends WhatsApp alert to Zee with full conversation summary
4. Zee takes over manually on BHW or Telegram

**Handoff triggers:**
- Complex technical discussion beyond 8+ messages
- Lead wants to discuss contract/payment terms
- Lead mentions a budget over $3,000
- LLM is unsure about a technical answer
- Lead gets frustrated or confused

---

## 10. The Golden Rule: Never Reveal The Bot

Same principle as the inbound bot. Every comment, DM, and reply must pass the test: "Would this make someone suspect it's automated?"

**Bot tells specific to BHW:**

| Bot Tell | Our Solution |
|----------|-------------|
| Same comment on every thread | LLM generates unique pitches per job |
| Commenting at 3 AM | Time-of-day awareness — comment during Zee's active hours |
| Instant reply to DMs | 20-90 minute delay on DM replies |
| Perfect identical formatting | LLM varies structure, length, and style |
| Replying to things Zee wouldn't pitch on | LLM qualification filters out non-niche jobs |
| Never making typos | Occasional natural imperfections in generated text |
| Commenting and DMing within seconds | 15-30 minute gap between comment and DM |
| Same pitch to similar jobs | Context-specific pitch per job, even for similar ones |

---

## 11. Follow-Up System — DM Nurturing

### 11.1 Follow-Up Rules

| Condition | Timing | Message Style |
|-----------|--------|---------------|
| DM sent, no reply | 5 days | "Hello there, I hope you are doing good, is there any updates on your end." |
| Second follow-up, still no reply | 12 days after first DM | "Just checking in — still interested in [project]?" |
| Third and final follow-up | 21 days after first DM | "Hey [name], wanted to reach out one last time about [project]. Let me know if you'd like to revisit." |

### 11.2 Follow-Up Exclusions

Do NOT follow up if:
- Lead explicitly said "not interested" / "found someone" / "budget too high"
- Lead moved to Telegram (conversation continues there)
- Conversation was handed off to Zee
- Lead's thread is older than 1 month (they've likely moved on)
- Max 3 follow-ups reached

### 11.3 Follow-Up Generation

Follow-ups are LLM-generated using the conversation context, not templates. The LLM receives the full DM history and generates a natural follow-up that matches Zee's real follow-up style.

---

## 12. Duplication Prevention

### 12.1 Thread-Level Dedup

- Every thread is stored by `thread_id` (extracted from URL)
- Before commenting, check: `SELECT * FROM threads WHERE thread_id = X AND commented = true`
- If already commented → NEVER comment again (even if thread gets bumped)
- This is absolute — zero tolerance for duplicate comments

### 12.2 DM-Level Dedup

- Before DMing, check: `SELECT * FROM dms WHERE thread_id = X AND recipient = Y AND type = 'outreach'`
- Never send more than one outreach DM per thread per user
- Follow-ups are tracked separately and have their own dedup

### 12.3 Cross-Thread User Dedup

- If the same author posts multiple threads (common on BHW), don't DM them again if we already DMed them about a previous thread within the last 30 days
- Comment on the new thread is fine (different conversation), but don't spam their inbox

---

## 13. Anti-Bot Detection — Human Behavior Simulation

### 13.1 Timing

**Comment posting schedule:**
- Only post during Zee's active hours: 9 AM – 11 PM PKT
- Randomize comment times within this window
- No fixed intervals — vary spacing between 10-45 minutes
- Max 5-8 comments per day (start low, increase gradually)

**DM sending schedule:**
- Always 15-30 minutes AFTER the corresponding comment
- Space DMs 10-15 minutes apart
- Max 5-8 DMs per day

**DM reply timing:**
- New inbox messages: reply within 20-90 minutes (randomized)
- Don't reply at night (queue for morning like inbound bot)
- If lead sends multiple messages, wait until they stop, then reply to all

### 13.2 Browser Behavior

**Puppeteer human simulation:**
- Random mouse movements before clicks
- Scroll naturally (not instant jumps)
- Type character by character with variable speed (50-150ms per char)
- Occasional "typo" and backspace (very rare — 1 in 50 chars)
- Click around the page naturally before performing the target action
- Random viewport size (within typical desktop ranges)
- Realistic user agent string
- Enable JavaScript and cookies normally
- Use a real Chrome profile with history and cookies (not a clean profile)

### 13.3 Session Management

- Use a persistent Chrome profile (not incognito)
- The profile has app_pilot's BHW session cookies already saved
- If session expires, alert via WhatsApp — Zee re-logs in manually and updates cookies
- Don't clear cookies or cache between sessions
- Maintain natural browsing history (the bot visits BHW like a normal user)

---

## 14. WhatsApp Alerts & Daily Reports

### 14.1 Alert Types

| Alert Type | Trigger | Format |
|-----------|---------|--------|
| Hot DM Reply | Lead responds positively to outreach or asks about pricing/scope | "BHW HOT LEAD: [username] replied about [project]. They said: [summary]. Score: [X]." |
| Telegram Redirect | Lead accepted Telegram suggestion | "BHW LEAD → TELEGRAM: [username] agreed to move to Telegram for [project]." |
| Handoff | Complex conversation needs Zee | "BHW NEEDS ATTENTION: [username] — conversation about [project] needs your input. Summary: [3 lines]" |
| Session Expired | BHW cookies expired, bot can't act | "BHW SESSION DOWN: app_pilot cookies expired. Please re-login and update." |

### 14.2 Daily Report

Every day at 9 AM PKT, sent to the same WhatsApp group as the inbound bot:

```
BHW OUTBOUND DAILY REPORT
Date: February 27, 2026

THREADS SCRAPED: 47
QUALIFIED POSTS: 6
COMMENTS POSTED: 5
DMS SENT: 4
DM REPLIES RECEIVED: 2
FOLLOW-UPS SENT: 3

HOT LEADS:
- pureseogmbrank — Bulk SMS system ($1,500+ range) — in active DM conversation
- Little John — TikTok comment bot — replied after follow-up, interested

WAITING ON REPLY: 8
MOVED TO TELEGRAM: 1

THREADS SKIPPED (not niche): 41
```

---

## 15. Database Design

```sql
-- Threads discovered on BHW
CREATE TABLE bhw_threads (
    id SERIAL PRIMARY KEY,
    thread_id VARCHAR(50) UNIQUE NOT NULL,
    thread_url TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    author_username VARCHAR(100),
    original_post_date TIMESTAMP,
    last_activity_date TIMESTAMP,
    is_qualified BOOLEAN DEFAULT false,
    qualification_confidence DECIMAL(3,2),
    qualification_reason TEXT,
    pitch_angle TEXT,
    is_commented BOOLEAN DEFAULT false,
    comment_text TEXT,
    comment_date TIMESTAMP,
    is_dm_sent BOOLEAN DEFAULT false,
    dm_date TIMESTAMP,
    is_skipped BOOLEAN DEFAULT false,
    skip_reason VARCHAR(200),
    created_at TIMESTAMP DEFAULT NOW()
);

-- DM conversations tracked
CREATE TABLE bhw_conversations (
    id SERIAL PRIMARY KEY,
    thread_id VARCHAR(50) REFERENCES bhw_threads(thread_id),
    participant_username VARCHAR(100) NOT NULL,
    conversation_status VARCHAR(30) DEFAULT 'outreach_sent',
    -- statuses: outreach_sent, lead_replied, active, telegram_redirect, handed_off, cold, closed
    lead_score INTEGER DEFAULT 0,
    dm_count INTEGER DEFAULT 0,
    last_message_date TIMESTAMP,
    last_message_sender VARCHAR(20),
    moved_to_telegram BOOLEAN DEFAULT false,
    is_handed_off BOOLEAN DEFAULT false,
    is_bot_active BOOLEAN DEFAULT true,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Individual DM messages
CREATE TABLE bhw_messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES bhw_conversations(id),
    sender VARCHAR(20),             -- 'me' or 'client'
    message_text TEXT,
    message_type VARCHAR(20) DEFAULT 'dm',  -- 'dm', 'comment', 'follow_up'
    sent_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Follow-ups scheduled
CREATE TABLE bhw_followups (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES bhw_conversations(id),
    scheduled_at TIMESTAMP,
    followup_number INTEGER DEFAULT 1,
    message_sent TEXT,
    was_sent BOOLEAN DEFAULT false,
    was_responded BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Daily activity log
CREATE TABLE bhw_daily_reports (
    id SERIAL PRIMARY KEY,
    report_date DATE UNIQUE,
    threads_scraped INTEGER,
    threads_qualified INTEGER,
    comments_posted INTEGER,
    dms_sent INTEGER,
    replies_received INTEGER,
    followups_sent INTEGER,
    leads_to_telegram INTEGER,
    report_content TEXT,
    sent_to_whatsapp BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Bot state
CREATE TABLE bhw_bot_state (
    id SERIAL PRIMARY KEY,
    key VARCHAR(100) UNIQUE NOT NULL,
    value JSONB,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Deduplication index
CREATE INDEX idx_threads_thread_id ON bhw_threads(thread_id);
CREATE INDEX idx_threads_author ON bhw_threads(author_username);
CREATE INDEX idx_conversations_participant ON bhw_conversations(participant_username);
CREATE INDEX idx_conversations_status ON bhw_conversations(conversation_status);
```

---

## 16. Browser Automation — Chrome Profile & Puppeteer

### 16.1 Chrome Profile Setup

```
1. Create a Chrome profile directory: C:\BitbashBHW\chrome-profile\
2. Open Chrome with this profile: chrome.exe --user-data-dir=C:\BitbashBHW\chrome-profile
3. Navigate to BlackHatWorld and log in as app_pilot
4. Complete any CAPTCHA or 2FA
5. Close Chrome
6. The profile now has saved cookies/session

Puppeteer will launch with this same profile:
puppeteer.launch({
    headless: false,  // or 'new' for headless
    userDataDir: 'C:\\BitbashBHW\\chrome-profile',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
});
```

### 16.2 Key Puppeteer Operations

**Read thread listing:**
```javascript
// Navigate to Hire a Freelancer
await page.goto('https://www.blackhatworld.com/forums/hire-a-freelancer.76/');
// Extract thread data from DOM
const threads = await page.$$eval('.structItem', items => items.map(item => ({
    id: item.dataset.threadId,
    title: item.querySelector('.structItem-title a')?.textContent,
    url: item.querySelector('.structItem-title a')?.href,
    author: item.querySelector('.username')?.textContent,
    date: item.querySelector('time')?.getAttribute('datetime'),
})));
```

**Post a comment:**
```javascript
// Navigate to thread
await page.goto(threadUrl);
// Scroll to reply box
await humanScroll(page, 'bottom');
// Click reply editor
await page.click('.fr-element');
// Type with human speed
await humanType(page, commentText);
// Click post
await page.click('button[type="submit"]');
```

**Send a DM:**
```javascript
// Navigate to conversation start
await page.goto(`https://www.blackhatworld.com/conversations/add?to=${username}`);
// Fill title
await humanType(page, '#title', dmSubject);
// Fill message body
await humanType(page, '.fr-element', dmText);
// Click send
await page.click('button[type="submit"]');
```

**Read inbox:**
```javascript
// Navigate to conversations
await page.goto('https://www.blackhatworld.com/conversations/');
// Extract conversations with unread indicators
const conversations = await page.$$eval('.structItem', items => items.map(item => ({
    id: item.dataset.conversationId,
    title: item.querySelector('.structItem-title a')?.textContent,
    participant: item.querySelector('.username')?.textContent,
    isUnread: item.classList.contains('is-unread'),
    lastMessage: item.querySelector('.structItem-latestDate time')?.textContent,
})));
```

### 16.3 Session Health Check

Every 30 minutes, verify the BHW session is still active:
1. Navigate to a BHW page
2. Check if the user menu shows "app_pilot"
3. If not logged in → send WhatsApp alert, pause all actions
4. Zee re-logs in manually, restarts the bot

---

## 17. Admin Interface

### 17.1 Admin Panel (localhost:3001)

Separate port from inbound bot's admin panel.

**Dashboard:**
- Today's stats: threads scraped, qualified, commented, DMs sent, replies
- Bot status (on/off/paused)
- BHW session status (active/expired)

**Threads:**
- All scraped threads with qualification status
- Filter by: qualified, skipped, commented, DM sent
- Override: mark a thread as "pitch this" or "skip this" manually
- View qualification reasoning

**Conversations:**
- All active DM conversations
- Conversation status (outreach, replied, active, telegram, cold)
- View full message history
- Per-conversation controls: pause bot, force handoff, add notes

**Qualification Settings:**
- Edit niche keywords and rules
- View "maybe" threads (confidence 0.4-0.7) for manual review
- Override qualification for specific threads

**Limits & Timing:**
- Max comments per day (default: 6)
- Max DMs per day (default: 6)
- Comment spacing (default: 10-45 min)
- DM reply delay (default: 20-90 min)
- Active hours (default: 9 AM - 11 PM PKT)

---

## 18. Windows Server Deployment

### 18.1 Prerequisites (additional to inbound bot)

- Chrome browser installed (not Chromium — real Chrome for profile compatibility)
- Puppeteer: `npm install puppeteer-core` (use installed Chrome, not bundled)
- Sufficient RAM: Puppeteer + Chrome needs ~500MB additional

### 18.2 Installation

```powershell
# Create project directory
mkdir C:\BitbashBHW
cd C:\BitbashBHW

# Initialize
npm init -y
npm install puppeteer-core cheerio dotenv pg node-cron express cors openclaw

# Create Chrome profile
mkdir chrome-profile

# Create .env
@"
OPENAI_API_KEY=sk-your-key-here
DATABASE_URL=postgresql://bitbash:password@localhost:5432/bitbash_bhw
CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
CHROME_PROFILE=C:\BitbashBHW\chrome-profile
BHW_BASE_URL=https://www.blackhatworld.com
ADMIN_PORT=3001
ADMIN_PASSWORD=your_password
TIMEZONE=Asia/Karachi
ACTIVE_HOURS_START=9
ACTIVE_HOURS_END=23
MAX_COMMENTS_PER_DAY=6
MAX_DMS_PER_DAY=6
"@ | Out-File -FilePath .env -Encoding UTF8
```

### 18.3 Running

```powershell
# PM2 setup
pm2 start engine/pipeline.js --name "bhw-outbound-bot"
pm2 start admin-panel/server.js --name "bhw-admin"
pm2 save
```

---

## 19. Security & Access Control

- BHW cookies stored in Chrome profile only — never exported or logged
- If session expires, bot pauses everything and alerts via WhatsApp
- Admin panel password protected, localhost only
- OpenAI API key in `.env` only
- Never log full DM content to console (only to database with access controls)
- Puppeteer runs with `--no-sandbox` flag — acceptable for trusted environment
- Rate limits enforced strictly — exceeding BHW's tolerance risks account ban

---

## 20. Development Phases & Timeline

### Phase 1: Foundation
- Project scaffolding, database setup, Puppeteer Chrome profile configuration
- BHW page scraper (headless, extract threads)
- Thread detail fetcher (get descriptions)
- Duplication prevention system
- Database seeding

### Phase 2: Intelligence
- OpenClaw integration with GPT-4o mini
- LLM qualification engine ("Is this our niche?")
- Comment pitch generator
- DM outreach generator

### Phase 3: Actions
- Puppeteer comment poster (with human behavior simulation)
- Puppeteer DM sender
- Human behavior engine (delays, typing, scrolling)
- Comment and DM scheduling / limits

### Phase 4: Inbox & Conversation
- Inbox reader (detect new messages)
- DM reply generator
- Conversation state tracking
- Telegram redirect logic
- Handoff system

### Phase 5: Follow-ups & Alerts
- Follow-up scheduler and executor
- WhatsApp alert system (hot leads, session issues)
- Daily report generator
- Deal risk detection

### Phase 6: Admin & Deployment
- Admin panel (dashboard, threads, conversations, settings)
- PM2 service setup
- Backup scripts
- Full integration testing
- Production launch

---

## 21. Testing Plan

### 21.1 Unit Tests

| Test Area | Cases |
|-----------|-------|
| Thread parser | Extracts correct data from BHW HTML |
| Dedup engine | Prevents duplicate comments and DMs |
| Qualifier | Correctly classifies niche vs non-niche posts |
| Human behavior | Delays are within expected ranges, typing speed varies |
| Follow-up scheduler | Fires at correct intervals, respects exclusions |

### 21.2 Integration Tests

| Test | Steps | Expected |
|------|-------|----------|
| Full scrape cycle | Run scraper on live BHW page | Threads extracted, new ones identified, known ones skipped |
| Qualification | Feed 20 sample posts (from postsamples.json) | SEO/backlinks rejected, automation/dev jobs accepted |
| Comment posting | Post on a test thread | Comment appears as app_pilot, natural timing |
| DM sending | Send DM to a test account | DM delivered, logged in database |
| Inbox monitoring | Receive test DM reply | Bot detects new message, generates appropriate reply |
| Follow-up | Lead goes cold for 5 days | Follow-up fires with contextual message |
| Telegram redirect | Conversation reaches 3+ exchanges | Bot naturally suggests Telegram |
| Handoff | Complex conversation | Bot stops, WhatsApp alert fires |
| Session health | Expire cookies manually | Bot detects, pauses, alerts via WhatsApp |
| Duplication | Run scraper twice on same page | No duplicate comments or DMs |
| Daily report | Trigger report generation | Accurate stats sent to WhatsApp |
| Night mode | DM arrives at 2 AM PKT | No reply until morning |
| Bot never reveals itself | Test various conversation paths | No message says AI/bot/automated |

### 21.3 Qualification Test (against real data)

Feed all 20 posts from `postsamples.json` through the qualifier:

**Should QUALIFY:**
- HIRING - Redesign my mobile version of Wordpress/Elementor Site (web dev)
- [HaF] Hiring someone to make WP design (web dev)
- SMM Ads (edge case — depends on description)

**Should REJECT:**
- I need Indian players via Google ads
- GMB verification, USA
- Looking for motion design / pitchdeck
- WTB - Forbes US Featured Placement
- SEO Expert Needed for Turkish Casino Keywords
- [WTB] 3 Marketing/SEO related links
- Need Guest Post on High Quality sites
- Looking for .sg or .ai backlinks for SEO
- Need Professional SEO Person for Casino/Gambling Keywords
- All other SEO/backlink posts

---

## 22. Launch Checklist

### Pre-Launch

- [ ] All phases implemented and tested
- [ ] Chrome profile has active BHW session (app_pilot logged in)
- [ ] Qualification engine tested against 20+ sample posts
- [ ] Comment generation produces varied, natural pitches
- [ ] DM generation produces detailed, specific proposals
- [ ] Duplication prevention verified (no double comments)
- [ ] Rate limits configured (6 comments/day, 6 DMs/day)
- [ ] Active hours configured (9 AM - 11 PM PKT)
- [ ] WhatsApp alerts tested
- [ ] Daily report tested