# Social Brain Module — Dev Plan

**Project:** Bitbash BHW Outbound Sales Bot  
**Module:** `src/services/socialBrain.js`  
**Scope:** Semantic retrieval of past post-reply pairs to inject as few-shot context before LLM generation  
**Status:** 📋 Planned — not started  
**Created:** March 1, 2026

---

## Problem Statement

The bot generates replies (comments, DMs, follow-ups) using a static `knowledge-base.json` — a flat JSON file with category buckets and tagged tips. This approach has two hard limits:

1. **Voice & style are lost.** Tips explain *what* to say, not *how we say it*. The LLM defaults to generic GPT-style prose, not Zeeshan's actual conversational voice.
2. **The KB can't scale.** As we accumulate hundreds of real post-reply pairs, we can't dump them all into every prompt — context windows have limits and cost spikes linearly.

**Solution:** Build a retrieval system. Every real reply we've ever written becomes a searchable example. When a new post arrives, embed it, find the 5 most semantically similar past posts, and inject those 5 post→reply pairs as few-shot examples into the prompt. The LLM now has *real* examples of our voice for each specific scenario rather than generic instructions.

---

## Scope (exactly what social-brain does)

```
INPUT:  new post text (from BHW thread, inbox message, or hire-a-freelancer listing)
PROCESS: embed → search Qdrant → retrieve top 5 similar past post-reply pairs
OUTPUT: array of { post, reply } objects ready to be injected into any LLM prompt
```

That is the entire module. It does **not** generate replies itself — it enriches the context that existing engines (comment, DM, conversation) pass to `aiEngine.js`.

---

## Architecture

```
knowledge-base.json (existing)          ←── still used for tips/facts (structural knowledge)
                                               |
past-replies/ CSV or manual entry       ←── NEW: raw data source
                  |
                  ▼
        social-brain/ingest.js          ←── one-time + incremental ingest script
                  |
          OpenAI text-embedding-3-small  ←── embed each post-reply pair
                  |
              Qdrant (local Docker)      ←── vector DB, collection: "bhw_replies"
                  |
        src/services/socialBrain.js     ←── production retrieval module
                  |
             aiEngine.js                ←── pass retrieved examples as fewShotExamples[]
```

---

## Tech Stack

| Component | Choice | Reason |
|---|---|---|
| Embedding model | `text-embedding-3-small` (OpenAI) | Same provider as LLM — no new auth needed. 1536-dim, cheap ($0.02/1M tokens), fast |
| Vector DB | Qdrant (Docker, local) | Best OSS option: native payload filtering, fast ANN search, no cloud lock-in, runs on same server as the bot |
| Qdrant Node client | `@qdrant/js-client-rest` | Official, ESM-compatible |
| Collection name | `bhw_replies` | One collection, payload stores metadata |
| Distance metric | Cosine | Standard for text embeddings |

---

## Step-by-Step Dev Plan

---

### Step 0 — Prerequisites & Setup

**Goal:** Get Qdrant running locally and install the JS client.

#### 0a — Run Qdrant via Docker

```bash
docker pull qdrant/qdrant
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 \
  -v $(pwd)/.qdrant_storage:/qdrant/storage \
  qdrant/qdrant
```

This gives you:
- REST API at `http://localhost:6333`
- Dashboard at `http://localhost:6333/dashboard`
- Data persisted to `.qdrant_storage/` (add to `.gitignore`)

Verify: `curl http://localhost:6333/health` → `{"title":"qdrant","version":"..."}`

#### 0b — Install JS client

```bash
npm install @qdrant/js-client-rest
```

#### 0c — Add env vars to `.env` / `.env.example`

```
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=bhw_replies
QDRANT_TOP_K=5
```

**Deliverable:** Qdrant running, client installed, env vars set.

---

### Step 1 — Data Collection (Populate the Raw KB)

**Goal:** Assemble a CSV/JSON file of real post→reply pairs that represent our voice.

#### Format

Create `src/data/past-replies.json` — an array of objects:

```json
[
  {
    "id": "reply_001",
    "post": "Looking for a developer to build a Telegram bot with subscription management and Stripe. Budget $800, timeline 2 weeks.",
    "reply": "Hey, this is right in our wheelhouse — we've shipped 15+ Telegram bots with Stripe/payment integrations. Two weeks is totally doable for a clean sub management system. DM me with your exact feature list and I'll send a breakdown with timeline.",
    "context": "hire-a-freelancer DM",
    "tags": ["telegram", "stripe", "bot", "subscription"],
    "date": "2026-02-01"
  },
  ...
]
```

#### Where to get the data (since we have none yet)

**Option A — Manual: export BHW conversation history**
- Log into BHW as app_pilot
- Go to Conversations (inbox)
- Copy-paste our sent replies into the JSON file
- 20–30 real replies is enough to start

**Option B — Synthetic seed (bootstrapping)**
- Write 30–50 example post→reply pairs manually that match Zeeshan's voice
- These act as seed data until real replies accumulate
- Cover all common scenarios: Telegram bots, React apps, WooCommerce, API integrations, scraping, urgency signals

