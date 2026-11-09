'use strict';

// The owner's people priority ranking (Owner decision: "just build and maintain
// the ranking yourself ... that original list was my people in order so that's
// the baseline it won't change much - ExampleCo people I interact with matter too
// and STARTUP and ExampleCo"). Amy owns memory/contacts/_priority.json; rank is list
// order. Family ranks above the list and is loaded elsewhere from the family
// memory. At runtime anyone not listed who reaches AUTO_MIN_CALLS distinct
// recorded calls is appended after the curated list, so a new regular appears
// without waiting for a hand edit and the curated order never moves on its own.

const fs = require('node:fs');
const path = require('node:path');

const PRIORITY_REL = ['memory', 'contacts', '_priority.json'];
const SCHEMA = 'amy-people-priority/v1';
const AUTO_MIN_CALLS = 10;

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function loadPriorityList(repoRoot) {
  const file = path.join(repoRoot, ...PRIORITY_REL);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { available: false, people: [], file };
  }
  if (!doc || doc.schema !== SCHEMA || !Array.isArray(doc.people)) {
    return { available: false, people: [], file };
  }
  const seen = new Set();
  const people = [];
  for (const row of doc.people) {
    const id = String((row && row.id) || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    people.push({
      id,
      name: String(row.name || id),
      group: String(row.group || 'other'),
      search: row.search ? String(row.search) : '',
      aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
    });
  }
  return { available: true, people, file, updated: doc.updated || null };
}

// Curated order first, then recorder regulars the list does not yet name. Each
// row carries rank (1-based), personId, name, group, and source.
function effectivePriority({ curated = [], otter = [], autoMinCalls = AUTO_MIN_CALLS } = {}) {
  const rows = [];
  const claimed = new Set();
  const claimedNames = new Set();
  for (const row of curated) {
    rows.push({ personId: row.id, name: row.name, group: row.group, search: row.search, aliases: row.aliases, source: 'curated' });
    claimed.add(row.id);
    for (const alias of row.aliases || []) claimed.add(alias);
    const key = normalizeKey(row.name);
    if (key.includes(' ')) claimedNames.add(key);
  }
  for (const row of otter) {
    if (claimed.has(row.personId)) continue;
    if (claimedNames.has(normalizeKey(row.name))) continue;
    if (curated.length && Number(row.calls || 0) < autoMinCalls) continue;
    rows.push({ personId: row.personId, name: row.name, group: 'other', search: '', aliases: [], source: curated.length ? 'otter-auto' : 'otter', calls: row.calls });
    claimed.add(row.personId);
  }
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

// A promoted person needs a People file so the URL resolver can look them up
// (Codex review 2026-10-31). An existing file is kept as is; otherwise a
// minimal one records who they are and why Amy added them.
function ensurePeopleFile({ repoRoot, row }) {
  const file = path.join(repoRoot, 'memory', 'contacts', `${row.id}.md`);
  if (fs.existsSync(file)) return { file, created: false };
  const body = [
    '---',
    `name: ${row.id.replace(/_/g, '-')}`,
    `description: '${row.name.replace(/'/g, "''")}; the owner started talking with them directly (${row.reason})'`,
    'metadata:',
    '  node_type: memory',
    '  type: user',
    '  category: active-network',
    `  source: amy-direct-contact-promotion ${row.added}`,
    '---',
    '',
    `# ${row.name}`,
    '',
    `Added to the owner's priority list by Amy on ${row.added}: ${row.reason}.`,
    '',
  ].join('\n');
  fs.writeFileSync(file, body, { encoding: 'utf8', flag: 'wx' });
  return { file, created: true };
}

// owner decision: "you can actively add people who I start talking directly
// to". Each candidate (from recentDirectContacts) the list does not already
// name by id, alias, or full name is appended to _priority.json, after
// everyone already listed, with the date and the evidence, and gets a People
// file. Returns the rows added; the file is untouched when nothing is new. A
// missing or malformed list throws, so the caller records a failed promotion.
function promoteDirectContacts({ repoRoot, candidates = [], today }) {
  const file = path.join(repoRoot, ...PRIORITY_REL);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!doc || doc.schema !== SCHEMA || !Array.isArray(doc.people)) {
    throw new Error(`${file} is not an ${SCHEMA} list`);
  }
  const claimed = new Set();
  const claimedNames = new Set();
  for (const row of doc.people) {
    claimed.add(String(row.id));
    for (const alias of row.aliases || []) claimed.add(String(alias));
    const key = normalizeKey(row.name);
    if (key.includes(' ')) claimedNames.add(key);
  }
  const added = [];
  for (const c of candidates) {
    const key = normalizeKey(c.name);
    if (!c.personId || claimed.has(c.personId) || (key.includes(' ') && claimedNames.has(key))) continue;
    const row = {
      rank: doc.people.length + 1,
      id: c.personId,
      name: c.name,
      group: 'direct-auto',
      search: key.includes(' ') ? c.name : '',
      added: today,
      reason: c.reason || `${c.calls} direct calls ${c.firstSeen} to ${c.lastSeen}`,
    };
    ensurePeopleFile({ repoRoot, row });
    doc.people.push(row);
    added.push(row);
    claimed.add(c.personId);
    if (key.includes(' ')) claimedNames.add(key);
  }
  if (added.length) {
    doc.updated = today;
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  }
  return added;
}

// Lookup by contact slug, alias, or full (multi-word) display name.
function priorityIndex(rows) {
  const byId = new Map();
  const byName = new Map();
  for (const row of rows) {
    for (const id of [row.personId, ...(row.aliases || [])]) {
      if (id && !byId.has(id)) byId.set(id, row);
    }
    // Full names only: a bare first name would claim every namesake.
    const key = normalizeKey(row.name);
    if (key.includes(' ') && !byName.has(key)) byName.set(key, row);
  }
  return {
    byId,
    byName,
    rankOf(id, name) {
      const hit = (id && byId.get(id)) || byName.get(normalizeKey(name));
      return hit ? hit.rank : null;
    },
  };
}

module.exports = {
  AUTO_MIN_CALLS,
  PRIORITY_REL,
  SCHEMA,
  effectivePriority,
  loadPriorityList,
  normalizeKey,
  priorityIndex,
  promoteDirectContacts,
};
