-- Bitbash BHW Bot Database Schema
-- Version: 1.0
-- Date: February 27, 2026

-- =====================================================
-- LEADS TABLE
-- Stores all job posts discovered from BHW
-- =====================================================
CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    thread_id VARCHAR(200) UNIQUE NOT NULL,
    thread_url TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    poster_username VARCHAR(100),
    poster_url TEXT,
    post_date TIMESTAMP,
    discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Qualification status
    is_qualified BOOLEAN DEFAULT FALSE,
    qualification_reason TEXT,
    niche_match_score INTEGER, -- 0-100
    
    -- Age categorization
    thread_age_category VARCHAR(20), -- 'fresh' (<1 month), 'old' (1-12 months), 'ancient' (>1 year)
    
    -- Actions taken
    commented BOOLEAN DEFAULT FALSE,
    commented_at TIMESTAMP,
    comment_id VARCHAR(200),
    
    dm_sent BOOLEAN DEFAULT FALSE,
    dm_sent_at TIMESTAMP,
    
    -- Lead status
    status VARCHAR(50) DEFAULT 'discovered', -- discovered, qualified, contacted, responded, moved_to_telegram, closed, cold
    last_interaction TIMESTAMP,
    
    -- Metadata
    tags TEXT[], -- e.g., ['automation', 'shopify', 'scraping']
    notes TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- COMMENTS TABLE
-- Tracks all public comments made on threads
-- =====================================================
CREATE TABLE IF NOT EXISTS comments (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    comment_id VARCHAR(50) UNIQUE,
    comment_text TEXT NOT NULL,
    posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    thread_url TEXT NOT NULL,
    
    -- Generation metadata
    generated_by VARCHAR(50) DEFAULT 'gpt-4o-mini',
    prompt_used TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- DMS TABLE
-- All direct messages sent (both initial and replies)
-- =====================================================
CREATE TABLE IF NOT EXISTS dms (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    conversation_id INTEGER, -- Links to conversations table
    
    direction VARCHAR(10) NOT NULL, -- 'outbound' or 'inbound'
    message_text TEXT NOT NULL,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Message type
    message_type VARCHAR(50), -- 'initial_pitch', 'follow_up', 'reply', 'telegram_push', 'closing'
    
    -- Generation metadata (for outbound only)
    generated_by VARCHAR(50),
    prompt_used TEXT,
    
    -- Tracking
    read_by_recipient BOOLEAN DEFAULT FALSE,
    replied_to BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- CONVERSATIONS TABLE
-- Tracks DM conversation threads with each lead
-- =====================================================
CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Status
    status VARCHAR(50) DEFAULT 'active', -- active, waiting_reply, cold, moved_to_telegram, closed
    message_count INTEGER DEFAULT 0,
    our_message_count INTEGER DEFAULT 0,
    their_message_count INTEGER DEFAULT 0,
    
    -- Engagement tracking
    avg_response_time_minutes INTEGER,
    last_response_from VARCHAR(10), -- 'us' or 'them'
    
    -- Temperature (engagement level)
    temperature VARCHAR(20) DEFAULT 'warm', -- hot, warm, cool, cold
    
    -- Actions
    telegram_offered BOOLEAN DEFAULT FALSE,
    telegram_offered_at TIMESTAMP,
    moved_to_telegram BOOLEAN DEFAULT FALSE,
    moved_to_telegram_at TIMESTAMP,
    
    -- Metadata
    summary TEXT, -- AI-generated summary of conversation
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- FOLLOW_UPS TABLE
-- Scheduled follow-up messages for cold/unresponsive leads
-- =====================================================
CREATE TABLE IF NOT EXISTS follow_ups (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    
    scheduled_for TIMESTAMP NOT NULL,
    follow_up_number INTEGER NOT NULL, -- 1st, 2nd, 3rd follow-up etc.
    
    status VARCHAR(20) DEFAULT 'pending', -- pending, sent, cancelled, failed
    sent_at TIMESTAMP,
    
    message_text TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- NICHE_KEYWORDS TABLE
-- Keywords and patterns for niche qualification
-- =====================================================
CREATE TABLE IF NOT EXISTS niche_keywords (
    id SERIAL PRIMARY KEY,
    keyword VARCHAR(100) NOT NULL,
    category VARCHAR(50), -- e.g., 'primary', 'secondary', 'exclude'
    weight INTEGER DEFAULT 1, -- Scoring weight
    is_active BOOLEAN DEFAULT TRUE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- ACTIVITY_LOG TABLE
-- Logs all bot actions for monitoring and debugging
-- =====================================================
CREATE TABLE IF NOT EXISTS activity_log (
    id SERIAL PRIMARY KEY,
    action_type VARCHAR(50) NOT NULL, -- 'scrape', 'comment', 'dm', 'follow_up', 'error', etc.
    lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    
    description TEXT,
    metadata JSONB, -- Additional data in JSON format
    
    status VARCHAR(20) DEFAULT 'success', -- success, failed, pending
    error_message TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- DAILY_REPORTS TABLE
-- Stores daily summary reports
-- =====================================================
CREATE TABLE IF NOT EXISTS daily_reports (
    id SERIAL PRIMARY KEY,
    report_date DATE UNIQUE NOT NULL,
    
    -- Stats
    threads_scraped INTEGER DEFAULT 0,
    leads_qualified INTEGER DEFAULT 0,
    comments_posted INTEGER DEFAULT 0,
    dms_sent INTEGER DEFAULT 0,
    replies_received INTEGER DEFAULT 0,
    telegram_conversions INTEGER DEFAULT 0,
    
    -- Summary
    hot_leads TEXT[],
    report_text TEXT,
    sent_to_whatsapp BOOLEAN DEFAULT FALSE,
    sent_at TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- INDEXES for performance
-- =====================================================
CREATE INDEX idx_leads_thread_id ON leads(thread_id);
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_discovered_at ON leads(discovered_at DESC);
CREATE INDEX idx_leads_qualified ON leads(is_qualified);

CREATE INDEX idx_dms_lead_id ON dms(lead_id);
CREATE INDEX idx_dms_conversation_id ON dms(conversation_id);
CREATE INDEX idx_dms_direction ON dms(direction);

CREATE INDEX idx_conversations_lead_id ON conversations(lead_id);
CREATE INDEX idx_conversations_status ON conversations(status);

CREATE INDEX idx_follow_ups_scheduled_for ON follow_ups(scheduled_for);
CREATE INDEX idx_follow_ups_status ON follow_ups(status);

CREATE INDEX idx_activity_log_action_type ON activity_log(action_type);
CREATE INDEX idx_activity_log_created_at ON activity_log(created_at DESC);

-- =====================================================
-- TRIGGERS for updated_at timestamps
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_leads_updated_at BEFORE UPDATE ON leads
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_conversations_updated_at BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_follow_ups_updated_at BEFORE UPDATE ON follow_ups
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_niche_keywords_updated_at BEFORE UPDATE ON niche_keywords
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
