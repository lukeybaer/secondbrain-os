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
 *   - a write whose target resolves inside the shared main checkout AND is
 *     SOURCE: under a code dir (src/, scripts/, scheduled-tasks/, electron/) OR
 *     has a code extension (.ts/.tsx/.js/.jsx/.mjs/.cjs/.py/.go/.rs).
 *
 * Class we ALLOW:
 *   - any path inside an isolated worktree (sb-sessions/, .claude/worktrees/,
 *     sb-isolation, sb-hygiene);
 *   - non-code files anywhere in the shared tree -- this is what keeps the
 *     accept-and-sweep curated state working (memory/*.md, data/*.json,
 *     content-review/*.json are not source, so they fall through to allowed);
 *   - anything outside the shared main checkout;
 *   - the single integration session (SB_INTEGRATION_SESSION=1).
 *
 * '.' and '..' segments are collapsed before any check, so a relative or
 * absolute path cannot traverse out of a worktree into shared source and still
 * read as "isolated".
 *
 * CommonJS so the .mjs hook can require() it via createRequire, and so it is
 * unit-tested in isolation.
 */

'use strict';

const ISOLATED_WORKTREE_MARKERS = [
  '/.claude/worktrees/',
  'sb-sessions/',
  'sb-isolation',
  'sb-hygiene',
];

// Code directories: writes here are engineering work and must be isolated.
const SOURCE_DIR_PREFIXES = ['src/', 'scripts/', 'scheduled-tasks/', 'electron/'];

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs'];

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

/**
 * @param {{filePath:string, cwd?:string, mainRoot:string, env?:object}} args
 * @returns {{blocked:boolean, reason:string}}
 */
function evaluateSharedTreeWrite({ filePath, cwd, mainRoot, env } = {}) {
  env = env || {};

  if (env.SB_INTEGRATION_SESSION === '1') {
    return {
      blocked: false,
      reason: 'integration session escape hatch (SB_INTEGRATION_SESSION=1)',
    };
  }

  let target = normalize(filePath);
  if (!target) return { blocked: false, reason: 'no target path' };

  // Resolve a relative target against cwd (Write/Edit pass absolute paths, but
  // be defensive so a relative path can never silently slip the guard).
  if (!/^[a-zA-Z]:\//.test(target) && cwd) {
    target = normalize(normalize(cwd) + '/' + target);
  }

  if (isIsolatedPath(target)) {
    return { blocked: false, reason: 'isolated worktree path' };
  }

  const root = normalize(mainRoot);
  if (!isUnderMainRoot(target, root)) {
    return { blocked: false, reason: 'outside the shared main checkout' };
  }

  const rel = target.slice(root.length + 1);
  const lower = rel.toLowerCase();

  // Source = under a code dir OR carrying a code extension, anywhere in the
  // shared tree. Curated state (memory/*.md, data/*.json) is NOT source and
  // falls through to allowed; but a code file (.py/.js) dropped under memory/
  // or data/ IS source and is blocked, so the curated-state paths cannot be
  // used to smuggle code into the shared checkout. Lowercased so a Windows
  // "Src/" or "Scripts/" cannot evade the dir-prefix check.
  const inSourceDir = SOURCE_DIR_PREFIXES.some((p) => lower.startsWith(p));
  const hasSourceExt = SOURCE_EXTENSIONS.some((e) => lower.endsWith(e));

  if (inSourceDir || hasSourceExt) {
    return {
      blocked: true,
      reason:
        `tracked source write in the shared main checkout (${rel}). ` +
        'Isolate in a worktree (scripts/new-session.sh) and land via scripts/land.js, ' +
        'or set SB_INTEGRATION_SESSION=1 for the single integration session.',
    };
  }

  return { blocked: false, reason: 'non-source path in the shared checkout' };
}

module.exports = {
  evaluateSharedTreeWrite,
  // exported for reuse/parity with shared-tree-guard.js consumers
  normalize,
  isIsolatedPath,
  isUnderMainRoot,
};
