# Social Brain Module — Dev Plan

**Project:** Bitbash BHW Outbound Sales Bot  
**Module:** `src/services/socialBrain.js`  
**Scope:** Semantic retrieval of past community comments to inject as few-shot context into the Community Commenter engine only  
**Status:** 📋 Planned — not started  
**Created:** March 1, 2026

---

## Problem Statement

The Community Commenter (`src/engines/community-commenter.js`) posts helpful organic replies in BHW discussion sub-forums. It currently generates those replies using `knowledge-base.json` — a flat JSON file with category buckets and tagged tips. This has two hard limits:

1. **Voice & style are lost.** Tips explain *what* to say, not *how we say it*. The LLM defaults to generic GPT-style prose, not Zeeshan's actual community voice.
2. **The KB can't scale.** As we accumulate hundreds of real community comment examples, we cannot dump them all into every prompt — context windows have limits and cost spikes linearly.

**Solution:** Build a retrieval system specifically for community comments. Every real community reply we've written becomes a searchable example. When the commenter finds a new thread, it embeds that thread's post, finds the 5 most semantically similar past threads we've already commented on, and injects those 5 thread→comment pairs as few-shot examples into the prompt. The LLM now replies in Zeeshan's actual community voice.

### ⚠️ Explicit Out-of-Scope

This module is **ONLY** for `community-commenter.js`. The following engines are **NOT** touched:

- `dm.js` — hire-a-freelancer DMs stay as-is
- `comment.js` — hire-a-freelancer outreach comments stay as-is
- `conversation.js` / `inbox-monitor.js` — conversation replies stay as-is
- `follow-up.js` — follow-up messages stay as-is

Those engines have a different goal (direct sales outreach) and already work well. Social Brain is purely for improving the organic community persona.

---

## Scope (exactly what social-brain does)

```
INPUT:  new BHW discussion thread text (title + opening post snippet)
PROCESS: embed → search Qdrant → retrieve top 5 similar past thread→comment pairs
OUTPUT: array of { thread, comment } objects injected into generateCommunityComment() prompt
```

That is the entire module. It does **not** generate replies itself — it enriches the context that `community-commenter.js` passes to `aiEngine.generateCommunityComment()`.

---

## Architecture

```
knowledge-base.json (existing)               ←── still used for tips/facts (unchanged)
                                                    |
past-community-comments.json (NEW)           ←── raw seed data: thread+comment pairs
                  |                                 |  (30+ manually written examples)
                  ▼                                 |
        social-brain/ingest.js               ←── one-time + incremental ingest script
                  |
          OpenAI text-embedding-3-small       ←── embed each thread text
                  |
              Qdrant (local Docker)           ←── vector DB, collection: "community_comments"
                  |
        src/services/socialBrain.js           ←── getFewShotExamples() retrieval module
                  |
        src/engines/community-commenter.js    ←── calls getFewShotExamples() before generation
                  |
          aiEngine.generateCommunityComment() ←── receives fewShotExamples[] as context
```

---

## Tech Stack

| Component | Choice | Reason |
|---|---|---|
| Embedding model | `text-embedding-3-small` (OpenAI) | Same provider as LLM — no new auth needed. 1536-dim, cheap ($0.02/1M tokens), fast |
| Vector DB | Qdrant (Docker, local) | Best OSS option: native payload filtering, fast ANN search, no cloud lock-in, runs on same server as the bot |
| Qdrant Node client | `@qdrant/js-client-rest` | Official, ESM-compatible |
| Collection name | `community_comments` | Dedicated collection for community thread→reply pairs only |
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

**Goal:** Assemble a JSON file of real BHW discussion thread→community comment pairs that represent Zeeshan's community voice.

**Important:** These are NOT hire-a-freelancer DMs or sales pitches. These are the organic, helpful replies Zeeshan would write in BHW discussion sub-forums (SEO, Programming, Tools, Web Design, etc.).

#### Format

Create `src/data/past-community-comments.json` — an array of objects:

