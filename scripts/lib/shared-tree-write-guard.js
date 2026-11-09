/**
 * shared-tree-write-guard.js (session isolation, write surface)
 *
 * Companion to shared-tree-guard.js. That guard blocks destructive git ops and
 * commit/push to mainline in the shared checkout; this one blocks the step
 * BEFORE that: WRITING tracked source into the shared main checkout at all.
 *
 * The leak this closes: scheduled/headless agents whose prompts hardcode the
 * shared ABSOLUTE path ("write src/...; push to master") built files in the
 * shared tree (Write/Edit was never guarded), then could not push (blocked),
 * leaving permanent dirt. Because the decision is on the TARGET path, an
 * isolated cwd does not rescue an absolute write into the shared tree -- which
 * is exactly how the prior fix (isolated cwd only) was defeated.
 *
 * Class we block (category, not literal trigger):
 *   - any write whose target resolves inside the shared main checkout.
 *
 * Class we ALLOW:
 *   - any path inside an isolated worktree (sb-sessions/, .claude/worktrees/,
 *     sb-isolation, sb-hygiene);
 *   - anything outside the shared main checkout;
 *
 * '.' and '..' segments are collapsed before any check, so a relative or
 * absolute path cannot traverse out of a worktree into shared source and still
 * read as "isolated".
 *
 * CommonJS so the .mjs hook can require() it via createRequire, and so it is
 * unit-tested in isolation.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ISOLATED_WORKTREE_MARKERS = [
  '/.claude/worktrees/',
  'sb-sessions/',
  'sb-isolation',
  'sb-hygiene',
];

// Collapse '.' and '..' segments so a path can never launder its real target
// past the isolated-path / under-main-root checks. Without this, a relative or
// absolute path like "sb-sessions/x/../../secondbrain/src/foo.py" would still
// literally contain "sb-sessions/" and be mis-classified as isolated even though
// it resolves into the shared tree.
function collapseDotSegments(p) {
  const drive = /^([a-zA-Z]:)(\/.*)?$/.exec(p);
  const prefix = drive ? drive[1] : '';
  const rest = drive ? drive[2] || '' : p;
  const lead = rest.startsWith('/') ? '/' : '';
  const out = [];
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length) out.pop();
      continue;
    }
    out.push(seg);
  }
  return prefix + lead + out.join('/');
}

function normalize(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  let out = p.replace(/\\/g, '/');
  // MSYS /c/Users/x -> c:/Users/x so it compares equal to the Windows form.
  const msys = out.match(/^\/([a-zA-Z])\/(.*)$/);
  if (msys) out = msys[1] + ':/' + msys[2];
  if (/^[a-zA-Z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1);
  out = collapseDotSegments(out);
  out = out.replace(/\/+$/, '');
  return out;
}

function isIsolatedPath(p) {
  const n = normalize(p);
  if (!n) return false;
  return ISOLATED_WORKTREE_MARKERS.some((m) => n.includes(m));
}

function isUnderMainRoot(candidate, mainRoot) {
  const c = normalize(candidate);
  const root = normalize(mainRoot);
  if (!c || !root) return false;
  if (isIsolatedPath(c)) return false;
  if (c === root) return true;
  return c.startsWith(root + '/');
}

// Resolve junctions/symlinks before comparing paths. The Windows shared checkout
// is commonly reachable through both ~/secondbrain and Documents/GitHub/SecondBrain;
// string comparison alone lets one alias bypass a guard configured with the other.
// For a not-yet-created target, resolve the nearest existing parent and append the
// missing tail so new files receive the same protection as existing files.
function resolveExistingRealPath(candidate) {
  const normalized = normalize(candidate);
  if (!normalized) return normalized;
  if (process.platform !== 'win32' && /^[a-zA-Z]:\//.test(normalized)) return normalized;

  let cursor = normalized.split('/').join(path.sep);
  const missing = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (!parent || parent === cursor) return normalized;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  try {
    return path.join(fs.realpathSync.native(cursor), ...missing);
  } catch {
    return normalized;
  }
}

/**
 * @param {{filePath:string, cwd?:string, mainRoot:string, env?:object}} args
 * @returns {{blocked:boolean, reason:string}}
 */
function evaluateSharedTreeWrite({ filePath, cwd, mainRoot, env, resolveRealPath } = {}) {
  env = env || {};

  let target = normalize(filePath);
  if (!target) return { blocked: false, reason: 'no target path' };

  // Resolve a relative target against cwd (Write/Edit pass absolute paths, but
  // be defensive so a relative path can never silently slip the guard). Join
  // before collapsing dot segments so a leading '..' is not lost.
  if (!/^[a-zA-Z]:\//.test(target) && cwd) {
    target = normalize(String(cwd).replace(/\\/g, '/') + '/' + String(filePath).replace(/\\/g, '/'));
  }

  const realPath = typeof resolveRealPath === 'function' ? resolveRealPath : resolveExistingRealPath;
  target = normalize(realPath(target) || target);
  const root = normalize(realPath(normalize(mainRoot)) || mainRoot);

  if (isIsolatedPath(target)) {
    return { blocked: false, reason: 'isolated worktree path' };
  }

  if (!isUnderMainRoot(target, root)) {
    return { blocked: false, reason: 'outside the shared main checkout' };
  }

  const rel = target.slice(root.length + 1);
  return {
    blocked: true,
    reason:
      `shared checkout write blocked (${rel || '.'}). ` +
      'Use an isolated worktree and land through scripts/land.js.',
  };
}

