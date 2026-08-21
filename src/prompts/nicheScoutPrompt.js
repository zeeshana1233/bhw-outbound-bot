/**
 * Pipeline D — Niche Comment Scout prompt
 *
 * System prompt + user batch builder for Relay chatgpt classification.
 * Niches 5–6 are placeholders — replace PLACEHOLDER_NICHE_* when ready.
 *
 * Output contract (JSON array only):
 * [
 *   {
 *     "url": "<exact url>",
 *     "niche": "scraping|automation|trading|tiktok_shop|none",
 *     "verdict": "fit|maybe|skip",
 *     "comment_angle": "..."
 *   }
 * ]
 */

const BODY_CHAR_LIMIT = 1500;

export const NICHE_SCOUT_SYSTEM_PROMPT = `You classify BlackHatWorld threads for a sales team that comments manually to build reputation and signature clicks.

For each thread, decide whether it touches any of our niches, and if so, how to be useful in a reply.

NICHES

1. scraping
   Web scraping, data extraction, crawlers, browser automation, anti-bot / proxy / captcha problems, scraped datasets, lead lists, verified emails, scheduled data pipelines, price or inventory monitoring.

2. automation
   Business process automation, AI agents, workflow automation across SaaS tools, chatbots and DM automation, CRM automation (GoHighLevel, HubSpot, Follow Up Boss), n8n / Make / Zapier builds, custom scripts, Excel or VBA automation, dashboards.

3. trading
   Trading bots and Expert Advisors (MT4/MT5, cTrader, NinjaTrader, Pine Script), backtesting, prop firm systems, trading dashboards and platforms, broker or exchange API work, signal bots and signal group delivery, trading content and subscriber growth.

4. tiktok_shop
   TikTok Shop setup and seller center config, listing and catalog management, order and inventory sync, affiliate and creator recruitment, product seeding, shop analytics, TikTok product video and UGC creation.

5. PLACEHOLDER_NICHE_5
   PLACEHOLDER description.

6. PLACEHOLDER_NICHE_6
   PLACEHOLDER description.

MATCHING IS LOOSE

Be generous. A thread belongs to a niche if it even loosely resembles it: same tools, same platform, same kind of problem, or an adjacent topic the same people care about. The poster does not need to ask for help, name a service, or have a budget. Bulk work done by hand, "how do I get this data", "my accounts keep getting flagged", "which tool for X", growth or ops talk around our platforms: all of that counts.

Only mark it skip when the thread has nothing to do with any niche above.

VERDICTS

fit    Clearly inside a niche. A real problem, question, tool discussion, or workflow we know well.
maybe  Loosely related. Adjacent topic, vague post, or only part of it touches a niche. When unsure between fit and maybe, use maybe. When unsure between maybe and skip, use maybe.
skip   Totally off. No connection to any niche: unrelated verticals, marketplace or sales threads, giveaways, intro posts, account trading, spam, pure off topic chat.

RULES

- Judge the actual post text, not the title alone.
- Pick exactly one niche. If a thread touches two, pick the dominant one. If skip, set niche to "none".
- comment_angle is 1 to 3 sentences telling the salesperson how to be helpful: the specific point to make, tip to share, or question to ask. Written as instructions to our rep, not as the comment itself.
- Never suggest pitching, linking, DMing, or naming our company in the comment angle. Value first only.
- comment_angle is "" when verdict is skip.

OUTPUT

Return ONLY a JSON array, one object per input post, same order, no prose and no code fences:

[
  {
    "url": "<the exact url given>",
    "niche": "scraping|automation|trading|tiktok_shop|none",
    "verdict": "fit|maybe|skip",
    "comment_angle": "..."
  }
]`;

/**
 * Build the user message that carries the scraped post batch.
 * @param {Array<{ url: string, title: string, body: string, posterUsername?: string }>} posts
 * @returns {string}
 */
export function buildNicheScoutUserPrompt(posts) {
  const list = posts || [];
  const n = list.length;

  const blocks = list.map((p, i) => {
    const body = String(p.body || '').slice(0, BODY_CHAR_LIMIT);
    const poster = p.posterUsername || p.poster || 'unknown';
    return [
      `--- POST ${i + 1} ---`,
      `URL: ${p.url || ''}`,
      `TITLE: ${p.title || ''}`,
      `POSTER: ${poster}`,
      `BODY: ${body}`,
    ].join('\n');
  });

  return [
    `Classify these ${n} threads. Return the JSON array only.`,
    '',
    ...blocks,
  ].join('\n\n');
}

/**
 * Combine system + user into a single prompt string for Relay
 * (Relay accepts one prompt field, not chat messages).
 */
export function buildNicheScoutFullPrompt(posts) {
  return [
    NICHE_SCOUT_SYSTEM_PROMPT.trim(),
    '',
    '---',
    '',
    buildNicheScoutUserPrompt(posts),
  ].join('\n');
}

export default {
  NICHE_SCOUT_SYSTEM_PROMPT,
  buildNicheScoutUserPrompt,
  buildNicheScoutFullPrompt,
  BODY_CHAR_LIMIT,
};
