/**
 * Generates a random delay between min and max milliseconds
 * Used to simulate human behavior and avoid bot detection
 */
export function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate human-like typing delay for a given text
 */
export function calculateTypingDelay(text, minSpeed = 50, maxSpeed = 150) {
  const length = text.length;
  const avgSpeed = (minSpeed + maxSpeed) / 2;
  return length * avgSpeed;
}

/**
 * Type text character by character with random delays
 * Returns array of delays for each character
 */
export function generateTypingPattern(text, minSpeed = 50, maxSpeed = 150) {
  const delays = [];
  for (let i = 0; i < text.length; i++) {
    delays.push(randomDelay(minSpeed, maxSpeed));
  }
  return delays;
}

/**
 * Calculate thread age category based on post date
 */
export function getThreadAgeCategory(postDate) {
  const now = new Date();
  const ageInDays = Math.floor((now - new Date(postDate)) / (1000 * 60 * 60 * 24));
  
  if (ageInDays < 30) return 'fresh';
  if (ageInDays < 365) return 'old';
  return 'ancient';
}

/**
 * Extract thread ID from BHW URL
 * Handles both /threads/slug.ID/ and /seo/slug.ID/ paths
 */
export function extractThreadId(url) {
  // Match numeric ID at the end of the slug: /seo/slug.12345/ or /threads/slug.12345/
  const match = url.match(/(?:threads|seo)\/[^\/]+\.(\d+)\/?/);
  return match ? match[1] : null;
}

/**
 * Sanitize text for database storage
 */
export function sanitizeText(text) {
  if (!text) return '';
  return text.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
}

/**
 * Format date for logging
 */
export function formatLogDate(date = new Date()) {
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Check if we should take action on this thread based on age
 */
export function shouldTakeAction(threadAgeCategory) {
  // Only comment and DM on fresh threads (<1 month)
  // Only comment on old threads (1-12 months)
  // Skip ancient threads (>1 year)
  return threadAgeCategory === 'fresh' || threadAgeCategory === 'old';
}

/**
 * Returns true if the current time falls within active operating hours:
 * 9:00 AM – 11:00 PM Pakistan Standard Time (UTC+5, no DST).
 * The bot sleeps outside these hours to avoid looking like a 24/7 robot.
 * GAP-04
 */
export function shouldSendDM(threadAgeCategory) {
  return threadAgeCategory === 'fresh';
}

/**
 * Strip markdown formatting before sending to BHW's Froala editor.
 * BHW submits plain text — markdown characters appear literally in the
 * sent message (e.g. **bold** shows as **bold**).
 *
 * Handles: bold/italic asterisks, headings, inline code, code blocks,
 * horizontal rules, leading bullet/numbered-list markers.
 */
export function sanitizeBHWMessage(text) {
  if (!text) return '';
  return text
    // Code blocks (``` ... ```)
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```/g, '').trim())
    // Inline code (`code`)
    .replace(/`([^`]+)`/g, '$1')
    // Bold+italic (***text*** or ___text___)
    .replace(/\*{3}(.+?)\*{3}/g, '$1')
    .replace(/_{3}(.+?)_{3}/g, '$1')
    // Bold (**text** or __text__)
    .replace(/\*{2}(.+?)\*{2}/g, '$1')
    .replace(/_{2}(.+?)_{2}/g, '$1')
    // Italic (*text* or _text_) — single char, not mid-word
    .replace(/(^|\s)\*([^*\n]+)\*(\s|$)/g, '$1$2$3')
    .replace(/(^|\s)_([^_\n]+)_(\s|$)/g, '$1$2$3')
    // ATX headings (# Heading)
    .replace(/^#{1,6}\s+/gm, '')
    // Horizontal rules (--- or ***)
    .replace(/^[-*]{3,}\s*$/gm, '')
    // Blockquotes (> text)
    .replace(/^>\s?/gm, '')
    // Bullet list markers (- item or * item or + item)
    .replace(/^[\-\*\+]\s+/gm, '')
    // Numbered list markers (1. item)
    .replace(/^\d+\.\s+/gm, '')
    // Trim each line + collapse 3+ consecutive blank lines to 2
    .split('\n').map(l => l.trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isActiveHours() {
  const now = new Date();
  const pktHour = (now.getUTCHours() + 5) % 24; // PKT = UTC+5
  return pktHour >= 9 && pktHour < 23;
}

