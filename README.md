# Bitbash BHW Bot - README

## Overview
Automated outbound sales bot for BlackHatWorld's "Hire a Freelancer" section. Built for Bitbash Software Development Agency.

## Features
- 🔍 **Auto Job Discovery** - Scrapes BHW every 2 minutes for new opportunities
- 🎯 **AI Qualification** - GPT-4o mini determines if jobs match our niche
- 💬 **Smart Commenting** - Posts personalized public comments on threads
- 📩 **DM Automation** - Sends tailored pitches via private message
- 🤖 **Conversation Handler** - Responds intelligently to DM replies
- 📈 **Follow-up System** - Nurtures cold leads automatically
- 🔔 **WhatsApp Alerts** - Daily reports of activity and hot leads
- 🎭 **Human Simulation** - Random delays, natural typing, anti-bot detection

## Tech Stack
- **Runtime:** Node.js (ES Modules)
- **Browser Automation:** Puppeteer + Stealth Plugin
- **Database:** PostgreSQL
- **AI:** OpenAI GPT-4o mini
- **Messaging:** WhatsApp Web.js
- **Logging:** Winston

## Setup

### 1. Prerequisites
- Node.js 18+
- PostgreSQL 14+
- Chrome browser with logged-in BHW profile

### 2. Install Dependencies
```bash
npm install
```

### 3. Database Setup
```bash
# Create database
createdb bhw_bot

# Run schema
psql -d bhw_bot -f database/schema.sql

# Seed data
psql -d bhw_bot -f database/seed.sql
```

### 4. Environment Configuration
```bash
cp .env.example .env
```

Edit `.env` and configure:
- Database credentials
- OpenAI API key
- Chrome profile path
- WhatsApp settings

### 5. Chrome Profile
1. Open Chrome with a dedicated profile
2. Log into BlackHatWorld as `app_pilot`
3. Note the profile path (e.g., `~/Library/Application Support/Google/Chrome/Profile 1`)
4. Add path to `.env`

## Usage

### Start the Bot
```bash
npm start
```

### Development Mode (with auto-restart)
```bash
npm run dev
```

## Project Structure
```
├── src/
│   ├── index.js                 # Main entry point
│   ├── config/
│   │   └── config.js           # Configuration management
│   ├── database/
│   │   ├── init.js             # Database connection
│   │   └── queries.js          # SQL queries
│   ├── engines/
│   │   ├── comment.js          # Public comment engine
│   │   ├── dm.js               # Direct message engine
│   │   ├── conversation.js     # Conversation handler
│   │   ├── follow-up.js        # Follow-up system
│   │   ├── inbox-monitor.js    # Inbox checker
│   │   └── qualification.js    # Niche qualification
│   ├── scraper/
│   │   └── index.js            # BHW scraper
│   ├── services/
│   │   ├── browser.js          # Puppeteer wrapper
│   │   └── openai.js           # OpenAI integration
│   └── utils/
│       ├── helpers.js          # Utility functions
│       └── logger.js           # Winston logger
├── database/
│   ├── schema.sql              # Database schema
│   └── seed.sql                # Seed data
├── logs/                       # Log files (auto-generated)
├── .env.example                # Environment template
├── package.json
└── README.md
```

## How It Works

### Main Loops

**Loop 1: Discovery & Outreach (every 2 minutes)**
1. Scrape BHW "Hire a Freelancer" page
2. Check for new threads (not in database)
3. Qualify each thread with AI
4. Comment on qualified threads
5. Send DM to fresh threads (<1 month old)

**Loop 2: Inbox Monitor (every 5 minutes)**
1. Check BHW inbox for new messages
2. Route to conversation engine
3. Generate AI reply
4. Send response
5. Update conversation status

**Loop 3: Follow-ups (hourly)**
1. Check for pending follow-ups
2. Send scheduled messages
3. Update lead status

## Safety Features
- ✅ Duplication prevention (never contacts same lead twice)
- ✅ Human behavior simulation (random delays, typing patterns)
- ✅ Anti-bot detection (Puppeteer Stealth)
- ✅ Rate limiting (respects BHW's limits)
- ✅ Error recovery (graceful failures)

## Monitoring
- All actions logged to `logs/combined.log`
- Errors logged to `logs/error.log`
- Daily WhatsApp reports
- Database activity log

## Development Status
🚧 **Project is currently in development** 

See [PROJECT_LOG.md](PROJECT_LOG.md) for progress tracking.

## License
Private - Bitbash Software Development Agency

## Contact
Zeeshan Ahmad - Bitbash
