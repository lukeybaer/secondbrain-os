'use strict';

// LIVE PRODUCT HEALTH FOR SYSTEM HEALTH.
//
// Owner decision: split Client App into the two or three checks that really
// represent its health. Before this, the "Client App" row only restated the
// Client App invoice card's verdict and the ExampleCo row was a fixed green
// string. Each row below is a real request against the running product:
//
//   ExampleCo              GET https://example.com/ answers HTTP 200.
//   Client App app       GET the app page (HTTP 200) and GET /api/health
//                        answers {"ok":true}, so the client can open the app and the
//                        invoice API behind it is up.
//   Client App invoice   POST /api/settings/email-connection-check answers
//   email                {"ok":true}. It proves the Google Workspace login the
//                        invoice emails use and sends nothing. Since the
//                        2026-10-23 lockdown (The owner, recorder C2) the API needs a
//                        Bearer token: the probe signs in once per run with the
//                        app password from ~/.secrets and never writes it out.
//   Client App backups   Production lives in the separate Client App AWS
//                        account (profile clientapp). Three layers must all
//                        hold: every live table keeps point-in-time recovery
//                        restorable to within the last hour; the nightly
//                        change-history job (clientapp-scd2-nightly, 2 AM CT)
//                        finished within 26 hours with zero errors, writing
//                        each record's prior versions to
//                        s3://clientapp-scd2-snapshots; and the nightly copy
//                        of all nine tables into Amy's account
//                        (scripts/client-app-offsite-backup.js, the owner
//                        2026-10-24) finished within 26 hours with zero
//                        errors. All three are read-only.
//
// The renderer is synchronous, so the requests run in one bounded child
// process. A timeout or network error is red with the reason; it is never
// green. Every run writes data/agent/business-app-health-latest.json.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ExampleCo_URL = 'https://example.com/';
const CLIENT_APP_APP_URL = 'https://your-distribution.cloudfront.net/';
const CLIENT_APP_API = 'https://your-api-id.execute-api.us-east-2.amazonaws.com';
// Lockdown 2026-10-23: every route except /api/health and /api/auth/login needs
// a token. Sign in once per run; the password comes from the env or the
// per-secret file (same convention as northwest_ra_password.txt) and is never
// written to the receipt or a log.
const CLIENT_APP_LOGIN_URL = `${CLIENT_APP_API}/api/auth/login`;
const CLIENT_APP_USERNAME = process.env.CLIENT_APP_USERNAME || 'client';
const CLIENT_APP_PASSWORD_FILE = path.join(os.homedir(), '.secrets', 'clientapp_app_password.txt');
const REQUEST_TIMEOUT_MS = 8000;
const CLIENT_APP_REGION = 'us-east-2';
// Production tables only. The owner's own account holds stale clientapp-dev-*
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
// The separate copy lives in Amy's account and is read with EC2's own role.
const CLIENT_APP_OFFSITE_BUCKET = 'ExampleCo-clientapp-backups';
const CLIENT_APP_OFFSITE_REGION = 'us-east-1';
const CLIENT_APP_OFFSITE_LOG = `s3://${CLIENT_APP_OFFSITE_BUCKET}/latest.json`;
// Client App production's account: the copy must have been read from it.
const CLIENT_APP_ACCOUNT = '1555000000029';
// About five of each tier (The owner); set by
// scripts/infra/apply-client-app-offsite-backup.sh and checked here for drift.
const CLIENT_APP_OFFSITE_RETENTION = Object.freeze([
  { id: 'keep-5-daily', prefix: 'daily/', days: 5 },
  { id: 'keep-5-weekly', prefix: 'weekly/', days: 35 },
  { id: 'keep-5-monthly', prefix: 'monthly/', days: 155 },
  { id: 'keep-5-yearly', prefix: 'yearly/', days: 1830 },
]);
const BACKUP_MAX_LAG_MS = 60 * 60 * 1000;
const HISTORY_MAX_AGE_MS = 26 * 60 * 60 * 1000;
const BACKUP_TIMEOUT_MS = 20000;
const RECEIPT_REL = path.join('agent', 'business-app-health-latest.json');

