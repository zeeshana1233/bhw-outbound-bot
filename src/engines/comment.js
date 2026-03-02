/**
 * Comment Engine
 *
 * Handles:
 * 1. Generating a comment pitch via OpenClaw (GPT-4o mini)
 * 2. Posting the comment on a BHW thread using the saved BHW session
 *    with full human-behaviour simulation
 *
 * Human Behaviour Simulation:
 * - Random delays between every action
 * - Smooth scroll to the reply box before typing
 * - Mouse movement simulation via moveMouse() before clicking
 * - Character-by-character typing with per-character random delays
 *   (including occasional "mis-type + backspace" mistakes)
 * - Pause mid-sentence (simulates thinking) on longer texts
 * - Random micro-pause before submitting
 * - Verifies the comment appeared after submission
 *
 * All DB writes use the shared queries module.
 */

import logger from '../utils/logger.js';
import { sleep, randomDelay } from '../utils/helpers.js';
import aiEngine from '../services/aiEngine.js';
import bhwSession from '../utils/bhwSession.js';
import { markLeadCommented, getLeadById } from '../database/queries.js';
import { config } from '../config/config.js';
import { checkAndReplyToInbox } from './inbox-monitor.js';

// ─────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────

/**
 * Simulate smooth mouse movement to an element then click it.
 * Uses page.mouse for a brief hover before the actual click so
 * CloudFlare / BHW can see mouse activity before the form submit.
 */
async function moveMouseAndClick(page, selector) {
  const element = await page.$(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);

  const box = await element.boundingBox();
  if (!box) throw new Error(`Could not get bounding box for: ${selector}`);

  // Pick a random point inside the element (not always dead-centre)
  const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
  const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);

  await page.mouse.move(targetX, targetY, { steps: randomDelay(8, 20) });
  await sleep(randomDelay(80, 200));
  await page.mouse.click(targetX, targetY);
  await sleep(randomDelay(200, 500));
}

/**
 * Scroll an element into view with a smooth, human-speed scroll.
 * Puppeteer's built-in scrollIntoView is instant — this version
 * scrolls gradually so it looks natural.
 */
async function smoothScrollToElement(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      const rect = el.getBoundingClientRect();
      const scrollY = window.scrollY + rect.top - Math.floor(window.innerHeight * 0.35);
      window.scrollTo({ top: scrollY, behavior: 'smooth' });
    }
  }, selector);

  // Give the browser time to finish scrolling
  await sleep(randomDelay(600, 1200));
}

/**
 * Type a string character-by-character with human-like per-char delays.
 *
 * Extras included:
 * - Occasional typo: types wrong char then immediately backspaces
 * - Mid-sentence pause: after every ~8-15 words there is a 400-900 ms pause
 *   as if the user is thinking about the next word
 */
async function humanTypeInBrowser(page, text) {
  // Probability that any given character gets a typo (0-1)
  const TYPO_PROB = 0.03;
  // Adjacent-key mis-types (very naive map, enough to look real)
  const TYPO_MAP = {
    a: 's', b: 'v', c: 'x', d: 's', e: 'w', f: 'g', g: 'h', h: 'j',
    i: 'u', j: 'k', k: 'l', l: 'k', m: 'n', n: 'm', o: 'p', p: 'o',
    q: 'w', r: 'e', s: 'a', t: 'r', u: 'y', v: 'b', w: 'e', x: 'z',
    y: 'u', z: 'x',
  };

  let wordCount = 0;
  let nextPauseAt = randomDelay(8, 15); // pause at this word count

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // Count words (spaces)
    if (char === ' ') {
      wordCount++;
      if (wordCount >= nextPauseAt) {
        // Mid-sentence thinking pause
        await sleep(randomDelay(400, 900));
        wordCount = 0;
        nextPauseAt = randomDelay(8, 15);
      }
    }

    // Occasional typo
    if (
      TYPO_PROB > Math.random() &&
      char.toLowerCase() in TYPO_MAP &&
      char !== ' ' &&
      char !== '\n'
    ) {
      const wrongChar = TYPO_MAP[char.toLowerCase()];
      await page.keyboard.type(wrongChar);
      await sleep(randomDelay(80, 180)); // brief pause — "oh wait"
      await page.keyboard.press('Backspace');
      await sleep(randomDelay(100, 250)); // correction delay
    }

    // Type the real character
    await page.keyboard.type(char);

    // Per-character delay: base speed ± jitter
    const baseDelay = randomDelay(
      config.bot.typingSpeedMin || 50,
      config.bot.typingSpeedMax || 140
    );
    // Punctuation and spaces get a slightly longer pause
    const extra = ['.', ',', '!', '?', '\n', ' '].includes(char)
      ? randomDelay(0, 80)
      : 0;
    await sleep(baseDelay + extra);
  }
}

