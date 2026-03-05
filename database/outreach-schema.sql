-- ═══════════════════════════════════════════════════════════════════════════
-- THREADS OWNER OUTREACH MODULE — Database Schema
-- ═══════════════════════════════════════════════════════════════════════════
-- These 4 tables are fully isolated from the main pipeline tables.
-- No foreign keys into leads, conversations, dms, or follow_ups.
-- Run via init.js migrations (CREATE TABLE IF NOT EXISTS — safe to re-run).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. outreach_targets
--    Master list seeded from CSV. Never auto-populated by the bot.
--    Processed FIFO by added_at ASC, 5 targets per day.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_targets (
  id               SERIAL PRIMARY KEY,
  thread_id        VARCHAR(200) UNIQUE NOT NULL,          -- extracted from URL
  thread_url       TEXT        NOT NULL,                  -- full BHW thread URL
  title            TEXT,                                  -- from CSV or scraped
  description      TEXT,                                  -- OP body, scraped on first contact
  poster_username  VARCHAR(100),                          -- from CSV or scraped

  status           VARCHAR(30)  NOT NULL DEFAULT 'pending',
  -- pending | dm_sent | replied | cold | skip

  skip_reason      TEXT,
  -- no_username | scrape_failed | already_contacted_outreach | already_contacted_main_pipeline

  contacted_at     TIMESTAMPTZ,                           -- first DM sent time
  last_reply_at    TIMESTAMPTZ,                           -- last time THEY replied

  added_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),   -- when seeded from CSV
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_targets_status     ON outreach_targets(status);
CREATE INDEX IF NOT EXISTS idx_outreach_targets_username   ON outreach_targets(poster_username);
CREATE INDEX IF NOT EXISTS idx_outreach_targets_added_at   ON outreach_targets(added_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. outreach_conversations
--    One row per started DM conversation.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_conversations (
  id                     SERIAL PRIMARY KEY,
  target_id              INTEGER NOT NULL REFERENCES outreach_targets(id) ON DELETE CASCADE,
  bhw_conversation_url   TEXT,                            -- stored after first DM sent

  status                 VARCHAR(30)  NOT NULL DEFAULT 'active',
  -- active | waiting_reply | replied | cold | closed

  message_count          INTEGER NOT NULL DEFAULT 0,
  our_message_count      INTEGER NOT NULL DEFAULT 0,
  their_message_count    INTEGER NOT NULL DEFAULT 0,
  last_response_from     VARCHAR(10),                     -- 'us' or 'them'

  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_convs_target   ON outreach_conversations(target_id);
CREATE INDEX IF NOT EXISTS idx_outreach_convs_status   ON outreach_conversations(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. outreach_dms
--    Every message in every outreach conversation.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_dms (
  id               SERIAL PRIMARY KEY,
  target_id        INTEGER NOT NULL REFERENCES outreach_targets(id)        ON DELETE CASCADE,
  conversation_id  INTEGER NOT NULL REFERENCES outreach_conversations(id)  ON DELETE CASCADE,

  direction        VARCHAR(10)  NOT NULL,                 -- 'outbound' | 'inbound'
  message_text     TEXT        NOT NULL,
  message_type     VARCHAR(40),
  -- initial_pitch | follow_up_1 | follow_up_2 | follow_up_3 | reply

  sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_dms_target   ON outreach_dms(target_id);
CREATE INDEX IF NOT EXISTS idx_outreach_dms_conv     ON outreach_dms(conversation_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. outreach_follow_ups
--    Pre-generated follow-up messages, scheduled at DM send time.
--    Day 3 / Day 7 / Day 14 relative to contacted_at.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_follow_ups (
  id               SERIAL PRIMARY KEY,
  target_id        INTEGER NOT NULL REFERENCES outreach_targets(id)        ON DELETE CASCADE,
  conversation_id  INTEGER NOT NULL REFERENCES outreach_conversations(id)  ON DELETE CASCADE,

  follow_up_number INTEGER NOT NULL,                      -- 1, 2, or 3
  scheduled_for    TIMESTAMPTZ NOT NULL,                  -- contacted_at + 3/7/14 days
  message_text     TEXT,                                  -- pre-generated at DM send time

  status           VARCHAR(20)  NOT NULL DEFAULT 'pending',
  -- pending | sent | cancelled | failed

  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_fups_target        ON outreach_follow_ups(target_id);
CREATE INDEX IF NOT EXISTS idx_outreach_fups_status        ON outreach_follow_ups(status);
CREATE INDEX IF NOT EXISTS idx_outreach_fups_scheduled     ON outreach_follow_ups(scheduled_for);

-- ─────────────────────────────────────────────────────────────────────────────
-- Auto-updated updated_at triggers
-- ─────────────────────────────────────────────────────────────────────────────
-- Reuse or create the trigger function (safe if it already exists)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'update_outreach_targets_updated_at'
  ) THEN
    CREATE TRIGGER update_outreach_targets_updated_at
    BEFORE UPDATE ON outreach_targets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'update_outreach_conversations_updated_at'
  ) THEN
    CREATE TRIGGER update_outreach_conversations_updated_at
    BEFORE UPDATE ON outreach_conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'update_outreach_follow_ups_updated_at'
  ) THEN
    CREATE TRIGGER update_outreach_follow_ups_updated_at
    BEFORE UPDATE ON outreach_follow_ups
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
