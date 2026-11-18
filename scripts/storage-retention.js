#!/usr/bin/env node
'use strict';

/*
 * storage-retention.js -- the one storage job (S-10, 2026-11-11).
 *
 * Reads config/storage-retention.json. For each row: copy its path to its S3
 * prefix and verify the copy is complete, then prune the local copy by the
 * row's keepNewest / localKeepDays. Raw rows are copy-only; the table loader
 * refuses a table that prunes one. A row with an `owner` script is copied and
 * pruned by that script (it holds extra proof) and is only reported here.
 *
 * Folders over 1 GB (table threshold unmappedFolderGb) under
 * /opt/secondbrain-durable or /opt/secondbrain-shared/data that no row covers
 * make the job exit 1 and name them, so new growth cannot hide.
 *
 * Dry run by default: S3 is only read (sync --dryrun), nothing is deleted, and
 * every delete is printed with its size. Only --apply copies and deletes. A
 * row whose S3 copy cannot be verified is never pruned.
 *
 *   node scripts/storage-retention.js            # dry run
 *   node scripts/storage-retention.js --apply
 *   flags: --json  --only id,id  --no-s3
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const store = require('./lib/storage-retention-table.js');
const { planRetention, applyRetention, dirBytes } = require('./lib/storage-pressure-retention.js');
const { ctDate } = require('./lib/storage-pressure-maintenance.js');

const GIB = 1024 ** 3;

function runAws(args) {
  return execFileSync('aws', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function sizeOf(target) {
  if (process.platform !== 'win32') {
    try {
      const kb = Number(String(execFileSync('du', ['-sk', '--', target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).split(/\s/)[0]);
      if (Number.isFinite(kb)) return kb * 1024;
    } catch {
      /* fall through to the walk */
    }
  }
  const st = fs.lstatSync(target);
  return st.isDirectory() ? dirBytes(target) : st.size;
}

function fmt(bytes) {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

// Copy one row to S3 and prove it. A directory is synced (no --delete, so S3
// only ever gains) and verified by a second sync --dryrun that must have
// nothing left to upload. A file is copied and verified by object size.
function copyAndVerify(row, resolved, { bucket, apply, aws }) {
  const dest = `s3://${bucket}/${row.s3Prefix.replace(/\/+$/, '')}`;
  const isDir = fs.statSync(resolved).isDirectory();
  const key = `${row.s3Prefix.replace(/\/+$/, '')}/${path.basename(resolved)}`;
  try {
    if (isDir) {
      if (apply) aws(['s3', 'sync', resolved, dest, '--only-show-errors']);
      const pending = aws(['s3', 'sync', resolved, dest, '--dryrun'])
        .split('\n')
        .filter((line) => line.includes('upload:')).length;
      return { verified: pending === 0, pending, detail: pending ? `${pending} file(s) not yet in S3` : 'S3 copy complete' };
    }
    if (apply) aws(['s3', 'cp', resolved, `s3://${bucket}/${key}`, '--only-show-errors']);
    const head = JSON.parse(aws(['s3api', 'head-object', '--bucket', bucket, '--key', key, '--output', 'json']));
    const ok = Number(head.ContentLength) === fs.statSync(resolved).size;
    return { verified: ok, pending: ok ? 0 : 1, detail: ok ? 'S3 object size matches' : 'S3 object missing or wrong size' };
  } catch (error) {
    return { verified: false, pending: null, detail: `S3 check failed: ${String(error.message || error).split('\n')[0].slice(0, 200)}` };
  }
}

// Big folders no row accounts for. A folder is covered when it is or sits
// inside a row's path. A big folder that merely contains rows is searched
// deeper; a big folder with no row inside is reported.
function findUnmapped({ tokens, rows, limitBytes, size = sizeOf }) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const rowPaths = rows.filter((r) => !/[*?]/.test(path.basename(r.path))).map((r) => real(store.resolvePath(r, tokens)));
  const inside = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);
  const found = [];
  // Reports the deepest uncovered big folder; a big folder that only holds
  // rows or many small children is searched and not itself reported.
  const walk = (entry) => {
    let bytes;
    try {
      bytes = size(entry);
    } catch {
      return;
    }
    if (bytes <= limitBytes) return;
    if (rowPaths.some((rp) => inside(entry, rp))) return;
    let names = [];
    try {
      names = fs.readdirSync(entry);
    } catch {
      /* a file has no children */
    }
    const holdsRows = rowPaths.some((rp) => inside(rp, entry));
    const big = names.map((n) => path.join(entry, n)).filter((child) => {
      try {
        return size(child) > limitBytes;
      } catch {
        return false;
      }
    });
    const bigDirs = big.filter((child) => fs.statSync(child).isDirectory());
    bigDirs.forEach(walk);
    if (holdsRows) big.filter((child) => !bigDirs.includes(child)).forEach(walk);
    else if (!bigDirs.length) found.push({ path: entry, bytes });
  };
  const scanRoots = [tokens.DURABLE, path.join(tokens.SHARED, 'data')];
  for (const root of scanRoots) if (fs.existsSync(root)) walk(real(root));
  return found;
}