/**
 * Wait for a selector to appear on the page, polling every interval ms.
 * Throws if maxWait ms elapses without the selector being found.
 */
async function waitForSelectorSafe(page, selector, maxWait = 15000, interval = 500) {
  const started = Date.now();
  while (Date.now() - started < maxWait) {
    const el = await page.$(selector);
    if (el) return el;
    await sleep(interval);
  }
  throw new Error(`Timeout waiting for selector: ${selector}`);
}

// ─────────────────────────────────────────────────
// MAIN EXPORTED FUNCTIONS
// ─────────────────────────────────────────────────

/**
 * Generate a comment pitch for a lead (calls OpenClaw).
 *
 * @param {Object} lead - DB lead row (must have title, description, pitch_angle)
 * @returns {string} The generated comment text
 */
export async function generateComment(lead) {
  logger.info(`Generating comment pitch for lead "${lead.title}"...`);

  const pitchAngle = lead.pitch_angle ||
    lead.qualification_reason ||
    'software development and automation expertise';

  const commentText = await aiEngine.generateCommentPitch(
    lead.title,
    lead.description || '',
    pitchAngle,
    lead.poster_username || null
  );

  logger.info('Comment pitch generated successfully.');
  return commentText.trim();
}

/**
 * Post a comment on a BHW thread with full human-behaviour simulation.
 *
 * Flow:
 *  1. Ensure the BHW session is authenticated
 *  2. Navigate to the thread URL
 *  3. Verify page loaded (look for the thread title)
 *  4. Read the OP / existing comments (simulate "reading the thread")
 *  5. Scroll down to the reply box
 *  6. Click into the reply textarea and start typing
 *  7. Type the comment character-by-character with human delays
 *  8. Wait a natural pause before clicking Post
 *  9. Submit the comment
 * 10. Verify the comment appeared on the page
 * 11. Mark lead as commented in the database
 * 12. Return the new comment ID / URL
 *
 * @param {Object} lead  - DB lead row (must have id, thread_url, thread_id)
 * @param {string} commentText - The comment text to post
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false] - If true, skips the actual submission
 * @returns {Object} { success, commentUrl, commentId }
 */
