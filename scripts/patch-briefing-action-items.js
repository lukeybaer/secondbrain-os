#!/usr/bin/env node
// One-time patch: add missing action items to today's briefing.
// Run: node scripts/patch-briefing-action-items.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Pick the most-recent briefing file when today's isn't on disk yet (the
// briefing runs in CT; UTC days roll over before CT does). Lets this script
// run any time of day without "No briefing for <UTC tomorrow>" failures.
function pickLatestBriefing() {
  const dir = path.join(ROOT, 'data', 'briefings');
  const files = fs.readdirSync(dir)
    .filter((f) => /^briefing-\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}
const argDate = process.argv[2];
const todayIso = argDate || new Date().toISOString().slice(0, 10);
const todayBriefing = path.join(ROOT, 'data', 'briefings', `briefing-${todayIso}.md`);
const briefingPath = fs.existsSync(todayBriefing) ? todayBriefing : pickLatestBriefing();

if (!briefingPath) {
  console.error('No briefing files found in data/briefings/');
  process.exit(1);
}
console.log('[patch] using briefing:', path.basename(briefingPath));

const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'briefing-action-items.json'), 'utf8'));
const openItems = (d.unansweredEmails || []).filter(e => !e.repliedAt).sort((a, b) => (a.rank || 99) - (b.rank || 99));

let content = fs.readFileSync(briefingPath, 'utf8');
const lines = content.split('\n');

// Find the ACTION ITEMS section end (first line that is OPEN COMMITMENTS)
const aiStart = lines.findIndex(l => l.startsWith('ACTION ITEMS'));
const ocStart = lines.findIndex(l => l.startsWith('OPEN COMMITMENTS'));
if (aiStart < 0 || ocStart < 0) {
  console.error('Could not find ACTION ITEMS or OPEN COMMITMENTS section');
  process.exit(1);
}

// Current item count in the section
const currentItems = lines.slice(aiStart, ocStart).filter(l => /^\d+\./.test(l.trim())).length;
console.log('Current action items in briefing:', currentItems, '/ should be:', openItems.length);

// Always rewrite the section so the canonical fields (person, summary,
// daysOld, gmailUrl) win over any stale "Unknown" placeholders that earlier
// versions of this script wrote. Idempotent: identical inputs produce identical
// output.

// Build new action items block
function ageDays(isoDate) {
  if (!isoDate) return 0;
  return Math.round((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

const gmailBase = 'https://mail.google.com/mail/u/0/#inbox/';
const newBlock = ['ACTION ITEMS -- unanswered asks (verified by reading each thread):', ''];

for (let i = 0; i < openItems.length; i++) {
  const e = openItems[i];
  const age = e.daysOld != null ? e.daysOld : ageDays(e.sentAt);
  // Field-name precedence matches manual-briefing-v3.js: `person` is the
  // canonical key on briefing-action-items.json. Fall back to legacy
  // contactName/contact only if person is absent.
  const contact = e.person || e.contactName || e.contact || 'Unknown';
  const body = (e.summary || e.body || e.description || '').slice(0, 300).replace(/\n/g, ' ');
  const url = e.gmailUrl
    || (e.threadId && /^[0-9a-f]{12,20}$/i.test(e.threadId) ? gmailBase + e.threadId : '');
  newBlock.push(`${i + 1}. ${contact} -- ${e.subject} (${age}d old)`);
  if (body) newBlock.push(`   ${body}`);
  if (url) newBlock.push(`   ${url}`);
  newBlock.push('');
}

// Replace the action items section (from aiStart+1 to ocStart)
const before = lines.slice(0, aiStart);
const after = lines.slice(ocStart);
const patched = [...before, ...newBlock, ...after].join('\n');

fs.writeFileSync(briefingPath, patched, 'utf8');
console.log('Patched', briefingPath, 'with', openItems.length, 'action items');
