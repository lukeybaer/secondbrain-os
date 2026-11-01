'use strict';

// Owner context for the Emails to Action card (Owner decision: read email
// with context about my life, not at face value). Two parts:
//   1. memory/email_triage_owner_context.md is the canonical prose, passed to
//      the ranking model as evidence.
//   2. Deterministic pre-filters for the hard rules (Client App invoice copies,
//      scam patterns) so the model never sees them as candidates.
// Plus a bounded People-file lookup: name, relationship label and last
// interaction only, never contact details.

const fs = require('node:fs');
const path = require('node:path');
const { buildPeopleCatalog } = require('./gmail-people-facts.js');

const CONTEXT_FILE = 'memory/email_triage_owner_context.md';
const CONTEXT_MAX_BYTES = 3500;

function loadOwnerContext(root) {
  try {
    const text = fs.readFileSync(path.join(root, CONTEXT_FILE), 'utf8').replace(/^---[\s\S]*?\n---\s*/, '');
    return `${CONTEXT_FILE}\n${text}`.slice(0, CONTEXT_MAX_BYTES);
  } catch {
    return '';
  }
}

// Client App invoices are the owner's own business billing its customers; he is
// copied on every one, sometimes on the To line. Never a bill for him.
const CLIENT_APP_SENDER = /@theclientapp\.com\b/i;
function isClientAppInvoiceCopy(msg) {
  return CLIENT_APP_SENDER.test(String((msg && msg.from) || '')) && /\binvoice\b/i.test(String((msg && msg.subject) || ''));
}

const SCAM_PATTERNS = [
  /\b(?:prince|princess|barrister|diplomat|late (?:husband|father)|widow)\b[\s\S]{0,300}\b(?:gold|funds?|million|fortune|inheritance|bank account|estate|transfer)\b/i,
  /\b(?:gold|funds?|fortune|inheritance|estate)\b[\s\S]{0,300}\b(?:prince|princess|barrister|late (?:husband|father))\b/i,
  /\b(?:unclaimed (?:funds?|inheritance|estate)|next of kin|beneficiary of (?:a |an |the )?(?:estate|fund|inheritance))\b/i,
  /\b(?:you(?:'ve| have)? (?:won|been selected)|congratulations[,!]? you)\b[\s\S]{0,200}\b(?:lottery|prize|jackpot|sweepstakes|\$\s?[\d,]{4,})/i,
  /\b(?:lottery|sweepstakes) (?:winner|winnings|claim)\b/i,
  /\b(?:buy|purchase|send|need) (?:me )?(?:\d+ )?(?:itunes|google play|amazon|apple|steam) gift cards?\b/i,
  /\b(?:crypto|bitcoin|btc|ethereum)\b[\s\S]{0,120}\b(?:giveaway|double your|guaranteed returns?|send (?:me|us) \d)/i,
  /\b(?:transfer|release|move) (?:of )?(?:the )?(?:sum of )?(?:us\$|\$|usd)\s?[\d.,]+\s?(?:million|m)\b/i,
];

// A sender the owner has a People file for is never auto-called a scam.
function isScamEmail(msg, relationship = null) {
  if (relationship) return false;
  const text = `${(msg && msg.subject) || ''}\n${(msg && msg.body) || ''}`.slice(0, 6000);
  return SCAM_PATTERNS.some((re) => re.test(text));
}

// Bounded People lookup: email address -> { name, relationship, lastInteraction }.
// Addresses come from the canonical People catalog (lines a file labels as its
// own email), never from every address mentioned in the file, and an address
// claimed by more than one file is dropped rather than guessed.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const indexCache = new Map();

// Frontmatter field at any nesting depth (top level or under metadata:).
function fieldOf(text, key) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!fm) return '';
  const m = new RegExp(`^[ \t]*${key}:[ \t]*(.+)$`, 'mi').exec(fm[1]);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

function buildPeopleIndex(root) {
  const index = new Map();
  let catalog;
  try {
    catalog = buildPeopleCatalog(root);
  } catch {
    return index;
  }
  for (const [email, rows] of catalog.byEmail) {
    if (rows.length !== 1) continue;
    const row = rows[0];
    const entry = {
      name: (fieldOf(row.text, 'name') || row.display_name || '').slice(0, 80),
      relationship: (fieldOf(row.text, 'category') || fieldOf(row.text, 'relationship')).slice(0, 60),
      lastInteraction: fieldOf(row.text, 'last_interaction').slice(0, 20),
    };
    if (entry.name) index.set(email, entry);
  }
  return index;
}

function peopleIndexFor(root) {
  if (!indexCache.has(root)) indexCache.set(root, buildPeopleIndex(root));
  return indexCache.get(root);
}

function relationshipFor(from, root) {
  if (!root) return null;
  const addr = (String(from || '').match(EMAIL_RE) || [])[0];
  if (!addr) return null;
  return peopleIndexFor(root).get(addr.toLowerCase()) || null;
}

module.exports = { loadOwnerContext, isClientAppInvoiceCopy, isScamEmail, relationshipFor, buildPeopleIndex, CONTEXT_FILE };
