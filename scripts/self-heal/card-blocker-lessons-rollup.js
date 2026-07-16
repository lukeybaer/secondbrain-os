#!/usr/bin/env node
'use strict';

// scripts/self-heal/card-blocker-lessons-rollup.js
//
// STRUCTURED LESSON CAPTURE, item 4 (ExampleCo dispatch 2026-07-12 evening):
// extends the per-component LESSONS discipline. Appends a dated digest of the
// trailing week's card-blocker lessons (aggregate by card, count, outcomes)
// to dev-plans/core/briefing.LESSONS.md, the doc scripts/self-heal already
// treats as the durable, git-tracked record of hard-won briefing rules.
//
// Invoked from the Friday step in scripts/ec2-morning-briefing-run.sh
// (BRIEFING_SKIP_LESSONS_ROLLUP=1 to skip). Idempotent per week: a digest for
// the same [sinceDate, untilDate] window is not appended twice (checked by
// the header text already being present in the doc).
//
// CLI: node scripts/self-heal/card-blocker-lessons-rollup.js [--date YYYY-MM-DD] [--data-dir DIR]

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cardBlockerLessons = require('./card-blocker-lessons.js');

const REPO = path.resolve(__dirname, '..', '..');
const LESSONS_DOC_REL = path.join('dev-plans', 'core', 'briefing.LESSONS.md');

function safeDate(nowDate) {
  const d = String(nowDate || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : new Date().toISOString().slice(0, 10);
}

// Trailing 7-day window ending on `nowDate` (inclusive).
function weekWindow(nowDate) {
  const today = safeDate(nowDate);
  const untilMs = Date.parse(`${today}T00:00:00Z`);
  const sinceMs = untilMs - 6 * 24 * 3600 * 1000;
  return {
    sinceDate: new Date(sinceMs).toISOString().slice(0, 10),
    untilDate: today,
  };
}

// GIT DURABILITY (Codex review 2026-07-12): dev-plans/core/briefing.LESSONS.md
// is git-tracked curated state, not a runtime artifact (memory/MEMORY.md:
// "source, memory, hooks, curated state live in git; runtime artifacts are
// durable, not git-tracked"). Writing it on a live host without committing it
// is silently lost the moment the EC2 build path re-syncs from git
// (feedback_ec2_build_path_silent_revert.md), and /opt/secondbrain may not
// even be a git checkout at all (EC2 root contract). This is a MECHANICAL,
// scoped, single-file commit+push, not the full land.js worktree-isolation
// dance: the change is a pure, idempotent (header-guarded) markdown append
// with zero test risk, so a scoped commit against the resolved real git
// checkout ($ROOT, explicit pathspec, never a broad `git add -A`) is
// proportionate. Never throws; a git failure degrades to an honest reason
// string, and the header-check keeps a retried run from double-appending.
function commitAndPushLessonsDoc({ repoRoot, docRelPath, message, spawnSyncFn = spawnSync }) {
  const git = (...args) =>
    spawnSyncFn('git', ['-C', repoRoot, ...args], { encoding: 'utf8', timeout: 60_000 });
  try {
    const inside = git('rev-parse', '--is-inside-work-tree');
    if (inside.status !== 0 || String(inside.stdout || '').trim() !== 'true') {
      return {
        committed: false,
        pushed: false,
        reason:
          'not a git checkout at this root (e.g. an EC2 file-copy deploy root); durable git write skipped, local file write still stands',
      };
    }
    git('fetch', 'origin', 'master');
    const diff = git('diff', '--quiet', '--', docRelPath);
    if (diff.status === 0) {
      return {
        committed: false,
        pushed: false,
        reason: 'no diff to commit against the current HEAD',
      };
    }
    const add = git('add', '--', docRelPath);
    if (add.status !== 0) {
      return {
        committed: false,
        pushed: false,
        reason: `git add failed: ${String(add.stderr || add.stdout || '').slice(0, 300)}`,
      };
    }
    const commit = git('commit', '-m', message);
    if (commit.status !== 0) {
      return {
        committed: false,
        pushed: false,
        reason: `git commit failed: ${String(commit.stderr || commit.stdout || '').slice(0, 300)}`,
      };
    }
    let push = git('push', 'origin', 'HEAD:master');
    if (push.status !== 0) {
      // One rebase-and-retry, mirroring land.js's fetch+rebase+push shape at
      // a much smaller (single-file, mechanical) scope.
      const rebase = git('pull', '--rebase', 'origin', 'master');
      if (rebase.status === 0) push = git('push', 'origin', 'HEAD:master');
    }
    if (push.status !== 0) {
      return {
        committed: true,
        pushed: false,
        reason: `git push failed after retry: ${String(push.stderr || push.stdout || '').slice(0, 300)}`,
      };
    }
    return { committed: true, pushed: true, reason: '' };
  } catch (e) {
    return {
      committed: false,
      pushed: false,
      reason: `git commit/push threw: ${String((e && e.message) || e).slice(0, 300)}`,
    };
  }
}

function appendRollup({ opts = {}, nowDate, docPath, repoRoot, commit = false, gitFn } = {}) {
  const root = repoRoot || REPO;
  const targetDoc = docPath || path.join(root, LESSONS_DOC_REL);
  const { sinceDate, untilDate } = weekWindow(nowDate);
  const header = `## Card-blocker lessons weekly digest: ${sinceDate} to ${untilDate}`;
  let existing = '';
  try {
    existing = fs.readFileSync(targetDoc, 'utf8');
  } catch {
    existing = '';
  }
  if (existing.includes(header)) {
    return {
      written: false,
      reason: 'digest for this week already recorded',
      header,
      sinceDate,
      untilDate,
    };
  }
  const body = cardBlockerLessons.formatRollupMarkdown({ opts, sinceDate, untilDate });
  const sep = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  fs.mkdirSync(path.dirname(targetDoc), { recursive: true });
  fs.writeFileSync(targetDoc, existing + sep + body + '\n');
  const result = { written: true, header, sinceDate, untilDate };
  if (commit) {
    const relDoc = path.relative(root, targetDoc).replace(/\\/g, '/');
    result.git = (gitFn || commitAndPushLessonsDoc)({
      repoRoot: root,
      docRelPath: relDoc,
      message: `chore(briefing-lessons): weekly card-blocker digest ${sinceDate} to ${untilDate}`,
    });
  }
  return result;
}

function parseCliArgs(argv) {
  const opts = {};
  let date;
  let noCommit = false;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--date') date = argv[++i];
    else if (argv[i] === '--data-dir') opts.dataDir = argv[++i];
    else if (argv[i] === '--no-commit') noCommit = true;
  }
  return { opts, date, noCommit };
}

function main() {
  const { opts, date, noCommit } = parseCliArgs(process.argv);
  const result = appendRollup({ opts, nowDate: date, commit: !noCommit });
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = { safeDate, weekWindow, commitAndPushLessonsDoc, appendRollup };

if (require.main === module) main();
