#!/usr/bin/env node
'use strict';

// Mechanical deploy hold lease (agent delivery protocol, 2026-09-27).
//
// On 2026-09-26 two Codex threads held production deploys with chat messages
// ("HOLD", "Renewed HOLD ... until I send RELEASED") plus a 15-minute polling
// heartbeat; a landed briefing change then sat undeployed for 14 hours. A chat
// message is not a lock. deploy-ec2-server.sh already waits at an Otter stage
// boundary; when a cohort truly needs production frozen, it takes this lease:
// at most 90 minutes, one renewal, hard expiry, so a crashed agent can never
// freeze production.
//
//   node scripts/deploy-hold.js take --minutes 60 --reason "otter cohort new50"
//   node scripts/deploy-hold.js renew --minutes 30
//   node scripts/deploy-hold.js release
//   node scripts/deploy-hold.js status
//   ... | node scripts/deploy-hold.js check     (used by deploy-ec2-server.sh)

const os = require('node:os');
const { runRemote } = require('./lib/ec2-remote.js');

const MAX_MINUTES = 90;
const MAX_RENEWALS = 1;
const HOLD_FILE = '/opt/secondbrain/data/agent/deploy-hold.json';

function evaluateHold(hold, now = Date.now()) {
  if (!hold || typeof hold !== 'object' || !hold.expires_at) return { held: false };
  const expires = Date.parse(hold.expires_at);
  if (!Number.isFinite(expires) || expires <= now) return { held: false, expired: true };
  return { held: true, owner: hold.owner, reason: hold.reason, expires_at: hold.expires_at, minutes_left: Math.ceil((expires - now) / 60000) };
}

function nextHold(current, { action, minutes, reason, owner }, now = Date.now()) {
  const m = Number(minutes);
  if (action === 'take' || action === 'renew') {
    if (!Number.isFinite(m) || m < 1 || m > MAX_MINUTES) throw new Error(`--minutes must be 1 through ${MAX_MINUTES}.`);
  }
  const active = evaluateHold(current, now);
  if (action === 'take') {
    if (!reason || String(reason).trim().length < 8) throw new Error('--reason must say why production must stay frozen.');
    if (active.held && current.owner !== owner) throw new Error(`Deploys are already held by ${current.owner} until ${current.expires_at}: ${current.reason}`);
    return { schema: 'deploy_hold.v1', owner, reason: String(reason).trim(), taken_at: new Date(now).toISOString(), expires_at: new Date(now + m * 60000).toISOString(), renewals: 0 };
  }
  if (action === 'renew') {
    if (!active.held) throw new Error('No active hold to renew; take a new one if it is still needed.');
    if (current.owner !== owner) throw new Error(`The hold belongs to ${current.owner}.`);
    if ((current.renewals || 0) >= MAX_RENEWALS) throw new Error('This hold was already renewed once; let it expire so the queued deploy can run.');
    return { ...current, expires_at: new Date(now + m * 60000).toISOString(), renewals: (current.renewals || 0) + 1 };
  }
  throw new Error(`Unknown action ${action}`);
}

function ownerName(env = process.env) {
  const thread = env.CODEX_THREAD_ID || env.CLAUDE_SESSION_ID || '';
  return env.SB_HOLD_OWNER || `${os.userInfo().username}@${os.hostname()}${thread ? `:${thread}` : ''}`;
}

function readHold(deps = {}) {
  const r = (deps.runRemote || runRemote)(`cat ${HOLD_FILE} 2>/dev/null || true`);
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function writeHold(hold, deps = {}) {
  const r = (deps.runRemote || runRemote)(
    `mkdir -p /opt/secondbrain/data/agent && cat > ${HOLD_FILE}.tmp && mv ${HOLD_FILE}.tmp ${HOLD_FILE}`,
    { input: JSON.stringify(hold, null, 2) },
  );
  if (r.status !== 0) throw new Error(`Could not write the hold on EC2: ${r.stderr.trim()}`);
}

function main(argv = process.argv.slice(2), deps = {}) {
  const action = argv[0];
  const get = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (action === 'check') {
    let hold = null;
    try { hold = JSON.parse(deps.stdin ?? require('node:fs').readFileSync(0, 'utf8')); } catch { hold = null; }
    const v = evaluateHold(hold);
    if (v.held) {
      process.stdout.write(`HELD until ${v.expires_at} (${v.minutes_left} min) by ${v.owner}: ${v.reason}\n`);
      return 75;
    }
    process.stdout.write('CLEAR\n');
    return 0;
  }
  if (action === 'status') {
    process.stdout.write(`${JSON.stringify(evaluateHold(readHold(deps)))}\n`);
    return 0;
  }
  if (action === 'release') {
    const current = readHold(deps);
    if (current && current.owner !== ownerName() && evaluateHold(current).held) throw new Error(`The hold belongs to ${current.owner}.`);
    (deps.runRemote || runRemote)(`rm -f ${HOLD_FILE}`);
    process.stdout.write('released\n');
    return 0;
  }
  const hold = nextHold(readHold(deps), { action, minutes: get('minutes'), reason: get('reason'), owner: ownerName() });
  writeHold(hold, deps);
  process.stdout.write(`${JSON.stringify(hold)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`[deploy-hold] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { MAX_MINUTES, MAX_RENEWALS, evaluateHold, main, nextHold };