```json
[
  {
    "id": "cc_001",
    "thread": "My Scrapy spider keeps getting blocked even with rotating proxies. I've tried 10 different proxy providers and still getting 403s on page 2+.",
    "comment": "Proxies alone won't fix it if your fingerprint is still robotic. The issue is usually WebGL/canvas entropy, not the IP. Try puppeteer-real-browser with stealth mode — it randomizes the fingerprint on every launch. Also check your timing: most detection systems measure variance between events, not just request rate. Add jitter between scroll events too, not just between page loads.",
    "forum": "Programming",
    "tags": ["scraping", "puppeteer", "fingerprint", "proxy"],
    "date": "2026-02-15"
  },
  ...
]
```

#### Where to get the data (since we have none yet)

**Option A — Manual: export BHW post history**
- Log into BHW as app_pilot
- Check post history for any real community replies already made
- Copy thread text + our reply into the JSON
- Even 15–20 real ones are enough to start

**Option B — Synthetic seed (recommended for bootstrapping)**
- Write 30–50 example thread→comment pairs manually that match Zeeshan's voice
- These act as seed data until real live comments accumulate
- Cover the 8 sub-forums the community commenter already scans:
  - SEO, Black Hat SEO, Programming, PHP, Tools, Social Media, Web Design, General
- Focus on topics overlapping our expertise: scraping, automation, bots, WooCommerce, APIs, Laravel

**Option C — Auto-harvest (after going live)**
- After the bot is live, every successful community comment is saved to the `community_comments` DB table (already exists)
- Nightly sync job picks up `embedded = FALSE` rows, embeds them, upserts to Qdrant
- KB grows automatically — no manual steps

**Minimum viable dataset:** 30 pairs spread across at least 4 topic categories.

**Deliverable:** `src/data/past-community-comments.json` with ≥30 entries.

---

### Step 2 — Create Qdrant Collection

**Goal:** Create the `community_comments` collection with the right vector config.

#### Script: `social-brain/setup-collection.js`

```js
import { QdrantClient } from '@qdrant/js-client-rest';

const client = new QdrantClient({ url: process.env.QDRANT_URL });

await client.createCollection('community_comments', {
  vectors: {
    size: 1536,          // text-embedding-3-small output dimensions
    distance: 'Cosine',
  },
});

console.log('Collection created: community_comments');
```

Run once: `node social-brain/setup-collection.js`

**Deliverable:** Collection created and visible in Qdrant dashboard at `http://localhost:6333/dashboard`.

---

### Step 3 — Ingest Script (Embed + Store)

**Goal:** Read `past-community-comments.json`, embed each `thread` field using OpenAI, store vector + payload in Qdrant.

#### Script: `social-brain/ingest.js`

**What it does:**
1. Reads `src/data/past-community-comments.json`
2. For each entry, checks if `id` already exists in Qdrant (skip if yes — idempotent)
3. Embeds the `thread` text via `text-embedding-3-small`
4. Upserts to Qdrant: vector = embedding, payload = `{ id, thread, comment, forum, tags, date }`
5. Logs progress

**Usage:**

```bash
# First time — ingest all entries
node social-brain/ingest.js

# After adding new entries to past-community-comments.json — only ingests new ones
node social-brain/ingest.js

# Force re-embed everything (e.g. after changing embedding model)
node social-brain/ingest.js --force
```

**Batching:** OpenAI's embedding API accepts up to 2048 inputs per call — batch in groups of 100 to avoid timeouts.

**Deliverable:** All entries stored in Qdrant. Verify via dashboard or `GET /collections/community_comments`.

---

### Step 4 — Production Retrieval Module

**Goal:** Build `src/services/socialBrain.js` — the module that existing engines call.

#### API (what `community-commenter.js` imports)

```js
import { getFewShotExamples } from '../services/socialBrain.js';

// Returns top-K most semantically similar past community thread→comment pairs
const examples = await getFewShotExamples(threadText, { topK: 5 });
// → [{ thread, comment, score }, ...]
```

#### Implementation outline