**Option C — Auto-harvest (future, Phase 2)**
- After the bot goes live, automatically log every reply it sends to `past_replies` DB table
- Nightly job re-embeds new rows and upserts them into Qdrant
- KB grows by itself as the bot operates

**Minimum viable dataset:** 30 pairs covering 5-6 project types.

**Deliverable:** `src/data/past-replies.json` with ≥30 entries.

---

### Step 2 — Create Qdrant Collection

**Goal:** Create the `bhw_replies` collection with the right vector config.

#### Script: `social-brain/setup-collection.js`

```js
import { QdrantClient } from '@qdrant/js-client-rest';

const client = new QdrantClient({ url: process.env.QDRANT_URL });

await client.createCollection('bhw_replies', {
  vectors: {
    size: 1536,          // text-embedding-3-small output dimensions
    distance: 'Cosine',
  },
});
```

Run once: `node social-brain/setup-collection.js`

**Deliverable:** Collection created and visible in Qdrant dashboard.

---

### Step 3 — Ingest Script (Embed + Store)

**Goal:** Read `past-replies.json`, embed each `post` field using OpenAI, store vector + payload in Qdrant.

#### Script: `social-brain/ingest.js`

**What it does:**
1. Reads `src/data/past-replies.json`
2. For each entry, checks if `id` already exists in Qdrant (skip if yes — idempotent)
3. Embeds the `post` text via `text-embedding-3-small`
4. Upserts to Qdrant: vector = embedding, payload = `{ id, post, reply, context, tags, date }`
5. Logs progress

**Usage:**

```bash
# First time — ingest all 30 entries
node social-brain/ingest.js

# After adding new entries to past-replies.json — only ingests new ones
node social-brain/ingest.js

# Force re-embed everything (e.g. after changing embedding model)
node social-brain/ingest.js --force
```

**Batching:** OpenAI's embedding API accepts up to 2048 inputs per call — batch in groups of 100 to avoid timeouts.

**Deliverable:** All entries stored in Qdrant. Verify via dashboard or `GET /collections/bhw_replies`.

---

### Step 4 — Production Retrieval Module

**Goal:** Build `src/services/socialBrain.js` — the module that existing engines call.

#### API (what other modules import)

```js
import { getFewShotExamples } from './socialBrain.js';

// Returns top-K most semantically relevant past post-reply pairs
const examples = await getFewShotExamples(postText, { topK: 5 });
// → [{ post, reply, score }, ...]
```

#### Implementation outline

```js
// src/services/socialBrain.js

import { QdrantClient }  from '@qdrant/js-client-rest';
import { embedText }     from './socialBrainEmbed.js';  // thin wrapper around OpenAI embed API
import logger            from '../utils/logger.js';

const client     = new QdrantClient({ url: process.env.QDRANT_URL || 'http://localhost:6333' });
const COLLECTION = process.env.QDRANT_COLLECTION || 'bhw_replies';
const DEFAULT_K  = parseInt(process.env.QDRANT_TOP_K) || 5;

export async function getFewShotExamples(postText, opts = {}) {
  const topK = opts.topK ?? DEFAULT_K;

  // 1. Embed the query
  const queryVector = await embedText(postText);

  // 2. Search Qdrant
  const results = await client.search(COLLECTION, {
    vector:       queryVector,
    limit:        topK,
    with_payload: true,
    score_threshold: 0.70,   // ignore low-quality matches
  });

  // 3. Return clean array
  return results.map(r => ({
    post:  r.payload.post,
    reply: r.payload.reply,
    score: r.score,
  }));
}
```

#### Separate embed helper: `src/services/socialBrainEmbed.js`

```js
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function embedText(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.substring(0, 8000),   // stay well within token limit
  });
  return response.data[0].embedding;
}
```

**Deliverable:** `getFewShotExamples(postText)` works and returns relevant examples.

---

### Step 5 — Wire Into aiEngine.js

**Goal:** Inject retrieved examples into the LLM prompts for DMs, comments, and conversation replies.

#### What changes in `aiEngine.js`

Each generation function (`generateDMOutreach`, `generateCommunityComment`, `generateConversationReply`) gets a new optional `fewShotExamples` parameter:

```js
// Before
async generateDMOutreach(lead) { ... }

// After
async generateDMOutreach(lead, fewShotExamples = []) { ... }
```

#### How examples are formatted in the prompt

```js
function formatFewShotBlock(examples) {
  if (!examples || examples.length === 0) return '';

  const lines = ['--- PAST REPLIES (use these as style reference, not templates) ---'];
  for (const [i, ex] of examples.entries()) {
    lines.push(`\nExample ${i + 1}:`);
    lines.push(`Post: ${ex.post}`);
    lines.push(`Our reply: ${ex.reply}`);
  }
  lines.push('\n--- Write a new reply in the same voice and tone ---');
  return lines.join('\n');
}
```

The block is injected into the system prompt before the generation instruction:

