#!/usr/bin/env node
// ec2-drift-alarm.js
//
// "Git is the law" enforcement for the EC2 backend. Detects when any live PM2
// runtime file on EC2 has DRIFTED from its git/master source -- i.e. someone
// hot-patched the box (edited a runtime file directly) instead of deploying
// from git. Read-only: SSH-reads each runtime file, compares to
// `git show origin/master:<gitpath>`, and reports divergence. Wire into the
// nightly health check / briefing System Health row so a hot-patch is caught
// the next morning instead of drifting silently for months.
//
// EC2 path -> git path mapping is authoritative from `pm2 jlist` (2026-06-16).
// NOTE the one special case: PM2 runs /opt/secondbrain/server.js, which is a
// deploy-time COPY of the repo's ec2-server.js (see reference_ec2_server_deploy_path.md).
//
// Usage:
//   node scripts/ec2-drift-alarm.js            # check live EC2 vs origin/master
//   node scripts/ec2-drift-alarm.js --json      # machine-readable report

const { execFileSync } = require('child_process');
const path = require('path');

const HOST = process.env.EC2_HOST || 'ec2-user@ExampleCo';
const KEY = process.env.EC2_KEY || path.join(require('os').homedir(), '.ssh', 'sb-key.pem');
const REPO = path.resolve(__dirname, '..');

// name = PM2 process; ec2 = live path on the box; git = source path in the repo.
const RUNTIME_MAP = [
  { name: 'secondbrain-backend', ec2: '/opt/secondbrain/server.js', git: 'ec2-server.js' },
  { name: 'yt-auth', ec2: '/opt/secondbrain/youtube-auth.js', git: 'youtube-auth.js' },
  {
    name: 'dispatch-processor',
    ec2: '/opt/secondbrain/scripts/process-dispatches.js',
    git: 'scripts/process-dispatches.js',
  },
  {
    name: 'otter-ingest',
    ec2: '/opt/secondbrain/scripts/otter-ingest-watch.js',
    git: 'scripts/otter-ingest-watch.js',
  },
  {
    name: 'ec2-spine-worker',
    ec2: '/opt/secondbrain/scripts/ec2-spine-worker.js',
    git: 'scripts/ec2-spine-worker.js',
  },
];

// Known, explained drift: file -> reason. These are reported as "known" (an
// outstanding reconcile), never as a fresh alarm. Keep in sync with the rescue
// manifest's knownDrift. Empty once the box is fully reconciled to git.
const KNOWN_DRIFT = {
  // 'scripts/process-dispatches.js': 'dispatch act-rung bypass hot-patch; reconcile pending (ec2-rescue-2026-06-15.json)',
};

// Normalize before comparing: LF endings, strip per-line trailing whitespace,
// collapse trailing blank lines. CRLF / trailing-ws differences are not drift.
function normalize(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '\n');
}

// Pure core. entries: [{ name, git, ec2, ec2Content, gitContent, known }].
// Returns { clean, drifted[], known[], matched[], missing[] }.
function computeDrift(entries) {
  const drifted = [];
  const matched = [];
  const known = [];
  const missing = [];
  for (const e of entries) {
    if (e.ec2Content == null || e.gitContent == null) {
      missing.push({ name: e.name, git: e.git, ec2: e.ec2 });
      continue;
    }
    if (normalize(e.ec2Content) === normalize(e.gitContent)) {
      matched.push(e.name);
      continue;
    }
    if (e.known) {
      known.push({ name: e.name, reason: e.known });
      continue;
    }
    drifted.push({ name: e.name, git: e.git, ec2: e.ec2 });
  }
  // Alarm only on UNEXPLAINED drift; known drift is an outstanding reconcile,
  // not a fresh hot-patch.
  return { clean: drifted.length === 0, drifted, known, matched, missing };
}

function sshRead(ec2Path) {
  try {
    return execFileSync(
      'ssh',
      [
        '-i',
        KEY,
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'ConnectTimeout=15',
        HOST,
        `cat "${ec2Path}"`,
      ],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return null;
  }
}

function gitRead(gitPath) {
  try {
    return execFileSync('git', ['show', `origin/master:${gitPath}`], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function check(map = RUNTIME_MAP) {
  const entries = map.map((m) => ({
    ...m,
    ec2Content: sshRead(m.ec2),
    gitContent: gitRead(m.git),
    known: KNOWN_DRIFT[m.git],
  }));
  return computeDrift(entries);
}

function main() {
  // Refresh origin/master so the comparison is against the true remote.
  try {
    execFileSync('git', ['fetch', 'origin', 'master'], {
      cwd: REPO,
      stdio: 'ignore',
      timeout: 30000,
    });
  } catch {
    /* offline: compare against the local origin/master ref */
  }
  const report = check();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.clean ? 0 : 1);
  }
  console.log('[ec2-drift-alarm] EC2 runtime vs origin/master');
  console.log(`  matched (git-as-law): ${report.matched.join(', ') || 'none'}`);
  if (report.known.length) {
    console.log('  KNOWN drift (reconcile pending):');
    report.known.forEach((k) => console.log(`    - ${k.name}: ${k.reason}`));
  }
  if (report.missing.length) {
    console.log('  COULD NOT READ (unreachable file/box):');
    report.missing.forEach((m) => console.log(`    - ${m.name} (${m.ec2})`));
  }
  if (report.drifted.length) {
    console.log('  *** UNEXPLAINED DRIFT (a hot-patch -- the box diverged from git) ***');
    report.drifted.forEach((d) => console.log(`    - ${d.name}: live ${d.ec2} != git ${d.git}`));
    console.log(
      '  Fix: deploy from git (do not hot-patch). For the server: bash scripts/deploy-ec2-server.sh',
    );
  } else {
    console.log('  CLEAN: no unexplained drift.');
  }
  process.exit(report.clean ? 0 : 1);
}

module.exports = { RUNTIME_MAP, KNOWN_DRIFT, normalize, computeDrift, check };

if (require.main === module) main();