```js
// src/services/socialBrain.js

import { QdrantClient }  from '@qdrant/js-client-rest';
import { embedText }     from './socialBrainEmbed.js';  // thin wrapper around OpenAI embed API
import logger            from '../utils/logger.js';

const client     = new QdrantClient({ url: process.env.QDRANT_URL || 'http://localhost:6333' });
const COLLECTION = process.env.QDRANT_COLLECTION || 'community_comments';
const DEFAULT_K  = parseInt(process.env.QDRANT_TOP_K) || 5;

export async function getFewShotExamples(threadText, opts = {}) {
  const topK = opts.topK ?? DEFAULT_K;

  // 1. Embed the query (thread title + OP snippet)
  const queryVector = await embedText(threadText);

  // 2. Search Qdrant
  const results = await client.search(COLLECTION, {
    vector:       queryVector,
    limit:        topK,
    with_payload: true,
    score_threshold: 0.70,   // ignore low-quality matches
  });

  // 3. Return clean array
  return results.map(r => ({
    thread:  r.payload.thread,
    comment: r.payload.comment,
    score:   r.score,
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

### Step 5 — Wire Into community-commenter.js + aiEngine.js

**Goal:** Inject retrieved examples into the LLM prompt for community comment generation only.

#### What changes in `aiEngine.js`

Only `generateCommunityComment()` gets a new optional `fewShotExamples` parameter:

```js
// Before
async generateCommunityComment(threadTitle, opSnippet, tips, category) { ... }

// After
async generateCommunityComment(threadTitle, opSnippet, tips, category, fewShotExamples = []) { ... }
```

All other generation functions (`generateDMOutreach`, `generateConversationReply`, `qualifyLead`, etc.) are **not changed**.

#### How examples are formatted in the prompt

```js
function formatFewShotBlock(examples) {
  if (!examples || examples.length === 0) return '';

  const lines = ['--- PAST COMMUNITY COMMENTS (use as voice and style reference only — do not copy) ---'];
  for (const [i, ex] of examples.entries()) {
    lines.push(`\nExample ${i + 1}:`);
    lines.push(`Thread: ${ex.thread}`);
    lines.push(`Our comment: ${ex.comment}`);
  }
  lines.push('\n--- Write a new comment in the same voice and tone ---');
  return lines.join('\n');
}
```

The block is injected into the system prompt before the generation instruction:

```
[Zee persona / community member description]
[Few-shot examples block]    ← NEW
[Tips from knowledge-base]   ← existing
[Generation instruction: "Write a helpful reply to this thread:"]
[Thread title + OP snippet]
```

#### Call site in `community-commenter.js`:

```js
import { getFewShotExamples } from '../services/socialBrain.js';

// Inside runCommunityCycle(), after relevance classification passes:
const queryText = `${thread.title} ${snippet}`;
const examples  = await getFewShotExamples(queryText).catch(() => []);

commentText = await aiEngine.generateCommunityComment(
  thread.title,
  snippet,
  tips,
  classification.category,
  examples,            // ← new param
);
```

If Qdrant is down or returns nothing, `examples` is `[]` and the function falls back to its current behaviour — no hard dependency.

**Deliverable:** Community comments are enriched with retrieved voice examples. DMs, follow-ups, and outreach comments are completely unchanged.

---

### Step 6 — Auto-Ingest New Live Comments (Self-Learning)

**Goal:** Every community comment the bot successfully posts is automatically fed back into Qdrant so the KB grows by itself.

#### No new DB table needed

The `community_comments` table already exists and already stores every posted comment. It has:
- `thread_url`, `thread_title` — the post that was replied to
- `comment_text` — what the bot wrote
- `dry_run` — only real (non-dry-run) comments are useful

We add a single boolean column:

```sql
ALTER TABLE community_comments ADD COLUMN embedded BOOLEAN DEFAULT FALSE;
```

#### Nightly sync job: `social-brain/sync-live-comments.js`

```bash
# Cron: run at 02:00 every night (or run manually anytime)
node social-brain/sync-live-comments.js
```

**What it does:**
1. Queries `community_comments WHERE embedded = FALSE AND dry_run = FALSE AND comment_text IS NOT NULL`
2. For each row: embeds `thread_title + comment_text` snippet → upserts to Qdrant collection `community_comments`
3. Marks `embedded = TRUE` in DB
4. Logs how many new comments were synced

This is the only place that touches DMs, conversations, or follow-ups — it does **not**. It only reads from `community_comments`.

**Deliverable:** KB grows automatically as the bot posts real community comments. No manual steps after initial setup.

---

### Step 7 — Test

**Goal:** Verify the full retrieval pipeline works end to end.

#### Test file: `test-social-brain.js`

Tests to cover:

| # | Test |
|---|---|
| T01 | Qdrant connection — `GET /health` returns OK |
| T02 | `embedText()` — returns 1536-dim float array |
| T03 | `getFewShotExamples()` with a scraping-related thread — returns ≤5 results |
| T04 | All returned results have score ≥ 0.70 |
| T05 | Unrelated query (e.g. "looking for a logo designer") returns 0 results (filtered by score threshold) |
| T06 | Ingest idempotency — running `ingest.js` twice produces no Qdrant duplicates |
| T07 | Full `generateCommunityComment()` with examples — output is richer vs without examples |
| T08 | Qdrant down / timeout → `getFewShotExamples()` returns `[]` gracefully, no crash |

**Deliverable:** `node test-social-brain.js` — all 8 passing.

---

## File Summary

```
social-brain/
  setup-collection.js       ← run once: create Qdrant collection "community_comments"
  ingest.js                 ← embed + store past-community-comments.json into Qdrant
  sync-live-comments.js     ← nightly: embed new live community_comments rows → Qdrant

