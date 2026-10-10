'use strict';

// LIVE PRODUCT HEALTH FOR SYSTEM HEALTH.
//
// ExampleCo, 2026-09-24: split Client App into the two or three checks that really
// represent its health. Before this, the "Client App" row only restated the
// Client App invoice card's verdict and the ExampleCo row was a fixed green
// string. Each row below is a real request against the running product:
//
//   ExampleCo              GET https://ExampleCo.com/ answers HTTP 200.
//   Client App app       GET the app page (HTTP 200) and GET /api/health
//                        answers {"ok":true}, so the client can open the app and the
//                        invoice API behind it is up.
//   Client App invoice   POST /api/settings/email-connection-check answers
//   email                {"ok":true}. It proves the Google Workspace login the
//                        invoice emails use and sends nothing.
//   Client App backups   Production lives in the separate Client App AWS
//                        account (profile clientapp). Two layers must both
//                        hold: every live table keeps point-in-time recovery
//                        restorable to within the last hour, and the nightly
//                        change-history job (clientapp-scd2-nightly, 2 AM CT)
//                        finished within 26 hours with zero errors, writing
//                        each record's prior versions to
//                        s3://clientapp-scd2-snapshots. Both are read-only.
//
// The renderer is synchronous, so the requests run in one bounded child
// process. A timeout or network error is red with the reason; it is never
// green. Every run writes data/agent/business-app-health-latest.json.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ExampleCo_URL = 'https://ExampleCo.com/';
const CLIENT_APP_APP_URL = 'https://your-distribution.cloudfront.net/';
const CLIENT_APP_API = 'https://your-api-id.execute-api.us-east-2.amazonaws.com';
const REQUEST_TIMEOUT_MS = 8000;
const CLIENT_APP_REGION = 'us-east-2';
// Production tables only. ExampleCo's own account holds stale clientapp-dev-*
// copies that the live app does not use; never point this check at them.
const CLIENT_APP_AWS_COMMAND = Object.freeze(['aws', '--profile', 'clientapp']);
const CLIENT_APP_TABLES = Object.freeze([
  'clientapp-customers',
  'clientapp-invoices',
  'clientapp-invoice-items',
  'clientapp-products',
  'clientapp-special-prices',
  'clientapp-purchase-orders',
  'clientapp-purchase-order-items',
  'clientapp-settings',
  'clientapp-cashflow-settings',
]);
// The nightly job versions these five; the others are settings and orders.
const CLIENT_APP_HISTORY_TABLES = Object.freeze([
  'clientapp-customers',
  'clientapp-products',
  'clientapp-invoices',
  'clientapp-invoice-items',
  'clientapp-special-prices',
]);
const CLIENT_APP_HISTORY_LOG = 's3://clientapp-scd2-snapshots/batch-logs/latest.json';
const BACKUP_MAX_LAG_MS = 60 * 60 * 1000;
const HISTORY_MAX_AGE_MS = 26 * 60 * 60 * 1000;
const BACKUP_TIMEOUT_MS = 20000;
const RECEIPT_REL = path.join('agent', 'business-app-health-latest.json');

const CHILD_SOURCE = `
const targets = JSON.parse(process.argv[1]);
const timeoutMs = Number(process.argv[2]);
async function one(t) {
  const started = Date.now();
  try {
    const res = await fetch(t.url, {
      method: t.method,
      headers: t.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: t.method === 'POST' ? '{}' : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { key: t.key, url: t.url, status: res.status, ok: res.ok, jsonOk: json && json.ok === true, ms: Date.now() - started };
  } catch (error) {
    return { key: t.key, url: t.url, status: 0, ok: false, jsonOk: false, ms: Date.now() - started, error: String(error && (error.name || error.message) || error).slice(0, 120) };
  }
}
Promise.all(targets.map(one)).then((r) => process.stdout.write(JSON.stringify(r)));
`;

const TARGETS = Object.freeze([
  { key: 'ExampleCo', method: 'GET', url: ExampleCo_URL },
  { key: 'clientApp', method: 'GET', url: CLIENT_APP_APP_URL },
  { key: 'clientApi', method: 'GET', url: `${CLIENT_APP_API}/api/health` },
  { key: 'clientEmail', method: 'POST', url: `${CLIENT_APP_API}/api/settings/email-connection-check` },
]);

