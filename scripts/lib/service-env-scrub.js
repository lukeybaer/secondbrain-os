'use strict';

// A `pm2 restart --update-env` copies the CALLER's environment into the live
// service. When a heal worker or controller child runs a release on EC2, that
// environment carries run-scoped state: the parent controller's delegation
// tokens, a pinned BRIEFING_DATE, the night-owner marker and the worker's
// Claude/Codex session markers. On 2026-09-30 a content_pipeline heal worker
// relanded at 04:13 CT; every PM2 service then launched controllers as
// delegated children of a night controller that died at 04:24 CT, so every
// repair for the rest of the day was refused with conflict-lease-held.
//
// Service configuration (secrets, feature flags, data roots) is never listed
// here. Only names that identify one run, one night, or one agent session.
// scripts/lib/atomic-release.sh and scripts/ec2-release-rollback.sh carry the
// same list as a shell `case` pattern; service-env-scrub.test.js pins parity.
const RUN_SCOPED_ENV_PREFIXES = Object.freeze([
  'CARD_CONTROLLER_',
  'BRIEFING_CONTROLLER_',
  'BRIEFING_CARD_CONTROLLER_',
  'BRIEFING_NIGHT_',
  'CLAUDE_CODE_MESSAGING_',
  'CLAUDE_CODE_SESSION_',
]);

const RUN_SCOPED_ENV_NAMES = Object.freeze([
  'BRIEFING_DATE',
  'BRIEFING_HUMAN_ACTION_TOKEN',
  'AMY_NIGHT_OWNER',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CODEX_CI',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
]);

function isRunScopedEnvName(name) {
  const key = String(name || '');
  return (
    RUN_SCOPED_ENV_NAMES.includes(key) ||
    RUN_SCOPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function scrubServiceEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (!isRunScopedEnvName(key)) clean[key] = value;
  }
  return clean;
}

module.exports = {
  RUN_SCOPED_ENV_PREFIXES,
  RUN_SCOPED_ENV_NAMES,
  isRunScopedEnvName,
  scrubServiceEnv,
};