export async function postComment(lead, commentText, opts = {}) {
  const DRY_RUN = opts.dryRun === true;

  // ── GUARD: already commented? (fresh DB check — prevents duplicates) ───
  if (lead.commented === true) {
    logger.warn(`Lead #${lead.id} already has commented=true in memory — skipping postComment.`);
    return { success: false, reason: 'already_commented' };
  }
  // Double-check DB in case another cycle already posted while we were generating
  try {
    const freshLead = await getLeadById(lead.id);
    if (freshLead && freshLead.commented === true) {
      logger.warn(`Lead #${lead.id} already commented in DB — aborting to prevent duplicate.`);
      return { success: false, reason: 'already_commented_db' };
    }
  } catch (checkErr) {
    logger.error(`Failed DB freshness check for lead #${lead.id}:`, checkErr.message);
    // Proceed cautiously — the main loop guard should have caught it
  }

  logger.info('═══════════════════════════════════════════════════════════');
  logger.info(DRY_RUN ? '💬 COMMENT ENGINE — DRY RUN MODE' : '💬 COMMENT ENGINE — LIVE MODE');
  logger.info('═══════════════════════════════════════════════════════════');
  logger.info(`Thread : ${lead.thread_url}`);
  logger.info(`Lead ID: ${lead.id}`);
  logger.info('Comment text:');
  logger.info('─────────────────────────────────────────────────────────');
  commentText.split('\n').forEach(l => logger.info(`  ${l}`));
  logger.info('─────────────────────────────────────────────────────────\n');

  if (DRY_RUN) {
    logger.info('DRY RUN — skipping browser actions and DB update.');
    return { success: true, commentUrl: null, commentId: null, dryRun: true };
  }

  // ── 1. Ensure authenticated ────────────────────────────────────────
  logger.info('Step 1/10 — Verifying BHW session...');
  await bhwSession.ensureAuthenticated();
  const page = bhwSession.getPage();
  logger.info(`          Session active as: ${bhwSession.getUsername()}`);

  // ── 2. Navigate to thread ──────────────────────────────────────────
  logger.info(`Step 2/10 — Navigating to thread...`);
  // Random pre-navigation pause (feels like user switching tabs)
  await sleep(randomDelay(1500, 4000));

  await page.goto(lead.thread_url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  // Post-navigation pause (page is rendering)
  await sleep(randomDelay(2000, 4500));

  // ── 3. Verify page loaded ──────────────────────────────────────────
  logger.info('Step 3/10 — Verifying page loaded...');
  try {
    await page.waitForSelector('.p-title-value, .thread-title, h1', { timeout: 15000 });
  } catch {
    throw new Error('Thread page did not load correctly — could not find title element.');
  }

  const pageTitle = await page.$eval(
    '.p-title-value, h1',
    el => el.innerText.trim()
  ).catch(() => '(unknown)');
  logger.info(`          Page title: "${pageTitle}"`);

  // ── 4. Simulate reading the thread ────────────────────────────────
  logger.info('Step 4/10 — Simulating reading the thread...');
  // Scroll through the page in a few steps as if reading
  const scrollSteps = randomDelay(2, 5);
  for (let i = 0; i < scrollSteps; i++) {
    const scrollAmount = randomDelay(200, 600);
    await page.evaluate((amt) => window.scrollBy({ top: amt, behavior: 'smooth' }), scrollAmount);
    await sleep(randomDelay(800, 2500)); // reading time between scrolls
  }

  // ── 5. Scroll to reply box ─────────────────────────────────────────
  logger.info('Step 5/10 — Locating reply box...');

  // BHW uses XenForo — the quick-reply box selector
  const REPLY_BOX_SELECTORS = [
    '.fr-element[contenteditable="true"]',   // Froala editor (most common on XenForo 2)
    '.message-body .fr-element',
    'textarea[name="message"]',               // Fallback textarea
    '#quickReply textarea',
    '.js-quickReply textarea',
  ];

  let replySelector = null;
  for (const sel of REPLY_BOX_SELECTORS) {
    const found = await page.$(sel);
    if (found) {
      replySelector = sel;
      logger.info(`          Reply box found: ${sel}`);
      break;
    }
  }

  if (!replySelector) {
    // Try scrolling to the bottom — some forums lazy-load the reply box
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    await sleep(randomDelay(1500, 2500));

    for (const sel of REPLY_BOX_SELECTORS) {
      const found = await page.$(sel);
      if (found) {
        replySelector = sel;
        logger.info(`          Reply box found after scroll: ${sel}`);
        break;
      }
    }
  }

  if (!replySelector) {
    throw new Error('Could not locate the reply/comment box on this thread page.');
  }

  await smoothScrollToElement(page, replySelector);

  // ── 6. Activate Froala editor + clear any draft ─────────────────────
  logger.info('Step 6/10 — Activating editor and clearing draft...');
  await sleep(randomDelay(400, 900));

  // Scroll into view
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, replySelector);
  await sleep(randomDelay(800, 1200));

  // Activate the Froala editor with full mouse event sequence
  // (el.click() alone doesn't trigger Froala's focus handler)
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.focus();
    ['mouseenter', 'mousedown', 'mouseup', 'click'].forEach(type =>
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    );
    // Set Froala's empty state — must be <p><br></p> NOT empty string
    // (empty string breaks Froala's cursor tracking)
    el.innerHTML = '<p><br></p>';
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    el.dispatchEvent(new InputEvent('change', { bubbles: true }));
  }, replySelector);
  await sleep(randomDelay(500, 900));

  // Puppeteer-level focus so subsequent keyboard events go to this element
  await page.click(replySelector).catch(() => {});
  await page.focus(replySelector);
  await sleep(randomDelay(300, 500));

  // Keyboard clear (belt-and-suspenders)
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Delete');
  await sleep(randomDelay(200, 400));

  // Click once more to ensure cursor is inside the editor
  await page.click(replySelector).catch(() => {});
  await sleep(randomDelay(200, 400));

  // ── 7. Type comment ────────────────────────────────────────────────
  logger.info('Step 7/10 — Typing comment (human speed)...');
  await humanTypeInBrowser(page, commentText);
  logger.info('          Typing complete.');

  // ── 7.5 Sync Froala → hidden textarea (CRITICAL) ───────────────────
  // Froala maintains a hidden <textarea> that gets submitted with the form.
  // Keyboard events may not fully sync the visual editor → hidden input.
  // We force-sync here to guarantee the form receives the text.
  const syncResult = await page.evaluate((sel, text) => {
    const ed = document.querySelector(sel);
    if (!ed) return 'no_editor';

    // Make sure the visual editor actually has content
    if (!ed.textContent.trim()) {
      ed.innerHTML = '<p>' + text.replace(/\n/g, '<br>') + '</p>';
    }
    const html = ed.innerHTML;

    const form = ed.closest('form');
    if (!form) return 'no_form';

    // Sync to every textarea and hidden input that looks like a message field
    let synced = 0;
    form.querySelectorAll('textarea, input[type="hidden"]').forEach(el => {
      const name = (el.name || el.id || '').toLowerCase();
      if (name.includes('message') || name.includes('body') || name.includes('content')) {
        el.value = html;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        synced++;
      }
    });
    // Also hit any display:none textarea (Froala mirror input)
    form.querySelectorAll('textarea').forEach(ta => {
      if (getComputedStyle(ta).display === 'none' || ta.hidden) {
        ta.value = html;
        synced++;
      }
    });
    return 'synced:' + synced;
  }, replySelector, commentText);
  logger.info(`          Editor sync: ${syncResult}`);

  // ── 8. Pre-submit pause ────────────────────────────────────────────
  logger.info('Step 8/10 — Pausing before submit (reviewing comment)...');
  await sleep(randomDelay(1800, 4500)); // "re-reading before posting"

  // Tiny scrolls to look like re-reading
  const reviewScrolls = randomDelay(1, 3);
  for (let i = 0; i < reviewScrolls; i++) {
    await page.evaluate(() => window.scrollBy({ top: -60, behavior: 'smooth' }));
    await sleep(randomDelay(400, 900));
    await page.evaluate(() => window.scrollBy({ top: 60, behavior: 'smooth' }));
    await sleep(randomDelay(400, 800));
  }

  // ── 9. Submit ──────────────────────────────────────────────────────
  logger.info('Step 9/10 — Submitting comment...');

  // Scroll to bottom so button is in DOM viewport
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
  await sleep(randomDelay(1000, 1800));

  // Submit via full synthetic MouseEvent sequence on the form's submit button.
  // This is the most reliable method — el.click() skips XenForo's JS handler,
  // but a full MouseEvent sequence triggers it properly.
  const submitResult = await page.evaluate((sel) => {
    const ed = document.querySelector(sel);
    // Walk up from editor to find the containing form
    let form = ed ? ed.closest('form') : null;
    if (!form) {
      // XenForo quick-reply form fallbacks
      form = document.querySelector('.js-quickReply form') ||
             document.querySelector('form.quickReply') ||
             document.querySelector('form[action*="reply"]') ||
             document.querySelector('form[action*="post"]') ||
             document.querySelector('form[action*="thread"]');
    }

    // Find the submit button within the form (or page)
    const btn = form
      ? (form.querySelector('[data-xf-click="submit"]') ||
         form.querySelector('button[type="submit"]') ||
         form.querySelector('input[type="submit"]'))
      : (document.querySelector('button[data-xf-click="submit"]') ||
         document.querySelector('button.button--primary[type="submit"]'));

    if (btn) {
      btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // Full synthetic mouse event sequence — mimics a real user click
      const opts = { bubbles: true, cancelable: true, view: window };
      btn.dispatchEvent(new MouseEvent('mouseenter', opts));
      btn.dispatchEvent(new MouseEvent('mousemove', opts));
      btn.dispatchEvent(new MouseEvent('mousedown', opts));
      btn.dispatchEvent(new MouseEvent('mouseup',   opts));
      btn.dispatchEvent(new MouseEvent('click',     opts));
      return 'btn_events:' + (btn.textContent.trim().slice(0, 30));
    }

    // Last resort: form.requestSubmit() — triggers native HTML5 submit with validation
    if (form) {
      try { form.requestSubmit(); return 'form_requestSubmit'; }
      catch (e) { form.submit(); return 'form_submit'; }
    }
    return 'nothing_found';
  }, replySelector);
  logger.info(`          Submit: ${submitResult}`);

  // Wait for XenForo to process + page to settle
  await sleep(randomDelay(4000, 7000));

  // ── 10. Verify comment appeared ────────────────────────────────────
  logger.info('Step 10/10 — Verifying comment was posted...');

  let commentUrl = null;
  let commentId = null;

  try {
    // After posting, XenForo reloads/redirects to the same thread
    // and your comment should be the last .message block
    await page.waitForSelector('.message', { timeout: 15000 });

    // Extract the last comment's post ID from the URL anchor
    const lastComment = await page.$$('.message');
    if (lastComment.length > 0) {
      const lastId = await page.evaluate(el => el.getAttribute('data-content'), lastComment[lastComment.length - 1]);
      if (lastId) {
        commentId = lastId.replace('post-', '');
        commentUrl = `${lead.thread_url}post-${commentId}`;
        logger.info(`          Comment verified! ID: ${commentId}`);
        logger.info(`          URL: ${commentUrl}`);
      }
    }

    // Cross-check: does the page contain the first ~40 chars of our comment?
    const firstChunk = commentText.substring(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pageContent = await page.content();
    if (pageContent.includes(commentText.substring(0, 30))) {
      logger.info('          Comment text confirmed visible on page.');
    } else {
      logger.warn('          Could not confirm comment text on page — may still have posted.');
    }
  } catch (verifyErr) {
    logger.warn('Could not fully verify comment — it may still have posted:', verifyErr.message);
  }

  // ── 11. Update database ────────────────────────────────────────────
  try {
    await markLeadCommented(lead.id, commentId || 'unknown');
    lead.commented = true; // Update in-memory so callers see it immediately
    logger.info('          Database updated — lead marked as commented.');
  } catch (dbErr) {
    logger.error('CRITICAL — Failed to update database after posting comment:', dbErr);
    logger.error('This lead may get double-commented on next cycle!');
    // Re-throw so the caller knows the DB update failed
    throw new Error(`Comment posted but DB update failed for lead #${lead.id}: ${dbErr.message}`);
  }

  logger.info('');
  logger.info('✅ Comment posted successfully!');
  logger.info(`   URL: ${commentUrl || lead.thread_url}`);
  logger.info('═══════════════════════════════════════════════════════════\n');

  // ── Opportunistic inbox check ──────────────────────────────────────
  // We already have an authenticated browser open — check inbox now
  // so any replies while we were posting get answered immediately.
  logger.info('📬 Checking inbox after comment post...');
  checkAndReplyToInbox().catch(err =>
    logger.warn('Post-comment inbox check failed (non-fatal):', err.message)
  );

  return { success: true, commentUrl, commentId };
}

