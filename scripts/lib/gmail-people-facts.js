'use strict';

// gmail-people-facts.js
//
// Email-derived relationship facts into existing People files, the same way the
// call and Signal pipelines do it: resolve to an EXISTING file (never invent
// one), screen sensitive text with the shared note gate, append a dated,
// provenance-tagged fact, and let the caller land the batch in one commit.
//
// Rules (dev-plans/core/memory.md, "Gmail into People"):
//  - match by exact email address first, then by exact full display name only
//    when exactly one file carries it; otherwise HOLD the fact for review.
//  - never create a file named after an email local part.
//  - append only (fs.appendFileSync); an existing file is never rewritten.
//  - facts are tagged "(Gmail)" with the source message id and dedupe on it.

const fs = require('node:fs');
const path = require('node:path');
const {
  loadPeopleFileCatalog,
  exactCandidates,
  hasConflictingSurname,
  normalizeName,
} = require('./voice-people-file-target.js');
const { isSensitive } = require('./voice-people-note-gate.js');
const { assertNoForbiddenPeople } = require('./forbidden-people.js');

const OWNER_EMAILS = new Set(['ExampleCo@gmail.com']);
const AUTOMATED_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|postmaster|bounces?|alerts?|news(letter)?|support|billing|receipts?|updates?)([+._-].*)?$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const BLOCK_HEADING = '## History (Gmail)';
const MAX_RECIPIENTS = 3;

function ownerEmails(extra = []) {
  const set = new Set(OWNER_EMAILS);
  for (const e of extra) if (e) set.add(String(e).toLowerCase());
  return set;
}

function splitAddressList(value) {
  const parts = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of String(value || '')) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle = true;
    else if (!quoted && ch === '>') angle = false;
    if (ch === ',' && !quoted && !angle) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseAddress(value) {
  const text = String(value || '').trim();
  const email = (text.match(EMAIL_RE) || [])[0] || '';
  const name = text
    .replace(/<[^>]*>/g, '')
    .replace(email, '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .trim();
  return { name, email: email.toLowerCase() };
}

// Emails a People file states for its own person: any line that labels an
// email (frontmatter `email:`, `- **Email**: ...`, `Work email: ...`).
function emailsInContactText(text, owners) {
  const found = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/e-?mail/i.test(line)) continue;
    for (const m of line.match(EMAIL_RE) || []) {
      const e = m.toLowerCase();
      if (!owners.has(e)) found.add(e);
    }
  }
  return found;
}

function buildPeopleCatalog(repoRoot, { owners = ownerEmails() } = {}) {
  const rows = loadPeopleFileCatalog(repoRoot).filter((r) => r.rel !== 'memory/user_profile.md');
  const byEmail = new Map();
  for (const row of rows) {
    row.emails = emailsInContactText(row.text, owners);
    for (const e of row.emails) {
      if (!byEmail.has(e)) byEmail.set(e, []);
      byEmail.get(e).push(row);
    }
  }
  return { rows, byEmail };
}

function isAutomatedAddress(email) {
  const local = String(email || '').split('@')[0];
  return AUTOMATED_LOCAL.test(local);
}

function significant(name) {
  return normalizeName(name).split(' ').filter(Boolean);
}

// -> { status: 'matched'|'held'|'skipped', row?, via?, reason?, candidates? }
function resolveCounterparty({ name, email }, catalog) {
  if (!email) return { status: 'skipped', reason: 'no_address' };
  if (isAutomatedAddress(email)) return { status: 'skipped', reason: 'automated_sender' };
  const byEmail = catalog.byEmail.get(email) || [];
  if (byEmail.length === 1) return { status: 'matched', row: byEmail[0], via: 'email' };
  if (byEmail.length > 1) {
    return { status: 'held', reason: 'ambiguous_email', candidates: byEmail.map((r) => r.rel) };
  }
  if (significant(name).length >= 2) {
    const named = exactCandidates(catalog.rows, name);
    if (named.length === 1 && !hasConflictingSurname(name, named[0])) {
      return { status: 'matched', row: named[0], via: 'name' };
    }
    if (named.length > 1) {
      return { status: 'held', reason: 'ambiguous_name', candidates: named.map((r) => r.rel) };
    }
  }
  return { status: 'held', reason: 'no_unambiguous_match', candidates: [] };
}