src/
  services/
    socialBrain.js          ← getFewShotExamples() — main production module
    socialBrainEmbed.js     ← thin OpenAI embedding wrapper
  engines/
    community-commenter.js  ← MODIFIED: call getFewShotExamples() before generateCommunityComment()
  services/
    aiEngine.js             ← MODIFIED: add fewShotExamples param to generateCommunityComment() only
  data/
    past-community-comments.json  ← raw KB seed: array of { id, thread, comment, forum, tags }

database/
  schema.sql                ← ADD: ALTER TABLE community_comments ADD COLUMN embedded BOOLEAN

test-social-brain.js        ← T01–T08 end-to-end test
```

**Files NOT changed:** `dm.js`, `comment.js`, `conversation.js`, `inbox-monitor.js`, `follow-up.js`, `queries.js` (except the ALTER TABLE), `index.js`, `scraper/`

New `.gitignore` entries needed:
```
.qdrant_storage/
```

New `.env` entries needed:
```
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=community_comments
QDRANT_TOP_K=5
```

---

## Effort Estimate

| Step | Work |
|---|---|
| Step 0 — Setup | 15 min |
| Step 1 — Data collection (seed 30 community comment pairs) | 2–3 hrs |
| Step 2 — Create collection | 10 min |
| Step 3 — Ingest script | 45 min |
| Step 4 — socialBrain.js module | 45 min |
| Step 5 — Wire into community-commenter.js + aiEngine.js | 45 min |
| Step 6 — Nightly sync job | 45 min |
| Step 7 — Tests | 1 hr |
| **Total** | **~7–8 hrs** |

Bottleneck is Step 1 — the seed data doesn't exist yet. Everything else is straightforward code.

---

## Open Questions (resolve before starting)

1. **Seed data source:** Synthetic examples written manually to match Zeeshan's community voice, OR export real BHW post history if any exists. Even 20 real ones beat 50 synthetic ones.
2. **Score threshold:** 0.70 is a sensible default. Tune after testing: raise to 0.75 if results feel semantically unrelated, lower to 0.65 if valid queries return nothing.
3. **Fallback:** If Qdrant is down or returns 0 results, `getFewShotExamples()` returns `[]` — `generateCommunityComment()` already handles an empty array by falling back to tip-only context. No hard dependency, no crashes.
4. **Re-embedding on model change:** If we ever switch from `text-embedding-3-small`, all vectors in `community_comments` collection need to be deleted and re-indexed from scratch. Document before switching.

---

## Dependencies on Current Codebase

| File | Change | Breaking? |
|---|---|---|
| `src/engines/community-commenter.js` | Add `getFewShotExamples()` call before `generateCommunityComment()` | No — optional param |
| `src/services/aiEngine.js` | Add `fewShotExamples = []` param to `generateCommunityComment()` only | No — optional param |
| `database/schema.sql` | `ALTER TABLE community_comments ADD COLUMN embedded BOOLEAN DEFAULT FALSE` | No — additive |
| **Everything else** | **No changes** | — |

DMs, follow-ups, hire-a-freelancer outreach comments, conversation replies — completely untouched.
