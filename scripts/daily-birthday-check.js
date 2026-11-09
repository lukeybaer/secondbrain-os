#!/usr/bin/env node
/**
 * daily-birthday-check.js
 *
 * Deterministic replacement for the daily-birthday-check model session
 * (2026-10-05, Amy Top 15 smaller win). Scans memory/contacts/*.md frontmatter
 * for birthday, anniversary, work_anniversary, spouse_birthday, kids_birthdays
 * and writes memory/contacts/_upcoming-dates.md in the same format the model
 * produced. run-scheduled-skill.js runs it through scheduled-tasks/
 * daily-birthday-check/direct.json and lands the output through the same gate.
 *
 * Usage: node scripts/daily-birthday-check.js [--date YYYY-MM-DD] [--root DIR]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const WINDOW_DAYS = 7;
const SINGLE_FIELDS = [
  ['birthday', 'Birthday'],
  ['birthdate', 'Birthday'],
  ['anniversary', 'Anniversary'],
  ['work_anniversary', 'Work anniversary'],
  ['spouse_birthday', 'Spouse birthday'],
];

function isContactFile(name) {
  return /\.md$/i.test(name) && !name.startsWith('_') && !/^[A-Z0-9_]+\.md$/.test(name);
}

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    out[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// "MM-DD", "YYYY-MM-DD" or "MM/DD[/YY]" -> "MM-DD"; month-only ("03-XX") -> null.
function monthDay(value) {
  const s = String(value || '').trim();
  const m = /^(?:\d{4}-)?(\d{2})-(\d{2})$/.exec(s) || /^(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?$/.exec(s);
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function displayName(fm, file) {
  let name = String(fm.name || path.basename(file, '.md')).replace(/\s*\(last name unknown\)/i, '').trim();
  if (/^ExampleCo$/i.test(String(fm.category || '').trim()) && !/\(/.test(name)) name += ' (ExampleCo)';
  return name;
}

function extractDates(fm, file) {
  const name = displayName(fm, file);
  const dates = [];
  for (const [key, label] of SINGLE_FIELDS) {
    const md = monthDay(fm[key]);
    if (md) dates.push({ name, md, event: label });
  }
  if (fm.kids_birthdays) {
    for (const part of fm.kids_birthdays.split(',')) {
      const kv = /^\s*([^:]+):\s*(.+?)\s*$/.exec(part);
      const md = kv && monthDay(kv[2]);
      if (md) dates.push({ name, md, event: `${kv[1].trim()}'s birthday` });
    }
  }
  return dates;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Upcoming dates in [today, today+7], year-boundary safe. Feb 29 falls on Feb 28
// in non-leap years so it is never silently skipped.
function upcoming(dates, today) {
  const days = new Map();
  for (let i = 0; i <= WINDOW_DAYS; i++) days.set(addDays(today, i).slice(5), i);
  const hits = [];
  for (const d of dates) {
    const key = d.md === '02-29' && !days.has('02-29') ? '02-28' : d.md;
    if (days.has(key)) hits.push({ ...d, offset: days.get(key), on: key });
  }
  return hits.sort((a, b) => a.offset - b.offset || a.name.localeCompare(b.name));
}

function bullet(h) {
  const action =
    h.offset === 0
      ? 'Send a quick message to recognize it today.'
      : 'Consider a brief note or message to recognize it.';
  return `- **${h.name}**: ${h.event} on ${h.on}. Suggested action: ${action}`;
}

function render({ today, hits, scanned }) {
  const end = addDays(today, WINDOW_DAYS);
  const out = [
    '---',
    'name: upcoming-dates',
    'description: Upcoming birthdays and anniversaries for the next 7 days',
    `last_scan: ${today}`,
    `window_start: ${today}`,
    `window_end: ${end}`,
    '---',
    '',
    '# Upcoming Dates',
    '',
    `**Scan date:** ${today}`,
    `**Window:** ${today} to ${end}`,
    '',
  ];
  const now = hits.filter((h) => h.offset === 0);
  const later = hits.filter((h) => h.offset > 0);
  if (!hits.length) {
    out.push('## No upcoming dates', '', 'No birthdays or anniversaries in the next 7 days.', '');
  }
  if (now.length) out.push('## TODAY', '', ...now.map(bullet), '');
  if (later.length) out.push('## This Week', '', ...later.map(bullet), '');
  out.push(`**Total contacts scanned:** ${scanned}`, '');
  return out.join('\n');
}

function scan({ contactsDir, today }) {
  const files = fs.readdirSync(contactsDir).filter(isContactFile).sort();
  const dates = [];
  for (const f of files) {
    dates.push(...extractDates(frontmatter(fs.readFileSync(path.join(contactsDir, f), 'utf8')), f));
  }
  return { today, hits: upcoming(dates, today), scanned: files.length };
}

function main(argv = process.argv.slice(2)) {
  const arg = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = path.resolve(arg('--root') || process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..'));
  const today = arg('--date') || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`bad --date ${today}`);
  const contactsDir = path.join(root, 'memory', 'contacts');
  const result = scan({ contactsDir, today });
  fs.writeFileSync(path.join(contactsDir, '_upcoming-dates.md'), render(result));
  console.log(
    `daily-birthday-check ${today}: scanned ${result.scanned} contact files, ${result.hits.length} upcoming date(s).`,
  );
}

if (require.main === module) main();

module.exports = { extractDates, frontmatter, isContactFile, monthDay, render, scan, upcoming };
