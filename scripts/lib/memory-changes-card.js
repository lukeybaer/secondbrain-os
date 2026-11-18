'use strict';
// MEMORY.MD CHANGES (24H): what changed in Amy's Tier 1 memory in the last day.
// owner decision (#otter): "Try to get it to be generally similar in terms of
// its output. I like how it works, but not for 2000 lines of code, and not in
// nine parts." One producer: git log plus one net diff of memory/MEMORY.md. The
// snapshot run (where git is) writes it to data/agent/memory-delta-snapshot.json;
// the dashboard and the briefing markdown only render memoryChangesSummary().
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { scrubInternalIdsFromFace } = require('./executive-surface-policy');

const FILE = 'memory/MEMORY.md';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const RAW_PATH = /(?:\/(?:opt\/secondbrain|life-archive|Users|mnt|home|data\/agent)\/|\b[A-Za-z]:\\|%[A-Za-z]+%\\)\S*/gi;
const DATE = '--date=format:%b %d %I:%M %p';

function memoryChanges(repo, hours = 24, git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  const generatedAt = new Date().toISOString();
  try {
    const log = git(['log', `--since=${hours} hours ago`, '--format=%H|%ad|%s', DATE, '--', FILE]);
    const shas = [];
    const card = { hours, generatedAt, commits: [], updated: [], added: [], removed: [], plus: 0, minus: 0 };
    for (const line of log.split('\n').filter(Boolean)) {
      const [sha, when, ...subject] = line.split('|');
      shas.push(sha);
      card.commits.push({ when, subject: subject.join('|') });
    }
    if (shas.length) {
      Object.assign(card, pointerDiff(git, parentOf(git, shas[shas.length - 1]), 'HEAD'));
    } else {
      // A quiet day still says something (owner decision: "no memory changes at
      // all?"): when the index last changed and what that edit did, and which Tier 2
      // memory files changed in the window. Contacts belong to the People Files card.
      const [sha, when, ...subject] = git(['log', '-1', '--format=%H|%ad|%s', DATE, '--', FILE]).trim().split('|');
      if (sha) card.lastEdit = { when, subject: subject.join('|'), ...pointerDiff(git, parentOf(git, sha), sha) };
      const changed = git(['log', `--since=${hours} hours ago`, '--format=', '--name-only', '--', 'memory/',
        `:(exclude)${FILE}`, ':(exclude)memory/contacts/', ':(exclude)memory/archive/']);
      card.tier2 = [...new Set(changed.split('\n').filter((f) => f.endsWith('.md')).map((f) => f.slice('memory/'.length)))];
    }
    // Per-item "why it matters" (feedback_per_item_why_it_matters.md), one per
    // linked Tier 2 file, read here because only the snapshot run has the repo.
    card.why = {};
    const pointers = [...card.added, ...card.updated.map((c) => c.after)];
    for (const file of [...pointers.flatMap(linkedFiles), ...(card.tier2 || [])]) {
      if (card.why[file]) continue;
      try {
        const why = whyFromFile(fs.readFileSync(path.join(repo, 'memory', file), 'utf8').slice(0, 4000));
        if (why) card.why[file] = why.slice(0, 240);
      } catch { /* pointer to a file that is not there: no why line */ }
    }
    card.indexLines = fs.readFileSync(path.join(repo, FILE), 'utf8').split('\n').length;
    return card;
  } catch (err) {
    const why = String(err.message).trim().split('\n').pop();
    return { hours, generatedAt, stale: true, reason: `Could not read memory history: ${why}` };
  }
}

function parentOf(git, sha) {
  try { return git(['rev-parse', `${sha}^`]).trim(); } catch { return EMPTY_TREE; } // first commit of the file
}

