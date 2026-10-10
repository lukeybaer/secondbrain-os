'use strict';

// storage-pressure-retention.js -- the actual prune pass for
// ec2-storage-pressure-maintenance.js (Packet S, 2026-09-01). Before this,
// that script only sampled disk usage; nothing on EC2 ever deleted anything,
// so briefing-card-qc-receipts (4-5.5GB/date), briefing-card-publish-journal
// (2-3GB/date), and the unbounded night-supervisor-recovery-<date>.log files
// grew until the root disk hit 98% full (3.7GB free) on 2026-08-23, breaking
// Otter recluster with ENOSPC.
//
// Four bounded prune rules, dry-run by default:
//   1. briefing-card-qc-receipts/<date>/  -- keep the newest N briefing dates.
//   2. briefing-card-publish-journal/<date>/ -- same rule, same N.
//   3. heal-sessions/*.log -- delete once older than a fixed age.
//   4. night-supervisor-recovery-<date>.log -- gzip once its briefing date has
//      passed, delete the gzip once it is old enough.
//
// SAFETY: every candidate path is checked against an explicit allow-list of
// roots AND an explicit deny-list of raw-archive substrings before it can be
// planned for deletion. Raw archives (Otter raw, life-archive, Gmail raw) and
// data/agent/overnight-report-events are never touched by this module, no
// matter what a future caller passes as a root -- the invariant is enforced
// here, not just documented at the call site.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DEFAULT_BRIEFING_DATES_TO_KEEP = 4;
const DEFAULT_HEAL_SESSIONS_MAX_AGE_DAYS = 14;
const DEFAULT_RECOVERY_LOG_DELETE_AFTER_DAYS = 7;
// briefing-overnight-watch/<date>-report-evidence-ledgers.json: the exact
// frozen ledger rows the 4:00 CT report freeze keeps beside its receipt so
// later report ticks reuse the same bytes. The receipt itself is small and
// stays; the sidecar can be tens of MB on a busy night and is only needed
// until that briefing date's report is closed and audited.
const DEFAULT_REPORT_EVIDENCE_LEDGERS_KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECOVERY_LOG_RE = /^night-supervisor-recovery-(\d{4}-\d{2}-\d{2})\.log$/;
const RECOVERY_LOG_GZ_RE = /^night-supervisor-recovery-(\d{4}-\d{2}-\d{2})\.log\.gz$/;

// Substrings that can NEVER appear in a path this module deletes or rewrites,
// regardless of which root a caller passes in. This is the hard stop the
// packet asked for: "never touch raw archives ... or anything under
// data/agent/overnight-report-events."
const FORBIDDEN_PATH_SUBSTRINGS = [
  `${path.sep}otter${path.sep}raw`,
  `${path.sep}life-archive${path.sep}`,
  `${path.sep}gmail${path.sep}raw`,
  `${path.sep}overnight-report-events${path.sep}`,
];

function isForbiddenPath(absPath) {
  const normalized = `${path.normalize(absPath)}${path.sep}`;
  return FORBIDDEN_PATH_SUBSTRINGS.some((needle) => normalized.includes(needle));
}