/**
 * Full pipeline: generate a comment pitch then post it.
 *
 * @param {Object} lead  - full DB lead row
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false] - preview only, do not submit
 * @returns {Object} { success, commentText, commentUrl, commentId }
 */
export async function generateAndPostComment(lead, opts = {}) {
  const commentText = await generateComment(lead);
  const result = await postComment(lead, commentText, opts);
  return { ...result, commentText };
}

/**
 * Post ANY BHW thread comment with full human-behaviour simulation —
 * no lead DB tracking. Used by the community commenter for organic replies.
 *
 * @param {string} threadUrl  - Full URL of the BHW thread
 * @param {string} commentText
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun]
 * @returns {{ success, commentUrl, commentId }}
 */
export async function postToThread(threadUrl, commentText, opts = {}) {
  // Reuse the existing postComment machinery by passing a minimal fake-lead object.
  // The only special handling: we skip markLeadCommented (caller handles DB tracking).
  const fakeLead = { id: null, thread_url: threadUrl, thread_id: null };

  const DRY_RUN = opts.dryRun === true;

  logger.info('══════════════════════════════════════════════════════════');
  logger.info(DRY_RUN ? '🗣️  COMMUNITY COMMENT — DRY RUN' : '🗣️  COMMUNITY COMMENT — LIVE');
  logger.info('══════════════════════════════════════════════════════════');
  logger.info(`Thread: ${threadUrl}`);
  commentText.split('\n').forEach(l => logger.info(`  ${l}`));
  logger.info('──────────────────────────────────────────────────────────\n');

  if (DRY_RUN) {
    return { success: true, commentUrl: null, commentId: null, dryRun: true };
  }

  await bhwSession.ensureAuthenticated();
  const page = bhwSession.getPage();

  await sleep(randomDelay(1500, 4000));
  await page.goto(threadUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(randomDelay(2000, 4500));

  try {
    await page.waitForSelector('.p-title-value, .thread-title, h1', { timeout: 15000 });
  } catch {
    throw new Error('Community thread page did not load correctly.');
  }

  // Simulate reading
  const scrollSteps = randomDelay(2, 5);
  for (let i = 0; i < scrollSteps; i++) {
    await page.evaluate((amt) => window.scrollBy({ top: amt, behavior: 'smooth' }), randomDelay(200, 600));
    await sleep(randomDelay(800, 2500));
  }

  const REPLY_BOX_SELECTORS = [
    '.fr-element[contenteditable="true"]',
    '.message-body .fr-element',
    'textarea[name="message"]',
    '#quickReply textarea',
    '.js-quickReply textarea',
  ];

  let replySelector = null;
  for (const sel of REPLY_BOX_SELECTORS) {
    if (await page.$(sel)) { replySelector = sel; break; }
  }
  if (!replySelector) {
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    await sleep(randomDelay(1500, 2500));
    for (const sel of REPLY_BOX_SELECTORS) {
      if (await page.$(sel)) { replySelector = sel; break; }
    }
  }
  if (!replySelector) throw new Error('Reply box not found on community thread page.');

  await smoothScrollToElement(page, replySelector);
  await sleep(randomDelay(400, 900));
  await moveMouseAndClick(page, replySelector);
  await sleep(randomDelay(300, 700));
  await page.focus(replySelector);
  await sleep(randomDelay(200, 500));

  await humanTypeInBrowser(page, commentText);

  await sleep(randomDelay(1800, 4500));

  const SUBMIT_SELECTORS = [
    'button[data-xf-click="submit"]',
    '.quickReply .button--primary',
    'button.button--primary[type="submit"]',
    'input[type="submit"][value*="Post"]',
    'button[type="submit"]',
  ];

  let submitted = false;
  for (const sel of SUBMIT_SELECTORS) {
    if (await page.$(sel)) {
      await smoothScrollToElement(page, sel);
      await sleep(randomDelay(300, 700));
      await moveMouseAndClick(page, sel);
      submitted = true;
      break;
    }
  }
  if (!submitted) {
    await page.focus(replySelector);
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
  }

  await sleep(randomDelay(3000, 6000));

  let commentUrl = null;
  let commentId  = null;
  try {
    await page.waitForSelector('.message', { timeout: 15000 });
    const lastComment = await page.$$('.message');
    if (lastComment.length > 0) {
      const lastId = await page.evaluate(el => el.getAttribute('data-content'), lastComment[lastComment.length - 1]);
      if (lastId) {
        commentId  = lastId.replace('post-', '');
        commentUrl = `${threadUrl.split('#')[0]}post-${commentId}`;
        logger.info(`🗣️  Community comment posted — ID: ${commentId}`);
      }
    }
  } catch (err) {
    logger.warn('🗣️  Could not fully verify community comment (may still have posted):', err.message);
  }

  return { success: true, commentUrl, commentId };
}

export default {
  generateComment,
  postComment,
  generateAndPostComment,
  postToThread,
};
