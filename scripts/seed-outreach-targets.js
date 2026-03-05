/**
 * Seed Outreach Targets — One-time CSV importer
 *
 * Usage:
 *   node scripts/seed-outreach-targets.js /path/to/targets.csv
 *
 * Minimum CSV format:
 *   thread_url,title
 *   https://www.blackhatworld.com/threads/some-thread.1234567/,Thread Title
 *
 * Optional third column:
 *   thread_url,title,poster_username
 *
 * Skips duplicates (same thread_id already in outreach_targets).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'bhw_bot',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// ─────────────────────────────────────────────────────────────────────────────
// Extract thread_id from a BHW thread URL
// Matches both /threads/slug.ID/ and /seo/slug.ID/ patterns
// ─────────────────────────────────────────────────────────────────────────────
function extractThreadId(url) {
  const match = url.match(/(?:threads|seo)\/[^/]+\.(\d+)\/?/);
  return match ? match[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse CSV line, handling quoted fields with commas inside
// ─────────────────────────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const csvPath = process.argv[2];

  if (!csvPath) {
    console.error('❌  Usage: node scripts/seed-outreach-targets.js /path/to/targets.csv');
    process.exit(1);
  }

  const resolvedPath = path.resolve(csvPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`❌  File not found: ${resolvedPath}`);
    process.exit(1);
  }

  console.log(`\n📄  Reading CSV: ${resolvedPath}`);

  // Read all lines
  const fileContent = fs.readFileSync(resolvedPath, 'utf8');
  const lines       = fileContent.split(/\r?\n/).filter(l => l.trim());

  // Detect and skip header row
  const firstLine = lines[0].toLowerCase();
  const hasHeader = firstLine.includes('thread_url') || firstLine.includes('url');
  const dataLines = hasHeader ? lines.slice(1) : lines;

  if (dataLines.length === 0) {
    console.error('❌  CSV has no data rows.');
    process.exit(1);
  }

  console.log(`📊  Found ${dataLines.length} row(s)${hasHeader ? ' (header skipped)' : ''}`);

  const client = await pool.connect();
  let imported = 0;
  let skipped  = 0;
  let invalid  = 0;

  try {
    for (const line of dataLines) {
      if (!line.trim()) continue;

      const cols           = parseCsvLine(line);
      const rawUrl         = (cols[0] || '').trim();
      const title          = (cols[1] || '').trim() || null;
      const posterUsername = (cols[2] || '').trim() || null;

      if (!rawUrl || !rawUrl.startsWith('http')) {
        console.warn(`  ⚠️  Invalid URL, skipping row: "${line.slice(0, 80)}"`);
        invalid++;
        continue;
      }

      const threadId = extractThreadId(rawUrl);
      if (!threadId) {
        console.warn(`  ⚠️  Could not extract thread_id from: ${rawUrl}`);
        invalid++;
        continue;
      }

      // Normalise URL (ensure trailing slash)
      const threadUrl = rawUrl.replace(/\/?$/, '/');

      // Check for duplicate
      const existing = await client.query(
        'SELECT id FROM outreach_targets WHERE thread_id = $1',
        [threadId]
      );

      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }

      // Insert
      await client.query(
        `INSERT INTO outreach_targets
           (thread_id, thread_url, title, poster_username, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [threadId, threadUrl, title, posterUsername]
      );

      imported++;
      console.log(`  ✅  ${threadId} — "${(title || rawUrl).slice(0, 60)}"`);
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`\n────────────────────────────────────────`);
  console.log(`✅  Imported ${imported} new target(s)`);
  if (skipped > 0)  console.log(`⏭   Skipped  ${skipped} duplicate(s)`);
  if (invalid > 0)  console.log(`⚠️   Invalid  ${invalid} row(s)`);
  console.log(`────────────────────────────────────────\n`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