async function run(argv = [], deps = {}) {
  const apply = argv.includes('--apply');
  const only = argv.includes('--only') ? String(argv[argv.indexOf('--only') + 1] || '').split(',').filter(Boolean) : null;
  const skipS3 = argv.includes('--no-s3');
  const tokens = deps.tokens || store.roots();
  const aws = deps.aws || runAws;
  const now = deps.now || new Date();
  const table = deps.table || store.loadTable();
  const bucket = table.s3Bucket;
  const report = { mode: apply ? 'apply' : 'dry-run', rows: [], unmapped: [], bytesFreed: 0, failed: false };

  const chosen = table.rows.filter((r) => !only || only.includes(r.id));
  for (const row of chosen) {
    const resolved = store.resolvePath(row, tokens);
    const entry = { id: row.id, class: row.class, path: resolved, status: 'ok', s3: null, actions: [] };
    report.rows.push(entry);
    if (row.owner) {
      entry.status = `owner: ${row.owner}`;
      continue;
    }
    const isGlob = /[*?]/.test(path.basename(resolved));
    if (!isGlob && !fs.existsSync(resolved)) {
      entry.status = 'absent';
      continue;
    }
    let s3Ok = true;
    if (row.s3Prefix && !isGlob && !skipS3) {
      entry.s3 = copyAndVerify(row, resolved, { bucket, apply, aws });
      s3Ok = entry.s3.verified;
      if (!s3Ok && apply) report.failed = true;
    }
    if (!row.prune) continue;
    const plan = planRetention({ dataDir: tokens.DATA, now, todayCtDate: ctDate(now), rows: [row], tokens });
    if (!s3Ok && apply) {
      entry.status = 'prune skipped: S3 copy not verified';
      continue;
    }
    const receipt = applyRetention({ dataDir: tokens.DATA, plan, apply });
    entry.actions = receipt.actions.map((a) => ({ type: a.type, path: a.path, bytes: a.bytesFreed, ok: a.ok, error: a.error }));
    entry.bytesFreed = receipt.bytesFreed;
    report.bytesFreed += receipt.bytesFreed;
    if (receipt.actions.some((a) => !a.ok)) report.failed = true;
  }

  report.unmapped = findUnmapped({
    tokens,
    rows: table.rows,
    limitBytes: table.thresholds.unmappedFolderGb * GIB,
    size: deps.sizeOf || sizeOf,
  });
  if (report.unmapped.length) report.failed = true;
  return report;
}

function printReport(report) {
  const verb = report.mode === 'apply' ? 'DELETED' : 'WOULD DELETE';
  for (const row of report.rows) {
    const s3 = row.s3 ? ` | s3: ${row.s3.detail}` : '';
    console.log(`[${row.id}] ${row.status}${s3}`);
    for (const a of row.actions) {
      const label = a.type === 'gzip-file' ? (report.mode === 'apply' ? 'GZIPPED' : 'WOULD GZIP') : verb;
      console.log(`  ${label} ${fmt(a.bytes)}  ${a.path}${a.ok ? '' : `  FAILED ${a.error}`}`);
    }
  }
  console.log(`${report.mode === 'apply' ? 'freed' : 'would free'} ${fmt(report.bytesFreed)}`);
  for (const item of report.unmapped) console.error(`UNMAPPED ${fmt(item.bytes)} has no storage-retention row: ${item.path}`);
}

async function main() {
  try {
    const argv = process.argv.slice(2);
    const report = await run(argv);
    if (argv.includes('--json')) console.log(JSON.stringify(report));
    else printReport(report);
    process.exitCode = report.failed ? 1 : 0;
  } catch (error) {
    console.error(`[storage-retention] ${error.message || error}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = { copyAndVerify, findUnmapped, printReport, run };
