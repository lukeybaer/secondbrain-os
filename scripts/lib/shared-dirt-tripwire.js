'use strict';

// shared-dirt-tripwire.js
//
// The no-more-promises mechanism for the shared-checkout writer problem
// (ExampleCo 2026-07-12: "does your fix appreciate that this is a constant
// repeating problem despite many promises that it's fixed permanently?").
// Prevention lives in scripts/lib/scan-output-lander.js (writers land their
// own outputs) and .gitignore (runtime artifacts untracked). This module is
// the DETECTION property that holds regardless of which future writer
// misbehaves: any path that shows up dirty in the shared checkout outside an
// explicit allowlist becomes a NAMED System Health defect plus a
// guard-telemetry line identifying the file and its mtime.
//
// Differential semantics (same principle as the per-card differential publish
// gates): only NEW dirt alarms.
//   - The first run against a tree seeds a baseline from whatever dirt already
//     exists (deploying the tripwire onto an already-dirty tree must not
//     retro-alarm history; after the 2026-07-12 reconciliation the baseline is
//     EMPTY and stays empty).
//   - A path seen for the first time after the baseline emits ONE telemetry
//     line and joins the defect list. It stays a named defect on every
//     subsequent run until it disappears from git status (defects do not age
//     out; the alarm just does not re-fire).
//   - A dirty path whose working content is byte-identical to the
//     origin/master blob is "landed, awaiting fast-forward sync", not dirt:
//     the content already went through the land gate and the shared checkout
//     simply has not pulled yet. Exempt, named separately.
//
// The allowlist is EXPLICIT and empty by design. Adding to it is a decision,
// not a default.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Empty on purpose. Every sanctioned writer lands through the gate or writes
// a gitignored path; there is no standing legitimate dirt in the shared
// checkout. If a future integration flow genuinely needs a standing entry,
// add the exact relative path here with a dated reason.
const SHARED_DIRT_ALLOWLIST = [];

const STATE_REL_PATH = path.join('agent', 'shared-dirt-tripwire-state.json');
const TELEMETRY_REL_PATH = path.join('agent', 'guard-telemetry.jsonl');

function runGitDefault(args, cwd) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
  };
}

function parsePorcelain(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      let rel = line.slice(3);
      const arrow = rel.indexOf(' -> ');
      if (arrow !== -1) rel = rel.slice(arrow + 4);
      if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
      return { code, rel };
    });
}

function readState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.seen && typeof parsed.seen === 'object') {
      return parsed;
    }
  } catch {
    /* first run or corrupt state: reseed below */
  }
  return null;
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function appendTelemetry(telemetryPath, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(telemetryPath), { recursive: true });
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(telemetryPath, text);
}

function fileMtimeIso(absPath) {
  try {
    return new Date(fs.statSync(absPath).mtimeMs).toISOString();
  } catch {
    return null; // deleted-from-worktree dirt has no mtime
  }
}

// True when the dirty path's working content equals the origin/master blob:
// the change already landed through the gate and this checkout just has not
// fast-forwarded yet. Never true for untracked files.
function matchesOriginContentDefault(mainRoot, rel, runGit) {
  const originBlob = runGit(['rev-parse', `origin/master:${rel}`], mainRoot);
  if (!originBlob.ok) return false;
  const workingHash = runGit(['hash-object', '--', rel], mainRoot);
  if (!workingHash.ok) return false;
  return originBlob.stdout.trim() === workingHash.stdout.trim();
}

