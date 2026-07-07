#!/usr/bin/env node
// snapshot-people-and-memory-delta.js
//
// Produces two JSON snapshots that the EC2 dashboard reads as a fallback
// when git is not available on EC2:
//   data/agent/people-files-snapshot.json
//   data/agent/memory-delta-snapshot.json
//
// Run locally (where git lives), then scp the JSONs along with the briefing
// markdown. The dashboard helpers in ec2-server.js
// (buildPeopleFilesChangeCard, buildMemoryDeltaCard) prefer live git but
// fall back to these JSON files when git fails.
//
// ExampleCo 2026-04-28 dispatch: top-level cards for biggest/smallest people
// file change + MEMORY.md change. EC2 has no .git so we ship the
// pre-computed snapshot.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// REPO honors SECONDBRAIN_ROOT (the repo-wide convention used by
// health-self-heal.js) so regression tests can point it at a temp git repo.
// git still runs in REPO (that is where the .git lives).
const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
// OUTPUT honors SECONDBRAIN_DATA_DIR so the snapshots land in the SAME live
// data store the cloud briefing reader looks at (/opt/secondbrain/data/agent
// on EC2). cloud-morning-briefing.js spawns this generator with
// SECONDBRAIN_DATA_DIR=<live data dir>, but the generator used to ignore it and
// wrote to REPO/data/agent (the build-path checkout), so the reader kept
// reading a stale/missing snapshot at the live path and rendered "the memory
// and people snapshot did not run on the cloud build" even when the data
// existed. Defaulting to REPO/data keeps local runs and the regression tests
// (which only set SECONDBRAIN_ROOT) unchanged.
const DATA_DIR = process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data');
const OUT_PEOPLE = path.join(DATA_DIR, 'agent', 'people-files-snapshot.json');
const OUT_MEMORY = path.join(DATA_DIR, 'agent', 'memory-delta-snapshot.json');

function execGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

// Distinguish "git ran, no commits in window" from "git is fatal in this dir"
// (REPO has no real .git). On EC2 the live briefing runner's REPO is
// /opt/secondbrain, whose .git is an empty stub, so EVERY `git log` was fatal and
// execGit returned '' -- indistinguishable from a genuinely idle 24h. That false
// empty was written over the real snapshot and the card read "0 people/memory
// changes" even on a day with a Gmail-scan commit touching 6 contacts (ExampleCo
// 2026-07-07 #gap). This probe lets main() refuse to write a false-zero and lets
// the cloud runner point REPO at a checkout with a real .git.
function gitIsAvailable() {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === 'true';
  } catch {
    return false;
  }
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

// ExampleCo 2026-04-29 dispatch (third pass): aggregator/index files like
// _gmail-daily-intel.md and _upcoming-dates.md are not people. Filter them
// out at snapshot-write time AND read-time so the People Files card is
// always per-contact.
function isAggregatorFile(file) {
  if (!file) return false;
  const basename = path.basename(file, '.md');
  if (basename.startsWith('_')) return true;
  if (basename.toUpperCase() === 'INDEX') return true;
  return false;
}

function peopleHistoryPartIsFresh(text, hours = 24, nowMs = Date.now()) {
  const dates = explicitPeopleDates(text, nowMs);
  if (!dates.length) return true;
  const cutoff = nowMs - Number(hours || 24) * 60 * 60 * 1000;
  return dates.every((ms) => Number.isFinite(ms) && ms >= cutoff);
}

function explicitPeopleDates(text, nowMs = Date.now()) {
  const raw = String(text || '');
  const dates = [...raw.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((m) =>
    Date.parse(`${m[1]}T12:00:00Z`),
  );
  const year = new Date(nowMs).getUTCFullYear();
  const monthByName = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
  };
  for (const m of raw.matchAll(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:\s*(?:-|to)\s*(\d{1,2}))?\b/gi,
  )) {
    const month = monthByName[m[1].toLowerCase()];
    const startDay = Number(m[2]);
    const endDay = Number(m[3] || m[2]);
    for (const day of [startDay, endDay]) {
      const ms = Date.UTC(year, month, day, 12, 0, 0);
      if (Number.isFinite(ms)) dates.push(ms);
    }
  }
  return dates;
}

