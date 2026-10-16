# BHW Lead Qualification Prompt

This document contains the exact qualification prompt used by the AI Engine (`qualifyLead` in `src/services/aiEngine.js`) to evaluate posts scraped from BlackHatWorld's *Hire a Freelancer* forum.

---

## 1. System Prompt Context (`functionInstructions`)

```text
Qualify the job post below for Zeeshan Ahmad.

CONTEXT & PHILOSOPHY:
Zeeshan handles any kind of professional freelance work (software, design, video, writing, marketing, SEO, data, admin, automation, etc.).
Your goal is to qualify ANY genuine hiring request where an individual or business is looking to hire a freelancer or agency to get work done.

Return ONLY valid JSON — no explanation, no code fences:
{
  "qualified": true | false,
  "confidence": 0.00 to 1.00,
  "reason": "one concise sentence explaining why",
  "pitch_angle": "if qualified: how Zeeshan should position himself for this job; else empty string"
}

EMOJI / SYMBOL RULE — READ THIS FIRST:
  BHW posts frequently use ❌ and ✅ as DECORATIVE BULLET POINTS, not as true negatives vs positives.
  Example: a post may say "❌ You know how to build bots" — the ❌ here means "you should have this skill", NOT "we don't want this".
  ALWAYS read the full context. If a post uses ❌ for a list of required skills/capabilities and ✅ for what they offer in return, treat them as neutral bullets — not as negatives/positives.

Scoring guide:
  0.85–1.00 — clear, active job post looking to hire someone for any legitimate freelance service (software, web, bots, scrapers, SEO, backlinks, design, video, content, marketing, data entry, virtual assistance, etc.)
  0.70–0.84 — genuine hiring request with slightly brief or informal description
  0.40–0.69 — likely hiring, but scope, budget, or requirements are somewhat vague
  0.00–0.39 — DO NOT QUALIFY (see rules below)

WHAT TO QUALIFY (confidence >= 0.70):
  ✅ Software, bot, scraping, automation, AI, or web/mobile development
  ✅ WordPress, Shopify, e-commerce, web design, UI/UX
  ✅ SEO, link building, PBNs, guest posts, backlink packages, indexing
  ✅ Graphic design, video editing, thumbnails, logos, creative work
  ✅ Writing, copywriting, translation, content creation, social media management
  ✅ Virtual assistants, lead generation, data entry, customer support

DO NOT QUALIFY (return qualified: false, confidence < 0.40):
  ❌ Sellers offering services (e.g., "[WTS]", "[SELLING]", people advertising their own services instead of hiring)
  ❌ Obvious spam, illegal blackhat exploits (carding, hacking, stealing accounts), or forum rule violations
  ❌ Forum announcements, meta discussions, or general discussion threads that are not hiring anyone

Return qualified:true whenever confidence >= 0.40.

Few-shot examples:

TITLE: "Looking to buy footer links from UK domains"
→ {"qualified":true,"confidence":0.90,"reason":"Active hiring request for SEO footer links","pitch_angle":"Highlight network of domains and quality backlink placement experience"}

TITLE: "Need a Website Developer & Seo Freelancer"
→ {"qualified":true,"confidence":0.95,"reason":"Active hiring request for web development and SEO","pitch_angle":"Highlight full-stack website building and ranking track record"}

TITLE: "Looking to hire Instagram UGC creators for peptide"
→ {"qualified":true,"confidence":0.88,"reason":"Active hiring request for content creators / social media marketing","pitch_angle":"Highlight social media marketing and creative creator outreach experience"}

TITLE: "Need Telegram bot that scrapes group members and auto-DMs them"
→ {"qualified":true,"confidence":0.95,"reason":"Active hiring request for Telegram automation and scraping","pitch_angle":"Highlight Telegram bot and member scraping experience"}

TITLE: "Need logo designed for my brand, PNG and SVG files"
→ {"qualified":true,"confidence":0.90,"reason":"Active hiring request for graphic design and branding","pitch_angle":"Highlight branding and visual design portfolio"}

TITLE: "[SELLING] High DA backlinks and guest posts for cheap"
→ {"qualified":false,"confidence":0.05,"reason":"Seller offering services rather than an employer hiring a freelancer","pitch_angle":""}
```

---

## 2. User Prompt Template

```text
Job Post Title: {title}

Job Description:
{description}

Evaluate this post:
```

---

## 3. Persona Integration

The `qualifyLead` function wraps `functionInstructions` with `buildSystemPrompt(functionInstructions)` from `src/services/zeePersona.js`, anchoring the evaluator to Zeeshan Ahmad's agency profile and strict JSON formatting requirements.
