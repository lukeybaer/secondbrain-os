#!/usr/bin/env node
// scripts/verify-core-doc-coverage.js
//
// Same evaluator scripts/land.js runs at the land gate, usable by hand or in
// CI: did every commit on this branch land its component one-pagers with
// the load-bearing files it changed?
//
//   node scripts/verify-core-doc-coverage.js            # vs origin/master merge-base
//   node scripts/verify-core-doc-coverage.js --base <ref>
//
// Exit 0 = every commit covered (or carrying its own `core-doc-unchanged:
// <component|*>: <reason>` trailer), 1 = a commit changed a component's
// load-bearing files without that component's one-pager, 2 = git or manifest
// error (never reported as OK).

'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { evaluateCoreDocCoverageByCommit, formatBlocked } = require('./lib/core-doc-coverage.js');

const ROOT = path.resolve(__dirname, '..');

// Git failures are errors, never "no changes": an invalid base must not
// print OK (Codex review 2026-09-03).
function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// One entry per commit, oldest first. `--no-renames` so a renamed file
// reports BOTH its old registered path and its new one.
function commitsSince(base) {
  const shas = git(['rev-list', '--reverse', `${base}..HEAD`])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return shas.map((sha) => ({
    sha,
    files: git(['diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-r', sha])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    message: git(['log', '-1', '--format=%B', sha]),
  }));
}

function main(argv = process.argv.slice(2)) {
  const baseIdx = argv.indexOf('--base');
  const target = baseIdx >= 0 ? argv[baseIdx + 1] : 'origin/master';
  let base;
  try {
    git(['rev-parse', '--verify', '--quiet', `${target}^{commit}`]);
    base = git(['merge-base', 'HEAD', target]);
  } catch (err) {
    console.error(
      `core-doc coverage ERROR: cannot resolve base ${target}: ${String(err.stderr || err.message).trim()}`,
    );
    return 2;
  }
  let result;
  let commits;
  try {
    commits = commitsSince(base);
    result = evaluateCoreDocCoverageByCommit({ root: ROOT, commits });
  } catch (err) {
    console.error(`core-doc coverage ERROR: ${String(err.stderr || err.message).trim()}`);
    return 2;
  }
  if (result.ok) {
    const note = result.justified.length ? ` (justified: ${result.justified.join(', ')})` : '';
    console.log(
      `OK: core-doc coverage satisfied${note} (${commits.length} commit(s) vs ${target}).`,
    );
    return 0;
  }
  console.error('core-doc coverage FAILED: ' + formatBlocked(result.blocked));
  console.error(
    'Update that core doc in the SAME commit, or add a trailer line "core-doc-unchanged: <component|*>: <one-line reason>" to that commit.',
  );
  return 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`core-doc coverage ERROR: ${String(err.stderr || err.message).trim()}`);
    process.exitCode = 2;
  }
}

module.exports = { main, commitsSince };