// Refuses to plan (or execute) any action whose target is not safely inside
// `dataDir` and is not on the forbidden list. Throws rather than silently
// skipping: a caller passing a bad root is a bug, not a normal empty case.
function assertSafeTarget(dataDir, targetPath) {
  const resolvedRoot = path.resolve(dataDir);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`storage-pressure-retention: target escapes dataDir: ${resolvedTarget}`);
  }
  if (isForbiddenPath(resolvedTarget)) {
    throw new Error(`storage-pressure-retention: refused forbidden path: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

function listDateDirs(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && DATE_DIR_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function dirBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        const stat = safeStat(full);
        if (stat) total += stat.size;
      }
    }
  }
  return total;
}

// Plans which of a root's date-named subdirectories fall outside the newest
// `keep` briefing dates present on disk. Pure: does not touch the filesystem
// beyond a readdir, so this is unit-testable against a fixture tree.
function planDateDirRetention({ dataDir, root, keep, label }) {
  const dates = listDateDirs(root);
  const stale = dates.slice(keep);
  return stale.map((date) => {
    const target = assertSafeTarget(dataDir, path.join(root, date));
    return { type: 'delete-date-dir', label, date, path: target };
  });
}

// heal-sessions/*.log older than `maxAgeDays` by mtime (no reliable date in
// every filename, so age is the only signal that works across all of them).
function planHealSessionsRetention({ dataDir, root, maxAgeDays, now }) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const cutoffMs = now.getTime() - maxAgeDays * DAY_MS;
  const actions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
    const full = path.join(root, entry.name);
    const stat = safeStat(full);
    if (!stat || stat.mtimeMs >= cutoffMs) continue;
    const target = assertSafeTarget(dataDir, full);
    actions.push({
      type: 'delete-heal-session-log',
      label: 'heal-sessions',
      path: target,
      ageDays: Math.floor((now.getTime() - stat.mtimeMs) / DAY_MS),
    });
  }
  return actions;
}

// night-supervisor-recovery-<date>.log[.gz] living directly under
// data/agent/. Gzip once the briefing date has passed (the log for tonight is
// still actively appended to, so it is never rewritten while live); delete
// the gzip once it is older than `deleteAfterDays` past that date.
function planRecoveryLogRetention({ dataDir, agentRoot, todayCtDate, deleteAfterDays }) {
  let entries = [];
  try {
    entries = fs.readdirSync(agentRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const actions = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const gzMatch = entry.name.match(RECOVERY_LOG_GZ_RE);
    if (gzMatch) {
      const logDate = gzMatch[1];
      const ageDays = Math.round(
        (Date.parse(`${todayCtDate}T00:00:00Z`) - Date.parse(`${logDate}T00:00:00Z`)) / DAY_MS,
      );
      if (Number.isFinite(ageDays) && ageDays > deleteAfterDays) {
        const target = assertSafeTarget(dataDir, path.join(agentRoot, entry.name));
        actions.push({
          type: 'delete-recovery-log-gz',
          label: 'night-supervisor-recovery',
          date: logDate,
          path: target,
          ageDays,
        });
      }
      continue;
    }
    const match = entry.name.match(RECOVERY_LOG_RE);
    if (!match) continue;
    const logDate = match[1];
    if (logDate < todayCtDate) {
      const target = assertSafeTarget(dataDir, path.join(agentRoot, entry.name));
      actions.push({
        type: 'gzip-recovery-log',
        label: 'night-supervisor-recovery',
        date: logDate,
        path: target,
      });
    }
  }
  return actions;
}

// Builds the full plan without touching disk beyond directory listings and
// stats -- safe to call in a health probe or a --retention (no --apply) run.
function planReportEvidenceLedgerRetention({ dataDir, agentRoot, todayCtDate, keepDays }) {
  const root = path.join(agentRoot, 'briefing-overnight-watch');
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const todayMs = Date.parse(`${todayCtDate}T00:00:00.000Z`);
  if (!Number.isFinite(todayMs)) return [];
  const actions = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})-report-evidence-ledger(?:s|-[A-Za-z]+-[a-f0-9]{64})\.json$/);
    if (!match) continue;
    const fileMs = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (!Number.isFinite(fileMs)) continue;
    const ageDays = Math.floor((todayMs - fileMs) / DAY_MS);
    if (ageDays <= keepDays) continue;
    const target = assertSafeTarget(dataDir, path.join(root, entry.name));
    actions.push({
      type: 'delete-report-evidence-ledgers',
      label: 'briefing-overnight-watch',
      path: target,
      date: match[1],
      ageDays,
    });
  }
  return actions;
}

function planRetention({
  dataDir,
  now = new Date(),
  todayCtDate,
  briefingDatesToKeep = DEFAULT_BRIEFING_DATES_TO_KEEP,
  healSessionsMaxAgeDays = DEFAULT_HEAL_SESSIONS_MAX_AGE_DAYS,
  recoveryLogDeleteAfterDays = DEFAULT_RECOVERY_LOG_DELETE_AFTER_DAYS,
  reportEvidenceLedgersKeepDays = DEFAULT_REPORT_EVIDENCE_LEDGERS_KEEP_DAYS,
} = {}) {
  if (!dataDir) throw new Error('storage-pressure-retention: dataDir is required');
  const ctDate = todayCtDate || new Date(now).toISOString().slice(0, 10);
  const agentRoot = path.join(dataDir, 'agent');
  const qcReceiptsRoot = path.join(agentRoot, 'briefing-card-qc-receipts');
  const publishJournalRoot = path.join(agentRoot, 'briefing-card-publish-journal');
  const healSessionsRoot = path.join(agentRoot, 'heal-sessions');

  const actions = [
    ...planDateDirRetention({
      dataDir,
      root: qcReceiptsRoot,
      keep: briefingDatesToKeep,
      label: 'briefing-card-qc-receipts',
    }),
    ...planDateDirRetention({
      dataDir,
      root: publishJournalRoot,
      keep: briefingDatesToKeep,
      label: 'briefing-card-publish-journal',
    }),
    ...planHealSessionsRetention({
      dataDir,
      root: healSessionsRoot,
      maxAgeDays: healSessionsMaxAgeDays,
      now,
    }),
    ...planRecoveryLogRetention({
      dataDir,
      agentRoot,
      todayCtDate: ctDate,
      deleteAfterDays: recoveryLogDeleteAfterDays,
    }),
    ...planReportEvidenceLedgerRetention({
      dataDir,
      agentRoot,
      todayCtDate: ctDate,
      keepDays: reportEvidenceLedgersKeepDays,
    }),
  ];
  return {
    schema: 'secondbrain.storage-pressure-retention-plan.v1',
    generatedAt: now.toISOString(),
    todayCtDate: ctDate,
    thresholds: {
      briefingDatesToKeep,
      healSessionsMaxAgeDays,
      recoveryLogDeleteAfterDays,
      reportEvidenceLedgersKeepDays,
    },
    actions,
  };
}

function gzipFile(source) {
  const dest = `${source}.gz`;
  const input = fs.readFileSync(source);
  const compressed = zlib.gzipSync(input);
  const temp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, compressed);
  fs.renameSync(temp, dest);
  fs.unlinkSync(source);
  return dest;
}

// Executes a plan built by planRetention. `apply:false` (the default) only
// measures what WOULD be freed; `apply:true` actually deletes/gzips. Every
// action is re-validated through assertSafeTarget immediately before it
// touches disk, not just at plan time, so an apply run is never trusting a
// plan object a caller could have mutated in between.
function applyRetention({ dataDir, plan, apply = false }) {
  const results = [];
  let bytesFreed = 0;
  for (const action of plan.actions) {
    const target = assertSafeTarget(dataDir, action.path);
    let bytes = 0;
    let ok = true;
    let error = null;
    try {
      if (action.type === 'delete-date-dir') {
        bytes = dirBytes(target);
        if (apply) fs.rmSync(target, { recursive: true, force: true });
      } else if (
        action.type === 'delete-heal-session-log' ||
        action.type === 'delete-recovery-log-gz' ||
        action.type === 'delete-report-evidence-ledgers'
      ) {
        const stat = safeStat(target);
        bytes = stat ? stat.size : 0;
        if (apply) fs.rmSync(target, { force: true });
      } else if (action.type === 'gzip-recovery-log') {
        const stat = safeStat(target);
        const before = stat ? stat.size : 0;
        if (apply) {
          const gz = gzipFile(target);
          const after = safeStat(gz);
          bytes = Math.max(0, before - (after ? after.size : 0));
        } else {
          bytes = 0; // no real compression measured in a dry run
        }
      } else {
        ok = false;
        error = `unknown action type: ${action.type}`;
      }
    } catch (err) {
      ok = false;
      error = String((err && err.message) || err);
    }
    if (ok) bytesFreed += bytes;
    results.push({ ...action, ok, error, bytesFreed: bytes });
  }
  return {
    schema: 'secondbrain.storage-pressure-retention-receipt.v1',
    mode: apply ? 'apply' : 'dry-run',
    generatedAt: new Date().toISOString(),
    todayCtDate: plan.todayCtDate,
    thresholds: plan.thresholds,
    actionCount: results.length,
    bytesFreed,
    actions: results,
  };
}

module.exports = {
  DEFAULT_BRIEFING_DATES_TO_KEEP,
  DEFAULT_HEAL_SESSIONS_MAX_AGE_DAYS,
  DEFAULT_RECOVERY_LOG_DELETE_AFTER_DAYS,
  isForbiddenPath,
  assertSafeTarget,
  listDateDirs,
  dirBytes,
  planRetention,
  applyRetention,
};