const CHILD_SOURCE = `
const targets = JSON.parse(process.argv[1]);
const timeoutMs = Number(process.argv[2]);
// Credentials arrive on stdin, never on the command line (argv is readable by every local process).
let auth = null;
try { const raw = require('node:fs').readFileSync(0, 'utf8').trim(); auth = raw ? JSON.parse(raw) : null; } catch { auth = null; }
const NO_PASSWORD = 'no app password: set CLIENT_APP_APP_PASSWORD or ~/.secrets/clientapp_app_password.txt';
function fail(msg) { const e = new Error(msg); e.probeReason = msg; return e; }
let tokenPromise = null;
// One sign-in per run, shared by every target that needs it.
function token() {
  if (!tokenPromise) {
    tokenPromise = (async () => {
      if (!auth || !auth.password) throw fail(NO_PASSWORD);
      const res = await fetch(auth.loginUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: auth.username, password: auth.password }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw fail('login HTTP ' + res.status);
      const body = await res.json().catch(() => null);
      if (!body || !body.token) throw fail('login answered without a token');
      return body.token;
    })();
  }
  return tokenPromise;
}
async function one(t) {
  const started = Date.now();
  try {
    const headers = t.method === 'POST' ? { 'content-type': 'application/json' } : {};
    if (t.auth) headers.authorization = 'Bearer ' + (await token());
    const res = await fetch(t.url, {
      method: t.method,
      headers,
      body: t.method === 'POST' ? '{}' : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { key: t.key, url: t.url, status: res.status, ok: res.ok, jsonOk: json && json.ok === true, ms: Date.now() - started };
  } catch (error) {
    return { key: t.key, url: t.url, status: 0, ok: false, jsonOk: false, ms: Date.now() - started, error: String(error && (error.probeReason || error.name || error.message) || error).slice(0, 120) };
  }
}
Promise.all(targets.map(one)).then((r) => process.stdout.write(JSON.stringify(r)));
`;

const TARGETS = Object.freeze([
  { key: 'ExampleCo', method: 'GET', url: ExampleCo_URL },
  { key: 'clientApp', method: 'GET', url: CLIENT_APP_APP_URL },
  { key: 'clientApi', method: 'GET', url: `${CLIENT_APP_API}/api/health` },
  { key: 'clientEmail', method: 'POST', url: `${CLIENT_APP_API}/api/settings/email-connection-check`, auth: 'clientapp' },
]);