// Bash write surface (S-3, 2026-10-27). The Write/Edit hook never sees a shell
// write, so a session could append a lesson into the shared checkout with
// `>>`, tee, sed -i, cp or mv and leave it dirty (voice_confirmation
// LEARNINGS.md, Oct 26). Category: any shell command whose file-write target
// resolves inside the shared checkout. Targets that need expansion ($VAR) are
// not resolvable here and are skipped rather than guessed.
const WRITE_VERBS_LAST_ARG = new Set(['cp', 'mv', 'install']);
const WRITE_VERBS_ALL_ARGS = new Set(['tee', 'touch', 'rm', 'truncate']);
const INPLACE_VERBS = new Set(['sed', 'perl']);
const SKIP_WRAPPERS = new Set(['sudo', 'env', 'command', 'nice', 'time', 'timeout']);

function isAbsolute(p) {
  return /^([a-zA-Z]:)?[\\/]/.test(String(p || ''));
}

// Join before collapsing: normalize('../x') alone drops the '..'.
function joinRelative(base, p) {
  if (isAbsolute(p) || !base) return normalize(p);
  return normalize(String(base).replace(/\\/g, '/') + '/' + String(p).replace(/\\/g, '/'));
}

function isUnresolvable(target) {
  return (
    !target ||
    target.includes('$') ||
    target.includes('`') ||
    target.startsWith('&') ||
    /^\/dev\//.test(target)
  );
}

function expandHome(target) {
  if (target === '~' || target.startsWith('~/')) {
    return require('node:os').homedir().replace(/\\/g, '/') + target.slice(1);
  }
  return target;
}

// Quote-aware words for one segment. An unquoted '>' or '>>' (with an
// optional leading fd digit or '&') is a redirect even when glued to the word
// before or after it; a quoted '>' is plain text (rg -n '>>' file).
function shellWords(segment) {
  const words = [];
  let cur = '';
  let started = false;
  let quote = null;
  let redirectNext = false;
  const push = () => {
    if (started) words.push({ text: cur, redirect: redirectNext });
    if (started) redirectNext = false;
    cur = '';
    started = false;
  };
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        cur += segment[i + 1] || '';
        i += 1;
      } else if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '\\') {
      cur += segment[i + 1] || '';
      i += 1;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    if (ch === '>') {
      // A bare fd number or '&' right before '>' belongs to the operator.
      if (/^(\d+|&)$/.test(cur)) {
        cur = '';
        started = false;
      } else push();
      if (segment[i + 1] === '>') i += 1;
      if (segment[i + 1] === '&') {
        // fd duplication such as >&2: skip the fd word, no file target.
        i += 1;
        while (i + 1 < segment.length && /[\d-]/.test(segment[i + 1])) i += 1;
        continue;
      }
      redirectNext = true;
      continue;
    }
    cur += ch;
    started = true;
  }
  push();
  return words;
}

function segmentWriteTargets(words) {
  const targets = [];
  const args = [];
  for (const w of words) {
    if (w.redirect) targets.push(w.text);
    else args.push(w.text);
  }
  while (args.length && (SKIP_WRAPPERS.has(args[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]))) {
    args.shift();
  }
  const verb = (args[0] || '').replace(/^.*\//, '');
  const rest = args.slice(1);
  const positional = rest.filter((a) => !a.startsWith('-'));
  if (WRITE_VERBS_ALL_ARGS.has(verb)) targets.push(...positional);
  else if (WRITE_VERBS_LAST_ARG.has(verb) && positional.length >= 2) {
    targets.push(positional[positional.length - 1]);
  } else if (
    INPLACE_VERBS.has(verb) &&
    rest.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')) &&
    positional.length
  ) {
    targets.push(positional[positional.length - 1]);
  }
  return { targets, verb, positional };
}

/**
 * Evaluate a Bash command for file writes into the shared main checkout.
 * `cd <dir>` segments move the effective cwd for later relative targets; a cd
 * that needs expansion makes later relative targets unresolvable (skipped).
 * @returns {{blocked:boolean, reason:string}}
 */
function evaluateSharedTreeBashWrite({ command, cwd, mainRoot, env, resolveRealPath } = {}) {
  const { splitSegments } = require('./shared-tree-guard.js');
  let effectiveCwd = cwd ? normalize(cwd) : '';
  for (const segment of splitSegments(command)) {
    const { targets, verb, positional } = segmentWriteTargets(shellWords(segment));
    if (verb === 'cd' || verb === 'pushd') {
      const dir = positional[0];
      if (!dir || isUnresolvable(dir)) effectiveCwd = '';
      else {
        effectiveCwd = joinRelative(effectiveCwd, expandHome(dir));
      }
      continue;
    }
    for (const raw of targets) {
      if (isUnresolvable(raw)) continue;
      const home = expandHome(raw);
      // A POSIX absolute path that is not an MSYS drive path (/tmp/...) is
      // outside every Windows checkout; normalize already maps /c/... to c:/.
      if (normalize(home).startsWith('/')) continue;
      if (!isAbsolute(home) && !effectiveCwd) continue;
      const target = joinRelative(effectiveCwd, home);
      const r = evaluateSharedTreeWrite({
        filePath: target,
        cwd: effectiveCwd,
        mainRoot,
        env,
        resolveRealPath,
      });
      if (r.blocked) return r;
    }
  }
  return { blocked: false, reason: 'no shell write into the shared main checkout' };
}

module.exports = {
  evaluateSharedTreeWrite,
  evaluateSharedTreeBashWrite,
  // exported for reuse/parity with shared-tree-guard.js consumers
  normalize,
  isIsolatedPath,
  isUnderMainRoot,
  resolveExistingRealPath,
};
