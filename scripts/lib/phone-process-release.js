'use strict';

// Keeps the phone process (SB_SERVER_ROLE=phone, scripts/lib/server-role.js)
// on the right release during a deploy. Owner decision: calling restarts
// only when calling changes. An exception to the devops-release rule that a
// release restarts every process: the phone process is restarted only when
// the voice release surface hash of the new release differs from the one it
// runs, when it is down, or when its /health fails. Otherwise a deploy leaves
// live calls alone.
//
// The phone process runs from the real release directory (its PM2 cwd), not
// the /opt/secondbrain link, so its lazily loaded files stay the ones it
// booted with. Release retention already protects any directory that is a
// live process's cwd.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const { scrubServiceEnv } = require('./service-env-scrub.js');

const PM2_INTERNAL_RE = /^(pm_|PM2_|axm_|unique_id$|NODE_APP_INSTANCE$|SB_SERVER_ROLE$|SB_PHONE_PORT$)/;

function runPm2(args, { env } = {}) {
  return execFileSync('pm2', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
}

function listApps(pm2 = runPm2) {
  try {
    return JSON.parse(pm2(['jlist']) || '[]');
  } catch {
    return [];
  }
}

function surfaceHash(rootDir) {
  const proof = require(path.join(rootDir, 'scripts/lib/voice-release-proof.js'));
  return proof.currentVoiceSurface({ rootDir }).hash;
}

function supportsRoles(releaseDir) {
  return fs.existsSync(path.join(releaseDir, 'scripts/lib/server-role.js'));
}

function probeHealth(port, { attempts = 15, delayMs = 2000, get = http.get } = {}) {
  return new Promise((resolve) => {
    let tries = 0;
    const once = () => {
      tries += 1;
      const req = get({ hostname: '127.0.0.1', port, path: '/health', timeout: 6000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => req.destroy());
    };
    const retry = () => (tries >= attempts ? resolve(false) : setTimeout(once, delayMs));
    once();
  });
}

// The phone process gets main's environment (its secrets and settings), minus
// PM2 bookkeeping and run-scoped deploy state, plus its role.
function phoneEnv(mainApp, { optLink, port }) {
  const source = (mainApp && mainApp.pm2_env && mainApp.pm2_env.env) || {};
  const env = {};
  for (const [key, value] of Object.entries(scrubServiceEnv(source))) {
    if (typeof value === 'string' && !PM2_INTERNAL_RE.test(key)) env[key] = value;
  }
  const base = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!PM2_INTERNAL_RE.test(key)) base[key] = value;
  }
  return { ...base, ...env, SECONDBRAIN_ROOT: optLink, SB_SERVER_ROLE: 'phone', SB_PHONE_PORT: String(port) };
}

async function ensurePhoneProcess({
  releaseDir,
  optLink = '/opt/secondbrain',
  app = 'secondbrain-phone',
  mainAppName = 'secondbrain-backend',
  port = 3002,
  pm2 = runPm2,
  hashOf = surfaceHash,
  probe = probeHealth,
}) {
  const release = path.resolve(releaseDir);
  if (!supportsRoles(release)) {
    // The target serves calls itself as the whole server, so a phone process
    // from a newer release must not stay up beside it on the phone port.
    const stopped = stopPhoneProcess({ app, pm2 }).action === 'stopped';
    return { action: 'unsupported', reason: 'release has no server roles', release, phone_stopped: stopped };
  }
  const apps = listApps(pm2);
  const phone = apps.find((a) => a.name === app);
  const mainApp = apps.find((a) => a.name === mainAppName);
  const target = hashOf(release);
  const runningDir = phone && phone.pm2_env && phone.pm2_env.pm_cwd;
  const online = phone && phone.pm2_env && phone.pm2_env.status === 'online';
  let reason = 'not running';
  if (online && runningDir && fs.existsSync(runningDir)) {
    let running = null;
    try {
      running = hashOf(runningDir);
    } catch {
      running = null;
    }
    if (running === target) {
      if (await probe(port)) return { action: 'kept', reason: 'voice surface unchanged', release: runningDir, hash: target };
      reason = 'health failed';
    } else {
      reason = 'voice surface changed';
    }
  }
  if (!mainApp) throw new Error(`cannot start ${app}: ${mainAppName} is not in PM2 to copy its environment from`);
  try {
    pm2(['delete', app]);
  } catch {
    /* not installed yet */
  }
  pm2(['start', path.join(release, 'server.js'), '--name', app, '--cwd', release], { env: phoneEnv(mainApp, { optLink, port }) });
  if (!(await probe(port))) throw new Error(`${app} on :${port} did not answer /health after start`);
  pm2(['save']);
  return { action: 'started', reason, release, hash: target };
}

function stopPhoneProcess({ app = 'secondbrain-phone', pm2 = runPm2 } = {}) {
  const phone = listApps(pm2).find((a) => a.name === app);
  if (!phone) return { action: 'absent' };
  pm2(['delete', app]);
  pm2(['save']);
  return { action: 'stopped' };
}

function argValue(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const run = argv[0] === 'stop'
    ? Promise.resolve(stopPhoneProcess({ app: argValue(argv, '--app') }))
    : ensurePhoneProcess({
      releaseDir: argValue(argv, '--release-dir'),
      optLink: argValue(argv, '--opt-link', '/opt/secondbrain'),
      app: argValue(argv, '--app', 'secondbrain-phone'),
      mainAppName: argValue(argv, '--main-app', 'secondbrain-backend'),
      port: Number(argValue(argv, '--port', '3002')),
    });
  run
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => {
      process.stderr.write(`[phone-process-release] ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { ensurePhoneProcess, phoneEnv, probeHealth, stopPhoneProcess, supportsRoles };
