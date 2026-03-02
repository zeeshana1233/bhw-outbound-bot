/**
 * AI Engine — Plain OpenAI API, Zee's Voice
 *
 * Full replacement for the former openclaw service.
 * All 9 generation functions plus the new scoreLeadHotness utility.
 *
 * Architecture decision (per consultant review 2026-02-28):
 *   Plain openai.chat.completions.create() calls — no agent framework.
 *   Shared persona injected via zeePersona.buildSystemPrompt().
 *   Retry logic, centralised JSON fence stripping, and DB logging
 *   all live in callAI() so individual functions stay clean.
 */

import OpenAI from 'openai';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';
import { buildSystemPrompt, ZEE_SYSTEM_PROMPT } from './zeePersona.js';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

// ─────────────────────────────────────────────────────────────────────────────
// CORE callAI — used by every function below
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Call OpenAI with automatic retry, centralised JSON fence stripping, and logging.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} options
 * @param {number}  [options.temperature=0.7]
 * @param {number}  [options.max_tokens=2000]
 * @param {string}  [options.functionName='unknown'] - Label for logs
 * @param {'json'|'text'} [options.responseFormat='text']
 * @returns {string} Raw response string (JSON fences already stripped)
 */
export async function callAI(systemPrompt, userPrompt, options = {}) {
  const {
    temperature    = 0.7,
    max_tokens     = 2000,
    functionName   = 'unknown',
    responseFormat = 'text',
  } = options;

  const MAX_RETRIES  = 3;
  const BASE_DELAY   = 2000; // ms — doubles each retry

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const t0 = Date.now();
    try {
      const response = await openai.chat.completions.create({
        model:      config.openai.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
        temperature,
        max_tokens,
      });

      const raw      = response.choices[0].message.content ?? '';
      const latencyMs = Date.now() - t0;
      const tokensIn  = response.usage?.prompt_tokens     ?? 0;
      const tokensOut = response.usage?.completion_tokens ?? 0;

      // Log to DB (fire-and-forget — import lazily to avoid circular deps)
      _logAICall({ functionName, tokensIn, tokensOut, latencyMs, success: true })
        .catch(() => {});

      if (config.openai.logPrompts) {
        logger.debug(`[aiEngine:${functionName}] prompt:\n${userPrompt}`);
        logger.debug(`[aiEngine:${functionName}] response:\n${raw}`);
      }

      logger.debug(`[aiEngine:${functionName}] ${tokensIn}in/${tokensOut}out ${latencyMs}ms`);

      // Strip markdown code fences if model wraps JSON in ```json ... ```
      if (responseFormat === 'json') {
        return raw.replace(/^```[\w]*\n?/m, '').replace(/```$/m, '').trim();
      }
      return raw.trim();

    } catch (err) {
      lastError = err;
      const status = err.status ?? err.code;

      // Only retry on rate-limit (429) or server errors (5xx) or timeout
      const isRetryable =
        status === 429 ||
        (typeof status === 'number' && status >= 500) ||
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT';

      if (!isRetryable || attempt === MAX_RETRIES) break;

      const delay = BASE_DELAY * Math.pow(2, attempt - 1);
      logger.warn(
        `[aiEngine:${functionName}] attempt ${attempt} failed (${status}) — retrying in ${delay}ms`
      );
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // All retries exhausted
  _logAICall({ functionName, success: false, errorMessage: lastError?.message ?? 'unknown' })
    .catch(() => {});
  throw new Error(`[aiEngine:${functionName}] failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

// Lazy import helper so we don't create a circular dep (queries → init → queries)
async function _logAICall(data) {
  try {
    const { logAICall } = await import('../database/queries.js');
    await logAICall(data);
  } catch (_) {
    // Silently skip — logging is never allowed to break the main flow
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. qualifyLead
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide whether a BHW job post is in Bitbash's niche.
 *
 * @returns {{ qualified: boolean, confidence: number, tier: 'auto'|'maybe'|'skip', reason: string, pitch_angle: string }}
 *
 * confidence is 0.00–1.00 (decimal, not an integer score).
 * tier:
 *   'auto'  → confidence ≥ 0.70 — comment + DM immediately
 *   'maybe' → 0.40–0.69 — hold for manual approval (see GAP-06)
 *   'skip'  → < 0.40 — discard
 */
export async function qualifyLead(title, description) {
  const functionInstructions = `Qualify the job post below for Bitbash.

Return ONLY valid JSON — no explanation, no code fences:
{
  "qualified": true | false,
  "confidence": 0.00 to 1.00,
  "reason": "one concise sentence explaining why",
  "pitch_angle": "if qualified: how Bitbash should position itself for this job; else empty string"
}

Scoring guide:
  0.90–1.00 — explicitly asks for something Bitbash has shipped before (e.g. Instagram bot, scraper, React SaaS)
  0.70–0.89 — clearly in niche, minor ambiguity about scope
  0.40–0.69 — probably in niche but post is vague, unclear budget, or has non-niche elements mixed in
  0.10–0.39 — partially technical but mostly outside niche
  0.00–0.09 — completely outside niche (SEO services, design, copywriting, etc.)

Return qualified:true only when confidence ≥ 0.40.

Few-shot examples:

TITLE: "Need Telegram bot that scrapes group members and auto-DMs them"
→ {"qualified":true,"confidence":0.95,"reason":"Direct Telegram automation — core Bitbash capability","pitch_angle":"highlight Telegram bot experience and explain the member-scraping + DM flow we have built before"}

TITLE: "Looking for a Forbes contributor to write a press release and get it published"
→ {"qualified":false,"confidence":0.02,"reason":"PR/content placement — not software development","pitch_angle":""}`;

  const systemPrompt = buildSystemPrompt(functionInstructions);

  const userPrompt = `Job Post Title: ${title}

Job Description:
${description}

Evaluate this post for Bitbash:`;

  try {
    const raw    = await callAI(systemPrompt, userPrompt, {
      temperature:    0.2,
      max_tokens:     400,
      functionName:   'qualifyLead',
      responseFormat: 'json',
    });
    const result = JSON.parse(raw);

    const confidence = Math.min(1, Math.max(0, parseFloat(result.confidence) || 0));
    const tier = confidence >= 0.70
      ? 'auto'
      : confidence >= 0.40
        ? 'maybe'
        : 'skip';

    return {
      qualified:   result.qualified === true && confidence >= 0.40,
      confidence,
      tier,
      reason:      result.reason      || 'No reason provided',
      pitch_angle: result.pitch_angle || '',
    };
  } catch (err) {
    logger.error('[aiEngine] qualifyLead parse error:', err.message);
    return { qualified: false, confidence: 0, tier: 'skip', reason: 'Parse error — defaulting to skip', pitch_angle: '' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. generateCommentPitch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a public comment pitch for a qualified BHW thread.
 *
 * @param {string}      title           - Thread title
 * @param {string}      description     - Thread body
 * @param {string}      pitchAngle      - From qualifyLead output
 * @param {string|null} posterUsername  - Thread author's BHW username (optional)
 * @returns {string} Comment text ready to post
 */
export async function generateCommentPitch(title, description, pitchAngle, posterUsername = null) {
  const usernameRule = posterUsername
    ? `You MAY address the poster as @${posterUsername} at the very start or weave it naturally — but only do it roughly 30% of the time (vary it). Do not force it.`
    : `Do NOT use @username or any name placeholder — you do not know their name.`;

  const functionInstructions = `Write a comment pitch for the BHW thread below.

RULES FOR THIS COMMENT:
  • This is a PUBLIC forum comment, not a DM.
  • ABSOLUTELY NO Telegram usernames, handles, links, or any contact details in the comment body — not even hinted at. The DM handles contact info.
  • No other links, no website URLs — the forum signature handles that.
  • No markdown — plain text only. BHW forum renders plain text; asterisks and hashes appear literally.
  • ${usernameRule}
  • Vary the structure and opening — never use the exact same opener twice.
  • Sound like a human developer who happened to read the post, not a sales rep.
  • REQUIRED CLOSING LINE: The very last line of the comment MUST naturally mention that you have sent them a DM and dropped your contact/details there. Vary the wording each time — examples:
      "I've sent you a DM with more details."
      "Dropped you a DM — my contact details are in there."
      "Sent you a PM with some examples and my contact info."
      "Check your DMs — I've sent over some demos and how to reach me."
    Keep it short and natural. Never write your Telegram handle directly in the comment.

REAL COMMENT OPENERS ZEE HAS USED (rotate style, do not copy verbatim):
  "I can help you out with this."
  "This lines up really well with what I do."
  "I have been building exactly this kind of system for years."
  "Seen this type of project before — happy to help."
  "We handle this kind of work regularly."

Return ONLY the comment text. No subject, no metadata, no quotes around it.`;

  const systemPrompt = buildSystemPrompt(functionInstructions);

  const userPrompt = `Thread Title: ${title}

Description: ${description}

Pitch Angle: ${pitchAngle}${posterUsername ? `\n\nPoster's username: @${posterUsername}` : ''}

Write the comment:`;

  const text = await callAI(systemPrompt, userPrompt, {
    temperature:  0.82,
    max_tokens:   450,
    functionName: 'generateCommentPitch',
  });
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. generateDMOutreach
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate the first outreach DM to a qualified thread poster.
 *
 * @param {string} title       - Thread title
 * @param {string} description - Thread body
 * @param {string} username    - Poster's BHW username
 * @param {string} pitchAngle  - From qualifyLead output
 * @returns {string} DM text
 */
export async function generateDMOutreach(title, description, username, pitchAngle) {
  const functionInstructions = `Write the first outreach DM to a BHW job poster.

STRUCTURE (follow this, but write it naturally — not as a template):
  1. Casual greeting with @${username}
  2. Reference their specific post ("I saw your post about…")
  3. One sentence: why this project fits what you do
  4. Bullet list (3–5 points) of what you can specifically deliver for this job
  5. Social proof line: years of experience, demo videos, or a past similar project
  6. Soft next step: ask a question or invite them to reply with details

RULES:
  • Bullet list is acceptable here — it makes capabilities scannable. Use plain "- item" format.
  • Primary CTA (6 out of 10 DMs): offer demo videos
  • Secondary CTA (4 out of 10): ask for their exact requirements
  • No pricing unless they mentioned a budget in the post
  • 150–350 words total
  • Sound like Zee personally read the post and wrote this — mention specific details from the description

REAL DM OPENINGS ZEE HAS USED (vary the style):
  "Hey @username, I just saw your post about [topic]. This project lines up really well with what I do."
  "Hello @username, saw your thread about [X]. We handle this kind of work regularly."`;

  const systemPrompt = buildSystemPrompt(functionInstructions);

  const userPrompt = `Recipient: @${username}
Thread Title: ${title}
Description: ${description}
Pitch Angle: ${pitchAngle}

Write the DM:`;

  const text = await callAI(systemPrompt, userPrompt, {
    temperature:  0.78,
    max_tokens:   600,
    functionName: 'generateDMOutreach',
  });
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. generateDMReply
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a reply to an incoming BHW DM.
 *
 * @param {string} conversationHistory - All prior messages as a formatted string
 * @param {string} latestMessage       - The lead's most recent message
 * @param {number} [messageCount=0]    - Total messages in thread (for 8-msg handoff rule)
 * @returns {string} Reply text (may contain [HANDOFF] tag on its own final line)
 */
export async function generateDMReply(conversationHistory, latestMessage, messageCount = 0) {
  const functionInstructions = `Reply to the DM conversation below.

YOUR GOALS (in priority order):
  1. Answer their question or address their need directly
  2. Keep the conversation warm and moving forward
  3. For interested leads: naturally suggest moving to Telegram (@bitbashagency) after 2–3 exchanges
  4. Close or book a call when scope is established

REPLY RULES:
  • 40–150 words. Short unless they asked a detailed technical question.
  • Match their energy — if they wrote 2 sentences, write 2 sentences back.
  • No markdown formatting. Plain prose.
  • Do NOT repeat things already said in the conversation. Read the history.
  • If they ask for your contact / how to reach you: mention Telegram @bitbashagency.
  • If they ask about pricing: give a range based on scope, never a fixed price unprompted.

[HANDOFF] RULE — append exactly the text [HANDOFF] on its own final line ONLY when ANY of these are true:
  • Total message count in this conversation reaches 8 or more
  • Lead mentions a budget over $3,000 (or equivalent in other currencies)
  • Conversation has moved to contract terms, payment schedules, or legal matters
  • Scope is genuinely complex (multi-phase builds, enterprise integrations, ongoing retainer)
  • Lead explicitly asks to move the conversation to WhatsApp, a call, or a different platform
  • You are uncertain about a technical answer and guessing could cost the deal
In all other cases do NOT include [HANDOFF] — it is for complex/high-value hand-offs to Zee only.`;

  const systemPrompt = buildSystemPrompt(functionInstructions);

  const userPrompt = `Conversation so far (${messageCount} messages total):
${conversationHistory}

Their latest message:
${latestMessage}

Write your reply:`;

  const text = await callAI(systemPrompt, userPrompt, {
    temperature:  0.70,
    max_tokens:   500,
    functionName: 'generateDMReply',
  });
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. generateFollowUp
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a follow-up message for a cold / unresponsive lead.
 *
 * @param {string} title                 - Original thread title
 * @param {string} description           - Original thread description
 * @param {number} daysSinceLastContact  - 7, 12, or 21
 * @param {string} previousMessages      - Prior messages as a formatted string
 * @returns {string} Follow-up text
 */
export async function generateFollowUp(title, description, daysSinceLastContact, previousMessages) {
  // Tone shifts per interval
  let toneInstruction;
  if (daysSinceLastContact <= 7) {
    toneInstruction = 'Day-7 tone: soft, friendly check-in. "Just following up…" energy. Ask if they have any questions or updated their requirements.';
  } else if (daysSinceLastContact <= 12) {
    toneInstruction = 'Day-12 tone: add a small new hook — mention a recent project, a demo, or a new angle on their problem. Give them a reason to reply beyond just checking in.';
  } else {
    toneInstruction = 'Day-21 tone: closing / final nudge. Keep it warm but let them know this is your last message before you close the lead. "Let me know if the timing changes" energy.';
  }

  const functionInstructions = `Write a follow-up message to a cold lead on BHW.

${toneInstruction}

RULES:
  • 20–80 words MAX. Brevity is the point.
  • No markdown. Plain text only.
  • Non-pushy. Confident. Not desperate.
  • Do not repeat the pitch verbatim from the previous messages.
  • Do not say "I hope this message finds you well" or "just circling back".
  • Sound like Zee genuinely checked in — not like an automated drip sequence.

REAL FOLLOW-UP LINES ZEE HAS USED:
  "Hello there, I hope you are doing good, is there any updates on your end"
  "Hello there, is there any updates on your end."

Write ONE follow-up message. Return only the message text.`;

  const systemPrompt = buildSystemPrompt(functionInstructions);

  const userPrompt = `Original Job: ${title}

Description: ${description}

Days since last contact: ${daysSinceLastContact}

Previous conversation:
${previousMessages}

Write the follow-up:`;

  const text = await callAI(systemPrompt, userPrompt, {
    temperature:  0.68,
    max_tokens:   200,
    functionName: 'generateFollowUp',
  });
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. detectUrgencyAI
// ─────────────────────────────────────────────────────────────────────────────

// Keyword pre-screen — ~90% of messages never hit the API
const URGENCY_KEYWORDS = [
  'asap', 'urgent', 'rush', 'immediately', 'emergency', 'deadline',
  'launch', 'going live', 'time-sensitive', 'time sensitive', 'right away',
  'need by', 'due by', 'by friday', 'by monday', 'this week', 'end of week',
  'end of month', 'losing', 'need now', 'need today', 'need someone now',
  'quick turnaround', 'fast turnaround', 'lock in', 'before someone',
];

/**
 * Two-stage urgency detection: keyword pre-screen → AI confirmation.
 * Never throws — falls back to { urgent: false } on any error.
 *
 * @param {string} text - Job post body or inbound DM text
 * @returns {{ urgent: boolean, reason: string, matchedLine: string|null }}
 */
export async function detectUrgencyAI(text) {
  if (!text || text.trim().length < 10) return { urgent: false, reason: '', matchedLine: null };

  const lower = text.toLowerCase();
  const hasSignal = URGENCY_KEYWORDS.some(kw => lower.includes(kw));
  if (!hasSignal) return { urgent: false, reason: '', matchedLine: null };

  // Keyword hit — get AI confirmation
  const systemPrompt = `You are an urgency-detection classifier for a software agency.
Decide if the sender needs a developer URGENTLY.

Urgency means any of:
  - Hard deadline (date mentioned, launch approaching, going live soon)
  - Words like ASAP, urgent, rush, immediately, time-sensitive
  - Risk of losing money or customers if not solved fast
  - They need someone "now", "today", "this week"
  - They are afraid another developer will take the client before them

NOT urgent: general inquiries, "eventually", no time pressure.

Reply ONLY valid JSON — no extra text, no code fences:
{ "urgent": true|false, "reason": "one sentence", "matchedLine": "the exact phrase that triggered this" }`;

  const userPrompt = `Text to analyse:\n"""\n${text.substring(0, 800)}\n"""`;

  try {
    const raw    = await callAI(systemPrompt, userPrompt, {
      temperature:    0.1,
      max_tokens:     120,
      functionName:   'detectUrgencyAI',
      responseFormat: 'json',
    });
    const parsed = JSON.parse(raw);
    return {
      urgent:      parsed.urgent === true,
      reason:      parsed.reason      || '',
      matchedLine: parsed.matchedLine || null,
    };
  } catch (err) {
    logger.warn('[aiEngine] detectUrgencyAI parse error — defaulting to not urgent:', err.message);
    return { urgent: false, reason: '', matchedLine: null };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. scoreLeadHotness  (NEW — GAP-12)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score how "hot" a lead is right now on a 1–10 scale.
 * Replaces the raw niche_match_score >= 8 check.
 *
 * @param {string} title               - Thread title
 * @param {string} description         - Thread body
 * @param {string} [conversationHistory=''] - Current DM history if any
 * @returns {{ score: number, reasons: string[] }}
 */
export async function scoreLeadHotness(title, description, conversationHistory = '') {
  const systemPrompt = `You are a lead-scoring assistant for a software development agency.
Score how "hot" this lead is RIGHT NOW — how ready are they to hire and pay?

Scoring guide (return an integer 1–10):
  9–10 — Explicit budget ≥ $3k, tight deadline (this week/ASAP), single decision-maker, previous dev failed them, urgency signals present
  7–8  — Clear project scope, budget implied or mentioned, says "ready to start soon" or similar
  5–6  — Genuinely interested but scope is vague, no budget mention, still in exploration phase
  3–4  — Window-shopping, very low budget signals ("budget is tight", "$50"), not the decision-maker
  1–2  — Spam post, no real intent, test post, or clearly outside budget range for real dev work

Reply ONLY valid JSON — no extra text, no code fences:
{ "score": 7, "reasons": ["reason one", "reason two"] }`;

  const historyBlock = conversationHistory
    ? `\n\nConversation so far:\n${conversationHistory}`
    : '';

  const userPrompt = `Thread title: ${title}

Description: ${description}${historyBlock}

Score this lead:`;

  try {
    const raw    = await callAI(systemPrompt, userPrompt, {
      temperature:    0.2,
      max_tokens:     200,
      functionName:   'scoreLeadHotness',
      responseFormat: 'json',
    });
    const parsed = JSON.parse(raw);
    return {
      score:   Math.min(10, Math.max(1, parseInt(parsed.score) || 5)),
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
    };
  } catch (err) {
    logger.warn('[aiEngine] scoreLeadHotness parse error:', err.message);
    return { score: 5, reasons: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. classifyThreadRelevance  (community commenter)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide whether a BHW discussion thread is relevant enough for a helpful reply.
 *
 * @param {string} title   - Thread title
 * @param {string} snippet - Opening post snippet
 * @returns {{ relevant: boolean, category: string, relevanceScore: number, reason: string }}
 */
export async function classifyThreadRelevance(title, snippet) {
  const systemPrompt = `You classify BHW forum threads to decide if a software development agency can add a genuinely helpful, on-topic reply.

Categories (use exact key names):
  web_scraping              — scraping, crawling, Puppeteer, Selenium, data extraction
  seo                       — SEO, rankings, backlinks, Google updates
  wordpress                 — WordPress, WooCommerce, plugins, themes
  automation                — bots, automation scripts, Make, Zapier, n8n, RPA
  mobile_apps               — iOS, Android, React Native, Flutter
  social_media_automation   — social bots, scheduling, LinkedIn, Twitter, Instagram
  api_development           — REST APIs, GraphQL, webhooks, integrations, backend
  ai_ml                     — AI tools, LLMs, prompts, ChatGPT, fine-tuning
  affiliate_marketing       — CPA, affiliate, content sites, monetization niches
  discord_bots              — Discord bots, Discord.js, Discord API
  traffic_generation        — paid ads, Reddit, organic traffic, content distribution
  general_development       — coding, debugging, deployment, git, VPS
  irrelevant                — anything else

Scoring (relevanceScore 0–10):
  0–4  — irrelevant or too vague
  5    — tangentially related but our knowledge would be generic
  6–7  — we can add a specific, useful tip
  8–10 — directly in our core expertise

Reply ONLY valid JSON — no explanation, no code fences:
{ "relevant": true|false, "category": "key_name", "relevanceScore": 8, "reason": "one sentence" }`;

  const userPrompt = `Thread title: "${title}"\n\nOpening snippet:\n"""\n${(snippet || '').substring(0, 600)}\n"""`;

  try {
    const raw    = await callAI(systemPrompt, userPrompt, {
      temperature:    0.1,
      max_tokens:     120,
      functionName:   'classifyThreadRelevance',
      responseFormat: 'json',
    });
    const parsed = JSON.parse(raw);
    return {
      relevant:       parsed.relevant === true && (parsed.relevanceScore || 0) >= 6,
      category:       parsed.category      || 'irrelevant',
      relevanceScore: parseInt(parsed.relevanceScore) || 0,
      reason:         parsed.reason         || '',
    };
  } catch (err) {
    logger.warn('[aiEngine] classifyThreadRelevance parse error:', err.message);
    return { relevant: false, category: 'irrelevant', relevanceScore: 0, reason: '' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. generateCommunityComment  (community commenter)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a genuine, policy-compliant BHW community reply.
 * NO promotion — this is for reputation building only.
 *
 * @param {string} title        - Thread title
 * @param {string} snippet      - Opening post snippet
 * @param {Array}  relevantTips - Selected tips from knowledge-base.json
 * @param {string} category     - Knowledge base category key
 * @returns {string} Comment text ready to post
 */
export async function generateCommunityComment(title, snippet, relevantTips, category) {
  const tipsBlock = (relevantTips || [])
    .slice(0, 3)
    .map((t, i) => `Tip ${i + 1}: ${t.tip}`)
    .join('\n\n');

  const functionInstructions = `Write a helpful BHW community reply.

STRICT BHW POLICY — violating any of these gets the account banned:
  ✗ NEVER mention Bitbash, app_pilot, or any company name
  ✗ NEVER add Telegram, WhatsApp, Discord, website, or any contact link
  ✗ NEVER say "DM me", "PM me", "check my profile", "hire", or "contact"
  ✗ NEVER promote, upsell, or reference your services
  ✓ Write as a knowledgeable community member sharing from personal experience
  ✓ Be specific and technical — vague replies get ignored
  ✓ 80–200 words max — concise and scannable
  ✓ Plain text only — no markdown headers, no bullet lists (BHW doesn't render them)
  ✓ First-person, conversational — "I've found that…", "The approach I use is…"

Category: ${category.replace(/_/g, ' ')}

Reference knowledge (adapt naturally — do NOT quote verbatim):
${tipsBlock}

Return ONLY the reply text. One natural paragraph.`;

  const systemPrompt = `You are an experienced developer contributing to a forum discussion. You share practical knowledge because you enjoy helping. You have no agenda and nothing to sell.\n\n== YOUR TASK FOR THIS CALL ==\n${functionInstructions}`;

  const userPrompt = `Thread title: "${title}"

Opening post:
"""
${(snippet || '').substring(0, 800)}
"""

Write the reply:`;

  const text = await callAI(systemPrompt, userPrompt, {
    temperature:  0.75,
    max_tokens:   300,
    functionName: 'generateCommunityComment',
  });
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

export default {
  callAI,
  qualifyLead,
  generateCommentPitch,
  generateDMOutreach,
  generateDMReply,
  generateFollowUp,
  detectUrgencyAI,
  scoreLeadHotness,
  classifyThreadRelevance,
  generateCommunityComment,
};
