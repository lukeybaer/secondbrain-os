#!/usr/bin/env node
'use strict';

// One-time merge (Owner decision "fix sandbox"). Processes started by the
// Claude desktop app (hooks, shells) run inside its MSIX package, so their
// writes under %APPDATA%\secondbrain\data landed in the package's private
// LocalCache copy and never reached Amy. The data folders they write are now
// junctioned out of AppData (a junction inside Roaming that points outside it
// escapes the redirect), and their sandbox copies were moved to an archive.
// This folds that archive back into the real store:
//   missing in real            -> copied (mtime kept)
//   identical                  -> skipped
//   sandbox copy is newer      -> replaces real; the real version is saved
//                                 first under <archive>/_real-before-merge
//   real copy is newer         -> real kept
//   divergent .jsonl ledger    -> conflict: the real ledger is left untouched
//                                 and listed for manual reconcile. Ledgers
//                                 are applied in file order (a voice-safety
//                                 hold, then a clear), so neither replacing
//                                 nor appending older rows is safe (reviews
//                                 8b16547989ac F2, acec65deaadf)
// Nothing is deleted; the archive stays as the record of what was stranded.
// An --apply run writes <archive>/_merge-manifest-<time>.jsonl: a start row
// before each change, a done row with hashes after it, and a final completion
// row, so an interrupted or repeated run can be audited (review F6).
//
//   node scripts/msix-sandbox-merge.js --archive <dir> --real <dir> [--apply]

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SAVED = '_real-before-merge';
const MANIFEST_PREFIX = '_merge-manifest-';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const isLedger = (file) => file.toLowerCase().endsWith('.jsonl');
const lines = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());

function decide(archiveFile, realFile) {
  if (!fs.existsSync(realFile)) return 'copy';
  const a = fs.statSync(archiveFile);
  const r = fs.statSync(realFile);
  if (a.size === r.size && digest(archiveFile) === digest(realFile)) return 'same';
  if (isLedger(realFile)) {
    const have = new Set(lines(realFile));
    return lines(archiveFile).some((l) => !have.has(l)) ? 'conflict' : 'keep-real';
  }
  return a.mtimeMs > r.mtimeMs ? 'replace' : 'keep-real';
}

function copyKeepingTime(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  const st = fs.statSync(from);
  fs.utimesSync(to, st.atime, st.mtime);
}

function merge({ archive, real, apply = false, now = new Date() }) {
  const counts = { copy: 0, same: 0, replace: 0, 'keep-real': 0, conflict: 0 };
  const conflicts = [];
  const manifest = apply
    ? path.join(archive, `${MANIFEST_PREFIX}${now.toISOString().replace(/[:.]/g, '-')}.jsonl`)
    : '';
  const record = (row) => fs.appendFileSync(manifest, `${JSON.stringify(row)}\n`);
  for (const file of walk(archive)) {
    const rel = path.relative(archive, file);
    const top = rel.split(path.sep)[0];
    // Top-level _ entries are bookkeeping (saved real versions, manifests,
    // folders held back from merging), never data.
    if (top.startsWith('_')) continue;
    const target = path.join(real, rel);
    const action = decide(file, target);
    counts[action] += 1;
    if (action === 'conflict') conflicts.push(rel);
    if (!apply) continue;
    const before = fs.existsSync(target) ? digest(target) : null;
    const changes = action === 'copy' || action === 'replace';
    if (changes) record({ path: rel, action, phase: 'start', source_sha256: digest(file), real_before_sha256: before });
    if (action === 'replace') copyKeepingTime(target, path.join(archive, SAVED, rel));
    if (changes) copyKeepingTime(file, target);
    record({ path: rel, action, phase: 'done', source_sha256: digest(file), real_before_sha256: before, real_after_sha256: fs.existsSync(target) ? digest(target) : null });
  }
  if (apply) record({ complete: true, at: now.toISOString(), counts, conflicts });
  return { ...counts, conflicts };
}

function main() {
  const args = process.argv.slice(2);
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : '');
  const archive = value('--archive');
  const real = value('--real');
  if (!archive || !real) {
    console.error('usage: node scripts/msix-sandbox-merge.js --archive <dir> --real <dir> [--apply]');
    process.exit(2);
  }
  console.log(JSON.stringify(merge({ archive, real, apply: args.includes('--apply') })));
}

if (require.main === module) main();

module.exports = { merge, decide };
