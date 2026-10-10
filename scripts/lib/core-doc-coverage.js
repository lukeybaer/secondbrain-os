// scripts/lib/core-doc-coverage.js
//
// Core docs stay current EVERY change (ExampleCo, locked 2026-06-15; made
// mechanical 2026-09-03 after the brain-switch landing touched self-heal,
// briefing, and voice lanes without touching their one-pagers, and ExampleCo had
// to ask). Design equals code: each dev-plans/core/<name>.md declares the
// load-bearing files it owns in its frontmatter `paths:` list and names more
// under "## Key files". A COMMIT whose coverable changes match a component
// must also change that component's one-pager (`<name>.md`; a LESSONS entry
// is history, not current state) in the SAME commit, the unit ExampleCo's rule
// names. The only escape is an audited trailer line in that commit, bound to
// one component or explicitly to all: `core-doc-unchanged: <component|*>:
// <one-line reason>`, mirroring the g12 `no-test-justification:` escape.
//
// Deliberate carve-out: `memory/` and `data/` are content and runtime state.
// A component may register them so the drift lint can watch their shape, but
// editing a memory file or a ledger does not change a component's METHOD, so
// those paths never demand a one-pager edit here.
//
// Pure decision logic (fs reads only for the docs) so scripts/land.js and
// scripts/verify-core-doc-coverage.js share one evaluator and the tests can
// inject a component table and synthetic commits.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CORE_DIR_REL = 'dev-plans/core';
// Line-anchored like a git trailer, and bound to ONE component (or `*` for
// every component touched by that commit): a prose mention never counts.
const ESCAPE = /^\s*core-doc-unchanged:\s*([A-Za-z0-9_.-]+|\*)\s*:\s*(\S[^\n]{3,})$/gim;

function justifiedComponents(message) {
  const out = new Set();
  for (const m of String(message || '').matchAll(ESCAPE)) out.add(m[1]);
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Minimal glob support for the frontmatter shapes in use: `**`, `*`, `?`,
// and `{a,b}` alternation. Anchored to the whole repo-relative path.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const j = glob.indexOf('}', i);
      if (j === -1) {
        re += escapeRe(c);
      } else {
        const alts = glob
          .slice(i + 1, j)
          .split(',')
          .map((a) => escapeRe(a.trim()));
        re += '(?:' + alts.join('|') + ')';
        i = j;
      }
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp('^' + re + '$');
}

