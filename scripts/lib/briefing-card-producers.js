'use strict';
//
// briefing-card-producers.js -- the INDEPENDENT producers for the two briefing
// SYSTEM HEALTH cards whose snapshots are generated on the DESKTOP shared
// checkout and shipped to EC2, and which have historically gone stale-red
// overnight because nothing regenerated them on a reliable cadence:
//
//   * git-hygiene-snapshot.json  -> card `uncommitted_parked`
//       (UNCOMMITTED & PARKED WORK). Produced by classifyGitState over the
//       desktop shared checkout via scripts/publish-git-hygiene-snapshot.js.
//       Card reader (scripts/lib/git-hygiene-briefing.js readGitHygieneSnapshot)
//       hard-blocks RED once the snapshot is > 30h old. It had NO schedule, so
//       it sat 54h stale.
//
//   * devops-health-latest.json  -> card `system_health` (SYSTEM HEALTH, the
//       "Dev Ops" subsystem row). Produced by probeDevOpsHealth over the
//       desktop shared checkout via scripts/verify-shared-checkout-clean.js
//       --write-snapshot. Card reader (cloud-morning-briefing readDevOpsSnapshot)
//       red-lines once the snapshot is > 6h old. It also had NO schedule.
//
// DESIGN (ExampleCo's card-independence contract, breakpoint 3):
//   - Each card is produced on its OWN timeline. There is NO monolithic
//     "block the briefing until all fresh" gate. One producer failing NEVER
//     blocks the other; the runner isolates each in its own try/catch.
//   - Producers REUSE the existing writers/scp logic (writeSnapshot + syncCloud
//     from publish-git-hygiene-snapshot.js; main --write-snapshot from
//     verify-shared-checkout-clean.js). This module calls them; it does not
//     duplicate git classification or the ssh/scp transport.
//   - Every git subprocess inside those writers is already wall-clock bounded
//     (classifyGitState's git() uses SB_GIT_TIMEOUT_MS, default 45s;
//     probeDevOpsHealth's git status uses a 10s timeout). The runner surfaces
//     the effective bound so "never hang" is honest, not assumed.
//   - The snapshots MEASURE the desktop shared checkout. On the EC2 cloud
//     file-deploy (linux + /opt/secondbrain) they CANNOT be regenerated
//     honestly (there is no desktop checkout there), so regeneration is skipped
//     with an honest log and the card keeps reading the shipped snapshot and
//     labelling its freshness itself. That honest-freshness labelling is the
//     card's job and is intentionally left untouched here.
//
// Both the every-~2h runner (scripts/refresh-briefing-card-snapshots.js) and the
// per-card controller (scripts/refresh-card.js) drive producers through this
// single module, so there is exactly one place that knows how a card's snapshot
// is made and shipped.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gitHygienePublisher = require('../publish-git-hygiene-snapshot.js');
const devopsVerifier = require('../verify-shared-checkout-clean.js');

// ---------------------------------------------------------------------------
// Freshness windows. These MIRROR the card readers' own staleness tolerances
// (the single source of truth for "is this card stale"):
//   * git-hygiene: readGitHygieneSnapshot default snapshotMaxAgeMs = 30h
//     (scripts/lib/git-hygiene-briefing.js).
//   * devops:      DEVOPS_SNAPSHOT_MAX_AGE_HOURS = 6h
//     (scripts/cloud-morning-briefing.js readDevOpsSnapshot).
// A drift test (briefing-card-producers.test.js) pins these to the documented
// consumer values so a change to a card reader that is not reflected here is
// caught mechanically instead of silently letting a card go stale.
// ---------------------------------------------------------------------------
const GIT_HYGIENE_MAX_AGE_MS = 30 * 60 * 60 * 1000;
const DEVOPS_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function defaultDataDir() {
  return (
    process.env.SECONDBRAIN_DATA_DIR ||
    (process.platform === 'linux'
      ? '/opt/secondbrain/data'
      : path.join(
          process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
          'secondbrain',
          'data',
        ))
  );
}

function defaultMainRoot() {
  return process.env.SECONDBRAIN_ROOT || path.join(os.homedir(), 'secondbrain');
}

