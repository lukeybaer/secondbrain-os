'use strict';

// Deploy-parity scope (The owner, S-4, 2026-11-03). The EC2 release is a full
// git-archive of one sha (scripts/lib/atomic-release.sh), so "deployed" means
// "any tracked file that code can load at runtime". A scheduled job that only
// appends to a notes file (e.g. scheduled-tasks/<job>/LESSONS.md) after the
// deploy moves master ahead of the build-path checkout but changes nothing
// that runs, so it must not turn Deploy parity red.
//
// Fail safe: a path is ignorable ONLY when it matches an explicit notes rule
// below. Anything unknown, or any path under a runtime-read exception, counts
// as drift. Do not add a rule here unless nothing loads the file at runtime.

const { execFileSync } = require('node:child_process');
const { watchedLimitMs } = require('./watched-work-limit');

function normalizePath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

// Markdown the runtime DOES read, carved out of the notes rules below.
//   skills/cards/**             scripts/lib/card-skills.js loads SKILL.md, pages
//                               and LEARNINGS.md into every briefing card render.
//   scheduled-tasks/*/SKILL.md  scheduled-job-packet.js reads the method page.
const RUNTIME_READ_EXCEPTIONS = [
  /^skills\/cards\//i,
  /^scheduled-tasks\/[^/]+\/SKILL\.md$/i,
];

// Notes that no deployed code loads as behavior.
const NOTES_ONLY_RULES = [
  // Append-only job notes, e.g. scheduled-tasks/daily-briefing/LESSONS.md.
  /(^|\/)LESSONS\.md$/i,
  /(^|\/)[^/]*\.LESSONS\.md$/i,
  /(^|\/)LEARNINGS\.md$/i,
  // Plans and skill documentation. memory/** is not notes: ec2-server.js reads
  // memory/MEMORY.md and memory/user_profile.md at runtime.
  /^dev-plans\/.+\.(md|html)$/i,
  /^skills\/.+\.md$/i,
];

/**
 * True when a changed path can affect deployed or runtime-loaded code.
 * Unknown paths return true (fail safe).
 */
function isRuntimeLoadedPath(value) {
  const rel = normalizePath(value);
  if (!rel) return false;
  if (RUNTIME_READ_EXCEPTIONS.some((re) => re.test(rel))) return true;
  return !NOTES_ONLY_RULES.some((re) => re.test(rel));
}

/** Split a changed-file list into the deployed ones and the ignorable notes. */
function classifyChangedFiles(files) {
  const unique = [...new Set((files || []).map(normalizePath).filter(Boolean))].sort();
  return {
    runtimeFiles: unique.filter(isRuntimeLoadedPath),
    ignoredFiles: unique.filter((f) => !isRuntimeLoadedPath(f)),
  };
}

/**
 * Files that differ between two commits of one checkout, or null when git
 * cannot say (unknown commit, shallow clone). null makes the caller fail safe.
 */
function listChangedFiles(cwd, fromSha, toSha) {
  if (!fromSha || !toSha) return null;
  try {
    const out = execFileSync(
      'git',
      ['-C', cwd, 'diff', '--name-only', '--no-renames', fromSha, toSha],
      { encoding: 'utf8', timeout: watchedLimitMs(15000), maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return null;
  }
}

module.exports = { isRuntimeLoadedPath, classifyChangedFiles, listChangedFiles, normalizePath };
