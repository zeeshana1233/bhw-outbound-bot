/**
 * Pipeline D — Niche Comment Scout — local smoke test
 *
 * Tests (no live BHW scrape / no Relay call required):
 *  1. Config loads nicheScout + relay + channel ID keys
 *  2. Prompt builder returns a string containing post URLs
 *  3. JSON fence stripping / classification parse helper shape
 *  4. Discord alert format via sendNicheScoutAlert (optional if channel set)
 *
 * Run: node test-niche-scout.js
 */

import dotenv from 'dotenv';
dotenv.config();

import { config } from './src/config/config.js';
import {
  buildNicheScoutFullPrompt,
  buildNicheScoutUserPrompt,
  NICHE_SCOUT_SYSTEM_PROMPT,
} from './src/prompts/nicheScoutPrompt.js';

function pass(label) { console.log(`  ✅ ${label}`); }
function fail(label, detail) {
  console.error(`  ❌ ${label}`);
  if (detail) console.error(`     ${detail}`);
  process.exit(1);
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Pipeline D — Niche Comment Scout — Smoke');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ── 1. Config ──────────────────────────────────────────────────────────────
console.log('[1] Config…');
if (!config.nicheScout) fail('config.nicheScout missing');
pass(`nicheScout.enabled = ${config.nicheScout.enabled}`);
pass(`whatsNewUrl = ${config.nicheScout.whatsNewUrl}`);
pass(`maxPerRun = ${config.nicheScout.maxPerRun}`);
pass(`discord.nicheScoutChannelId set = ${Boolean(config.discord.nicheScoutChannelId)}`);
pass(`relay.serviceId = ${config.relay.serviceId}`);
pass(`relay.baseUrl set = ${Boolean(config.relay.baseUrl)}`);
console.log('');

// ── 2. Prompt builder ──────────────────────────────────────────────────────
console.log('[2] Prompt builder…');
if (!NICHE_SCOUT_SYSTEM_PROMPT || NICHE_SCOUT_SYSTEM_PROMPT.length < 50) {
  fail('NICHE_SCOUT_SYSTEM_PROMPT looks empty');
}
pass('System prompt placeholder present');

const samplePosts = [
  {
    url: 'https://www.blackhatworld.com/threads/example.123456/',
    title: 'Need a scraper for LinkedIn',
    body: 'Looking for someone to build a LinkedIn profile scraper with proxies.',
    posterUsername: 'testuser',
  },
];

const userPrompt = buildNicheScoutUserPrompt(samplePosts);
const fullPrompt = buildNicheScoutFullPrompt(samplePosts);
if (!userPrompt.includes('123456')) fail('User prompt missing thread url/id');
if (!userPrompt.includes('Classify these 1 threads')) fail('User prompt missing batch header');
if (!userPrompt.includes('--- POST 1 ---')) fail('User prompt missing POST block');
if (!userPrompt.includes('BODY:')) fail('User prompt missing BODY field');
if (!fullPrompt.includes('scraping')) fail('System prompt missing niches');
if (!fullPrompt.includes(samplePosts[0].title)) fail('Full prompt missing title');
pass('buildNicheScoutUserPrompt / FullPrompt OK');
console.log('');

// ── 3. Parse contract (inline mirror of engine helper) ──────────────────────
console.log('[3] JSON parse contract…');
function stripJsonFences(text) {
  let s = String(text).trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  return s.trim();
}
const fenced = '```json\n[{"url":"https://www.blackhatworld.com/threads/example.123456/","niche":"scraping","verdict":"fit","comment_angle":"Share a proxy tip"}]\n```';
const parsed = JSON.parse(stripJsonFences(fenced));
if (!Array.isArray(parsed) || parsed[0].verdict !== 'fit') {
  fail('Fence strip / JSON parse failed', JSON.stringify(parsed));
}
pass('JSON array contract parses (fit + comment_angle)');
console.log('');

// ── 4. Optional Discord card (only if channel + token configured) ──────────
console.log('[4] Discord alert (optional)…');
if (process.env.DISCORD_BOT_TOKEN && config.discord.nicheScoutChannelId) {
  const { initDiscord } = await import('./src/services/discordClient.js');
  const { sendNicheScoutAlert } = await import('./src/services/alerts.js');
  await initDiscord();
  // Give gateway a moment
  await new Promise((r) => setTimeout(r, 2500));
  const result = await sendNicheScoutAlert({
    title: 'Niche Scout smoke test',
    url: samplePosts[0].url,
    posterUsername: 'smoke_test',
    niche: 'scraping',
    verdict: 'fit',
    angle: 'This is a smoke-test card — ignore.',
    postedAt: new Date(),
  });
  if (result?.skipped) fail('Discord skipped — check NICHE_SCOUT_CHANNEL_ID');
  pass('sendNicheScoutAlert delivered (or attempted)');
} else {
  pass('Skipped live Discord (set DISCORD_BOT_TOKEN + NICHE_SCOUT_CHANNEL_ID to test)');
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  ✅  Niche Scout smoke checks passed');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('\nEnable on server:');
console.log('  NICHE_SCOUT_ENABLED=true');
console.log('  NICHE_SCOUT_CHANNEL_ID=<new channel id>');
console.log('  RELAY_API_KEY=...');
console.log('  RELAY_BASE_URL=...');
console.log('  RELAY_SERVICE_ID=chatgpt');
console.log('Then paste your niches prompt into src/prompts/nicheScoutPrompt.js\n');
process.exit(0);