function hasVoiceOrSourceProof(text) {
  return (
    /\b(?:voice(?:print)?|speaker|source|transcript)\b/i.test(text) &&
    /\b(?:verified|confirmed|matched|identified|proof|evidence|explicitly)\b/i.test(text)
  );
}

function isUnsafePeopleSample(text, file = '') {
  const raw = String(text || '');
  const fileName = path.basename(String(file || ''), '.md').toLowerCase();
  const isExampleCo = fileName === 'PRIVATE_NAME' || /\bExampleCo Millar\b/i.test(raw);
  if (!isExampleCo) return false;
  const isExampleCoLike =
    /\b(?:ExampleCo|teaching|preach(?:ed|ing)?|God defended His own reputation|First Kings|Israel|plains|valleys|Hebrew word)\b/i.test(
      raw,
    );
  return isExampleCoLike && !hasVoiceOrSourceProof(raw);
}

function isPlaceholderPeopleSamplePart(text) {
  const cleaned = String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(?:What was new:\s*)?(?:\[\s*\.\s*\.\s*\.\s*\]|\.\.\.|placeholder)$/i.test(cleaned);
}

function freshPeopleSubjectText(text, hours = 24) {
  const subject = String(text || '').trim();
  if (subject && peopleHistoryPartIsFresh(subject, hours) && !isUnsafePeopleSample(subject))
    return subject;
  return 'contact file changed';
}

// Word-boundary truncation for the "What was new" sample. ExampleCo 2026-04-29
// dispatch: the 280-char cap was cutting off mid-word mid-sentence; 600 chars
// lets multi-source same-day scans (Gmail + Otter on the same contact) finish
// their sentences. The truncation suffix must NOT be "[...]": render-QC
// (peopleFilesDetailDefects in verify-dashboard-cards-live.js) treats a
// literal "[...]" anywhere in the rendered card as a blank/placeholder
// "What was new" detail and flags the card defective (2026-07-06 live defect:
// PRIVATE_NAME' long Otter entry truncated to "... could be [...]" and the
// whole PEOPLE FILES CHANGES card went red). A plain ellipsis marks the cut
// without reading as a placeholder token to any QC placeholder matcher.
function truncatePeopleSample(joined, max = 600) {
  const text = String(joined || '');
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max - 100 ? cut.slice(0, lastSpace) : cut) + '…';
}