// The app password: env first, then the per-secret file. Null when absent; the
// authenticated row then goes red with that reason instead of probing blind.
function readClientAppPassword({ env = process.env, file = CLIENT_APP_PASSWORD_FILE } = {}) {
  const fromEnv = String(env.CLIENT_APP_APP_PASSWORD || '').trim();
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function defaultAuth() {
  return { loginUrl: CLIENT_APP_LOGIN_URL, username: CLIENT_APP_USERNAME, password: readClientAppPassword() };
}

// The child signs in and then calls the authenticated route in sequence, each
// under its own request budget, so the parent must wait for two budgets plus
// process start-up. A shorter parent deadline turned every slow but valid
// response into a red probe (review fc5b9a2b458a, finding 8).
const PROBE_OVERHEAD_MS = 5000;
function probeBudgetMs(timeoutMs = REQUEST_TIMEOUT_MS) {
  return timeoutMs * 2 + PROBE_OVERHEAD_MS;
}

function runProbes(targets = TARGETS, timeoutMs = REQUEST_TIMEOUT_MS, auth = defaultAuth()) {
  const child = spawnSync(
    process.execPath,
    ['-e', CHILD_SOURCE, JSON.stringify(targets), String(timeoutMs)],
    { encoding: 'utf8', input: JSON.stringify(auth ?? null), timeout: probeBudgetMs(timeoutMs), windowsHide: true },
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
const [command, tables, region, timeoutMs, historyLog, offsiteCommand, offsiteLog, offsiteRegion] = JSON.parse(process.argv[1]);
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
// The off-account copy is read with the caller's own credentials, not the
// Client App profile. Its manifest is not taken on trust: every table file it
// lists is downloaded (about 1.5 MB in all, 2026-10-24) and must match the
// SHA-256 the manifest recorded.
function offsiteCli(args, encoding = 'utf8') {
  return new Promise((resolve) => {
    execFile(offsiteCommand[0], [...offsiteCommand.slice(1), ...args, '--region', offsiteRegion], { timeout: timeoutMs, windowsHide: true, encoding, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve(error ? { error: String(stderr || error.message || error).trim().split('\\n').pop().slice(0, 160) } : { stdout });
    });
  });
}
async function offsite() {
  const got = await offsiteCli(['s3', 'cp', offsiteLog, '-']);
  if (got.error) return { error: got.error };
  let log;
  try {
    log = JSON.parse(got.stdout);
  } catch (e) {
    return { error: 'unreadable off-account copy log' };
  }
  const listed = (log.tables || []).filter((t) => t && t.table);
  const bucket = offsiteLog.slice('s3://'.length).split('/')[0];
  // The retention rules themselves, so a lifecycle edit cannot silently start
  // expiring snapshots early (or stop expiring them).
  const lifecycle = offsiteCli(['s3api', 'get-bucket-lifecycle-configuration', '--bucket', bucket, '--output', 'json']).then((r) => {
    if (r.error) return null;
    try {
      return (JSON.parse(r.stdout).Rules || []).map((x) => ({ id: x.ID, status: x.Status, prefix: x.Filter && x.Filter.Prefix, days: x.Expiration && x.Expiration.Days }));
    } catch (e) {
      return null;
    }
  });
  // One table file, three at a time: its snapshot only when it matches the
  // manifest's SHA-256 and its own item count; otherwise null.
  async function verifiedFiles(entries) {
    const out = {};
    for (let i = 0; i < entries.length; i += 3) {
      await Promise.all(entries.slice(i, i + 3).map(async (t) => {
        const file = await offsiteCli(['s3', 'cp', 's3://' + bucket + '/' + t.key, '-'], 'buffer');
        out[t.table] = null;
        if (file.error || require('node:crypto').createHash('sha256').update(file.stdout).digest('hex') !== t.sha256) return;
        try {
          const snap = JSON.parse(require('node:zlib').gunzipSync(file.stdout));
          if (Array.isArray(snap.items) && snap.items.length === snap.count) out[t.table] = snap;
        } catch (e) {
          // Unreadable: stays null.
        }
      }));
    }
    return out;
  }
  // The newest earlier clean night, for the records-not-shrinking check (at
  // most two earlier manifests are tried). Its counts also come from its
  // verified files, never from the manifest alone.
  const priorManifest = offsiteCli(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', 'daily/', '--delimiter', '/', '--query', 'CommonPrefixes[].Prefix', '--output', 'json']).then(async (r) => {
    if (r.error) return null;
    let dates;
    try {
      dates = (JSON.parse(r.stdout) || []).map((p) => p.slice('daily/'.length, -1)).filter((d) => d < String(log.date)).sort().reverse().slice(0, 2);
    } catch (e) {
      return null;
    }
    for (const date of dates) {
      const m = await offsiteCli(['s3', 'cp', 's3://' + bucket + '/daily/' + date + '/manifest.json', '-']);
      try {
        const prior = JSON.parse(m.stdout);
        if (!m.error && Array.isArray(prior.errors) && prior.errors.length === 0) return { date, tables: (prior.tables || []).filter((t) => t && t.table) };
      } catch (e) {
        // Try the next earlier night.
      }
    }
    return null;
  });
  const current = await verifiedFiles(listed);
  const prior = await priorManifest;
  const priorFiles = prior ? await verifiedFiles(prior.tables) : {};
  const countsOf = (files) => Object.fromEntries(Object.entries(files).filter(([, s]) => s).map(([table, s]) => [table, s.items.length]));
  return {
    date: log.date || null,
    completedAt: log.completedAt || null,
    totalErrors: Array.isArray(log.errors) ? log.errors.length : NaN,
    sourceAccount: log.sourceAccount || null,
    tables: listed.map((t) => t.table),
    counts: countsOf(current),
    badFiles: listed.map((t) => t.table).filter((t) => !current[t]),
    // Deletion protection as the night's verified file recorded it.
    deletionProtection: Object.fromEntries(Object.entries(current).filter(([, s]) => s).map(([table, s]) => [table, Boolean(s.definition && s.definition.DeletionProtectionEnabled === true)])),
    lifecycle: await lifecycle,
    previous: prior ? { date: prior.date, counts: countsOf(priorFiles) } : null,
  };
}
// Versioning on the change-history bucket keeps every overwritten or deleted
// snapshot file recoverable.
function versioning() {
  return new Promise((resolve) => {
    const bucket = historyLog.slice('s3://'.length).split('/')[0];
    const args = [...command.slice(1), 's3api', 'get-bucket-versioning', '--bucket', bucket, '--region', region, '--output', 'json'];
    execFile(command[0], args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return resolve({ error: String(stderr || error.message || error).trim().split('\\n').pop().slice(0, 160) });
      try {
        resolve({ status: JSON.parse(stdout || '{}').Status || 'never enabled' });
      } catch (e) {
        resolve({ error: 'unreadable versioning status' });
      }
    });
  });
}
// The PITR checks and the off-account copy run side by side, each at most
// three CLI processes at once.
Promise.all([all().then(async (r) => [r, ...(await Promise.all([history(), versioning()]))]), offsite()]).then(([[r, h, v], o]) => {
  process.stdout.write(JSON.stringify({ tables: r, history: h, versioning: v, offsite: o }));
});
`;

function runBackupProbe({ command = CLIENT_APP_AWS_COMMAND, tables = CLIENT_APP_TABLES, region = CLIENT_APP_REGION, timeoutMs = BACKUP_TIMEOUT_MS, historyLog = CLIENT_APP_HISTORY_LOG, offsiteCommand = ['aws'], offsiteLog = CLIENT_APP_OFFSITE_LOG } = {}) {
  const child = spawnSync(
    process.execPath,
    ['-e', BACKUP_CHILD_SOURCE, JSON.stringify([command, tables, region, timeoutMs, historyLog, offsiteCommand, offsiteLog, CLIENT_APP_OFFSITE_REGION])],
    // Longest chain is eight CLI steps (the copy's log, three download
    // batches, the earlier-night manifests, three baseline download batches),
    // each bounded by timeoutMs. Normally the whole check takes a few seconds.
    { encoding: 'utf8', timeout: 8 * timeoutMs + 5000, windowsHide: true },
  );
  try {
    const out = JSON.parse(child.stdout || '');
    if (out && Array.isArray(out.tables)) return { key: 'clientBackups', tables: out.tables, history: out.history, versioning: out.versioning, offsite: out.offsite };
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

// Pure: why the nightly copy into Amy's account is not current, or null.
function offsiteGap(result, nowMs) {
  const o = result && result.offsite;
  if (!o) return "no result recorded for the copy in Amy's account";
  if (o.error) return `the copy in Amy's account could not be read (${o.error})`;
  const done = Date.parse(o.completedAt);
  if (!Number.isFinite(done) || nowMs - done > HISTORY_MAX_AGE_MS) return `the nightly copy to Amy's account last finished ${o.completedAt || 'never'}, over 26 hours ago`;
  if (done - nowMs > 10 * 60 * 1000) return `the nightly copy to Amy's account claims a future finish time ${o.completedAt}`;
  if (o.totalErrors !== 0) return `the nightly copy to Amy's account reported ${o.totalErrors} errors`;
  const missing = CLIENT_APP_TABLES.filter((t) => !(o.tables || []).includes(t));
  if (missing.length) return `the nightly copy to Amy's account skipped ${missing.map((t) => t.replace(/^clientapp-/, '')).join(', ')}`;
  if (o.sourceAccount !== CLIENT_APP_ACCOUNT) return `the copy in Amy's account was read from account ${o.sourceAccount || 'unknown'}, not Client App's ${CLIENT_APP_ACCOUNT}`;
  if (!Array.isArray(o.badFiles)) return "the copy in Amy's account was not checked against its files";
  if (o.badFiles.length) return `the copy in Amy's account is missing or fails its checksum for ${o.badFiles.map((t) => t.replace(/^clientapp-/, '')).join(', ')}`;
  const rules = new Map((o.lifecycle || []).map((r) => [r.id, r]));
  const drifted = CLIENT_APP_OFFSITE_RETENTION.filter((want) => {
    const got = rules.get(want.id);
    return !got || got.status !== 'Enabled' || got.prefix !== want.prefix || got.days !== want.days;
  });
  if (!o.lifecycle || drifted.length || rules.size !== CLIENT_APP_OFFSITE_RETENTION.length) {
    return `the keep-five retention rules on Amy's backup bucket ${o.lifecycle ? `changed (${drifted.map((r) => r.id).join(', ') || 'extra rules'})` : 'could not be read'}`;
  }
  return null;
}

