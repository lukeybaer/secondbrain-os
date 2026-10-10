const { spawnSync } = require('child_process');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const COMPLETENESS_REASON = 'otter-speaker-identity-completeness';

// The hook waits on archive-wide People File steps that each get their own 15-minute budget
// (projectionStepTimeoutMs in speaker-identity-change-hook.js). A fixed 240-second outer limit
// killed it on a two-day backlog (2026-09-23), so the outer limit now follows that inner step
// budget and SPEAKER_IDENTITY_CHANGE_HOOK_TIMEOUT_MS overrides it.
const DEFAULT_HOOK_TIMEOUT_MS = 15 * 60 * 1000;

function speakerIdentityChangeHookTimeoutMs(env = process.env) {
  const configured = Number(env.SPEAKER_IDENTITY_CHANGE_HOOK_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) return Math.max(60_000, configured);
  const step = Number(env.OTTER_PEOPLE_FILE_PROJECTION_STEP_TIMEOUT_MS);
  return Number.isFinite(step) && step > 0
    ? Math.max(240_000, step)
    : DEFAULT_HOOK_TIMEOUT_MS;
}

function runSpeakerIdentityChangeHook(
  reason,
  { syncPeople = true, normalizedUpstream = false, spawnSyncFn = spawnSync } = {},
) {
  if (process.env.SPEAKER_IDENTITY_CHANGE_HOOK === '0') {
    return {
      skipped: true,
      deferred: true,
      ok: true,
      reason: 'SPEAKER_IDENTITY_CHANGE_HOOK=0',
    };
  }
  const args = ['scripts/speaker-identity-change-hook.js', '--write', '--reason', reason];
  if (syncPeople && process.env.SPEAKER_IDENTITY_CHANGE_SYNC !== '0') args.push('--sync-people');
  const result = spawnSyncFn(process.execPath, args, {
    cwd: REPO,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      SPEAKER_IDENTITY_NORMALIZED_UPSTREAM:
        normalizedUpstream && reason === COMPLETENESS_REASON ? '1' : '0',
      SKIP_EC2_PUBLISH: '1',
    },
    timeout: speakerIdentityChangeHookTimeoutMs(),
    windowsHide: true,
  });
  return {
    skipped: false,
    reason,
    status: result.status,
    ok: result.status === 0,
    stdout_tail: String(result.stdout || '').slice(-2000),
    stderr_tail: String(result.stderr || '').slice(-2000),
  };
}

module.exports = {
  COMPLETENESS_REASON,
  runSpeakerIdentityChangeHook,
  speakerIdentityChangeHookTimeoutMs,
};
