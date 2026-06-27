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
 *   - the single audited integration lease (SB_INTEGRATION_SESSION=1 plus a
 *     valid lock file created by scripts/integration-session.js).
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
const { validateIntegrationSession } = require('./integration-session.js');

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

  const integration = validateIntegrationSession({ env, mainRoot });
  if (integration.valid) {
    return {
      blocked: false,
      reason: integration.reason,
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
  return {
    blocked: true,
    reason:
      `shared checkout write blocked (${rel || '.'}). ` +
      'Use an isolated worktree and land through the gate, or run under ' +
      'scripts/integration-session.js for the single audited integration path.',
  };
}

module.exports = {
  evaluateSharedTreeWrite,
  // exported for reuse/parity with shared-tree-guard.js consumers
  normalize,
  isIsolatedPath,
  isUnderMainRoot,
};