// owner decision: the two daily alarms beside the backup row. Both read the
// nightly copy in Amy's account, so each needs one that passes every
// backups-row check (account, all tables, checksums) and has a real date.
function freshCopyGap(result, nowMs) {
  const problem = offsiteGap(result, nowMs);
  if (problem) return `can't check because ${problem}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(result.offsite.date || ''))) return "can't check because the nightly copy in Amy's account has no date";
  return null;
}

// Pure: tables that lost more than 10 records and more than 2% since the
// previous clean night, so the client deleting a few stays green and a wipe is red.
// A table that had records and is now empty is always red, however small.
function shrinkGap(result, nowMs) {
  if (!result || result.error) return `the backup check failed (${(result && result.error) || 'no result recorded'})`;
  const o = result.offsite;
  const stale = freshCopyGap(result, nowMs);
  if (stale) return stale;
  if (!o.previous) return 'there is no earlier clean nightly copy to compare against yet';
  const shrunk = [];
  for (const table of CLIENT_APP_TABLES) {
    const now = o.counts && o.counts[table];
    const before = o.previous.counts && o.previous.counts[table];
    const name = table.replace(/^clientapp-/, '');
    if (!Number.isFinite(now) || !Number.isFinite(before)) shrunk.push(`${name} (count missing)`);
    else if ((before > 0 && now === 0) || before - now > Math.max(10, 0.02 * before)) shrunk.push(`${name} ${before} to ${now}`);
  }
  return shrunk.length ? `records dropped since ${o.previous.date}: ${shrunk.join(', ')}` : null;
}

// Pure: delete safeguards that are off. Every table has deletion protection
// (as last night's verified copy recorded it) and the change-history bucket
// keeps old versions.
function safeguardGap(result, nowMs) {
  if (!result || result.error) return `the backup check failed (${(result && result.error) || 'no result recorded'})`;
  const o = result.offsite;
  const stale = freshCopyGap(result, nowMs);
  if (stale) return stale;
  const problems = [];
  const off = CLIENT_APP_TABLES.filter((t) => !(o.deletionProtection && o.deletionProtection[t] === true));
  if (off.length) problems.push(`deletion protection is off for ${off.length === CLIENT_APP_TABLES.length ? `all ${off.length} tables` : off.map((t) => t.replace(/^clientapp-/, '')).join(', ')}`);
  const v = result.versioning;
  if (!v || v.error) problems.push(`the change-history bucket's versioning could not be read${v && v.error ? ` (${v.error})` : ''}`);
  else if (v.status !== 'Enabled') problems.push(`the change-history bucket no longer keeps old versions (${v.status})`);
  return problems.length ? problems.join(', and ') : null;
}

