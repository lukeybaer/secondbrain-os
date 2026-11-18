'use strict';

// storage-pressure-retention.js -- the generic prune planner and applier for
// the storage table (config/storage-retention.json). Every keep-count and age
// comes from a table row; nothing is hardcoded here. Used by
// scripts/storage-retention.js (the one job) and by the daily
// ec2-storage-pressure-maintenance.js --retention pass.
//
// Rules a row can carry (rows with an `owner` are pruned by that script and
// skipped here):
//   keepNewest      child directories named YYYY-MM-DD: keep the newest N.
//   localKeepDays   child files (optionally limited by `match`/a glob path):
//                   delete once older than N days. Age comes from a date in
//                   the file name when `match` captures one, else from mtime.
//                   With `gzipFirst`, a live-format file whose date has
//                   passed is gzipped, and the gzip is deleted at N days.
//   a single-file row (for example a swap file) with localKeepDays is judged
//   by its own mtime, and never while /proc/swaps lists it.
//
// SAFETY: every target is checked against its root and against a deny-list of
// raw-archive substrings before it can be planned or applied. Raw archives
// (Recorder raw, life-archive, Gmail raw) and data/agent/overnight-report-events
// are never touched, whatever a table row says; the table loader also refuses
// prune:true on a raw row.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const store = require('./storage-retention-table.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_IN_NAME_RE = /^(\d{4}-\d{2}-\d{2})$/;

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

function assertSafeTarget(root, targetPath) {
  const resolvedRoot = path.resolve(root);
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
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && DATE_DIR_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
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
      else total += (safeStat(full) || { size: 0 }).size;
    }
  }
  return total;
}

function activeSwapPaths() {
  try {
    return fs
      .readFileSync('/proc/swaps', 'utf8')
      .split('\n')
      .slice(1)
      .map((line) => line.split(/\s+/)[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Plans one row. `override` lets a caller change keepNewest/localKeepDays for
// this run without editing the table (tests and an operator's one-off).
function planRow(row, { tokens, root, now, todayCtDate, override = {}, swaps }) {
  swaps = swaps || activeSwapPaths();
  if (!row.prune || row.owner) return [];
  const keepNewest = override.keepNewest ?? row.keepNewest;
  const keepDays = override.localKeepDays ?? row.localKeepDays;
  const resolved = store.resolvePath(row, tokens);
  const isGlob = /[*?]/.test(path.basename(resolved));
  const dir = isGlob ? path.dirname(resolved) : resolved;
  const make = (type, target, extra = {}) => ({
    type,
    label: row.id,
    root,
    path: assertSafeTarget(root, target),
    ...extra,
  });

  if (keepNewest != null) {
    return listDateDirs(dir)
      .slice(keepNewest)
      .map((date) => make('delete-date-dir', path.join(dir, date), { date }));
  }
  if (keepDays == null) return [];

  const st = safeStat(resolved);
  if (!isGlob && st && st.isFile()) {
    if (swaps.map((p) => path.resolve(p)).includes(resolved)) return [];
    const ageDays = Math.floor((now.getTime() - st.mtimeMs) / DAY_MS);
    return ageDays >= keepDays ? [make('delete-file', resolved, { ageDays })] : [];
  }

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nameFilter = isGlob ? store.globToRegExp(path.basename(resolved)) : null;
  const match = row.match ? new RegExp(row.match) : null;
  const todayMs = Date.parse(`${todayCtDate}T00:00:00.000Z`);
  const actions = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (nameFilter && !nameFilter.test(entry.name)) continue;
    const m = match ? entry.name.match(match) : null;
    if (match && !m) continue;
    const full = path.join(dir, entry.name);
    const dateText = m && m[1] && DATE_IN_NAME_RE.test(m[1]) ? m[1] : null;
    let ageDays;
    if (dateText) {
      ageDays = Math.round((todayMs - Date.parse(`${dateText}T00:00:00.000Z`)) / DAY_MS);
    } else {
      const fileStat = safeStat(full);
      if (!fileStat || fileStat.mtimeMs >= now.getTime() - keepDays * DAY_MS) continue;
      ageDays = Math.floor((now.getTime() - fileStat.mtimeMs) / DAY_MS);
    }
    if (!Number.isFinite(ageDays)) continue;
    const info = dateText ? { date: dateText, ageDays } : { ageDays };
    if (row.gzipFirst && !entry.name.endsWith('.gz')) {
      if (dateText < todayCtDate) actions.push(make('gzip-file', full, info));
    } else if (ageDays > keepDays || !dateText) {
      actions.push(make('delete-file', full, info));
    }
  }
  return actions;
}

function gzipFile(source) {
  const dest = `${source}.gz`;
  const temp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, zlib.gzipSync(fs.readFileSync(source)));
  fs.renameSync(temp, dest);
  fs.unlinkSync(source);
  return dest;
}

// Builds the plan for every unowned prunable row that lives inside `dataDir`
// (the daily pressure pass), or for explicit `rows` with their own roots (the
// one job). Reads directories and stats only.
function planRetention({
  dataDir,
  now = new Date(),
  todayCtDate,
  overrides = {},
  rows,
  tokens = { ...store.roots(), DATA: dataDir },
  swaps,
} = {}) {
  if (!dataDir) throw new Error('storage-pressure-retention: dataDir is required');
  const ctDate = todayCtDate || new Date(now).toISOString().slice(0, 10);
  const inData = (row) => {
    const resolved = store.resolvePath(row, tokens);
    return resolved === path.resolve(dataDir) || resolved.startsWith(`${path.resolve(dataDir)}${path.sep}`);
  };
  const chosen = rows || store.rows().filter(inData);
  const actions = [];
  for (const row of chosen) {
    const resolved = store.resolvePath(row, tokens);
    const root = inData(row) ? dataDir : path.dirname(resolved);
    actions.push(...planRow(row, { tokens, root, now, todayCtDate: ctDate, override: overrides[row.id], swaps }));
  }
  return {
    schema: 'secondbrain.storage-pressure-retention-plan.v2',
    generatedAt: now.toISOString(),
    todayCtDate: ctDate,
    actions,
  };
}

// Executes a plan. `apply:false` (default) only measures what WOULD be freed.
// Every action is re-validated through assertSafeTarget immediately before it
// touches disk, so an apply run never trusts a plan object mutated in between.
function applyRetention({ dataDir, plan, apply = false }) {
  const results = [];
  let bytesFreed = 0;
  for (const action of plan.actions) {
    const target = assertSafeTarget(action.root || dataDir, action.path);
    let bytes = 0;
    let ok = true;
    let error = null;
    try {
      const stat = safeStat(target);
      if (action.type === 'delete-date-dir') {
        bytes = dirBytes(target);
        if (apply) fs.rmSync(target, { recursive: true, force: true });
      } else if (action.type === 'delete-file') {
        bytes = stat ? stat.size : 0;
        if (apply) fs.rmSync(target, { force: true });
      } else if (action.type === 'gzip-file') {
        const before = stat ? stat.size : 0;
        if (apply) {
          const after = safeStat(gzipFile(target));
          bytes = Math.max(0, before - (after ? after.size : 0));
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
    actionCount: results.length,
    bytesFreed,
    actions: results,
  };
}

module.exports = {
  isForbiddenPath,
  assertSafeTarget,
  listDateDirs,
  dirBytes,
  planRetention,
  applyRetention,
};