function isoDate(value, fallback) {
  const ms = Date.parse(value || '');
  if (Number.isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  const fb = Date.parse(fallback || '');
  return Number.isFinite(fb) ? new Date(fb).toISOString().slice(0, 10) : '';
}

function safeSubject(subject) {
  const cleaned = String(subject || '')
    .replace(/[\u0000-\u001f"`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (!cleaned) return '(no subject)';
  return isSensitive(cleaned) ? '(subject withheld, sensitive)' : cleaned;
}

// msg: { id, from, to, subject, date, ts }. Returns facts per counterparty.
function planMessage(msg, catalog, { owners = ownerEmails() } = {}) {
  const id = String(msg.id || msg.message_id || msg.gmail_message_id || '').trim();
  if (!id) return [{ status: 'skipped', reason: 'no_message_id' }];
  const from = parseAddress(msg.from);
  const fromOwner = owners.has(from.email);
  let counterparties;
  if (fromOwner) {
    const to = splitAddressList(msg.to).map(parseAddress).filter((a) => a.email && !owners.has(a.email));
    if (to.length > MAX_RECIPIENTS) return [{ status: 'skipped', reason: 'bulk_recipients', id }];
    counterparties = to;
  } else {
    counterparties = from.email ? [from] : [];
  }
  const date = isoDate(msg.date, msg.ts);
  if (!date) return [{ status: 'skipped', reason: 'no_date', id }];
  return counterparties.map((cp) => {
    const res = resolveCounterparty(cp, catalog);
    const base = { ...res, id, date, email: cp.email, name: cp.name, direction: fromOwner ? 'out' : 'in' };
    if (res.status === 'matched') {
      base.line = factLine({ date, id, direction: base.direction, subject: msg.subject });
    }
    return base;
  });
}

function factLine({ date, id, direction, subject }) {
  const who = direction === 'out' ? 'ExampleCo emailed them' : 'They emailed ExampleCo';
  return `- ${date} (Gmail) ${who}: "${safeSubject(subject)}" [gmail:${id}]`;
}

// Append-only. Returns the number of lines actually added.
function appendFactLines(file, lines) {
  const text = fs.readFileSync(file, 'utf8');
  const fresh = [...new Set(lines)].filter((line) => {
    const id = (line.match(/\[gmail:([^\]]+)\]/) || [])[1];
    return id && !text.includes(`[gmail:${id}]`);
  });
  if (!fresh.length) return 0;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const norm = text.replace(/\r\n/g, '\n');
  const at = norm.lastIndexOf(`\n${BLOCK_HEADING}`);
  const openBlock = at >= 0 && !/\n## /.test(norm.slice(at + 1 + BLOCK_HEADING.length));
  let chunk = '';
  if (!norm.endsWith('\n')) chunk += '\n';
  if (!openBlock) chunk += `\n${BLOCK_HEADING}\n\n`;
  chunk += `${fresh.join('\n')}\n`;
  assertNoForbiddenPeople(chunk, 'Gmail People-file fact');
  fs.appendFileSync(file, chunk.replace(/\n/g, eol), 'utf8');
  return fresh.length;
}

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* torn line: skip */
    }
  }
  return rows;
}

// Stage a batch: append matched facts, hold the rest. dryRun writes nothing.
function stageGmailFacts(messages, { repoRoot, heldPath, dryRun = false, now = () => new Date().toISOString(), owners } = {}) {
  const catalog = buildPeopleCatalog(repoRoot, { owners });
  const heldIds = new Set(readJsonl(heldPath).map((r) => `${r.message_id}|${r.email}`));
  const perFile = new Map();
  const held = [];
  const summary = { messages: 0, matched: 0, matched_by_email: 0, matched_by_name: 0, held: 0, skipped: 0, appended: 0 };
  const matchedFiles = new Set();
  const seenMessages = new Set();
  for (const msg of messages) {
    for (const plan of planMessage(msg, catalog, { owners })) {
      if (plan.id && !seenMessages.has(plan.id)) {
        seenMessages.add(plan.id);
        summary.messages++;
      }
      if (plan.status === 'skipped') summary.skipped++;
      else if (plan.status === 'matched') {
        summary.matched++;
        if (plan.via === 'email') summary.matched_by_email++;
        else summary.matched_by_name++;
        matchedFiles.add(plan.row.rel);
        if (!perFile.has(plan.row.file)) perFile.set(plan.row.file, []);
        perFile.get(plan.row.file).push(plan.line);
      } else {
        summary.held++;
        if (!heldIds.has(`${plan.id}|${plan.email}`)) {
          heldIds.add(`${plan.id}|${plan.email}`);
          held.push({
            ts: now(),
            message_id: plan.id,
            email: plan.email,
            name: plan.name,
            date: plan.date,
            reason: plan.reason,
            candidates: plan.candidates || [],
          });
        }
      }
    }
  }
  summary.matched_files = matchedFiles.size;
  if (!dryRun) {
    for (const [file, lines] of perFile) summary.appended += appendFactLines(file, lines);
    if (held.length && heldPath) {
      fs.mkdirSync(path.dirname(heldPath), { recursive: true });
      fs.appendFileSync(heldPath, held.map((h) => JSON.stringify(h)).join('\n') + '\n', 'utf8');
    }
  }
  return { summary, held, matchedFiles: [...matchedFiles] };
}

module.exports = {
  BLOCK_HEADING,
  appendFactLines,
  buildPeopleCatalog,
  factLine,
  isAutomatedAddress,
  ownerEmails,
  parseAddress,
  planMessage,
  readJsonl,
  resolveCounterparty,
  splitAddressList,
  stageGmailFacts,
};