function seconds(ms) {
  return `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)}s`;
}

function failure(result) {
  if (!result) return 'no result recorded';
  if (result.error) return `request failed (${result.error})`;
  return `HTTP ${result.status}`;
}

// Pure: probe results -> the six rendered rows.
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
  const offsiteProblem = backups && !backups.error ? offsiteGap(backups, nowMs) : null;
  const shrinkProblem = shrinkGap(backups, nowMs);
  const safeguardProblem = safeguardGap(backups, nowMs);
  const tableCount = CLIENT_APP_TABLES.length;
  const gapReason = () => {
    if (!backups) return 'no backup result recorded';
    if (backups.error) return `the backup check failed (${backups.error})`;
    const shortNames = gaps.map((t) => t.replace(/^clientapp-/, '')).join(', ');
    const tableText = gaps.length ? `${gaps.length} of ${tableCount} live tables are not restorable to within the last hour (${shortNames})` : null;
    return [tableText, historyProblem, offsiteProblem].filter(Boolean).join(', and ');
  };
  return [
    pixOk
      ? `✓ ExampleCo: example.com answered HTTP 200 in ${seconds(pix.ms)}; checked ${checkedAt}.`
      : `✗ ExampleCo: example.com did not load: ${failure(pix)}; checked ${checkedAt}.`,
    appOk
      ? `✓ Client App app: the invoice app page answered HTTP 200 and its invoice API answered ok; checked ${checkedAt}.`
      : `✗ Client App app: ${!(app && app.ok && app.status === 200) ? `the invoice app page did not load (${failure(app)})` : `the invoice API health check failed (${api && api.ok && !api.jsonOk ? 'answered without ok' : failure(api)})`}; checked ${checkedAt}.`,
    emailOk
      ? `✓ Client App invoice email: the Google Workspace login check passed and sent nothing; checked ${checkedAt}.`
      : `✗ Client App invoice email: the Google Workspace login check failed (${email && email.ok && !email.jsonOk ? 'answered without ok' : failure(email)}), so invoice emails may not send; checked ${checkedAt}.`,
    backups && !backups.error && gaps.length === 0 && !historyProblem && !offsiteProblem
      ? `✓ Client App backups: all ${tableCount} live tables restorable to any minute of the last 35 days, the nightly change history finished ${backups.history.completedAt} with no errors, and the nightly copy of all ${tableCount} tables to Amy's account finished ${backups.offsite.completedAt}; checked ${checkedAt}.`
      : `✗ Client App backups: ${gapReason()}, so lost invoice data may not be recoverable; checked ${checkedAt}.`,
    shrinkProblem
      ? `✗ Client App records: ${shrinkProblem}, so data may be disappearing; checked ${checkedAt}.`
      : `✓ Client App records: no table lost both more than 10 records and more than 2%, and none went empty, between the nightly copies of ${backups.offsite.previous.date} and ${backups.offsite.date} (invoices ${backups.offsite.counts['clientapp-invoices']}, customers ${backups.offsite.counts['clientapp-customers']}); checked ${checkedAt}.`,
    safeguardProblem
      ? `✗ Client App delete safeguards: ${safeguardProblem}; checked ${checkedAt}.`
      : `✓ Client App delete safeguards: all ${tableCount} tables have deletion protection on as of the ${backups.offsite.date} nightly copy and the change-history bucket keeps old versions; checked ${checkedAt}.`,
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
  CLIENT_APP_AWS_COMMAND,
  CLIENT_APP_REGION,
  CLIENT_APP_TABLES,
  CLIENT_APP_OFFSITE_BUCKET,
  CLIENT_APP_OFFSITE_REGION,
  CLIENT_APP_OFFSITE_RETENTION,
  CLIENT_APP_ACCOUNT,
  TARGETS,
  backupGaps,
  historyGap,
  offsiteGap,
  shrinkGap,
  safeguardGap,
  CLIENT_APP_HISTORY_TABLES,
  runBackupProbe,
  businessAppHealthRows,
  formatBusinessAppHealthRows,
  probeBudgetMs,
  readClientAppPassword,
  runProbes,
};