```
[Zee persona description]
[Few-shot examples block]
[Generation instruction: "Write a reply to this post:"]
[The actual post text]
```

#### Call site (e.g. in `dm.js`):

```js
import { getFewShotExamples } from '../services/socialBrain.js';

// Inside generateAndSendDM():
const examples = await getFewShotExamples(lead.description).catch(() => []);
const dmText   = await aiEngine.generateDMOutreach(lead, examples);
```

**Deliverable:** DMs, comments, and conversation replies are all enriched with retrieved examples.

---

### Step 6 — Auto-Ingest New Replies (Live Learning)

**Goal:** As the bot sends real replies, they automatically feed back into the KB so it improves over time.

#### What to add to `queries.js`

```sql
-- New table
CREATE TABLE past_replies (
  id           SERIAL PRIMARY KEY,
  reply_type   TEXT NOT NULL,   -- 'dm' | 'comment' | 'conversation'
  post_text    TEXT NOT NULL,
  reply_text   TEXT NOT NULL,
  thread_url   TEXT,
  lead_id      INT REFERENCES leads(id),
  embedded     BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
```

#### What to add to the engines

After every successful reply send, insert a row:

```js
await savePastReply({ replyType: 'dm', postText: lead.description, replyText: dmText, threadUrl: lead.thread_url, leadId: lead.id });
```

#### Nightly sync job in `social-brain/sync-new-replies.js`

```bash
# Cron: run at 02:00 every night
node social-brain/sync-new-replies.js
```

Queries `past_replies WHERE embedded = FALSE`, embeds them, upserts to Qdrant, marks `embedded = TRUE`.

**Deliverable:** KB grows automatically after every sent reply. No manual steps after initial setup.

---

### Step 7 — Test

**Goal:** Verify the full retrieval pipeline works end to end.

#### Test file: `test-social-brain.js`

Tests to cover:

| # | Test |
|---|---|
| T01 | Qdrant connection — `GET /health` returns OK |
| T02 | `embedText()` — returns 1536-dim float array |
| T03 | `getFewShotExamples()` — returns ≤5 results for a Telegram bot query |
| T04 | Results have score ≥ 0.70 |
| T05 | Lower-relevance query (e.g. "need a logo designer") returns 0 results (score threshold filters them) |
| T06 | Ingest idempotency — running ingest.js twice doesn't duplicate entries |
| T07 | Full DM generation with examples — output is longer/richer than without |

**Deliverable:** `node test-social-brain.js` — all passing.

---

## File Summary

```
social-brain/
  setup-collection.js     ← run once: create Qdrant collection
  ingest.js               ← embed + store past-replies.json into Qdrant
  sync-new-replies.js     ← nightly: embed new live replies from DB → Qdrant

src/
  services/
    socialBrain.js        ← getFewShotExamples() — main production module
    socialBrainEmbed.js   ← thin OpenAI embedding wrapper
  data/
    past-replies.json     ← raw KB: array of { id, post, reply, context, tags }

database/
  schema.sql              ← add past_replies table

test-social-brain.js      ← T01–T07 end-to-end test
```

New `.gitignore` entries needed:
```
.qdrant_storage/
```

New `.env` entries needed:
```
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=bhw_replies
QDRANT_TOP_K=5
```

---

## Effort Estimate

| Step | Work |
|---|---|
| Step 0 — Setup | 15 min |
| Step 1 — Data collection (manual seed 30 pairs) | 2–3 hrs |
| Step 2 — Create collection | 10 min |
| Step 3 — Ingest script | 1 hr |
| Step 4 — socialBrain.js module | 1 hr |
| Step 5 — Wire into aiEngine.js (3 functions) | 1–2 hrs |
| Step 6 — Auto-ingest loop | 1 hr |
| Step 7 — Tests | 1 hr |
| **Total** | **~8–10 hrs** |

Bottleneck is Step 1 — the data doesn't exist yet. Everything else is straightforward code.

---

## Open Questions (resolve before starting)

1. **Seed data source:** Do we use synthetic examples or export real sent replies from BHW first? Real ones are better — even 20 real replies beat 200 synthetic ones.
2. **Score threshold:** 0.70 is a sensible default but needs tuning based on actual data. If results feel unrelated, raise to 0.75. If you get no results on valid queries, lower to 0.65.
3. **Fallback strategy:** If Qdrant is down or returns 0 results, `getFewShotExamples()` returns `[]` — the engines already handle empty arrays gracefully (fall back to current behaviour). No hard dependency.
4. **Re-embedding on model change:** If we ever switch from `text-embedding-3-small`, all vectors need to be re-indexed. Document this clearly.

---

## Dependencies on Current Codebase

- `aiEngine.js` — add `fewShotExamples` param to 3 generation functions (non-breaking, optional param)
- `dm.js`, `comment.js`, `conversation.js` — each adds one `getFewShotExamples()` call before generation
- `database/schema.sql` + `queries.js` — add `past_replies` table
- No changes to scraper, session, or any other module
