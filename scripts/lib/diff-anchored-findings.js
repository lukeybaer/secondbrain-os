// scripts/lib/diff-anchored-findings.js
//
// Scope review findings to the diff they were asked about. A Codex review of
// a unified diff routinely names defects in code the diff never touched
// (2026-09-03: the EC2 deploy pass blocked on the deploy script's repaint
// closure and a dispatch lane, neither in the change). Those are real open
// work, but they are not a reason to keep THIS change out of production.
//
// Contract (Codex adversarial review, 2026-09-03, two passes):
//   - The scope is computed ONCE, at review time, from the artifact the
//     reviewer actually read, and stored in the receipt (`diffScope`). The
//     gate never re-reads the artifact file, so a mutated or relocated file
//     cannot change a verdict after the fact.
//   - Scoping is per FILE, not per hunk: a finding anywhere in a file the diff
//     changed stays in scope, because a change in a file can break any line
//     of it. Only a finding in a file the diff did not touch at all is out.
//   - Deleted, binary, renamed, and mode-only entries count as whole-file
//     changes. A file name that matches more than one diffed path is
//     ambiguous and stays in scope. A finding with no anchor stays in scope.
//     An artifact that is not a unified diff yields no scope at all, and no
//     scope means every finding is in.
//   - The reviewer's own words outrank geometry in one direction: a finding
//     that says the defect is introduced by this change is in scope wherever
//     it is anchored.

'use strict';

// Reviewer attribution to THIS change, in either word order: "introduced by
// this change", "this patch introduces", "regression from this patch".
const INTRODUCED_RE =
  /\b(introduced|caused|regress\w*|broken|breaks?)\b[^.\n]{0,60}\b(by|in|with|from|after)\b[^.\n]{0,20}\b(this|the)\b[^.\n]{0,10}\b(change|diff|patch|commit)\b|\b(this|the)\b[^.\n]{0,10}\b(change|diff|patch|commit)\b[^.\n]{0,40}\b(introduc\w*|caus\w*|regress\w*|breaks?|broke)\b/i;

// Serializable: { files: { 'repo/relative/path': 'whole' | [[start, end], ...] } }
function buildDiffScope(text) {
  const src = String(text || '');
  if (!isUnifiedDiff(src)) return null;
  const files = {};
  let current = null;
  const mark = (file, value) => {
    if (!file) return;
    const key = file.replace(/\\/g, '/');
    if (value === 'whole' || files[key] === undefined) files[key] = value;
  };
  for (const raw of src.split(/\r?\n/)) {
    const header = raw.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (header) {
      // Register both sides; hunks fill in ranges, and an entry left without
      // hunks (binary, rename, mode-only) becomes a whole-file change below.
      current = header[2];
      if (files[current] === undefined) files[current] = [];
      if (header[1] !== header[2] && files[header[1]] === undefined) files[header[1]] = [];
      continue;
    }
    if (
      /^(Binary files .* differ|rename (from|to) |(old|new) mode |deleted file mode |new file mode )/.test(
        raw,
      )
    ) {
      mark(current, 'whole');
      continue;
    }
    const minus = raw.match(/^--- (?:a\/)?(\S+)/);
    if (minus && minus[1] !== '/dev/null') {
      current = minus[1];
      if (files[current] === undefined) files[current] = [];
      continue;
    }
    const plus = raw.match(/^\+\+\+ (?:b\/)?(\S+)/);
    if (plus) {
      if (plus[1] === '/dev/null') {
        mark(current, 'whole'); // deletion: the whole old file changed
      } else {
        current = plus[1];
        if (files[current] === undefined) files[current] = [];
      }
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && current && Array.isArray(files[current])) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      files[current].push([start, Math.max(start, start + count - 1)]);
    }
  }
  // A file entry with no hunks (mode-only, binary, rename) is a whole-file change.
  for (const key of Object.keys(files)) {
    if (Array.isArray(files[key]) && files[key].length === 0) files[key] = 'whole';
  }
  return Object.keys(files).length ? { files } : null;
}

