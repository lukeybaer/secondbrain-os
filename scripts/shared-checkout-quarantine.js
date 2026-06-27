#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function runGit(root, args, opts = {}) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: opts.encoding === undefined ? 'utf8' : opts.encoding,
    timeout: opts.timeout || 30000,
    maxBuffer: opts.maxBuffer || 64 * 1024 * 1024,
  });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function parsePorcelainZ(raw) {
  const parts = String(raw || '').split('\0').filter(Boolean);
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    const status = item.slice(0, 2);
    const file = item.slice(3);
    if (!file) continue;
    if (/^[RC]/.test(status)) {
      const originalPath = parts[++i] || '';
      entries.push({ status, path: file, originalPath });
    } else {
      entries.push({ status, path: file });
    }
  }
  return entries;
}

function originContent(root, rel, ref = 'origin/master') {
  try {
    return runGit(root, ['show', `${ref}:${rel}`], { encoding: null, maxBuffer: 128 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function safeCopy(src, dest) {
  const st = fs.statSync(src);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (st.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true, force: true });
  } else {
    fs.copyFileSync(src, dest);
  }
}

function classifyEntry(root, entry, rescueFilesDir, ref = 'origin/master') {
  const abs = path.join(root, entry.path);
  const exists = fs.existsSync(abs);
  const origin = originContent(root, entry.path, ref);
  const item = {
    ...entry,
    exists,
    category: 'ExampleCo',
    action: 'review',
  };
  if (!exists) {
    item.originExists = Boolean(origin);
    item.category = origin ? 'deleted_locally_but_exists_on_origin' : 'deletion_already_on_origin';
    item.action = origin ? 'review_before_restore' : 'safe_after_sync';
    return item;
  }
  const st = fs.statSync(abs);
  item.kind = st.isDirectory() ? 'directory' : 'file';
  item.size = st.size;
  item.mtime = st.mtime.toISOString();
  if (st.isDirectory()) {
    item.category = entry.status.startsWith('??') ? 'unique_untracked_directory' : 'dirty_directory';
    item.action = 'preserve_to_rescue_then_review';
    safeCopy(abs, path.join(rescueFilesDir, entry.path));
    return item;
  }
  const content = fs.readFileSync(abs);
  item.sha256 = sha256(content);
  item.originExists = Boolean(origin);
  item.originSha256 = origin ? sha256(origin) : null;
  if (origin && item.sha256 === item.originSha256) {
    item.category = 'already_on_origin';
    item.action = 'safe_after_sync';
    return item;
  }
  item.category = entry.status.startsWith('??') ? 'unique_untracked_file' : 'unique_tracked_change';
  item.action = 'preserved_to_rescue';
  safeCopy(abs, path.join(rescueFilesDir, entry.path));
  return item;
}

function summarize(items) {
  const counts = {};
  for (const item of items) counts[item.category] = (counts[item.category] || 0) + 1;
  return counts;
}

function optionValue(argv, name) {
  const idx = argv.indexOf(name);
  if (idx < 0) return null;
  const value = argv[idx + 1];
  return value && !String(value).startsWith('--') ? value : null;
}

function main(argv = process.argv.slice(2)) {
  const sharedRoot =
    optionValue(argv, '--shared-root') ||
    process.env.SECONDBRAIN_SHARED_ROOT ||
    path.join(os.homedir(), 'secondbrain');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir =
    optionValue(argv, '--out-dir') ||
    path.join(os.homedir(), 'sb-sessions', `shared-checkout-quarantine-${stamp}`);
  const ref = optionValue(argv, '--ref') || 'origin/master';

  fs.mkdirSync(outDir, { recursive: true });
  const rescueFilesDir = path.join(outDir, 'files');
  fs.mkdirSync(rescueFilesDir, { recursive: true });

  runGit(sharedRoot, ['fetch', 'origin', 'master'], { timeout: 120000 });
  const statusRaw = runGit(sharedRoot, ['status', '--porcelain=v1', '-z'], { maxBuffer: 128 * 1024 * 1024 });
  const statusText = runGit(sharedRoot, ['status', '--porcelain=v1', '--branch'], {
    maxBuffer: 128 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(outDir, 'status.txt'), statusText);
  try {
    const diff = runGit(sharedRoot, ['diff', '--binary'], { maxBuffer: 256 * 1024 * 1024 });
    fs.writeFileSync(path.join(outDir, 'tracked-diff.patch'), diff);
  } catch (e) {
    fs.writeFileSync(path.join(outDir, 'tracked-diff.patch.error.txt'), String(e.message || e));
  }
  const entries = parsePorcelainZ(statusRaw);
  const items = entries.map((entry) => classifyEntry(sharedRoot, entry, rescueFilesDir, ref));
  const manifest = {
    generatedAt: new Date().toISOString(),
    sharedRoot,
    ref,
    outDir,
    counts: summarize(items),
    items,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(
    path.join(outDir, 'unique-paths.txt'),
    items
      .filter((i) => !['already_on_origin', 'deletion_already_on_origin'].includes(i.category))
      .map((i) => `${i.category}\t${i.path}`)
      .join('\n') + '\n',
  );
  console.log(JSON.stringify({ outDir, counts: manifest.counts, total: items.length }, null, 2));
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  parsePorcelainZ,
  classifyEntry,
  summarize,
  optionValue,
  main,
};
