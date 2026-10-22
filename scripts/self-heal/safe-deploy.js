'use strict';

// scripts/self-heal/safe-deploy.js
//
// The HARD-gated deploy orchestration for promoting a patched server file to the live
// host. Built after the 2026-06-19 incident (feedback_deploy_hard_syntax_gate.md) where
// an ad-hoc bash deploy bypassed its own `node --check` gate (set -e ignores a failure on
// the left of `&&`), so a syntactically broken file reached prod and crashed the backend.
//
// This encodes the gate as an EXPLICIT step that aborts on failure (no `&&` list), so a
// failed syntax check, stage, or backup stops the deploy BEFORE the live file is touched,
// and a failed health check after restart triggers an automatic rollback. The side effects
// are injected so the logic is unit-tested without touching a real host.
//
// deps (each async, returns a small result object or boolean):
//   localSyntaxOk()   -> boolean        node --check on the patched file, locally
//   stage()           -> {ok, reason?}  copy the file to the remote staging path
//   remoteSyntaxOk()  -> boolean        node --check on the staged file, on the host
//   backup()          -> {ok, ref}      snapshot the current live file (ref = backup path)
//   deployLive()      -> {ok, reason?}  copy staged -> live
//   restart()         -> {ok}           restart the service
//   health()          -> {ok, reason?}  probe the service /health
//   rollback(ref)     -> {ok, healthOk} restore the backup and restart
//
// Returns one of:
//   { status: 'deployed', backupRef }
//   { status: 'aborted', stage, reason? }              live file never touched
//   { status: 'rolled-back', backupRef, healthAfterRollback, reason }

async function runSafeDeploy(deps = {}) {
  const need = [
    'localSyntaxOk',
    'stage',
    'remoteSyntaxOk',
    'backup',
    'deployLive',
    'restart',
    'health',
    'rollback',
  ];
  for (const k of need) {
    if (typeof deps[k] !== 'function')
      return { status: 'aborted', stage: 'deps', reason: `missing dep ${k}` };
  }

  // 1. HARD local syntax gate (the gate that failed in the incident).
  if (!(await deps.localSyntaxOk())) return { status: 'aborted', stage: 'local-syntax' };

  // 2. Stage to the host (still has not touched the live file).
  const st = await deps.stage();
  if (!st || !st.ok) return { status: 'aborted', stage: 'stage', reason: st && st.reason };

  // 3. HARD remote syntax gate (re-check on the host that will run it).
  if (!(await deps.remoteSyntaxOk())) return { status: 'aborted', stage: 'remote-syntax' };

  // 4. Backup the live file BEFORE overwriting it (the rollback source).
  const bk = await deps.backup();
  if (!bk || !bk.ok || !bk.ref)
    return { status: 'aborted', stage: 'backup', reason: bk && bk.reason };

  // 5. Overwrite the live file.
  const dl = await deps.deployLive();
  if (!dl || !dl.ok)
    return { status: 'aborted', stage: 'deploy', reason: dl && dl.reason, backupRef: bk.ref };

  // 6. Restart and 7. HARD health gate.
  await deps.restart();
  const h = await deps.health();
  if (h && h.ok) return { status: 'deployed', backupRef: bk.ref };

  // 8. Health failed -> automatic rollback.
  const rb = await deps.rollback(bk.ref);
  return {
    status: 'rolled-back',
    backupRef: bk.ref,
    healthAfterRollback: !!(rb && rb.healthOk),
    reason: (h && h.reason) || 'health check failed after deploy',
  };
}

module.exports = { runSafeDeploy };
