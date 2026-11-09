'use strict';

// owner decision: "let the linkedin research reflect those priority people and
// then anyone else helpful". The crawl visits people in priority order, and for
// priority people with no LinkedIn URL on file it searches the owner's own
// 1st-degree connections once, accepting only an unambiguous name match. Read
// only: no connect, message, follow, or reaction.

const fs = require('node:fs');
const path = require('node:path');
const { normalizeKey } = require('./people-priority.js');

const RECHECK_DAYS = 14;
const DEFAULT_RESOLVE_MAX = 12;
const SOURCE_TAG = 'amy-1st-degree-search';

function readFrontMatter(text) {
  const match = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}

function hasLinkedInUrl(frontMatter) {
  return /^linkedin\w*:\s*['"]?https?:\/\/[^\s'"]*linkedin\.com\/in\//im.test(frontMatter || '');
}

function checkedRecently(frontMatter, today, days = RECHECK_DAYS) {
  const match = String(frontMatter || '').match(/^linkedin_search_checked:\s*(\d{4}-\d{2}-\d{2})/m);
  if (!match) return false;
  const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${match[1]}T00:00:00Z`)) / 86400000;
  return age >= 0 && age < days;
}

// Set or replace front-matter keys, keeping every other line as is.
function setFrontMatter(text, fields) {
  const match = String(text).match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!match) return text;
  let fm = match[2];
  for (const [key, value] of Object.entries(fields)) {
    const line = `${key}: ${value}`;
    const re = new RegExp(`^${key}:.*$`, 'm');
    fm = re.test(fm) ? fm.replace(re, line) : `${fm}\n${line}`;
  }
  return text.replace(match[0], `${match[1]}${fm}${match[3]}`);
}

// A full name searches alone (the name check guards it); a first name alone
// carries the curated context words, e.g. "PRIVATE_NAME".
function searchTerms(row) {
  return normalizeKey(row.name).includes(' ') ? row.name : row.search;
}

// Priority people with a search string, a contact file, no URL yet, and no
// recent failed search, in rank order.
function resolveCandidates({ people = [], contactsDir, today, max = DEFAULT_RESOLVE_MAX }) {
  const out = [];
  for (const row of people) {
    if (out.length >= max) break;
    if (!row.search) continue;
    const file = path.join(contactsDir, `${row.id}.md`);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const fm = readFrontMatter(text);
    if (fm === null || hasLinkedInUrl(fm) || checkedRecently(fm, today)) continue;
    out.push({ ...row, search: searchTerms(row), file });
  }
  return out;
}

function searchUrl(search) {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(search)}&network=%5B%22F%22%5D`;
}

function canonicalProfileUrl(href) {
  const match = String(href || '').match(/^(?:https?:\/\/(?:[a-z]+\.)?linkedin\.com)?(\/in\/[^/?#]+)/i);
  return match ? `https://www.linkedin.com${match[1]}` : '';
}

// anchors: [{ href, text }] from a 1st-degree people search page. Only result
// cards count: their text reads "Display Name • 1st ...". Mutual-connection
// links and headlines never do. The card's display name (the text before the
// first bullet) must equal the listed full name, or for a first-name-only entry
// start with it, and exactly one card may match; a first-name-only entry also
// needs the page to show exactly one card.
function cardDisplayName(text) {
  const raw = String(text || '');
  const cut = raw.indexOf('•');
  if (cut < 0) return null;
  const after = normalizeKey(raw.slice(cut + 1)).split(' ')[0];
  if (after !== '1st') return null;
  return normalizeKey(raw.slice(0, cut).split(',')[0]);
}

function pickFirstDegreeMatch(entry, anchors = []) {
  const tokens = normalizeKey(entry.name).split(' ').filter(Boolean);
  if (!tokens.length) return { result: 'none', cards: [] };
  const cards = new Map();
  for (const anchor of anchors) {
    const url = canonicalProfileUrl(anchor.href);
    const display = url ? cardDisplayName(anchor.text) : null;
    if (display && !cards.has(url)) cards.set(url, display);
  }
  const evidence = [...cards].map(([url, display]) => ({ url, display }));
  const full = tokens.join(' ');
  const matches = evidence.filter(({ display }) =>
    tokens.length > 1 ? display === full : display === full || display.startsWith(`${full} `),
  );
  if (tokens.length === 1 && cards.size > 1) {
    return { result: matches.length ? 'ambiguous' : 'none', cards: evidence };
  }
  if (matches.length === 1) return { result: 'match', url: matches[0].url, cards: evidence };
  return { result: matches.length ? 'ambiguous' : 'none', cards: evidence };
}

// Raw first (Codex F3): each search's evidence is written under a unique name
// and copied to the Life Archive bucket with a verified SHA-256 receipt before
// any contact changes. A failed copy throws, so the caller records an error
// and the person is retried next run.
const ARCHIVE_BUCKET = 'ExampleCo-secondbrain-backups';
const ARCHIVE_PREFIX = 'data-lake/secondbrain/life-archive/data/linkedin/raw/priority-resolver';

function archiveResolverEvidence({ evidence, dir, upload, now = new Date() }) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const name = `${String(evidence.id || 'unknown').replace(/[^A-Za-z0-9_-]+/g, '-')}-${stamp}.json`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2), { encoding: 'utf8', flag: 'wx' });
  const receipt = upload(file, {
    bucket: ARCHIVE_BUCKET,
    key: `${ARCHIVE_PREFIX}/${name}`,
    requireChecksumSha256: true,
  });
  if (!receipt || !receipt.s3Uri || !receipt.sha256) throw new Error(`no archive receipt for ${name}`);
  return { file, receipt };
}

function applyResolution(text, outcome, today) {
  if (outcome.result === 'match') {
    return setFrontMatter(text, {
      linkedin: outcome.url,
      linkedin_source: `${SOURCE_TAG} ${today}`,
    });
  }
  return setFrontMatter(text, {
    linkedin_search_checked: today,
    linkedin_search_result: outcome.result,
  });
}

// Crawl order: priority rank first (list order, then recorder regulars), then
// the old category order for everyone else.
function orderByPriority(contacts, rankOf) {
  const categoryOrder = { 'inner-circle': 0, 'active-network': 1 };
  const keyed = contacts.map((contact, index) => ({
    contact,
    index,
    rank: rankOf(String(contact.file || '').replace(/\.md$/, ''), contact.name),
  }));
  keyed.sort((a, b) => {
    const ra = a.rank ?? Infinity;
    const rb = b.rank ?? Infinity;
    if (ra !== rb) return ra - rb;
    const ca = categoryOrder[a.contact.category] ?? 99;
    const cb = categoryOrder[b.contact.category] ?? 99;
    if (ca !== cb) return ca - cb;
    return a.index - b.index;
  });
  return keyed.map((row) => row.contact);
}

module.exports = {
  ARCHIVE_BUCKET,
  ARCHIVE_PREFIX,
  archiveResolverEvidence,
  DEFAULT_RESOLVE_MAX,
  RECHECK_DAYS,
  SOURCE_TAG,
  applyResolution,
  canonicalProfileUrl,
  cardDisplayName,
  checkedRecently,
  hasLinkedInUrl,
  orderByPriority,
  pickFirstDegreeMatch,
  resolveCandidates,
  searchTerms,
  searchUrl,
  setFrontMatter,
};