// The `paths:` list inside the YAML frontmatter: block list or inline list.
function readFrontmatterPaths(text) {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const out = [];
  let inPaths = false;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const inline = line.match(/^paths:\s*\[(.*)\]\s*$/);
    if (inline) {
      for (const part of inline[1].split(',')) {
        const v = part.trim().replace(/^['"]|['"]$/g, '');
        if (v) out.push(v);
      }
      inPaths = false;
      continue;
    }
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    const item = line.match(/^\s+-\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
    if (item) {
      out.push(item[1] || item[2] || item[3]);
      continue;
    }
    if (/^\S/.test(line)) inPaths = false;
  }
  return out;
}

// Files a doc names in its "## Key files" section (backtick paths, with an
// optional `:line` suffix). A doc that calls a file load-bearing in prose has
// registered it, whether or not `paths:` was kept in sync (Codex review
// 2026-09-03: vapi-live-assistant.js was named at two lines and covered by
// nothing).
function readKeyFiles(text) {
  const src = String(text || '');
  const start = src.search(/^## Key files\s*$/m);
  if (start === -1) return [];
  const rest = src.slice(start);
  const next = rest.slice(1).search(/^## /m);
  const section = next === -1 ? rest : rest.slice(0, next + 1);
  const out = new Set();
  for (const m of section.matchAll(/`([^`\s]+?)(?::\d+)?`/g)) {
    const p = m[1].replace(/\\/g, '/');
    if (/^[\w./@-]+\.[A-Za-z0-9]+$/.test(p) && p.includes('/') === true) out.add(p);
    else if (/^[\w.-]+\.(js|ts|mjs|cjs|sh|py|json|md)$/.test(p)) out.add(p);
  }
  return [...out];
}

// A core doc with no parseable `paths:` cannot be covered, and a gate that
// silently skips it fails open; so it is an error unless the caller opts out.
function loadComponents(root, { strict = true } = {}) {
  const dir = path.join(root, CORE_DIR_REL);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.endsWith('.LESSONS.md'))
    .sort()
    .map((f) => {
      const name = f.replace(/\.md$/, '');
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const globs = readFrontmatterPaths(text);
      if (strict && !globs.length) {
        throw new Error(`core doc ${CORE_DIR_REL}/${f} declares no parseable frontmatter paths`);
      }
      const keyFiles = readKeyFiles(text).filter(isCoverable);
      return {
        name,
        doc: `${CORE_DIR_REL}/${f}`,
        lessons: `${CORE_DIR_REL}/${name}.LESSONS.md`,
        globs,
        keyFiles,
        regexes: [
          ...globs.map(globToRegExp),
          ...keyFiles.map((k) => new RegExp('^' + escapeRe(k) + '$')),
        ],
      };
    });
}

// Anything a core doc names is load-bearing by definition, code or not
// (config JSON, a SKILL.md). Excluded: tests, the core docs themselves, and
// the content carve-out (memory/, data/) explained in the header.
function isCoverable(file) {
  const f = String(file || '').replace(/\\/g, '/');
  if (!f) return false;
  if (/(^|\/)__tests__\//.test(f) || /^tests?\//.test(f)) return false;
  if (/\.(test|spec|node-test)\.[cm]?[jt]sx?$/.test(f)) return false;
  if (/^dev-plans\//.test(f)) return false;
  if (/^(memory|data|content-review)\//.test(f)) return false;
  // Append-only learning logs are history, the same class as LESSONS: a new
  // dated entry records what happened, it does not change a component's method.
  if (/(^|\/)[A-Z_]*(LEARNINGS|LESSONS)\.md$/.test(f)) return false;
  return true;
}

// One commit: files it touched plus its message. The one-pager must be in
// the SAME commit, or that commit carries the escape for that component.
function evaluateCommit({ files = [], message = '' }, comps) {
  const changed = new Set(files.map((f) => String(f).replace(/\\/g, '/')));
  const escapes = justifiedComponents(message);
  const missing = [];
  const justified = [];
  for (const c of comps) {
    const hits = [...changed].filter((f) => isCoverable(f) && c.regexes.some((re) => re.test(f)));
    if (!hits.length) continue;
    if (changed.has(c.doc)) continue;
    if (escapes.has('*') || escapes.has(c.name)) {
      justified.push(c.name);
      continue;
    }
    missing.push({ component: c.name, doc: c.doc, lessons: c.lessons, files: hits });
  }
  return { ok: missing.length === 0, justified, missing };
}

// The land-time contract: every commit in the land is judged on its own diff
// and its own message. `commits` is [{ sha, files, message }] oldest first.
function evaluateCoreDocCoverageByCommit({ root, commits = [], components } = {}) {
  const comps = components || loadComponents(root || path.resolve(__dirname, '..', '..'));
  const perCommit = commits.map((c) => ({ sha: c.sha || null, ...evaluateCommit(c, comps) }));
  const blocked = perCommit.filter((c) => !c.ok);
  return {
    ok: blocked.length === 0,
    commits: perCommit,
    blocked,
    justified: [...new Set(perCommit.flatMap((c) => c.justified))],
  };
}

// Single-diff convenience (one commit's worth of files and message), used by
// the tests and by callers that already squashed.
function evaluateCoreDocCoverage({
  root,
  changedFiles = [],
  commitMessages = [],
  components,
} = {}) {
  const comps = components || loadComponents(root || path.resolve(__dirname, '..', '..'));
  return evaluateCommit({ files: changedFiles, message: commitMessages.join('\n') }, comps);
}

function formatMissing(missing) {
  return missing.map((m) => `${m.component} (${m.files.join(', ')}) needs ${m.doc}`).join('; ');
}

function formatBlocked(blocked) {
  return blocked
    .map((c) => `${c.sha ? c.sha.slice(0, 9) + ': ' : ''}${formatMissing(c.missing)}`)
    .join(' | ');
}

module.exports = {
  CORE_DIR_REL,
  ESCAPE,
  evaluateCommit,
  evaluateCoreDocCoverage,
  evaluateCoreDocCoverageByCommit,
  formatBlocked,
  formatMissing,
  globToRegExp,
  isCoverable,
  justifiedComponents,
  loadComponents,
  readFrontmatterPaths,
  readKeyFiles,
};
