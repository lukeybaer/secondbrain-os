#!/usr/bin/env node
// health-self-heal.js
//
// Runs the same probes the daily briefing runs, and for every red item it
// attempts an inline self-heal, THEN reprobes. Logs every action to
// data/agent/health-heal.jsonl so the morning briefing can surface "fixed
// overnight by Amy" lines instead of red flags Luke has to notice himself.
//
// Scheduled at 4:00 AM CT via Windows Task Scheduler, between the 3 AM backup
// and the 5:30 AM briefing — wide enough window for a retry backup to finish.
//
// Exit codes:
//   0 — all green after heal pass
//   1 — still red after heal pass (briefing will surface it loudly)
//
// Usage:
//   node scripts/health-self-heal.js                     # run full pass
//   node scripts/health-self-heal.js --probe-only        # no remediation

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = 'C:/Users/luked/secondbrain';
const APPDATA = process.env.APPDATA || '';
const HEAL_LOG = path.join(REPO, 'data', 'agent', 'health-heal.jsonl');

const args = process.argv.slice(2);
const probeOnly = args.includes('--probe-only');

function log(entry) {
  try {
    fs.mkdirSync(path.dirname(HEAL_LOG), { recursive: true });
    fs.appendFileSync(HEAL_LOG, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('  log-write-failed:', e.message);
  }
}

function nowIso() {
  return new Date().toISOString();
}

// ── Probes (must match manual-briefing-v3.js getHealthChecks contract) ───────

function probeBackups() {
  try {
    const out = execSync(
      `aws s3api list-objects-v2 --bucket 672613094048-secondbrain-backups --prefix snapshots/2026 --region us-east-1 --query "reverse(sort_by(Contents, &LastModified))[:1].[Key,LastModified,Size]" --output text`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim();
    const [key, lastMod, size] = out.split('\t');
    const ageMs = Date.now() - new Date(lastMod).getTime();
    const ageHrs = Math.round(ageMs / 3600000);
    const sizeMb = Math.round(parseInt(size, 10) / 1024 / 1024);
    return {
      status: ageHrs <= 30 ? 'green' : 'red',
      detail: `last: ${key.split('/').pop()} (${ageHrs}h ago, ${sizeMb}MB)`,
      ageHrs,
    };
  } catch (e) {
    return { status: 'red', detail: 'S3 list failed: ' + e.message.slice(0, 80), ageHrs: null };
  }
}

// Checks whether any local snapshots are missing from S3 (parity gap).
// Returns yellow when orphans exist but the latest S3 snapshot is fresh --
// does not block the briefing, but triggers a retroactive sync.
function probeS3Parity() {
  try {
    const manifest = JSON.parse(
      require('fs').readFileSync(
        path.join(process.env.APPDATA, 'secondbrain', 'backups', 'manifest.json'),
        'utf8',
      ),
    );
    const s3Out = execSync(
      `aws s3 ls s3://672613094048-secondbrain-backups/snapshots/ --region us-east-1`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim();
    const s3Files = new Set(
      s3Out
        .split('\n')
        .filter(Boolean)
        .map((l) => l.trim().split(/\s+/).pop()),
    );
    const orphans = (manifest.snapshots || []).filter((s) => !s3Files.has(`${s.id}.zip`));
    if (orphans.length === 0)
      return { status: 'green', detail: 'all local snapshots on S3', orphans: [] };
    return {
      status: 'yellow',
      detail: `${orphans.length} local snapshot(s) missing from S3: ${orphans.map((s) => s.id).join(', ')}`,
      orphans,
    };
  } catch (e) {
    return {
      status: 'yellow',
      detail: 'parity check failed: ' + e.message.slice(0, 80),
      orphans: [],
    };
  }
}

function probeEc2() {
  try {
    const raw = execSync('curl -s -m 5 http://98.80.164.16:3001/health', {
      encoding: 'utf8',
      timeout: 8000,
    });
    const j = JSON.parse(raw);
    return {
      status: j.status === 'ok' ? 'green' : 'red',
      detail: `${j.status}, v${j.version || '?'}`,
      json: j,
    };
  } catch (e) {
    return { status: 'red', detail: 'curl failed: ' + e.message.slice(0, 80), json: null };
  }
}

function probeLlm() {
  const ec2 = probeEc2();
  if (!ec2.json) return { status: 'red', detail: 'EC2 unreachable' };
  const src = ec2.json.llm && ec2.json.llm.source;
  if (src && /claude-max-plan|FREE/.test(src)) {
    return { status: 'green', detail: src };
  }
  return { status: 'red', detail: `${src} — maxPlanProxy broken` };
}

// Pure log parser — exported so tests can drive it without touching disk.
// See memory/feedback_scheduled_task_dispatch_stuck.md for the incident.
function parseSchedDispatchLog(logText, nowMs) {
  const cutoffMs = nowMs - 24 * 60 * 60 * 1000;
  const lines = logText.split('\n');
  const stuckTasks = new Set();
  let tooLongCount = 0;
  for (const line of lines) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
    if (!m) continue;
    const ts = Date.parse(m[1].replace(' ', 'T') + 'Z');
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    if (line.includes('This conversation is too long to continue')) {
      tooLongCount += 1;
    }
    const skip = line.match(/Skipping dispatch for ([\w-]+): per_task_limit/);
    if (skip) stuckTasks.add(skip[1]);
  }
  if (stuckTasks.size === 0 && tooLongCount === 0) {
    return {
      status: 'green',
      detail: 'no stuck dispatches in last 24h',
      stuckTasks: [],
      tooLongCount: 0,
    };
  }
  const parts = [];
  if (stuckTasks.size > 0) parts.push(`stuck: ${[...stuckTasks].join(',')}`);
  if (tooLongCount > 0) parts.push(`context-too-long×${tooLongCount}`);
  return {
    status: 'red',
    detail: parts.join(' '),
    stuckTasks: [...stuckTasks],
    tooLongCount,
  };
}

// Scan Claude Code main.log for stuck-dispatch signatures.
function probeSchedDispatch() {
  const logPath = path.join(APPDATA, 'Claude', 'logs', 'main.log');
  if (!APPDATA || !fs.existsSync(logPath)) {
    return { status: 'red', detail: 'Claude main.log not found' };
  }
  let tail;
  try {
    const stat = fs.statSync(logPath);
    const readFrom = Math.max(0, stat.size - 2 * 1024 * 1024);
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(stat.size - readFrom);
    fs.readSync(fd, buf, 0, buf.length, readFrom);
    fs.closeSync(fd);
    tail = buf.toString('utf8');
  } catch (e) {
    return { status: 'red', detail: `main.log read failed: ${e.message}` };
  }
  return parseSchedDispatchLog(tail, Date.now());
}

module.exports = { parseSchedDispatchLog };

// ── Healers ──────────────────────────────────────────────────────────────────

function healBackup(probe) {
  console.log(`[heal] backup is red (${probe.detail}) — running backup-cli...`);
  const start = Date.now();
  try {
    execSync('npx ts-node scripts/backup-cli.ts', {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 30 * 60 * 1000, // 30 min
      stdio: 'pipe',
    });
    const durSec = Math.round((Date.now() - start) / 1000);
    console.log(`[heal] backup-cli succeeded in ${durSec}s`);
    return { healed: true, action: 'ran backup-cli', durSec };
  } catch (e) {
    const durSec = Math.round((Date.now() - start) / 1000);
    const stderr = (e.stderr || e.stdout || '').toString().slice(-800);
    console.error(`[heal] backup-cli failed in ${durSec}s: ${stderr}`);
    return { healed: false, action: 'ran backup-cli', durSec, error: stderr };
  }
}

function healLlm(probe) {
  // Max plan proxy — we can't restart it remotely from here, but log it loudly.
  // The fix is local: start-claude-proxy.vbs on Luke's machine. Leave a telegram
  // alert instead so Luke can nudge it with one click.
  return {
    healed: false,
    action: 'no-op (proxy tunnel local-only)',
    note: 'launch start-claude-proxy.vbs on Luke machine',
  };
}

function healSchedDispatch(probe) {
  // Stuck scheduled-task dispatch is caused by an overloaded host Claude Code
  // session. We cannot safely kill the session from inside a running Claude
  // Code process (risk of self-termination and scheduled-tasks.json races), so
  // we surface it loudly instead. Briefing picks this up as a red item with a
  // specific action: restart Claude Code app + re-subscribe notifySessionId.
  return {
    healed: false,
    action: 'no-op (host session restart required)',
    note: `restart Claude Code app — stuck tasks: ${(probe.stuckTasks || []).join(',') || 'none'}`,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const report = {
    ts: nowIso(),
    mode: probeOnly ? 'probe-only' : 'heal',
    before: {},
    heals: [],
    after: {},
    finalStatus: 'unknown',
  };

  console.log(`[${report.ts}] health-self-heal ${report.mode}`);

  report.before.backups = probeBackups();
  report.before.s3Parity = probeS3Parity();
  report.before.ec2 = probeEc2();
  report.before.llm = probeLlm();
  report.before.schedDispatch = probeSchedDispatch();

  console.log('before:');
  for (const [k, v] of Object.entries(report.before)) {
    console.log(`  ${k}: ${v.status} — ${v.detail}`);
  }

  if (!probeOnly) {
    if (report.before.backups.status === 'red') {
      report.heals.push({ target: 'backups', ...healBackup(report.before.backups) });
      report.after.backups = probeBackups();
    } else {
      report.after.backups = report.before.backups;
    }

    // Retroactively sync local snapshots missing from S3 (parity gap).
    // Runs even when backups probe is green -- a fresh local backup can coexist
    // with older orphaned snapshots that never uploaded (Apr 9-10 maxBuffer gap).
    if (
      report.before.s3Parity.status === 'yellow' &&
      (report.before.s3Parity.orphans || []).length > 0
    ) {
      console.log(`[heal] s3 parity gap — running --sync-orphaned...`);
      const start = Date.now();
      try {
        execSync('npx ts-node scripts/backup-cli.ts --sync-orphaned', {
          cwd: REPO,
          encoding: 'utf8',
          timeout: 120 * 60 * 1000, // 2 hours for large archives
          stdio: 'pipe',
        });
        const durSec = Math.round((Date.now() - start) / 1000);
        console.log(`[heal] --sync-orphaned completed in ${durSec}s`);
        report.heals.push({
          target: 's3Parity',
          healed: true,
          action: 'ran --sync-orphaned',
          durSec,
        });
      } catch (e) {
        const durSec = Math.round((Date.now() - start) / 1000);
        const stderr = (e.stderr || e.stdout || '').toString().slice(-400);
        console.error(`[heal] --sync-orphaned failed in ${durSec}s: ${stderr}`);
        report.heals.push({
          target: 's3Parity',
          healed: false,
          action: 'ran --sync-orphaned',
          durSec,
          error: stderr,
        });
      }
      report.after.s3Parity = probeS3Parity();
    } else {
      report.after.s3Parity = report.before.s3Parity;
    }

    if (report.before.llm.status === 'red') {
      report.heals.push({ target: 'llm', ...healLlm(report.before.llm) });
      report.after.llm = probeLlm();
    } else {
      report.after.llm = report.before.llm;
    }

    if (report.before.schedDispatch.status === 'red') {
      report.heals.push({
        target: 'schedDispatch',
        ...healSchedDispatch(report.before.schedDispatch),
      });
      report.after.schedDispatch = probeSchedDispatch();
    } else {
      report.after.schedDispatch = report.before.schedDispatch;
    }

    // EC2 self-heal is handled by a separate remote PM2 script; we just re-probe.
    report.after.ec2 = probeEc2();

    console.log('after:');
    for (const [k, v] of Object.entries(report.after)) {
      console.log(`  ${k}: ${v.status} — ${v.detail}`);
    }
  } else {
    report.after = report.before;
  }

  const allGreen = Object.values(report.after).every((v) => v.status === 'green');
  report.finalStatus = allGreen ? 'green' : 'red';

  log(report);
  console.log(`final: ${report.finalStatus} (logged to ${HEAL_LOG})`);
  process.exit(allGreen ? 0 : 1);
}

if (require.main === module) {
  main();
}