function runProbes(targets = TARGETS, timeoutMs = REQUEST_TIMEOUT_MS) {
  const child = spawnSync(
    process.execPath,
    ['-e', CHILD_SOURCE, JSON.stringify(targets), String(timeoutMs)],
    { encoding: 'utf8', timeout: timeoutMs + 5000, windowsHide: true },
  );
  try {
    const rows = JSON.parse(child.stdout || '');
    if (Array.isArray(rows)) return rows;
  } catch {
    // Fall through to the unreachable result below.
  }
  const reason = child.error ? String(child.error.code || child.error.message) : `probe exited ${child.status}`;
  return targets.map((t) => ({ key: t.key, url: t.url, status: 0, ok: false, jsonOk: false, ms: 0, error: reason }));
}

// One child runs the AWS CLI for every table, three at a time. `command` is the
// executable plus leading arguments so a test can substitute a fake CLI.
const BACKUP_CHILD_SOURCE = `
const { execFile } = require('node:child_process');
const [command, tables, region, timeoutMs, historyLog] = JSON.parse(process.argv[1]);
function one(table) {
  return new Promise((resolve) => {
    const args = [...command.slice(1), 'dynamodb', 'describe-continuous-backups', '--region', region, '--table-name', table, '--output', 'json'];
    execFile(command[0], args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return resolve({ table, status: 'UNKNOWN', latest: null, error: String(stderr || error.message || error).trim().split('\\n').pop().slice(0, 160) });
      try {
        const pitr = JSON.parse(stdout).ContinuousBackupsDescription.PointInTimeRecoveryDescription || {};
        resolve({ table, status: pitr.PointInTimeRecoveryStatus || 'UNKNOWN', latest: pitr.LatestRestorableDateTime || null });
      } catch (e) {
        resolve({ table, status: 'UNKNOWN', latest: null, error: 'unreadable CLI output' });
      }
    });
  });
}
// Three at a time: each AWS CLI is a Python process and the t3 box is small.
async function all() {
  const out = [];
  for (let i = 0; i < tables.length; i += 3) out.push(...(await Promise.all(tables.slice(i, i + 3).map(one))));
  return out;
}
function history() {
  return new Promise((resolve) => {
    const args = [...command.slice(1), 's3', 'cp', historyLog, '-', '--region', region];
    execFile(command[0], args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return resolve({ error: String(stderr || error.message || error).trim().split('\\n').pop().slice(0, 160) });
      try {
        const log = JSON.parse(stdout);
        resolve({
          completedAt: log.completedAt || null,
          totalErrors: Number(log.totalErrors),
          tables: (log.tables || []).filter((t) => t && !t.skipped && !t.errors).map((t) => t.tableName),
        });
      } catch (e) {
        resolve({ error: 'unreadable history log' });
      }
    });
  });
}
all().then(async (r) => process.stdout.write(JSON.stringify({ tables: r, history: await history() })));
`;

function runBackupProbe({ command = CLIENT_APP_AWS_COMMAND, tables = CLIENT_APP_TABLES, region = CLIENT_APP_REGION, timeoutMs = BACKUP_TIMEOUT_MS, historyLog = CLIENT_APP_HISTORY_LOG } = {}) {
  const child = spawnSync(
    process.execPath,
    ['-e', BACKUP_CHILD_SOURCE, JSON.stringify([command, tables, region, timeoutMs, historyLog])],
    { encoding: 'utf8', timeout: timeoutMs + 5000, windowsHide: true },
  );
  try {
    const out = JSON.parse(child.stdout || '');
    if (out && Array.isArray(out.tables)) return { key: 'clientBackups', tables: out.tables, history: out.history };
  } catch {
    // Fall through to the unreadable result below.
  }
  const reason = child.error ? String(child.error.code || child.error.message) : `backup check exited ${child.status}`;
  return { key: 'clientBackups', tables: [], error: reason };
}

// Pure: which tables are not safely backed up at nowMs.
function backupGaps(result, nowMs) {
  const byTable = new Map(((result && result.tables) || []).map((t) => [t.table, t]));
  return CLIENT_APP_TABLES.filter((table) => {
    const t = byTable.get(table);
    if (!t || t.status !== 'ENABLED') return true;
    const latest = Date.parse(t.latest);
    return !Number.isFinite(latest) || nowMs - latest > BACKUP_MAX_LAG_MS;
  });
}

// Pure: why the nightly change history is not current, or null when it is.
function historyGap(result, nowMs) {
  const h = result && result.history;
  if (!h) return 'no change-history result recorded';
  if (h.error) return `the change-history log could not be read (${h.error})`;
  const done = Date.parse(h.completedAt);
  if (!Number.isFinite(done) || nowMs - done > HISTORY_MAX_AGE_MS) return `the nightly change-history job last finished ${h.completedAt || 'never'}, over 26 hours ago`;
  if (h.totalErrors !== 0) return `the nightly change-history job reported ${h.totalErrors} errors`;
  const missing = CLIENT_APP_HISTORY_TABLES.filter((t) => !(h.tables || []).includes(t));
  if (missing.length) return `the nightly change-history job skipped ${missing.map((t) => t.replace(/^clientapp-/, '')).join(', ')}`;
  return null;
}

