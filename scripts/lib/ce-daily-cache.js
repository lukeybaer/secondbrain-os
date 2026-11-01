'use strict';

// Once-per-day file cache for AWS Cost Explorer queries.
//
// Why: Cost Explorer bills $0.01 per API request. Five scripts (the briefing's
// 30-day and 7-day pulls, the PC cost section's two queries, and the
// multi-account usage capability) each queried it on every run, paying for
// the same answer many times a day. Cost Explorer data only changes a few
// times a day, so one request per distinct query per Central day is enough.
//
// Behavior:
//   - The first caller of a Central day for a given query runs the live
//     request and stores the successful result under
//     <data>/cache/cost-explorer/<YYYY-MM-DD>/<hash>.json. Later callers that
//     day read the file and never touch the API.
//   - Failures are never cached (a denied or timed-out request is retried by
//     the next caller, and failed requests are not billed).
//   - Any cache I/O problem falls through to the live request; the cache can
//     slow nothing down and hide nothing.
//   - Day folders older than RETENTION_DAYS are pruned. Only folders under the
//     cache root whose name is a plain date are ever removed.
//   - Known limit: two processes that both miss in the same few seconds both
//     run the live request. That is at most one extra request per day per
//     query, not one per run.
//
// Controls (environment):
//   AMY_CE_CACHE=off          bypass the cache entirely.
//   AMY_CE_CACHE_REFRESH=1    ignore today's file and refresh it.
//   AMY_CE_CACHE_DIR=<path>   cache root (default <data dir>/cache/cost-explorer).
//   Under vitest the cache is off unless AMY_CE_CACHE_DIR is set, so a test
//   run never writes into the real data folder or reads a stale answer.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'amy.ce-daily-cache.v1';
const RETENTION_DAYS = 14;
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;

function centralDay(nowMs) {
  return new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function resolveDataDir(env = process.env, platform = process.platform, existsSync = fs.existsSync) {
  const explicit = String(env.SECONDBRAIN_DATA_DIR || env.SECONDBRAIN_DATA || '').trim();
  if (explicit) return path.resolve(explicit);
  if (platform === 'linux' && existsSync('/opt/secondbrain/data')) return '/opt/secondbrain/data';
  return path.resolve(path.join(__dirname, '..', '..', 'data'));
}

function cacheRoot(env = process.env) {
  const explicit = String(env.AMY_CE_CACHE_DIR || '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(resolveDataDir(env), 'cache', 'cost-explorer');
}

function cacheEnabled(env = process.env) {
  if (/^(off|0|false)$/i.test(String(env.AMY_CE_CACHE || ''))) return false;
  if (env.VITEST && !String(env.AMY_CE_CACHE_DIR || '').trim()) return false;
  return true;
}

function keyOf(keyParts) {
  const canonical = JSON.stringify(keyParts);
  return { canonical, hash: crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24) };
}

function filePathFor(root, day, hash) {
  return path.join(root, day, `${hash}.json`);
}

function readToday(file, day, canonical) {
  try {
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (row && row.schema === SCHEMA && row.day === day && row.key === canonical && 'value' in row) {
      return { hit: true, value: row.value, cachedAt: row.cached_at };
    }
  } catch {
    /* missing or corrupt: treated as a miss and overwritten */
  }
  return { hit: false };
}

function pruneOld(root, day) {
  try {
    const cutoff = Date.parse(`${day}T00:00:00Z`) - RETENTION_DAYS * 86400000;
    for (const name of fs.readdirSync(root)) {
      if (!DAY_DIR.test(name)) continue;
      if (Date.parse(`${name}T00:00:00Z`) < cutoff) {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
      }
    }
  } catch {
    /* pruning is best effort */
  }
}

function writeToday(root, file, day, canonical, value, nowMs) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${nowMs}`;
    const row = { schema: SCHEMA, day, key: canonical, cached_at: new Date(nowMs).toISOString(), value };
    fs.writeFileSync(tmp, `${JSON.stringify(row)}\n`);
    fs.renameSync(tmp, file);
    pruneOld(root, day);
  } catch {
    /* a failed write only means the next caller refreshes again */
  }
}

function defaultShouldCache(value) {
  return value !== undefined && value !== null && value.ok !== false;
}

function plan(keyParts, opts) {
  const env = opts.env || process.env;
  if (!cacheEnabled(env)) return null;
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  const root = opts.dir ? path.resolve(opts.dir) : cacheRoot(env);
  const day = centralDay(nowMs);
  const { canonical, hash } = keyOf(keyParts);
  return {
    nowMs,
    root,
    day,
    canonical,
    file: filePathFor(root, day, hash),
    refresh: /^(1|true|yes)$/i.test(String(env.AMY_CE_CACHE_REFRESH || '')),
    shouldCache: opts.shouldCache || defaultShouldCache,
  };
}

// Synchronous form for spawnSync/execFileSync callers.
function cachedCostExplorerSync(keyParts, fetchLive, opts = {}) {
  const p = plan(keyParts, opts);
  if (!p) return fetchLive();
  if (!p.refresh) {
    const found = readToday(p.file, p.day, p.canonical);
    if (found.hit) return found.value;
  }
  const value = fetchLive();
  if (p.shouldCache(value)) writeToday(p.root, p.file, p.day, p.canonical, value, p.nowMs);
  return value;
}

// Async form for promise-returning callers.
async function cachedCostExplorer(keyParts, fetchLive, opts = {}) {
  const p = plan(keyParts, opts);
  if (!p) return fetchLive();
  if (!p.refresh) {
    const found = readToday(p.file, p.day, p.canonical);
    if (found.hit) return found.value;
  }
  const value = await fetchLive();
  if (p.shouldCache(value)) writeToday(p.root, p.file, p.day, p.canonical, value, p.nowMs);
  return value;
}

module.exports = {
  RETENTION_DAYS,
  SCHEMA,
  cacheEnabled,
  cacheRoot,
  cachedCostExplorer,
  cachedCostExplorerSync,
  centralDay,
  keyOf,
  resolveDataDir,
};