// A real unified diff has a git header, or a ---/+++ pair followed by a hunk.
function isUnifiedDiff(text) {
  const src = String(text || '');
  if (/^diff --git /m.test(src)) return true;
  return /^--- \S+\r?\n\+\+\+ \S+\r?\n@@ /m.test(src);
}

// `path:line`, `path:line-line`, or a bare path, taken from the start of a
// finding's text (the shape both reviewers emit: "[high] a.js:12 - detail").
function parseAnchor(text) {
  const m = String(text || '')
    .trim()
    .match(/^`?([^\s`:]+?)(?::(\d+)(?:-(\d+))?)?`?(?:\s|$)/);
  if (!m) return null;
  const file = m[1].replace(/\\/g, '/');
  if (!/[./]/.test(file)) return null;
  return {
    file,
    line: m[2] === undefined ? null : Number(m[2]),
    endLine: m[3] === undefined ? null : Number(m[3]),
  };
}

// Exact path first; else exactly one suffix match; ambiguity is "unknown",
// which the caller treats as in scope.
function matchFile(anchorFile, files) {
  const keys = Object.keys(files);
  if (files[anchorFile] !== undefined) return { matched: true, file: anchorFile };
  const suffix = keys.filter((k) => k.endsWith('/' + anchorFile) || anchorFile.endsWith('/' + k));
  if (suffix.length === 1) return { matched: true, file: suffix[0] };
  if (suffix.length > 1) return { matched: true, file: null, ambiguous: true };
  return { matched: false };
}

// The reviewer's structured classification: `[pre-existing]` right after the
// severity tag, or the phrase "pre-existing" in the finding. Only the reviewer
// can assert that a defect exists on the base independent of this diff; file
// membership alone cannot (a change in one file can break an unchanged
// consumer). Codex review 2026-09-03: highs default to blocking.
// Structured tag only: a prose mention of "pre-existing" is not a classification.
const PRE_EXISTING_RE = /^\s*\[pre-existing\]/i;

function reviewerSaysPreExisting(finding) {
  return PRE_EXISTING_RE.test(String(finding?.text || ''));
}

// A finding is OUT of scope only when ALL hold: the reviewer classified it
// pre-existing, its file is not one the diff changed, and (when the checkout
// is available) that file really exists there, so a mistyped or invented path
// is "unknown", never "untouched" (Codex review 2026-09-03). Everything else
// is in.
function findingInScope(
  finding,
  diffScope,
  { repoRoot = null, fileExists = defaultFileExists } = {},
) {
  if (!diffScope || !diffScope.files) return true; // no scope: everything is in
  const text = String(finding?.text || '');
  if (INTRODUCED_RE.test(text)) return true; // reviewer says this change caused it
  if (!reviewerSaysPreExisting(finding)) return true; // untagged: attributed to this change
  const anchor = parseAnchor(text.replace(/^\s*\[pre-existing\]\s*/i, ''));
  if (!anchor) return true; // unanchored: stay conservative
  const hit = matchFile(anchor.file, diffScope.files);
  if (hit.matched) return true; // exact, unique-suffix, or ambiguous all stay in
  if (repoRoot && !fileExists(repoRoot, anchor.file)) return true; // unknown path: stay in
  return false;
}

function defaultFileExists(repoRoot, file) {
  try {
    return require('node:fs').existsSync(require('node:path').join(repoRoot, file));
  } catch {
    return false;
  }
}

// findings: [{severity, text}] -> { scoped, inDiff, outOfDiff }.
function scopeFindings(findings = [], diffScope = null, opts = {}) {
  if (!diffScope || !diffScope.files || !Object.keys(diffScope.files).length) {
    return { scoped: false, inDiff: [...findings], outOfDiff: [] };
  }
  const inDiff = [];
  const outOfDiff = [];
  for (const f of findings) {
    if (findingInScope(f, diffScope, opts)) inDiff.push(f);
    else outOfDiff.push({ ...f, outOfDiff: true, preExisting: true });
  }
  return { scoped: true, inDiff, outOfDiff };
}

module.exports = {
  INTRODUCED_RE,
  PRE_EXISTING_RE,
  buildDiffScope,
  reviewerSaysPreExisting,
  findingInScope,
  isUnifiedDiff,
  matchFile,
  parseAnchor,
  scopeFindings,
};
