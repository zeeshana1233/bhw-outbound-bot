/**
 * capture-prompts.js
 *
 * Re-runs the exact 3 outreach AI calls from the dry run and captures:
 *   - The EXACT system prompt sent to OpenAI (after persona injection)
 *   - The EXACT user prompt sent to OpenAI (after data injection)
 *   - The EXACT raw JSON response body from OpenAI (before any trimming/parsing)
 *
 * Outputs: OUTREACH_PROMPT_CAPTURE.md
 *
 * Usage: node capture-prompts.js
 */

import dotenv from 'dotenv';
dotenv.config();

import fs         from 'fs/promises';
import OpenAI     from 'openai';
import bhwSession from './src/utils/bhwSession.js';
import { initDatabase }            from './src/database/init.js';
import { getPendingOutreachTargets } from './src/database/queries.js';
import { config }                  from './src/config/config.js';
import { buildOutreachSystemPrompt } from './src/services/outreachPersona.js';
import { sleep, randomDelay }      from './src/utils/helpers.js';
import logger                      from './src/utils/logger.js';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

// ─── raw OpenAI call — captures everything ───────────────────────────────────
async function rawCall(systemPrompt, userPrompt, opts = {}) {
  const body = {
    model:       config.openai.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    temperature: opts.temperature ?? 0.8,
    max_tokens:  opts.max_tokens  ?? 500,
  };

  const response = await openai.chat.completions.create(body);

  return {
    requestBody:  body,         // what we sent
    rawResponse:  response,     // full OpenAI response object
    outputText:   response.choices[0].message.content,
  };
}

// ─── scrape (same selectors as dry run) ──────────────────────────────────────
async function scrapeThread(threadUrl) {
  const page = bhwSession.page;
  await bhwSession.navigateTo(threadUrl);
  await sleep(randomDelay(1500, 3000));

  const description = await page.evaluate(() => {
    const el = document.querySelector(
      '.message-body .bbWrapper, .message-content .bbWrapper, .message-body'
    );
    return el ? el.innerText.trim() : null;
  });

  const posterUsername = await page.evaluate(() => {
    const el = document.querySelector(
      '.message-name a.username, .message-userDetails .username, h4.message-name a'
    );
    return el ? el.textContent.trim() : null;
  });

  return { description: description || '', posterUsername: posterUsername || null };
}

// ─── MD helpers ──────────────────────────────────────────────────────────────
function fence(lang, text) {
  return `\`\`\`${lang}\n${text}\n\`\`\``;
}