// Mirrors cloud-morning-briefing.js runningOnEc2: the file-deploy where the
// desktop-checkout snapshots cannot be honestly regenerated. Same env override
// so a forced-EC2 test/build behaves identically across the two modules.
function isCloudFileDeploy(dataDir) {
  if (process.env.AMY_BRIEFING_FORCE_EC2_GENERATORS === '1') return true;
  if (process.env.AMY_BRIEFING_FORCE_EC2_GENERATORS === '0') return false;
  const resolved = path.resolve(dataDir || defaultDataDir());
  return process.platform === 'linux' && resolved.startsWith('/opt/secondbrain');
}

function snapshotPathFor(producer, dataDir) {
  return path.join(dataDir || defaultDataDir(), 'agent', producer.snapshotBasename);
}

// ---------------------------------------------------------------------------
// Producer registry. `cardIds` are the manifest card ids each producer feeds;
// `regenerate` writes the snapshot LOCALLY (calling the existing writer) and
// returns { outPath, generatedAt, verdict? }. `parseGeneratedAt` extracts the
// producer-native timestamp field so freshness reads one contract.
// ---------------------------------------------------------------------------
const PRODUCERS = [
  {
    id: 'git-hygiene',
    label: 'git hygiene (UNCOMMITTED & PARKED WORK)',
    cardIds: ['uncommitted_parked'],
    snapshotBasename: 'git-hygiene-snapshot.json',
    remotePath: '/opt/secondbrain/data/agent/git-hygiene-snapshot.json',
    maxAgeMs: GIT_HYGIENE_MAX_AGE_MS,
    parseGeneratedAt(payload) {
      return (
        (payload && (payload.generatedAt || payload.generated_at || payload.createdAt)) ||
        (payload && payload.snapshot && (payload.snapshot.generatedAt || payload.snapshot.generated_at)) ||
        null
      );
    },
    // Regenerate by REUSING publish-git-hygiene-snapshot.writeSnapshot: it runs
    // classifyGitState (git calls bounded by SB_GIT_TIMEOUT_MS) over the desktop
    // shared checkout at `cwd` and writes the standard payload to `outPath`.
    regenerate({ dataDir, mainRoot, today }) {
      const outPath = snapshotPathFor(this, dataDir);
      const { payload } = gitHygienePublisher.writeSnapshot({ cwd: mainRoot, today, outPath });
      return { outPath, generatedAt: payload.generatedAt, verdict: null };
    },
  },
  {
    id: 'devops-health',
    label: 'dev ops health (SYSTEM HEALTH / Dev Ops)',
    cardIds: ['system_health'],
    snapshotBasename: 'devops-health-latest.json',
    remotePath: '/opt/secondbrain/data/agent/devops-health-latest.json',
    maxAgeMs: DEVOPS_MAX_AGE_MS,
    parseGeneratedAt(payload) {
      return (payload && (payload.generated_at || payload.generatedAt)) || null;
    },
    // Regenerate by REUSING verify-shared-checkout-clean.main --write-snapshot:
    // it runs probeDevOpsHealth (git status bounded to 10s) over the desktop
    // shared checkout and writes { generated_at, mainRoot, result } to outPath.
    // A non-green verdict (exit 1) is NOT a producer failure -- the snapshot was
    // still written and MUST ship so the card honestly shows red.
    regenerate({ dataDir, mainRoot }) {
      const outPath = snapshotPathFor(this, dataDir);
      const code = devopsVerifier.main(['--main-root', mainRoot, '--write-snapshot', outPath]);
      const payload = readJsonSafe(outPath);
      return {
        outPath,
        generatedAt: this.parseGeneratedAt(payload),
        verdict: code === 0 ? 'green' : 'red',
      };
    },
  },
];