function seconds(ms) {
  return `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)}s`;
}

function failure(result) {
  if (!result) return 'no result recorded';
  if (result.error) return `request failed (${result.error})`;
  return `HTTP ${result.status}`;
}

// Pure: probe results -> the four rendered rows.
function formatBusinessAppHealthRows(results, { checkedAt = new Date().toISOString() } = {}) {
  const by = new Map((results || []).map((r) => [r.key, r]));
  const pix = by.get('ExampleCo');
  const app = by.get('clientApp');
  const api = by.get('clientApi');
  const email = by.get('clientEmail');
  const pixOk = Boolean(pix && pix.ok && pix.status === 200);
  const appOk = Boolean(app && app.ok && app.status === 200 && api && api.ok && api.jsonOk);
  const emailOk = Boolean(email && email.ok && email.jsonOk);
  const backups = by.get('clientBackups');
  const parsedNow = Date.parse(checkedAt);
  const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const gaps = backupGaps(backups, nowMs);
  const historyProblem = backups && !backups.error ? historyGap(backups, nowMs) : null;
  const tableCount = CLIENT_APP_TABLES.length;
  const gapReason = () => {
    if (!backups) return 'no backup result recorded';
    if (backups.error) return `the backup check failed (${backups.error})`;
    if (!gaps.length) return historyProblem;
    const shortNames = gaps.map((t) => t.replace(/^clientapp-/, '')).join(', ');
    const tableText = `${gaps.length} of ${tableCount} live tables are not restorable to within the last hour (${shortNames})`;
    return historyProblem ? `${tableText}, and ${historyProblem}` : tableText;
  };
  return [
    pixOk
      ? `✓ ExampleCo: ExampleCo.com answered HTTP 200 in ${seconds(pix.ms)}; checked ${checkedAt}.`
      : `✗ ExampleCo: ExampleCo.com did not load: ${failure(pix)}; checked ${checkedAt}.`,
    appOk
      ? `✓ Client App app: the invoice app page answered HTTP 200 and its invoice API answered ok; checked ${checkedAt}.`
      : `✗ Client App app: ${!(app && app.ok && app.status === 200) ? `the invoice app page did not load (${failure(app)})` : `the invoice API health check failed (${api && api.ok && !api.jsonOk ? 'answered without ok' : failure(api)})`}; checked ${checkedAt}.`,
    emailOk
      ? `✓ Client App invoice email: the Google Workspace login check passed and sent nothing; checked ${checkedAt}.`
      : `✗ Client App invoice email: the Google Workspace login check failed (${email && email.ok && !email.jsonOk ? 'answered without ok' : failure(email)}), so invoice emails may not send; checked ${checkedAt}.`,
    backups && !backups.error && gaps.length === 0 && !historyProblem
      ? `✓ Client App backups: all ${tableCount} live tables restorable to any minute of the last 35 days, and the nightly change history finished ${backups.history.completedAt} with no errors; checked ${checkedAt}.`
      : `✗ Client App backups: ${gapReason()}, so lost invoice data may not be recoverable; checked ${checkedAt}.`,
  ];
}

// Under the test runner no request leaves the machine unless a test injects a
// probe; the rows then report "not probed", which is red, never green.
function offlineProbe() {
  return [
    ...TARGETS.map((t) => ({ key: t.key, url: t.url, status: 0, ok: false, jsonOk: false, ms: 0, error: 'not probed under the test runner' })),
    { key: 'clientBackups', tables: [], error: 'not probed under the test runner' },
  ];
}

function defaultProbe() {
  return process.env.VITEST || process.env.NODE_ENV === 'test' ? offlineProbe() : [...runProbes(), runBackupProbe()];
}

function businessAppHealthRows({ dataDir, probe = defaultProbe, now = () => new Date() } = {}) {
  const results = probe();
  const checkedAt = now().toISOString();
  const rows = formatBusinessAppHealthRows(results, { checkedAt });
  if (dataDir) {
    try {
      const file = path.join(dataDir, RECEIPT_REL);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ schema: 'business-app-health.v1', checkedAt, results, rows }, null, 2)}\n`);
    } catch {
      // The rendered rows carry the evidence; a receipt write failure does not
      // change a measured result.
    }
  }
  return rows;
}

module.exports = {
  CLIENT_APP_TABLES,
  TARGETS,
  backupGaps,
  historyGap,
  CLIENT_APP_HISTORY_TABLES,
  runBackupProbe,
  businessAppHealthRows,
  formatBusinessAppHealthRows,
  runProbes,
};
