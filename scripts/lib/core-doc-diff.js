'use strict';

// Core one-pager diff alarm (the second check locked 2026-06-15 in
// dev-plans/managing-complex-scope-2026-06-14.html). ExampleCo's ask: alarm on diffs to
// the core one-pager files, surfaced as a briefing card.
//
// The core components each have a load-bearing one-pager at dev-plans/core/<name>.md.
// Churn there is high signal: extending a component (expected, low churn) versus
// rewriting one (the exact "rebuild instead of extend" failure this whole effort
// guards against). This computes what changed in dev-plans/core/*.md since a ref so
// the briefing card (the wiring step) can show the top changes.
//
// parseCoreDocChanges() is a pure parser over `git diff --name-status` output so it
// is unit-testable; coreDocsChangedSince() runs the real git command.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CORE_GLOB_DIR = 'dev-plans/core';

const STATUS_LABEL = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied' };

// Parse `git diff --name-status <ref>` output, keeping only dev-plans/core/*.md.
function parseCoreDocChanges(nameStatusOutput) {
  const changes = [];
  for (const raw of String(nameStatusOutput).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('\t');
    const code = parts[0][0]; // R100 / C75 carry a score; take the letter
    // For rename/copy the final path is the last column; otherwise the second.
    const file = parts[parts.length - 1];
    if (!file.startsWith(CORE_GLOB_DIR + '/') || !file.endsWith('.md')) continue;
    changes.push({
      status: STATUS_LABEL[code] || code,
      file,
      component: path.basename(file, '.md'),
    });
  }
  return changes.sort((a, b) => a.file.localeCompare(b.file));
}

// Real git: what core docs changed between ref and HEAD (working tree included if dirty).
function coreDocsChangedSince(ref, { cwd = REPO_ROOT } = {}) {
  let out = '';
  try {
    out = execFileSync('git', ['diff', '--name-status', ref, '--', CORE_GLOB_DIR], {
      cwd,
      encoding: 'utf8',
    });
  } catch {
    return [];
  }
  return parseCoreDocChanges(out);
}

module.exports = { parseCoreDocChanges, coreDocsChangedSince, CORE_GLOB_DIR };