// Evaluate the tripwire. Pure-ish: all IO is injectable for tests.
// Returns:
//   {
//     status: 'green' | 'red',
//     newDirt: [{ rel, code, mtime, firstSeenAt }],   // the defects
//     baselined: [rel],                               // pre-existing at seed time
//     allowlisted: [rel],
//     landedAwaitingSync: [rel],
//     telemetry: [rows appended this run],
//     detail: 'one-line executive summary',
//   }
function evaluateSharedDirtTripwire({
  mainRoot,
  dataDir,
  allowlist = SHARED_DIRT_ALLOWLIST,
  statePath,
  telemetryPath,
  runGit = runGitDefault,
  matchesOriginContent = matchesOriginContentDefault,
  now = () => new Date(),
} = {}) {
  if (!mainRoot) throw new Error('evaluateSharedDirtTripwire: mainRoot is required');
  const resolvedDataDir = dataDir || path.join(mainRoot, 'data');
  const resolvedStatePath = statePath || path.join(resolvedDataDir, STATE_REL_PATH);
  const resolvedTelemetryPath = telemetryPath || path.join(resolvedDataDir, TELEMETRY_REL_PATH);

  const status = runGit(['status', '--porcelain'], mainRoot);
  if (!status.ok) {
    // Not a git checkout here (EC2 file-deploy) or git is broken: the tripwire
    // cannot measure. Report ExampleCo-as-detail; callers already carve out the
    // cloud host the same way devops-health does.
    return {
      status: 'green',
      newDirt: [],
      baselined: [],
      allowlisted: [],
      landedAwaitingSync: [],
      telemetry: [],
      detail: `Shared-dirt tripwire: not measurable (${(status.stderr || 'git failed').trim().slice(0, 120)})`,
      unmeasurable: true,
    };
  }

  const entries = parsePorcelain(status.stdout);
  const allowSet = new Set(allowlist);
  const nowIso = now().toISOString();

  const prior = readState(resolvedStatePath);
  const seeding = prior == null;
  const seen = prior ? { ...prior.seen } : {};

  const allowlisted = [];
  const landedAwaitingSync = [];
  const newDirt = [];
  const baselined = [];
  const telemetry = [];
  const currentRels = new Set();

  for (const entry of entries) {
    currentRels.add(entry.rel);
    if (allowSet.has(entry.rel)) {
      allowlisted.push(entry.rel);
      continue;
    }
    // Tracked-modified dirt whose bytes already match origin/master: landed
    // through the gate, awaiting fast-forward. Not a writer violation.
    if (!entry.code.includes('?') && matchesOriginContent(mainRoot, entry.rel, runGit)) {
      landedAwaitingSync.push(entry.rel);
      continue;
    }
    if (seeding) {
      seen[entry.rel] = { firstSeenAt: nowIso, baseline: true };
      baselined.push(entry.rel);
      continue;
    }
    const known = seen[entry.rel];
    if (known && known.baseline) {
      baselined.push(entry.rel);
      continue;
    }
    const mtime = fileMtimeIso(path.join(mainRoot, entry.rel));
    if (!known) {
      // First sighting after the baseline: the differential alarm fires ONCE.
      seen[entry.rel] = { firstSeenAt: nowIso, baseline: false };
      telemetry.push({
        ts: nowIso,
        hook: 'shared-dirt-tripwire',
        event: 'new-shared-dirt',
        file: entry.rel,
        code: entry.code.trim(),
        mtime,
      });
    }
    newDirt.push({
      rel: entry.rel,
      code: entry.code.trim(),
      mtime,
      firstSeenAt: (seen[entry.rel] && seen[entry.rel].firstSeenAt) || nowIso,
    });
  }

  // Prune vanished paths so a cleaned file can re-alarm if it re-dirties.
  for (const rel of Object.keys(seen)) {
    if (!currentRels.has(rel)) delete seen[rel];
  }

  writeState(resolvedStatePath, {
    seededAt: prior ? prior.seededAt || nowIso : nowIso,
    updatedAt: nowIso,
    seen,
  });
  appendTelemetry(resolvedTelemetryPath, telemetry);

  const red = newDirt.length > 0;
  const parts = [];
  if (red) {
    parts.push(
      `${newDirt.length} unexpected dirty path(s) in the shared checkout: ` +
        newDirt.map((d) => `${d.rel} (mtime ${d.mtime || 'gone'})`).join(', '),
    );
  }
  if (landedAwaitingSync.length) {
    parts.push(
      `${landedAwaitingSync.length} landed-awaiting-sync (content already on origin/master)`,
    );
  }
  if (baselined.length) parts.push(`${baselined.length} baselined pre-existing`);
  if (allowlisted.length) parts.push(`${allowlisted.length} allowlisted`);
  const detail = red
    ? `Shared-dirt tripwire: RED - ${parts.join('; ')}. Every writer must land via the gate or write a gitignored path.`
    : `Shared-dirt tripwire: clean${parts.length ? ` (${parts.join('; ')})` : ''}`;

  return {
    status: red ? 'red' : 'green',
    newDirt,
    baselined,
    allowlisted,
    landedAwaitingSync,
    telemetry,
    detail,
  };
}

module.exports = {
  evaluateSharedDirtTripwire,
  SHARED_DIRT_ALLOWLIST,
  parsePorcelain,
};
