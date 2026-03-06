import dotenv from 'dotenv';

dotenv.config();

export const config = {
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'bhw_bot',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  },
  
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    logPrompts: process.env.LOG_PROMPTS === 'true', // set LOG_PROMPTS=true in .env during dev
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022',
  },
  
  bhw: {
    username: process.env.BHW_USERNAME || 'app_pilot',
    chromeProfilePath: process.env.BHW_CHROME_PROFILE_PATH,
    scrapeIntervalMin: parseInt(process.env.BHW_SCRAPE_INTERVAL_MIN) || 1200000,  // 20 minutes
    scrapeIntervalMax: parseInt(process.env.BHW_SCRAPE_INTERVAL_MAX) || 2400000,  // 40 minutes
    inboxCheckInterval: parseInt(process.env.BHW_INBOX_CHECK_INTERVAL) || 3600000, // 1 hour
    baseUrl: 'https://www.blackhatworld.com/forums/hire-a-freelancer.76/',
  },
  
  whatsapp: {
    groupName: process.env.WA_GROUP_NAME || 'Bitbash BHW Bot',
  },

  bot: {
    minDelay: parseInt(process.env.MIN_DELAY_MS) || 2000,
    maxDelay: parseInt(process.env.MAX_DELAY_MS) || 8000,
    typingSpeedMin: parseInt(process.env.TYPING_SPEED_MIN) || 50,
    typingSpeedMax: parseInt(process.env.TYPING_SPEED_MAX) || 150,
    maxFollowUps:    parseInt(process.env.MAX_FOLLOW_UPS)    || 3,   // plan §5.2: 3 touches max
    dailyCommentCap: parseInt(process.env.DAILY_COMMENT_CAP) || 25,  // GAP-03
    dailyDmCap:      parseInt(process.env.DAILY_DM_CAP)      || 25,  // GAP-03
    followUpDays: (process.env.FOLLOW_UP_DAYS || '7,12,21')          // plan §5.2
      .split(',')
      .map(d => parseInt(d.trim())),
  },

  system: {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT) || 3000,
  },

  // ── Threads Owner Outreach Module ───────────────────────────────────────
  outreach: {
    enabled:            process.env.OUTREACH_ENABLED === 'true',
    dailyCap:           parseInt(process.env.OUTREACH_DAILY_CAP)              || 5,
    activeStartUtc:     parseInt(process.env.OUTREACH_ACTIVE_START_UTC)       || 15, // 10am US Eastern
    activeEndUtc:       parseInt(process.env.OUTREACH_ACTIVE_END_UTC)         || 7,  // 2am US Eastern
    windowJitterMin:    parseInt(process.env.OUTREACH_WINDOW_JITTER_MINUTES)  || 30,
    minGapMinutes:      parseInt(process.env.OUTREACH_MIN_GAP_MINUTES)        || 90,
    followUp1Days:      parseInt(process.env.OUTREACH_FOLLOWUP1_DAYS)         || 3,
    followUp2Days:      parseInt(process.env.OUTREACH_FOLLOWUP2_DAYS)         || 7,
    followUp3Days:      parseInt(process.env.OUTREACH_FOLLOWUP3_DAYS)         || 14,
    // Preview mode: generate + WA notify, skip actual BHW send, mark target 'previewed'
    // so next cycle picks fresh targets. Flip to false when ready to go live.
    previewMode:        process.env.OUTREACH_PREVIEW_MODE === 'true',
  },
};