function readJsonSafe(file, readFile = fs.readFileSync) {
  try {
    return JSON.parse(readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function producerById(id) {
  return PRODUCERS.find((p) => p.id === id) || null;
}

function producerForCard(cardId) {
  const norm = String(cardId || '').trim();
  return PRODUCERS.find((p) => p.cardIds.includes(norm)) || null;
}

// Age (ms) of the on-disk snapshot for a producer, or null when the snapshot is
// missing / unparseable / has no timestamp. Injectable readFile for tests.
function snapshotAgeMs(producer, { dataDir, now = Date.now(), readFile = fs.readFileSync } = {}) {
  const payload = readJsonSafe(snapshotPathFor(producer, dataDir), readFile);
  if (!payload) return null;
  const generatedAt = producer.parseGeneratedAt(payload);
  const generatedMs = generatedAt ? Date.parse(generatedAt) : NaN;
  if (!Number.isFinite(generatedMs)) return null;
  return Math.max(0, now - generatedMs);
}

// A missing/unreadable snapshot (age null) is treated as STALE: it must be
// (re)produced. An age strictly greater than the window is stale.
function isStale(producer, ageMs) {
  if (ageMs == null) return true;
  return ageMs > producer.maxAgeMs;
}

function humanAge(ageMs) {
  if (ageMs == null) return 'missing/unreadable';
  const h = ageMs / 3600000;
  if (h < 1) return `${Math.round(ageMs / 60000)}m old`;
  return `${(Math.round(h * 10) / 10)}h old`;
}

// Default ship: REUSE publish-git-hygiene-snapshot.syncCloud (ssh mkdir + scp,
// both carrying ConnectTimeout so a dead host fails fast rather than hanging).
// The same transport ships BOTH snapshots -- only the remotePath differs.
function defaultShipSnapshot(localPath, remotePath, opts = {}) {
  return gitHygienePublisher.syncCloud(localPath, { remotePath, ...opts });
}

// ---------------------------------------------------------------------------
// runProducer -- execute ONE producer: regenerate locally, then (optionally)
// ship to EC2. NEVER throws: a failure is captured in the returned record so a
// sibling producer is never aborted by this one. Honest result fields:
//   ran      -> the local regenerate succeeded
//   shipped  -> the scp succeeded (false when ship:false or it failed)
//   error    -> the failing phase's message, or null
//   ageBeforeMs / staleBefore -> the snapshot this run replaced (for "aged" logs)
// Injectable regenerateFn/shipFn/readFile/now for hermetic tests (no git, no scp).
// ---------------------------------------------------------------------------
function runProducer(
  producer,
  {
    dataDir = defaultDataDir(),
    mainRoot = defaultMainRoot(),
    today = new Date().toISOString().slice(0, 10),
    ship = true,
    now = Date.now(),
    logger = console,
    regenerateFn = (ctx) => producer.regenerate(ctx),
    shipFn = defaultShipSnapshot,
    readFile = fs.readFileSync,
  } = {},
) {
  const result = {
    id: producer.id,
    cardIds: producer.cardIds,
    ok: false,
    ran: false,
    shipped: false,
    skipped: null,
    ageBeforeMs: null,
    staleBefore: null,
    generatedAt: null,
    verdict: null,
    outPath: null,
    remotePath: producer.remotePath,
    error: null,
  };

  result.ageBeforeMs = snapshotAgeMs(producer, { dataDir, now, readFile });
  result.staleBefore = isStale(producer, result.ageBeforeMs);

  try {
    // `producer` is passed through so an injected regenerateFn (tests) can
    // branch per producer; the default arrow ignores it and calls
    // producer.regenerate with `this` bound to the producer.
    const regen = regenerateFn({ dataDir, mainRoot, today, producer });
    result.ran = true;
    result.outPath = regen && regen.outPath;
    result.generatedAt = (regen && regen.generatedAt) || null;
    result.verdict = (regen && regen.verdict) || null;
    logger.log(
      `[card-producer] ${producer.id}: regenerated ${result.outPath} ` +
        `(was ${humanAge(result.ageBeforeMs)}${result.verdict ? `, verdict=${result.verdict}` : ''})`,
    );
  } catch (e) {
    result.error = `regenerate failed: ${(e && e.message) || e}`;
    logger.error(`[card-producer] ${producer.id}: ${result.error}`);
    return result; // cannot ship what we could not build; still isolated.
  }

  if (ship) {
    try {
      shipFn(result.outPath, producer.remotePath, {});
      result.shipped = true;
      logger.log(`[card-producer] ${producer.id}: shipped to ${producer.remotePath}`);
    } catch (e) {
      result.error = `ship failed: ${(e && e.message) || e}`;
      logger.error(`[card-producer] ${producer.id}: ${result.error}`);
      return result; // regenerate succeeded but ship did not: loud, not silent.
    }
  }

  result.ok = true;
  return result;
}

// Run EVERY producer, each isolated. Returns { results, ok } where ok is true
// only when all producers succeeded; a single failure leaves ok=false but the
// others still ran.
function runAllProducers(opts = {}) {
  const results = PRODUCERS.map((producer) => runProducer(producer, opts));
  return { results, ok: results.every((r) => r.ok) };
}

// ---------------------------------------------------------------------------
// refreshProducerForCard -- the per-card controller hook (scripts/refresh-card.js).
// If the target card has an independent producer whose snapshot is stale (older
// than the card's OWN window, or missing), regenerate + ship JUST that card's
// snapshot before the card is re-rendered. It NEVER touches any sibling card's
// snapshot. On the EC2 cloud file-deploy it is a no-op (honest log): the desktop
// snapshot cannot be regenerated there, so the card keeps reading the shipped
// snapshot and labelling its own freshness.
//
// Returns { skipped } for cards with no producer, a not-stale snapshot, or the
// cloud host; otherwise the runProducer result. Non-fatal by contract: the
// caller keeps refreshing the card even if this returns an error result.
// ---------------------------------------------------------------------------
function refreshProducerForCard({
  cardId,
  dataDir = defaultDataDir(),
  mainRoot = defaultMainRoot(),
  today = new Date().toISOString().slice(0, 10),
  now = Date.now(),
  ship = true,
  logger = console,
  onCloud = isCloudFileDeploy(dataDir),
  regenerateFn,
  shipFn,
  readFile = fs.readFileSync,
} = {}) {
  const producer = producerForCard(cardId);
  if (!producer) return { skipped: 'no-producer', cardId };

  const ageMs = snapshotAgeMs(producer, { dataDir, now, readFile });
  if (!isStale(producer, ageMs)) {
    logger.log(
      `[card-producer] ${producer.id}: snapshot fresh (${humanAge(ageMs)} <= ${humanAge(
        producer.maxAgeMs,
      )} window) -- no regeneration needed for card '${cardId}'.`,
    );
    return { skipped: 'fresh', cardId, id: producer.id, ageBeforeMs: ageMs };
  }

  if (onCloud) {
    logger.log(
      `[card-producer] ${producer.id}: snapshot is ${humanAge(ageMs)} but this is the EC2 ` +
        `file-deploy -- it is DESKTOP-generated and cannot be regenerated here. ` +
        `Card '${cardId}' keeps reading the shipped snapshot and labels its own freshness; ` +
        `the desktop scheduled runner (refresh-briefing-card-snapshots.js) must ship a fresh one.`,
    );
    return { skipped: 'cloud-file-deploy', cardId, id: producer.id, ageBeforeMs: ageMs };
  }

  logger.log(
    `[card-producer] ${producer.id}: snapshot is ${humanAge(ageMs)} (> ${humanAge(
      producer.maxAgeMs,
    )} window) -- regenerating for card '${cardId}' only.`,
  );
  const runOpts = { dataDir, mainRoot, today, now, ship, logger, readFile };
  if (regenerateFn) runOpts.regenerateFn = regenerateFn;
  if (shipFn) runOpts.shipFn = shipFn;
  return runProducer(producer, runOpts);
}

module.exports = {
  PRODUCERS,
  GIT_HYGIENE_MAX_AGE_MS,
  DEVOPS_MAX_AGE_MS,
  defaultDataDir,
  defaultMainRoot,
  isCloudFileDeploy,
  snapshotPathFor,
  producerById,
  producerForCard,
  snapshotAgeMs,
  isStale,
  humanAge,
  defaultShipSnapshot,
  runProducer,
  runAllProducers,
  refreshProducerForCard,
  readJsonSafe,
};
