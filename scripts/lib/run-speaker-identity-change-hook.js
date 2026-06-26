const { spawnSync } = require('child_process');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');

function runSpeakerIdentityChangeHook(reason, { syncPeople = true } = {}) {
  if (process.env.SPEAKER_IDENTITY_CHANGE_HOOK === '0') {
    return { skipped: true, reason: 'SPEAKER_IDENTITY_CHANGE_HOOK=0' };
  }
  const args = ['scripts/speaker-identity-change-hook.js', '--write', '--reason', reason];
  if (syncPeople && process.env.SPEAKER_IDENTITY_CHANGE_SYNC !== '0') args.push('--sync-people');
  const result = spawnSync(process.execPath, args, {
    cwd: REPO,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      SKIP_EC2_PUBLISH: '1',
    },
    timeout: 240000,
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

module.exports = { runSpeakerIdentityChangeHook };