// The net change to the index between two revisions. A removed and an added line
// with the same pointer (its bold label, else its linked file) are one update: a
// reworded pointer. Everything else is a plain removal or addition, so replacing
// one rule with another reads as both.
function pointerDiff(git, base, head) {
  const minus = [];
  const plus = [];
  for (const raw of git(['diff', '--no-color', '--unified=0', base, head, '--', FILE]).split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    const text = raw.slice(1).trim();
    if (!text || text === '---' || /^##\s/.test(text)) continue;
    if (raw[0] === '-') minus.push(text);
    if (raw[0] === '+') plus.push(text);
  }
  const out = { updated: [], added: [], removed: [], plus: plus.length, minus: minus.length };
  const paired = new Set();
  for (const before of minus) {
    const key = pointerKey(before);
    const j = key ? plus.findIndex((after, k) => !paired.has(k) && pointerKey(after) === key) : -1;
    if (j < 0) {
      out.removed.push(before);
      continue;
    }
    paired.add(j);
    out.updated.push({ before, after: plus[j] });
  }
  out.added.push(...plus.filter((_, k) => !paired.has(k)));
  return out;
}

// The Tier 2 files a pointer links to ("-> `a.md`, `b.md`").
function linkedFiles(line) {
  const tail = String(line).split(/\s(?:->|→)\s*/).slice(1).join(' ');
  return [...new Set((tail.match(/[\w./-]+\.md/g) || []).filter((f) => !f.includes('..')))];
}

// A pointer's identity across a rewording: its bold label, else its first linked file.
function pointerKey(line) {
  const bold = String(line).match(/\*\*([^*]+)\*\*/);
  if (bold) return `label:${bold[1].trim().toLowerCase().replace(/\s+/g, ' ')}`;
  const file = linkedFiles(line)[0];
  return file ? `file:${file.toLowerCase()}` : '';
}

// Why a lesson matters, in its own words: the frontmatter description, else the
// trigger quote, else the first prose paragraph under its title.
function whyFromFile(body) {
  const desc = body.match(/^description:\s*(.+)$/m);
  if (desc) return desc[1].trim().replace(/^["']|["']$/g, '');
  const trigger = body.match(/^trigger:\s*"([^"]+)"/m);
  if (trigger) return `Captured from: "${trigger[1].trim().slice(0, 200)}"`;
  for (const para of (body.split(/^#\s+.+$/m)[1] || '').split(/\n\s*\n/)) {
    const text = para.replace(/\s+/g, ' ').trim();
    if (text.length >= 30 && !/^(?:---|#|-\s|[a-z_]+:)/.test(text)) return text;
  }
  return '';
}

// "feedback_foo_bar.md" reads as "Foo Bar".
const fileTitle = (file) =>
  path.basename(file, '.md').replace(/^(feedback|reference|project|user)_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// One privacy scrub for every surface: no raw paths, no internal ids.
const clean = (s) => scrubInternalIdsFromFace(String(s || '').replace(RAW_PATH, '')).replace(/\s{2,}/g, ' ').trim();
// "- **Label** text -> `file.md`" reads as "Label"; an unlabeled line reads as its text.
function pointerHead(line) {
  const bold = String(line).match(/\*\*([^*]+)\*\*/);
  const head = clean((bold ? bold[1] : String(line).replace(/^[-*]\s+/, '').split(/\s+->\s+/)[0]).replace(/[`*]/g, ''));
  return head.length > 70 ? `${head.slice(0, 67)}...` : head;
}

// "Updated: A; B / Added: C": the first two pointers of each kind.
function describe(rows) {
  return ['Updated', 'Added', 'Removed']
    .map((kind) => [kind, rows.filter((r) => r.kind === kind).map((r) => r.head)])
    .filter(([, heads]) => heads.length)
    .map(([kind, heads]) => `${kind}: ${heads.slice(0, 2).join('; ')}`)
    .join(' / ');
}

function memoryChangesSummary(card) {
  if (!card || card.stale || !Array.isArray(card.commits)) {
    const reason = card && card.reason ? clean(card.reason) : 'The memory snapshot has not run since the card changed.';
    return { stale: true, delta: 0, label: 'memory history unavailable', face: reason, commits: [], rows: [] };
  }
  // One why per linked file; a pointer to several files names each one.
  const why = (line) => {
    const found = linkedFiles(line).filter((file) => (card.why || {})[file]);
    const parts = found.map((file) => (found.length > 1 ? `${fileTitle(file)}: ` : '') + clean(card.why[file]));
    return parts.join(' / ') || undefined;
  };
  const pointerRows = (diff) => [
    ...diff.updated.map((c) => ({ kind: 'Updated', head: pointerHead(c.after), before: clean(c.before), after: clean(c.after), why: why(c.after) })),
    ...diff.added.map((line) => ({ kind: 'Added', head: pointerHead(line), after: clean(line), why: why(line) })),
    ...diff.removed.map((line) => ({ kind: 'Removed', head: pointerHead(line), before: clean(line) })),
  ];
  const n = card.commits.length;
  let rows = pointerRows(card);
  let face = describe(rows) || (n ? clean(card.commits[0].subject) : '');
  if (n === 0) {
    const last = card.lastEdit;
    const tier2 = card.tier2 || [];
    const titles = tier2.slice(0, 3).map(fileTitle).join(', ') + (tier2.length > 3 ? ` and ${tier2.length - 3} more` : '');
    face = [
      `No edits to the MEMORY.md index in the last ${card.hours} hours${last ? `; the last was ${last.when}` : ''}.`,
      tier2.length
        ? `${tier2.length} Tier 2 memory file${tier2.length === 1 ? '' : 's'} changed: ${titles}.`
        : 'No Tier 2 memory files changed either.',
    ].join(' ');
    rows = [
      ...(last ? [{ kind: 'Last index edit', head: last.when, note: [clean(last.subject), describe(pointerRows(last))].filter(Boolean).join('. ') }] : []),
      ...tier2.map((file) => ({ kind: 'Tier 2 file', head: fileTitle(file), why: card.why && card.why[file] ? clean(card.why[file]) : undefined })),
    ];
  }
  return {
    stale: false,
    delta: card.plus + card.minus,
    label: `+${card.plus} / -${card.minus} · ${n} commit${n === 1 ? '' : 's'} · ${card.indexLines}-line index`,
    face,
    commits: card.commits.map((c) => ({ when: c.when, subject: clean(c.subject) })),
    rows: rows.map((row, i) => ({ ...row, key: `${row.kind.toLowerCase().replace(/\s+/g, '-')}-${i}` })),
  };
}

module.exports = { memoryChanges, memoryChangesSummary, pointerHead };
