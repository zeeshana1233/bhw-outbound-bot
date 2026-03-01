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