function snapshotPeople(hours = 24) {
  const since = `${hours} hours ago`;
  const numstat = execGit([
    'log',
    `--since=${since}`,
    '--numstat',
    '--format=__COMMIT__%H %s',
    '--',
    'memory/contacts/',
  ]);
  if (!numstat) return null;
  const perFile = {};
  let lastSubject = '';
  for (const line of numstat.split('\n')) {
    if (line.startsWith('__COMMIT__')) {
      lastSubject = line.replace('__COMMIT__', '').slice(41).trim();
      continue;
    }
    const m = line.match(/^(\d+)\s+(\d+)\s+(memory\/contacts\/[^\s]+)/);
    if (!m) continue;
    const file = m[3];
    if (isAggregatorFile(file)) continue;
    if (!perFile[file]) perFile[file] = { added: 0, deleted: 0, lastSubject };
    perFile[file].added += parseInt(m[1], 10);
    perFile[file].deleted += parseInt(m[2], 10);
    perFile[file].lastSubject = lastSubject;
  }
  // Pull a few added lines per file from the actual diff so the dashboard
  // can surface "what was new" instead of just commit subjects. ExampleCo
  // 2026-04-29 third pass: "what detail was new that you learned."
  function addedSampleFor(file) {
    const diff = execGit(['log', `--since=${since}`, '-p', '--no-color', '--', file]);
    if (!diff) return '';
    const lines = diff.split('\n');
    const historyEntries = [];
    const bulletEntries = [];
    const proseEntries = [];
    for (const ln of lines) {
      if (ln.startsWith('+++')) continue;
      if (!ln.startsWith('+')) continue;
      const text = ln.slice(1).trim();
      if (!text) continue;
      if (/^(last_update|updated|effective|category|warmth|description):/i.test(text)) continue;
      if (/^---$/.test(text)) continue;
      if (/^##\s/.test(text)) continue;
      if (/^-\s+\d{4}-\d{2}-\d{2}/.test(text)) {
        historyEntries.push(text.replace(/^-\s+/, ''));
        continue;
      }
      if (/^[-*]\s+\S/.test(text)) {
        bulletEntries.push(text.replace(/^[-*]\s+/, ''));
        continue;
      }
      if (text.length > 30 && /[a-z]/.test(text)) proseEntries.push(text);
    }
    // ExampleCo 2026-04-29 dispatch: 280-char cap was cutting off mid-word
    // mid-sentence. Extend to 600 chars so multi-source same-day scans
    // (Gmail + Otter on the same contact) finish their sentences. The
    // dashboard tile still shows ~240-char preview; the drilldown reads
    // the full string.
    const joined = [...historyEntries, ...bulletEntries, ...proseEntries]
      .filter((entry) => !isPlaceholderPeopleSamplePart(entry))
      .filter((entry) => peopleHistoryPartIsFresh(entry, hours))
      .filter((entry) => !isUnsafePeopleSample(entry, file))
      .slice(0, 3)
      .join(' • ');
    return truncatePeopleSample(joined);
  }
  const entries = Object.entries(perFile)
    .map(([file, s]) => ({
      file,
      name: path.basename(file, '.md').replace(/-/g, ' '),
      delta: s.added + s.deleted,
      added: s.added,
      deleted: s.deleted,
      lastSubject: freshPeopleSubjectText(s.lastSubject, hours),
      addedSample: addedSampleFor(file),
    }))
    .sort((a, b) => b.delta - a.delta);
  if (entries.length === 0) return null;
  return {
    biggest: entries[0],
    smallest: entries[entries.length - 1],
    biggestTwo: entries.slice(0, 2),
    smallestTwo: entries.slice(-2).sort((a, b) => a.delta - b.delta),
    allEntries: entries, // ExampleCo 2026-04-29 second pass: drilldown needs all
    totalFiles: entries.length,
    totalLines: entries.reduce((s, e) => s + e.delta, 0),
    hours,
    generatedAt: new Date().toISOString(),
  };
}

// Counts every commit on the repo over the window. The MEMORY.md-scoped
// `git log` only returns commits that touched memory/MEMORY.md, so on a day
// with heavy dev work but no index edit it reported "0 commits" even though
// the repo was busy. ExampleCo 2026-05-18: "I don't believe nothing changed."
// The card now reports the real repo-wide commit count alongside the
// MEMORY.md-specific line delta.
function repoCommitCount(hours) {
  const out = execGit(['log', `--since=${hours} hours ago`, '--pretty=format:%H']);
  if (!out) return 0;
  return out.split('\n').filter((l) => /^[0-9a-f]{7,}$/.test(l.trim())).length;
}

function snapshotMemory(hours = 24) {
  const since = `${hours} hours ago`;
  const numstat = execGit([
    'log',
    `--since=${since}`,
    '--numstat',
    '--format=__COMMIT__%H|%s',
    '--',
    'memory/MEMORY.md',
  ]);
  const repoCommits = repoCommitCount(hours);
  let added = 0;
  let deleted = 0;
  const subjects = [];
  for (const line of (numstat || '').split('\n')) {
    if (line.startsWith('__COMMIT__')) {
      const subj = line.split('|').slice(1).join('|').trim();
      if (subj) subjects.push(subj);
      continue;
    }
    const m = line.match(/^(\d+)\s+(\d+)\s+memory\/MEMORY\.md/);
    if (m) {
      added += parseInt(m[1], 10);
      deleted += parseInt(m[2], 10);
    }
  }
  // Return null only when the repo was genuinely idle. If commits exist but
  // none touched MEMORY.md, still emit a card so the dashboard reflects real
  // repo activity instead of a misleading "0 commits".
  if (added === 0 && deleted === 0 && subjects.length === 0 && repoCommits === 0) return null;
  // ExampleCo 2026-04-29: pull the actual added lines so the dashboard can
  // render real diff content instead of the commit subject. Mirrors the
  // logic in ec2-server.js buildMemoryDeltaCard so snapshot fallback
  // matches live-git path.
  const addedLines = [];
  const deletedLines = [];
  try {
    const diff = execGit(['log', `--since=${since}`, '-p', '--no-color', '--', 'memory/MEMORY.md']);
    if (diff) {
      for (const ln of diff.split('\n')) {
        if (ln.startsWith('+++') || ln.startsWith('---')) continue;
        const isAdd = ln.startsWith('+');
        const isDelete = ln.startsWith('-');
        if (!isAdd && !isDelete) continue;
        const text = ln.slice(1).trim();
        if (!text) continue;
        if (/^---$/.test(text)) continue;
        if (/^##\s/.test(text)) continue;
        if (isAdd && addedLines.length < 5) addedLines.push(text);
        if (isDelete && deletedLines.length < 5) deletedLines.push(text);
        if (addedLines.length >= 5 && deletedLines.length >= 5) break;
      }
    }
  } catch {
    /* ignore */
  }
  let currentLines = 0;
  try {
    const memPath = path.join(REPO, 'memory', 'MEMORY.md');
    if (fs.existsSync(memPath)) currentLines = fs.readFileSync(memPath, 'utf8').split('\n').length;
  } catch {
    /* ignore */
  }
  return {
    added,
    deleted,
    delta: added + deleted,
    // `commits` drives the card's "N commits" count. Use the count of
    // commits that actually touched MEMORY.md when there are any; otherwise
    // fall back to the repo-wide count so the card never claims "0 commits"
    // on a day with real dev activity.
    commits: subjects.length > 0 ? subjects.length : repoCommits,
    memoryCommits: subjects.length,
    repoCommits,
    subjects: subjects.slice(0, 3),
    addedLines,
    deletedLines,
    currentLines,
    hours,
    generatedAt: new Date().toISOString(),
  };
}

function emptyPeopleSnapshot(hours = 24) {
  return {
    hours,
    totalFiles: 0,
    totalLines: 0,
    biggest: null,
    smallest: null,
    biggestTwo: [],
    smallestTwo: [],
    allEntries: [],
    detail: 'No fresh people-file changes with concrete 24-hour details.',
    empty: true,
    generatedAt: new Date().toISOString(),
  };
}

function emptyMemorySnapshot(hours = 24) {
  let currentLines = 0;
  try {
    const memPath = path.join(REPO, 'memory', 'MEMORY.md');
    if (fs.existsSync(memPath)) currentLines = fs.readFileSync(memPath, 'utf8').split('\n').length;
  } catch {
    /* ignore */
  }
  return {
    added: 0,
    deleted: 0,
    delta: 0,
    commits: 0,
    memoryCommits: 0,
    repoCommits: 0,
    subjects: [],
    addedLines: [],
    deletedLines: [],
    currentLines,
    hours,
    source: 'snapshot-empty-success',
    empty: true,
    generatedAt: new Date().toISOString(),
  };
}

function gitUnavailableSnapshot(kind, hours = 24) {
  return {
    hours,
    empty: true,
    gitUnavailable: true,
    detail: `git is not available in ${REPO} (no real .git); the ${kind} change window could not be read. This is a runtime/deploy defect, not a genuinely idle day.`,
    source: 'snapshot-git-unavailable',
    generatedAt: new Date().toISOString(),
  };
}

function main() {
  // If git is fatal in REPO, a '' from execGit is NOT "no commits" -- it is "we
  // could not look." Never overwrite an existing real snapshot with a false zero;
  // write an honest gitUnavailable marker (or leave a good snapshot in place) so
  // the card renders a repair blocker instead of "0 changes."
  const gitOk = gitIsAvailable();
  const people = gitOk ? snapshotPeople(24) : null;
  const memory = gitOk ? snapshotMemory(24) : null;
  ensureDir(OUT_PEOPLE);
  if (people) {
    fs.writeFileSync(OUT_PEOPLE, JSON.stringify(people, null, 2));
    console.log(
      `wrote ${OUT_PEOPLE}: biggest=${people.biggest.name} (${people.biggest.delta} lines), totalFiles=${people.totalFiles}`,
    );
  } else if (!gitOk) {
    // Do not clobber an existing good snapshot (e.g. one SCP'd from the git
    // machine) with a false zero. Only write the honest marker if no real
    // snapshot is already present.
    if (existingSnapshotIsReal(OUT_PEOPLE)) {
      console.log(`${OUT_PEOPLE}: git unavailable in ${REPO}; kept existing real snapshot`);
    } else {
      fs.writeFileSync(
        OUT_PEOPLE,
        JSON.stringify(gitUnavailableSnapshot('people-file', 24), null, 2),
      );
      console.log(
        `wrote ${OUT_PEOPLE}: git unavailable in ${REPO} (honest marker, not a false zero)`,
      );
    }
  } else {
    fs.writeFileSync(OUT_PEOPLE, JSON.stringify(emptyPeopleSnapshot(24), null, 2));
    console.log(`wrote ${OUT_PEOPLE}: no people-file changes in window`);
  }
  ensureDir(OUT_MEMORY);
  if (memory) {
    fs.writeFileSync(OUT_MEMORY, JSON.stringify(memory, null, 2));
    console.log(
      `wrote ${OUT_MEMORY}: +${memory.added}/-${memory.deleted}, ${memory.commits} commits`,
    );
  } else if (!gitOk) {
    if (existingSnapshotIsReal(OUT_MEMORY)) {
      console.log(`${OUT_MEMORY}: git unavailable in ${REPO}; kept existing real snapshot`);
    } else {
      fs.writeFileSync(
        OUT_MEMORY,
        JSON.stringify(gitUnavailableSnapshot('MEMORY.md', 24), null, 2),
      );
      console.log(
        `wrote ${OUT_MEMORY}: git unavailable in ${REPO} (honest marker, not a false zero)`,
      );
    }
  } else {
    fs.writeFileSync(OUT_MEMORY, JSON.stringify(emptyMemorySnapshot(24), null, 2));
    console.log(`wrote ${OUT_MEMORY}: no MEMORY.md changes in window`);
  }
}

// A pre-existing snapshot counts as "real" only if it recorded actual changes
// (not an empty/marker snapshot). We must never keep a stale empty in place of a
// fresh honest marker, and never overwrite a real one with a false zero.
function existingSnapshotIsReal(file) {
  try {
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!snap || snap.empty || snap.gitUnavailable) return false;
    const changed =
      Number(snap.totalFiles || 0) > 0 ||
      Number(snap.commits || 0) > 0 ||
      Number(snap.added || 0) > 0 ||
      Number(snap.deleted || 0) > 0;
    return changed;
  } catch {
    return false;
  }
}

if (require.main === module) main();

module.exports = {
  snapshotPeople,
  snapshotMemory,
  emptyPeopleSnapshot,
  emptyMemorySnapshot,
  gitUnavailableSnapshot,
  gitIsAvailable,
  existingSnapshotIsReal,
  main,
  truncatePeopleSample,
};
