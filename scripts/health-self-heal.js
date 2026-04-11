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

// ── Main ─────────────────────────────────────────────────────────────────────

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
report.before.ec2 = probeEc2();
report.before.llm = probeLlm();

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

  if (report.before.llm.status === 'red') {
    report.heals.push({ target: 'llm', ...healLlm(report.before.llm) });
    report.after.llm = probeLlm();
  } else {
    report.after.llm = report.before.llm;
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