function hr() { return '\n---\n'; }

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  await initDatabase();
  logger.info('DB connected');

  logger.info('Authenticating BHW session…');
  await bhwSession.ensureAuthenticated();
  logger.info('BHW session active');

  const targets = await getPendingOutreachTargets(3);
  if (!targets.length) {
    console.error('No pending targets — seed first.');
    process.exit(1);
  }

  const sections = [];
  sections.push(`# Outreach AI Prompt Capture\n`);
  sections.push(`Generated: ${new Date().toISOString()}  `);
  sections.push(`Model: \`${config.openai.model}\`  `);
  sections.push(`Targets: ${targets.length}\n`);
  sections.push(hr());

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    console.log(`\n[${i+1}/${targets.length}] Scraping + calling AI for target #${target.id}…`);

    // ── scrape ──────────────────────────────────────────────────────────────
    const scrape = await scrapeThread(target.thread_url);
    const posterUsername = target.poster_username || scrape.posterUsername || '(unknown)';
    const description    = scrape.description    || target.description    || '';

    const title = target.title || '(untitled)';

    // ════════════════════════════════════════════════
    // SINGLE CALL — generateThreadsOwnerOutreachDMAndFollowUps
    // ════════════════════════════════════════════════
    const mergedFunctionInstructions = `You are writing outreach content for a BHW thread owner.

Thread context:
- Title: "${title}"
- Posted by: @${posterUsername}
- First post / description:
"""
${(description).substring(0, 1000)}
"""

You must produce FOUR pieces of content in one response. Return ONLY valid JSON with exactly these keys: dm, followUp1, followUp2, followUp3.

── dm ──
The initial cold DM to send right now.
- 3–5 sentences, max ~80 words
- Open with a specific observation from their thread (proves you read it)
- One sentence about who you are and what you build
- One clear value prop for what you could do for THEM specifically
- Soft CTA — invite a reply, no pressure
- NO pricing, NO generic opener, NO bullet points, NO markdown
- NO Telegram mention in the initial DM

── followUp1 ──
Day 3 follow-up. ONE sentence only. "Making sure this didn't get buried" energy. Zero pitch, zero pressure.

── followUp2 ──
Day 7 follow-up. 2–3 sentences. Introduce ONE new relevant capability or example (different from the DM). Mention Telegram naturally once: "easier to hash it out on Telegram if you use it — @zeeshanahmad4"

── followUp3 ──
Day 14 follow-up. 1–2 sentences. Gentle close — "if timing isn't right, no worries" energy. Leave door totally open.

Global rules for all four:
- Plain text only — no markdown, no bullet points
- Never sound desperate or mass-outreach-ish
- Each message must standalone (they may not have read any previous one)
- Return ONLY the JSON object — no extra text, no code fences`;

    const mergedSystemPrompt = buildOutreachSystemPrompt(mergedFunctionInstructions);
    const mergedUserPrompt   = `Thread by @${posterUsername}: "${title}"\n\nDescription:\n${(description).substring(0, 800)}\n\nReturn the JSON object with keys: dm, followUp1, followUp2, followUp3.`;

    const mergedCapture = await rawCall(mergedSystemPrompt, mergedUserPrompt, { temperature: 0.8, max_tokens: 700 });

    // ════════════════════════════════════════════════
    // Build MD section for this target
    // ════════════════════════════════════════════════
    const s = [];

    s.push(`## Target ${i+1} of ${targets.length} — #${target.id}`);
    s.push('');
    s.push(`| Field | Value |`);
    s.push(`|---|---|`);
    s.push(`| Thread ID | \`${target.thread_id}\` |`);
    s.push(`| URL | ${target.thread_url} |`);
    s.push(`| Title | ${title} |`);
    s.push(`| Poster | @${posterUsername} |`);
    s.push(`| Description length | ${description.length} chars |`);
    s.push('');

    // ── SINGLE CALL ──
    s.push(`### Single Call — \`generateThreadsOwnerOutreachDMAndFollowUps\``);
    s.push('');
    s.push(`**Request sent to OpenAI**`);
    s.push('');
    s.push(`Model: \`${mergedCapture.requestBody.model}\`  temperature: \`${mergedCapture.requestBody.temperature}\`  max_tokens: \`${mergedCapture.requestBody.max_tokens}\``);
    s.push('');
    s.push(`#### System Prompt`);
    s.push('');
    s.push(fence('text', mergedSystemPrompt));
    s.push('');
    s.push(`#### User Prompt`);
    s.push('');
    s.push(fence('text', mergedUserPrompt));
    s.push('');
    s.push(`**Raw OpenAI Response JSON**`);
    s.push('');
    s.push(fence('json', JSON.stringify(mergedCapture.rawResponse, null, 2)));
    s.push('');
    s.push(`**Extracted Output Text (raw JSON string from OpenAI)**`);
    s.push('');
    s.push(fence('json', mergedCapture.outputText));
    s.push('');

    sections.push(s.join('\n'));
    sections.push(hr());
  }

  const md = sections.join('\n');
  await fs.writeFile('OUTREACH_PROMPT_CAPTURE.md', md, 'utf8');

  console.log(`\n✅  Written to OUTREACH_PROMPT_CAPTURE.md`);
  process.exit(0);
}

process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
