/**
 * One-time script: re-qualify the WP design + Website Designer leads
 * Run: node requalify-two.mjs
 */
import { qualifyLead } from './src/services/aiEngine.js';
import { query } from './src/database/init.js';

const { rows: leads } = await query(
  "SELECT id, title, description FROM leads WHERE thread_id IN ('1796371', '1796328')"
);

if (leads.length === 0) {
  console.log('No leads found with those thread IDs.');
  process.exit(0);
}

for (const lead of leads) {
  console.log(`\nQualifying: "${lead.title}"`);
  const r = await qualifyLead(lead.title, lead.description || lead.title);
  await query(
    'UPDATE leads SET is_qualified=$1, qualification_reason=$2, niche_match_score=$3 WHERE id=$4',
    [r.qualified, r.reason, Math.round(r.confidence * 100), lead.id]
  );
  console.log(`  → ${r.qualified ? 'APPROVED ✅' : 'REJECTED ❌'} (${r.confidence}) — ${r.reason}`);
}

process.exit(0);
