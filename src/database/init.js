import pg from 'pg';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';

const { Pool } = pg;

export const pool = new Pool(config.database);

export async function initDatabase() {
  try {
    const client = await pool.connect();
    logger.info('Database connection established');

    // Safe migrations — add columns that may not exist in older schemas

    // leads table — columns added in later versions of the scraper
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS poster_url TEXT;`);
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS post_date TIMESTAMPTZ;`);
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS thread_age_category VARCHAR(20);`);
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';`);

    // leads qualification columns
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_qualified BOOLEAN DEFAULT FALSE;`);
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS qualification_reason TEXT;`);
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS niche_match_score INTEGER DEFAULT 0;`);
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS tier VARCHAR(20);`);
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS pitch_angle TEXT;`);
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS commented BOOLEAN DEFAULT FALSE;`);
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS commented_at TIMESTAMPTZ;`);
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS dm_sent BOOLEAN DEFAULT FALSE;`);
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS dm_sent_at TIMESTAMPTZ;`);
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'new';`);
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS converted BOOLEAN DEFAULT FALSE;`);
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;`);

    // activity_log table — columns missing from initial schema
    await client.query(`ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS description TEXT;`);
    await client.query(`ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'success';`);
    await client.query(`ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS error_message TEXT;`);
    await client.query(`ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS action_type VARCHAR(100);`);
    await client.query(`ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS metadata JSONB;`);

    // dms table — AI tracing columns
    await client.query(`ALTER TABLE dms ADD COLUMN IF NOT EXISTS generated_by TEXT;`);
    await client.query(`ALTER TABLE dms ADD COLUMN IF NOT EXISTS prompt_used TEXT;`);

    await client.query(`
      ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS bhw_conversation_url TEXT;
    `);

    await client.query(`
      ALTER TABLE follow_ups
      ADD COLUMN IF NOT EXISTS paused_reason TEXT;
    `);

    // [HANDOFF] detection columns
    await client.query(`
      ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS is_handed_off BOOLEAN DEFAULT FALSE;
    `);

    await client.query(`
      ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS handed_off_at TIMESTAMP;
    `);

    await client.query(`
      ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS handoff_reason TEXT;
    `);

    // AI Engine call logging — token usage, latency, success/fail per function
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_logs (
        id             SERIAL PRIMARY KEY,
        function_name  TEXT    NOT NULL,
        tokens_in      INTEGER,
        tokens_out     INTEGER,
        latency_ms     INTEGER,
        success        BOOLEAN DEFAULT TRUE,
        error_message  TEXT,
        lead_id        INTEGER,
        created_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_logs_function ON ai_logs(function_name);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_logs_created ON ai_logs(created_at);
    `);

    // Community commenter — tracks BHW threads we've already replied to organically
    await client.query(`
      CREATE TABLE IF NOT EXISTS community_comments (
        id             SERIAL PRIMARY KEY,
        thread_id      TEXT    NOT NULL UNIQUE,
        thread_url     TEXT    NOT NULL,
        thread_title   TEXT,
        category       TEXT,
        relevance_score INTEGER DEFAULT 0,
        comment_text   TEXT,
        comment_url    TEXT,
        comment_id     TEXT,
        posted_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        dry_run        BOOLEAN DEFAULT FALSE
      );
    `);

    // ── THREADS OWNER OUTREACH MODULE migrations ─────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS outreach_targets (
        id               SERIAL PRIMARY KEY,
        thread_id        VARCHAR(200) UNIQUE NOT NULL,
        thread_url       TEXT        NOT NULL,
        title            TEXT,
        description      TEXT,
        poster_username  VARCHAR(100),
        status           VARCHAR(30)  NOT NULL DEFAULT 'pending',
        skip_reason      TEXT,
        contacted_at     TIMESTAMPTZ,
        last_reply_at    TIMESTAMPTZ,
        added_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_outreach_targets_status   ON outreach_targets(status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_outreach_targets_username ON outreach_targets(poster_username);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_outreach_targets_added_at ON outreach_targets(added_at);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS outreach_conversations (
        id                     SERIAL PRIMARY KEY,
        target_id              INTEGER NOT NULL REFERENCES outreach_targets(id) ON DELETE CASCADE,
        bhw_conversation_url   TEXT,
        status                 VARCHAR(30)  NOT NULL DEFAULT 'active',
        message_count          INTEGER NOT NULL DEFAULT 0,
        our_message_count      INTEGER NOT NULL DEFAULT 0,
        their_message_count    INTEGER NOT NULL DEFAULT 0,
        last_response_from     VARCHAR(10),
        started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_message_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_outreach_convs_target ON outreach_conversations(target_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_outreach_convs_status ON outreach_conversations(status);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS outreach_dms (
        id               SERIAL PRIMARY KEY,
        target_id        INTEGER NOT NULL REFERENCES outreach_targets(id)       ON DELETE CASCADE,
        conversation_id  INTEGER NOT NULL REFERENCES outreach_conversations(id) ON DELETE CASCADE,
        direction        VARCHAR(10)  NOT NULL,
        message_text     TEXT        NOT NULL,
        message_type     VARCHAR(40),
        sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_outreach_dms_target ON outreach_dms(target_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_outreach_dms_conv   ON outreach_dms(conversation_id);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS outreach_follow_ups (
        id               SERIAL PRIMARY KEY,
        target_id        INTEGER NOT NULL REFERENCES outreach_targets(id)       ON DELETE CASCADE,
        conversation_id  INTEGER NOT NULL REFERENCES outreach_conversations(id) ON DELETE CASCADE,
        follow_up_number INTEGER NOT NULL,
        scheduled_for    TIMESTAMPTZ NOT NULL,
        message_text     TEXT,
        status           VARCHAR(20)  NOT NULL DEFAULT 'pending',
        sent_at          TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_outreach_fups_target    ON outreach_follow_ups(target_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_outreach_fups_status    ON outreach_follow_ups(status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_outreach_fups_scheduled ON outreach_follow_ups(scheduled_for);`);

    // ── PIPELINE D — Niche Comment Scout ────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_scout_posts (
        id                SERIAL PRIMARY KEY,
        thread_id         VARCHAR(50) UNIQUE NOT NULL,
        thread_url        TEXT NOT NULL,
        title             TEXT,
        poster_username   VARCHAR(100),
        body              TEXT,
        posted_at         TIMESTAMPTZ,
        niche             VARCHAR(100),
        verdict           TEXT,
        comment_angle     TEXT,
        raw_ai_response   JSONB,
        discord_sent      BOOLEAN DEFAULT FALSE,
        discord_sent_at   TIMESTAMPTZ,
        created_at        TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_scout_discord
      ON niche_scout_posts(discord_sent) WHERE discord_sent = FALSE;
    `);

    client.release();
    return true;
  } catch (error) {
    logger.error('Failed to connect to database:', error);
    throw error;
  }
}

export async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    // Silently swallow pool-already-closed errors — these are cosmetic and only
    // occur when fire-and-forget ai_logs writes race with pool.end() in tests.
    if (error.message && error.message.includes('pool after calling end')) {
      throw error;
    }
    logger.error('Database query error:', { text, error: error.message });
    throw error;
  }
}

export async function getClient() {
  return await pool.connect();
}
