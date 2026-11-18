#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const {
  shouldBlockSharedMainHook,
} = require('../lib/git-hook-shared-tree-policy.js');

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function main() {
  const hookName = process.argv[2] || '';
  const repoRoot = git(['rev-parse', '--show-toplevel']);
  let commonGitDir = git(['rev-parse', '--git-common-dir']);
  if (!path.isAbsolute(commonGitDir)) commonGitDir = path.join(repoRoot, commonGitDir);

  const result = shouldBlockSharedMainHook({
    hookName,
    repoRoot,
    commonGitDir,
    env: process.env,
  });

  if (result.blocked) {
    process.stderr.write('\nERROR: branch-cleanliness guard\n');
    process.stderr.write(`  ${result.reason}\n`);
    process.stderr.write('  This protects Claude, Codex, and all subagents from sweeping shared work.\n\n');
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `[shared-tree-policy] internal error, failing closed: ${err && err.message ? err.message : err}\n`,
  );
  process.exit(1);
}
