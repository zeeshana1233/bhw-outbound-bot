import dotenv from 'dotenv';

dotenv.config();

/**
 * Parse SCRAPER_PROXY_URL into puppeteer-real-browser proxy options.
 * Accepts:
 *   user:pass@host:port
 *   http://user:pass@host:port
 *   host:port  (no auth)
 * Returns null if unset / invalid. Never log the password.
 */
function parseScraperProxy(raw) {
  if (!raw || !String(raw).trim()) return null;
  let s = String(raw).trim();
  s = s.replace(/^https?:\/\//i, '');
  const at = s.lastIndexOf('@');
  let user = undefined;
  let pass = undefined;
  let hostPort = s;
  if (at !== -1) {
    const creds = s.slice(0, at);
    hostPort = s.slice(at + 1);
    const colon = creds.indexOf(':');
    if (colon === -1) return null;
    user = creds.slice(0, colon);
    pass = creds.slice(colon + 1);
  }
  const hpColon = hostPort.lastIndexOf(':');
  if (hpColon === -1) return null;
  const host = hostPort.slice(0, hpColon);
  const port = parseInt(hostPort.slice(hpColon + 1), 10);
  if (!host || !Number.isFinite(port)) return null;
  return { host, port, username: user, password: pass };
}

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
    // Anonymous scraper residential proxy (Pipeline C). null = direct VPS IP.
    scraperProxy: parseScraperProxy(process.env.SCRAPER_PROXY_URL),
  },
  
  discord: {
    botToken:            process.env.DISCORD_BOT_TOKEN,
    channelId:           process.env.DISCORD_CHANNEL_ID          || '',
    guildId:             process.env.DISCORD_GUILD_ID             || '',
    dmAlertsChannelId:   process.env.DISCORD_DM_ALERTS_CHANNEL_ID || '',
    clientInboxChannelId: process.env.DISCORD_CLIENT_INBOX_CHANNEL_ID || '',
    pipelineCChannelId:  process.env.PIPELINE_C_CHANNEL_ID      || '',
    nicheScoutChannelId: process.env.NICHE_SCOUT_CHANNEL_ID     || '',
  },

  // Pipeline C only — anonymous job notifier. When true: scrape + Discord job
  // cards only. No comment/DM outreach, no Threads Owner Outreach, no login.
  // Default true so A/B cannot re-enable by accident.
  pipelineCOnly: process.env.PIPELINE_C_ONLY !== 'false',

  // ── Pipeline D — Niche Comment Scout ────────────────────────────────────
  // After Hire-a-Freelancer scrape: What's New → today + non-marketplace →
  // Relay chatgpt classify → Discord for sales (no bot commenting).
  nicheScout: {
    enabled:     process.env.NICHE_SCOUT_ENABLED === 'true',
    whatsNewUrl: process.env.NICHE_SCOUT_WHATS_NEW_URL
      || 'https://www.blackhatworld.com/whats-new/posts/',
    maxPerRun:   parseInt(process.env.NICHE_SCOUT_MAX_PER_RUN) || 25,
  },

  // Relay AI Browser Automation Gateway (used by Niche Scout)
  relay: {
    apiKey:    process.env.RELAY_API_KEY || '',
    baseUrl:   (process.env.RELAY_BASE_URL || 'https://vmi3391996.tail98bcdc.ts.net').replace(/\/$/, ''),
    serviceId: process.env.RELAY_SERVICE_ID || 'chatgpt',
  },

  bot: {
    minDelay: parseInt(process.env.MIN_DELAY_MS) || 2000,
    maxDelay: parseInt(process.env.MAX_DELAY_MS) || 8000,
    typingSpeedMin: parseInt(process.env.TYPING_SPEED_MIN) || 50,
    typingSpeedMax: parseInt(process.env.TYPING_SPEED_MAX) || 150,
    maxFollowUps:    parseInt(process.env.MAX_FOLLOW_UPS)    || 3,   // plan §5.2: 3 touches max
    dailyCommentCap: parseInt(process.env.DAILY_COMMENT_CAP) || 25,  // GAP-03
    dailyDmCap:      parseInt(process.env.DAILY_DM_CAP)      || 25,  // GAP-03
    commentingEnabled: process.env.PIPELINE_A_COMMENTING_ENABLED === 'true', // default false (DM-only mode)
    todayOnly:         process.env.PIPELINE_A_TODAY_ONLY !== 'false',       // default true (only today's jobs)
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
