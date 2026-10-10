'use strict';

// THE SYSTEM HEALTH METRIC LEDGER.
//
// ExampleCo, 2026-09-07: "Nothing should put those metrics on the board. They're
// either red or green. They're red if we start attempting to refresh them (they
// can only be turned green by a successful result), they're green if they've
// gotten green previously (they would stay green). They can't appear or
// disappear; they're there permanently."
//
// The board carries ONE PERMANENT ROW PER REGISTERED METRIC. ExampleCo's September
// 8 correction makes Life coverage advisory yellow, and his September 14 rule
// does the same for owner-disabled services, lifetime catch-up and release
// bookkeeping (system-health-face-status.js); operational rows stay red/green:
//   - an operational row turns RED when a refresh starts; an advisory row turns YELLOW,
//   - it turns GREEN only when a successful result is proven by the live QC.
// An untouched row keeps its last proven color and shows the date it was
// proven. Rows never appear and never disappear. There is no stale, unknown,
// missing, informational, or placeholder state for a metric row, and
// the night's rendered artifact never defines the row set -- it only supplies
// proven results and fresh detail text.
//
// Before this file the row set came from whatever the renderer happened to emit
// (scripts/lib/system-health-nongreen.js systemHealthWorkUnits), so a missing
// System Health artifact shrank the board from 86 units to 48 and minted a
// synthetic `system_health:measurement-evidence` placeholder that the controller
// then planned as real work (dev-plans/core/briefing.LESSONS.md, 2026-09-06,
// mechanism four). A durable ledger removes that whole class: the artifact can
// be missing, partial, or from a foreign date and the row set is identical.
//
// `planning` is metadata, never a color. It records who may schedule the repair
// ('auto' = the unattended controller, 'owner-only' = ExampleCo targets it,
// 'immutable' = same-date history nothing can repair), which is exactly what the
// old yellow lanes carried. A row's COLOR stays honest either way.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  SYSTEM_HEALTH_MEASUREMENT_IDS,
  isRetiredSystemHealthMeasurementId,
  stableMeasurementKey,
} = require('./system-health-nongreen.js');
const { parseFullLifeBackupBody } = require('./parse-full-life-backup.js');
const { isOwnerGatedSystemHealthWorkUnit } = require('./system-health-owner-gated.js');
const { systemHealthChipStatus, isOwnerDisabledGraphitiItem } = require('./system-health-face-status.js');
const { repairClassOf } = require('./system-health-repair-class.js');
const { appendReportEvent } = require('./overnight-report-event-ledger.js');
const { briefingDateForLaunch } = require('./briefing-night-date.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LEDGER_REL_PATH = path.join('agent', 'system-health-ledger.json');
const LEDGER_SCHEMA_FAMILY = 'system-health-ledger';
const LEDGER_SCHEMA_VERSION = 1;
const LEDGER_SCHEMA = `${LEDGER_SCHEMA_FAMILY}@${LEDGER_SCHEMA_VERSION}`;
// How long a writer waits for a contended lease before it FAILS rather than
// writing unlocked. Bounded, not optional: two healer workers, refresh-card,
// and the QC writer all call markProven/markAttemptStarted concurrently.
const LEASE_STALE_MS = 30 * 1000;
const DEFAULT_LEASE_WAIT_MS = 15 * 1000;
const SYSTEM_HEALTH_CARD_ID = 'system_health';
const FULL_LIFE_CARD_ID = 'full_life_backup';
const LIFE_ID_PREFIX = 'system_health:life-';
const NEVER_PROVEN_DETAIL = 'never proven by live QC';

// WHICH DATA ROOT OWNS THE LEDGER.
//
// Explicit dataDir first (every board writer passes one), then
// SECONDBRAIN_DATA_DIR, then the EC2 spine store because EC2 is the sole
// autonomous night owner. There is deliberately NO implicit desktop
// (%APPDATA%) or repo fallback: an unaddressed caller must not silently
// read-modify-write ExampleCo's real ledger, so it gets `null` and the projection
// passes the caller's own rows through untouched.
let unaddressedDataDirLogged = false;

function resolveLedgerDataDir(dataDir) {
  if (dataDir) return String(dataDir);
  if (process.env.SECONDBRAIN_DATA_DIR) return process.env.SECONDBRAIN_DATA_DIR;
  if (process.platform === 'linux' && fs.existsSync('/opt/secondbrain/data')) {
    return '/opt/secondbrain/data';
  }
  // A caller that omits dataDir silently loses its attempt metadata boundary,
  // and the projection passes the caller's own rows through. That
  // is the safe behaviour, but it must never be invisible, so say it once per
  // process (once, because a whole-board projection would otherwise emit it
  // per row).
  if (!unaddressedDataDirLogged) {
    unaddressedDataDirLogged = true;
    console.warn(
      '[system-health-ledger] no data root resolved (no dataDir argument, no SECONDBRAIN_DATA_DIR, no /opt/secondbrain/data). Metric attempt boundaries and ledger projection are SKIPPED for this process.',
    );
  }
  return null;
}

// Test seam only: the once-per-process warning above is process state.
function resetUnaddressedDataDirLog() {
  unaddressedDataDirLogged = false;
}

function defaultDataDir() {
  return resolveLedgerDataDir(null) || path.join(REPO_ROOT, 'data');
}

function ledgerPath(dataDir) {
  return path.join(dataDir || defaultDataDir(), LEDGER_REL_PATH);
}

// --------------------------------------------------------------------------
// The registry: the row set, and nothing else, decides which rows exist.
// --------------------------------------------------------------------------

// THE PERMANENT ROW SET: WHAT THE CURRENT PRODUCERS CAN ACTUALLY RENDER.
//
// SYSTEM_HEALTH_MEASUREMENT_IDS is a LABEL -> ID PARSER registry, not a row
// set. It deliberately keeps superseded faces resolvable so an archived
// briefing still parses to a known id, so seeding the ledger from it minted
// permanent rows for metrics no producer emits any more. markProven only
// greens an id a producer rendered, so such a row is red forever, actionable
// forever, and planned every night forever.
//
// The row set is therefore derived from the PRODUCERS, audited against source
// on 2026-09-07:
//   - scripts/refresh-briefing-generated-sections.js renderSystemHealthSection
//     (54 labels, including the 13 test-category rows from
//     scripts/lib/system-health-tests-row.js, the 6 signal-flow rows from
//     scripts/lib/signal-flow-health.js, and the 3 session rows from
//     scripts/lib/session-cloud-health.js)
//   - scripts/cloud-morning-briefing.js formatSystemHealthSection (63 labels,
//     including the EC2 subsystem rows and the 10 content-readiness news rows)
//   - scripts/lib/parse-full-life-backup.js, whose `Life: <source>` rows are
//     the 12 system_health:life-* ids owned by full_life_backup
//
// Exactly three registry ids are NOT renderable by any current producer and so
// are NOT rows: `system_health:tests` (superseded by the 13 `tests-*` rows and
// `automated-regression-suite`), `system_health:news-summaries` (superseded by
// `llm-summarizer`, whose face is "News write-ups"), and bare `system_health:llm`.
// `dev-ops` and `deploy-parity` are BOTH still emitted by the cloud renderer,
// so both remain rows.
//
// scripts/__tests__/system-health-ledger.test.js is the drift lint: it proves
// every renderer-emitted label maps to a roster id, every roster id is emitted
// by a renderer or the life parser, and no excluded id has come back.
const RENDERABLE_SYSTEM_HEALTH_METRIC_IDS = Object.freeze([
  "system_health:amy-gravity",
  "system_health:api-audit",
  "system_health:automated-regression-suite",
  "system_health:backend-pm2-fleet",
  "system_health:backups",
  "system_health:backups-coverage",
  "system_health:briefing-delivery-slo",
  "system_health:cloud-briefing",
  "system_health:deploy-parity",
  "system_health:dev-ops",
  "system_health:dispatch-backlog",
  "system_health:ec2",
  "system_health:ec2-disk",
  "system_health:ec2-ssh-sessions",
  "system_health:gmail-scan",
  "system_health:graphiti",
  "system_health:graphiti-advisor",
  "system_health:life-archive-backup",
  "system_health:life-claude-code-sessions",
  "system_health:life-codex-sessions",
  "system_health:life-dispatches",
  "system_health:life-gmail",
  "system_health:life-linkedin-dms",
  "system_health:life-linkedin-posts",
  "system_health:life-other-prompt-surfaces",
  "system_health:life-otter",
  "system_health:life-sms-imessage",
  "system_health:life-vapi-amy",
  "system_health:life-whatsapp",
  "system_health:memory",
  "system_health:neo4j-cpu-cap",
  "system_health:news-headlines-with-a-full-story",
  "system_health:otter-call-processing-sla",
  "system_health:otter-hypothesis-projection",
  "system_health:otter-lifetime-call-processing-completion",
  "system_health:otter-name-resolver",
  "system_health:otter-speaker-enrichment",
  "system_health:past-week-voice-name-judge-orphans",
  "system_health:ExampleCo",
  "system_health:recall-broker",
  "system_health:scheduled-tasks",
  "system_health:session-search-projection",
  "system_health:session-terminal-receipts",
  "system_health:session-transcript-freshness",
  "system_health:signal-flow-archive",
  "system_health:signal-flow-capture",
  "system_health:signal-flow-graphiti",
  "system_health:signal-flow-linked-context",
  "system_health:signal-flow-message-completeness",
  "system_health:signal-flow-people-knowledge",
  "system_health:client-app-app",
  "system_health:client-app-backups",
  "system_health:client-app-email",
  "system_health:spec-changes",
  "system_health:stuck-videos",
  "system_health:telegram-phone-intake",
  "system_health:tests-action-item-ranker",
  "system_health:tests-auto-reply",
  "system_health:tests-briefing",
  "system_health:tests-dashboard",
  "system_health:tests-devops",
  "system_health:tests-dispatch",
  "system_health:tests-ingest",
  "system_health:tests-memory",
  "system_health:tests-other",
  "system_health:tests-self-heal",
  "system_health:tests-studio",
  "system_health:tests-vapi",
  "system_health:tests-video",
  "system_health:video-pipeline",
  "system_health:voice-confirmation-save-actions",
  "system_health:voice-name-conflicts",
  "system_health:voice-name-judge-orphans",
  "system_health:voice-people-projection",
  "system_health:voiceprint-text-conflicts",
  "system_health:watcher-interventions",
]);

const RENDERABLE_SYSTEM_HEALTH_METRIC_ID_SET = new Set(
  RENDERABLE_SYSTEM_HEALTH_METRIC_IDS,
);

function registeredLedgerIds() {
  return RENDERABLE_SYSTEM_HEALTH_METRIC_IDS.filter(
    (id) => id && !isRetiredSystemHealthMeasurementId(id),
  );
}

function isRenderableSystemHealthMetricId(id) {
  return RENDERABLE_SYSTEM_HEALTH_METRIC_ID_SET.has(String(id || "").trim());
}

const ACRONYMS = new Set([
  'ai',
  'api',
  'cpu',
  'dm',
  'dms',
  'ec2',
  'llm',
  'pm2',
  'qc',
  'sla',
  'slo',
  'sms',
  'ssh',
  'us',
  'vapi',
]);

function prettifyLabel(label) {
  return String(label || '')
    .split(' ')
    .map((word) => {
      const bare = word.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (ACRONYMS.has(bare)) return word.replace(/[a-z0-9]+/i, bare.toUpperCase());
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

// The owner-visible label for a registered id. A producer that emits the row
// overwrites this with its own rendered name; this is the fallback for a row
// that has never been rendered, so it must still read like ExampleCo's board (and
// keep the `Life: <name>` shape the full_life_backup merge evidence pins).
function canonicalMetricName(id) {
  const key = String(id || '').trim();
  const label = Object.keys(SYSTEM_HEALTH_MEASUREMENT_IDS).find(
    (name) => SYSTEM_HEALTH_MEASUREMENT_IDS[name] === key,
  );
  if (!label) return key;
  if (/^life:\s*/i.test(label)) return `Life: ${label.replace(/^life:\s*/i, '')}`;
  return prettifyLabel(label);
}

// Every permanent row a card owns. A whole-card refresh records attempt
// metadata for all of them; an exact refresh records exactly one.
function metricIdsForCard(cardId) {
  const key = String(cardId || '').trim();
  return registeredLedgerIds().filter((id) => ownerCardIdForId(id) === key);
}

function ownerCardIdForId(id) {
  return String(id || '').startsWith(LIFE_ID_PREFIX) ? FULL_LIFE_CARD_ID : SYSTEM_HEALTH_CARD_ID;
}

// Who may SCHEDULE this row's repair. Never a color.
function planningForId(id) {
  const key = String(id || '').toLowerCase();
  if (key === 'system_health:watcher-interventions') return 'immutable';
  if (key === 'system_health:amy-gravity') return 'owner-only';
  if (key.startsWith(LIFE_ID_PREFIX)) return 'owner-only';
  if (isOwnerGatedSystemHealthWorkUnit(key)) return 'owner-only';
  return 'auto';
}

function emptyRow(id, { now = new Date() } = {}) {
  return {
    id,
    name: canonicalMetricName(id),
    color: systemHealthChipStatus({id, status:'red'}),
    provenAt: null,
    attemptStartedAt: null,
    attemptId: '',
    attemptFinishedAt: null,
    attemptOutcome: '',
    proof: null,
    detail: NEVER_PROVEN_DETAIL,
    ownerCardId: ownerCardIdForId(id),
    planning: planningForId(id),
    seededAt: now.toISOString(),
  };
}

function normalizeRow(id, raw, { now = new Date() } = {}) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const color = systemHealthChipStatus({id, status:row.color});
  return {
    id,
    name: String(row.name || canonicalMetricName(id)),
    color,
    provenAt: row.provenAt || null,
    attemptStartedAt: row.attemptStartedAt || null,
    attemptId: String(row.attemptId || ''),
    attemptFinishedAt: row.attemptFinishedAt || null,
    attemptOutcome: String(row.attemptOutcome || ''),
    proof: row.proof && typeof row.proof === 'object' ? row.proof : null,
    detail: String(
      row.detail || (color === 'green' ? 'proven green by live QC' : NEVER_PROVEN_DETAIL),
    ),
    ownerCardId: ownerCardIdForId(id),
    planning: planningForId(id),
    seededAt: row.seededAt || now.toISOString(),
  };
}

// --------------------------------------------------------------------------
// Durable storage: atomic write, one short lease so two concurrent night
// processes cannot lose each other's transition.
// --------------------------------------------------------------------------

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // The rename normally consumed the temporary file.
    }
  }
}

function leaseWaitMs() {
  const raw = Number(process.env.SYSTEM_HEALTH_LEDGER_LEASE_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_LEASE_WAIT_MS;
}

// Back off and RETRY for a bounded time, then THROW. There is no unlocked
// write: two healer workers, refresh-card, and the live QC writer all reach
// markProven/markAttemptStarted at once, and a lost update here silently
// repaints a proven-green row red (or worse, a red row green).
function acquireLedgerLease(file, { waitMs = leaseWaitMs() } = {}) {
  const lock = `${file}.lock`;
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + Math.max(0, waitMs);
  let backoffMs = 5;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeFileSync(fd, token);
      fs.closeSync(fd);
      return { lock, token };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    // Reclaim a lease whose holder died mid-write.
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LEASE_STALE_MS) {
        fs.unlinkSync(lock);
        continue;
      }
    } catch {
      // The holder released it between the open and the stat.
    }
    if (Date.now() >= deadline) {
      const error = new Error(
        `system health ledger lease ${lock} is still held after ${Math.max(0, waitMs)}ms; refusing to write the ledger unlocked`,
      );
      error.code = 'SYSTEM_HEALTH_LEDGER_LEASE_TIMEOUT';
      throw error;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 250);
  }
}

function releaseLedgerLease(lease) {
  if (!lease) return;
  try {
    if (fs.readFileSync(lease.lock, 'utf8') === lease.token) fs.unlinkSync(lease.lock);
  } catch {
    // A stale lease is independently reclaimable.
  }
}

// AN EXISTING LEDGER IS NEVER SILENTLY DISCARDED.
//
// Before this, a parse failure or a schema mismatch returned null and the
// caller re-seeded the whole board from whatever artifact happened to be on
// disk, so a single corrupted byte quietly reverted every proven green. Now an
// existing-but-unreadable file is QUARANTINED (renamed, never deleted), the
// event is appended to the night's report event ledger, and the run fails
// loud. Seeding happens only when the file is genuinely absent.
function quarantineLedgerFile({ dataDir, file, reason, now = new Date() }) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let quarantined = `${file}.corrupt-${stamp}`;
  try {
    fs.renameSync(file, quarantined);
  } catch (renameError) {
    quarantined = `not-quarantined (${renameError && renameError.message})`;
  }
  try {
    appendReportEvent({
      dataDir: dataDir || defaultDataDir(),
      date: briefingDateForLaunch(now.getTime()) || now.toISOString().slice(0, 10),
      kind: 'system-health-ledger',
      subjectId: 'system_health:ledger',
      state: 'corrupt-quarantined',
      // Not terminal: the ledger is recoverable by hand from the quarantined
      // copy, and the night has not decided anything about it yet.
      outcome: 'running',
      terminal: false,
      sourceComponent: 'system-health-ledger',
      content: { file, quarantined, reason },
      ts: now.toISOString(),
    });
  } catch {
    // The throw below is the loud failure; a missing event ledger must not
    // swallow it.
  }
  const error = new Error(
    `system health ledger ${file} is unreadable (${reason}). Quarantined to ${quarantined}; refusing to reseed over an existing ledger.`,
  );
  error.code = 'SYSTEM_HEALTH_LEDGER_CORRUPT';
  error.quarantinedPath = quarantined;
  throw error;
}

// A schema bump MIGRATES, it never wipes: any file in this schema family is
// carried forward through normalizeRow (which coerces every field), including
// a NEWER file written by the other side of a rolling deploy. Only a foreign
// schema, unparseable JSON, or a missing rows map is quarantined.
function migrateLedgerSchema(parsed) {
  const match = /^([a-z0-9-]+)@(\d+)$/i.exec(String((parsed && parsed.schema) || ''));
  if (!match || match[1].toLowerCase() !== LEDGER_SCHEMA_FAMILY) return null;
  if (parsed.schema === LEDGER_SCHEMA) return parsed;
  return { ...parsed, schema: LEDGER_SCHEMA, migratedFrom: parsed.schema };
}

function readLedgerFile(dataDir, { now = new Date() } = {}) {
  const file = ledgerPath(dataDir);
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // Genuinely absent is the ONLY clean seed path.
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return quarantineLedgerFile({
      dataDir,
      file,
      reason: `unparseable JSON: ${error && error.message}`,
      now,
    });
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.rows || typeof parsed.rows !== 'object') {
    return quarantineLedgerFile({ dataDir, file, reason: 'no rows map', now });
  }
  const migrated = migrateLedgerSchema(parsed);
  if (!migrated) {
    return quarantineLedgerFile({
      dataDir,
      file,
      reason: `foreign schema '${parsed.schema}'`,
      now,
    });
  }
  return migrated;
}

// --------------------------------------------------------------------------
// Seeding. Idempotent: it runs whenever the file is missing OR a registered id
// is absent, and it never downgrades a row that is already in the ledger.
// --------------------------------------------------------------------------

function readNewestAcceptedCardArtifact({ dataDir, cardId }) {
  const root = path.join(dataDir || defaultDataDir(), 'agent', 'briefing-cards');
  let dates = [];
  try {
    dates = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const date of dates) {
    try {
      const artifact = JSON.parse(fs.readFileSync(path.join(root, date, `${cardId}.json`), 'utf8'));
      if (artifact && typeof artifact === 'object') return { artifact, date };
    } catch {
      // Try the next older date.
    }
  }
  return null;
}

// The rows an accepted card artifact proves. System Health carries them as
// `workUnits`; the Full Life card renders its `Life:` sources in markdown, so
// its rows are parsed the same way the board builder parses them.
function acceptedArtifactRows(cardId, artifact) {
  if (Array.isArray(artifact && artifact.workUnits) && artifact.workUnits.length) {
    return artifact.workUnits;
  }
  if (cardId !== FULL_LIFE_CARD_ID) return [];
  return parseFullLifeBackupBody(String((artifact && artifact.markdown) || '')).items.map(
    (item) => ({
      id: stableMeasurementKey(item.name),
      name: item.name,
      status: item.status,
      detail: item.detail || '',
    }),
  );
}

function seedRowsFromArtifacts({ dataDir, now = new Date() } = {}) {
  const seedByRow = new Map();
  for (const cardId of [SYSTEM_HEALTH_CARD_ID, FULL_LIFE_CARD_ID]) {
    const found = readNewestAcceptedCardArtifact({ dataDir, cardId });
    if (!found) continue;
    const units = acceptedArtifactRows(cardId, found.artifact);
    const generatedAt = found.artifact.generatedAt || `${found.date}T00:00:00.000Z`;
    for (const unit of units) {
      const id = String((unit && unit.id) || '').trim();
      if (!id) continue;
      seedByRow.set(id, {
        status: String((unit && unit.status) || '').toLowerCase(),
        name: String((unit && unit.name) || '') || canonicalMetricName(id),
        detail: String((unit && unit.detail) || ''),
        generatedAt,
        date: found.date,
      });
    }
  }
  const rows = {};
  let green = 0;
  let red = 0;
  for (const id of registeredLedgerIds()) {
    const seed = seedByRow.get(id);
    if (seed && seed.status === 'green') {
      green += 1;
      rows[id] = normalizeRow(
        id,
        {
          name: seed.name,
          color: 'green',
          provenAt: seed.generatedAt,
          attemptStartedAt: null,
          proof: { date: seed.date, source: 'seed', attemptId: '' },
          detail: seed.detail || 'proven green by live QC',
          seededAt: now.toISOString(),
        },
        { now },
      );
      continue;
    }
    red += 1;
    rows[id] = normalizeRow(
      id,
      {
        ...emptyRow(id, { now }),
        ...(seed ? { name: seed.name, detail: seed.detail || NEVER_PROVEN_DETAIL } : {}),
      },
      { now },
    );
  }
  return { rows, green, red };
}

// The current row map, with every registered id present: what the file holds,
// plus a seed for anything missing. Pure read, no lease and no write, so the
// lease holder in mutateLedger can call it without deadlocking against itself.
function resolveLedgerRows({ dataDir, now = new Date() } = {}) {
  const existing = readLedgerFile(dataDir, { now });
  const ids = registeredLedgerIds();
  const priorRows = (existing && existing.rows) || {};
  const missing = ids.filter((id) => !priorRows[id]);
  const seeded = missing.length ? seedRowsFromArtifacts({ dataDir, now }).rows : {};
  const rows = {};
  let addedGreen = 0;
  for (const id of ids) {
    rows[id] = normalizeRow(id, priorRows[id] || seeded[id] || null, { now });
    if (!priorRows[id] && rows[id].color === 'green') addedGreen += 1;
  }
  return {
    rows,
    carried: ids.length - missing.length,
    added: missing.length,
    addedGreen,
    complete: missing.length === 0,
  };
}

function seedLedger({ dataDir, now = new Date(), log = true } = {}) {
  const file = ledgerPath(dataDir);
  const lease = acquireLedgerLease(file);
  try {
    const resolved = resolveLedgerRows({ dataDir, now });
    const ledger = { schema: LEDGER_SCHEMA, updatedAt: now.toISOString(), rows: resolved.rows };
    writeJsonAtomic(file, ledger);
    if (log) {
      console.log(
        `[system-health-ledger] seeded ${resolved.added} new row(s) (${resolved.addedGreen} green, ${
          resolved.added - resolved.addedGreen
        } red), carried ${resolved.carried}, total ${Object.keys(resolved.rows).length}`,
      );
    }
    return { ledger, added: resolved.added, carried: resolved.carried, path: file };
  } finally {
    releaseLedgerLease(lease);
  }
}

// The single read every consumer uses. Seeds on a missing file or a missing
// registered id so the row set is complete by construction and a caller can
// never observe a partial board.
function readLedger({ dataDir, now = new Date(), seedIfIncomplete = true, log = false } = {}) {
  const existing = readLedgerFile(dataDir, { now });
  const resolved = resolveLedgerRows({ dataDir, now });
  if (resolved.complete) {
    return {
      schema: LEDGER_SCHEMA,
      updatedAt: (existing && existing.updatedAt) || now.toISOString(),
      rows: resolved.rows,
    };
  }
  // A row is missing from the durable file: persist the seed so the next reader
  // sees the same board, unless the caller explicitly wants a pure read.
  if (!seedIfIncomplete) {
    return { schema: LEDGER_SCHEMA, updatedAt: now.toISOString(), rows: resolved.rows };
  }
  return seedLedger({ dataDir, now, log }).ledger;
}

function mutateLedger({ dataDir, now, mutate }) {
  const file = ledgerPath(dataDir);
  const lease = acquireLedgerLease(file);
  try {
    // Read under the lease we already hold: never call readLedger here, or the
    // seed path would try to take the same lease and stall until it expires.
    const ledger = {
      schema: LEDGER_SCHEMA,
      updatedAt: now.toISOString(),
      rows: resolveLedgerRows({ dataDir, now }).rows,
    };
    const next = mutate(ledger) || ledger;
    next.schema = LEDGER_SCHEMA;
    next.updatedAt = now.toISOString();
    writeJsonAtomic(file, next);
    return next;
  } finally {
    releaseLedgerLease(lease);
  }
}

// --------------------------------------------------------------------------
// Attempt lifecycle and the sole proven-green transition.
// --------------------------------------------------------------------------

// A refresh attempt STARTED. Callers may keep a previously proven green row
// visible while fresh proof is collected. The attempt fields still expose the
// in-progress work, but admission by itself is not evidence that the accepted
// result regressed. Rows which were already non-green remain red.
function markAttemptStarted({
  dataDir,
  ids = [],
  at = new Date(),
  attemptId = '',
  detail = '',
} = {}) {
  const now = at instanceof Date ? at : new Date(at);
  const targets = (Array.isArray(ids) ? ids : [ids])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const root = resolveLedgerDataDir(dataDir);
  if (!targets.length || !root) return { changed: [], skipped: targets };
  const changed = [];
  const skipped = [];
  mutateLedger({
    dataDir: root,
    now,
    mutate: (ledger) => {
      for (const id of targets) {
        const row = ledger.rows[id];
        if (!row) {
          skipped.push(id);
          continue;
        }
        ledger.rows[id] = {
          ...row,
          color: row.color,
          attemptStartedAt: now.toISOString(),
          attemptId: String(attemptId || ''),
          attemptFinishedAt: null,
          attemptOutcome: '',
          // The face keeps the last accepted evidence while a green row is
          // rechecked. Attempt metadata is the honest progress signal; replacing
          // the evidence text with "refresh in progress" made the board itself
          // look failed before any new evidence existed.
          detail: row.detail,
        };
        changed.push(id);
      }
      return ledger;
    },
  });
  return { changed, skipped };
}

// Completion is not success. Close only this correlated, still-active attempt;
// a newer retry or generation-bound green proof belongs to its own writer.
function markAttemptFinished({ dataDir, ids = [], attemptId = '', outcome = 'unproven', detail = '', at = new Date() } = {}) {
  const token = String(attemptId || '').trim();
  const targets = [...new Set((Array.isArray(ids) ? ids : [ids]).map(String))];
  const root = resolveLedgerDataDir(dataDir);
  if (!token || !targets.length || !root) return { changed: [], skipped: targets };
  const now = at instanceof Date ? at : new Date(at);
  const changed = [];
  mutateLedger({ dataDir: root, now, mutate: (ledger) => {
    for (const id of targets) {
      const row = ledger.rows[id];
      if (!row?.attemptStartedAt || row.attemptId !== token) continue;
      ledger.rows[id] = {
        ...row,
        attemptStartedAt: null,
        attemptFinishedAt: now.toISOString(),
        attemptOutcome: String(outcome || 'unproven'),
        // Attempt outcome belongs in attempt fields. An unknown/failure is not
        // fresh source-backed evidence and cannot replace accepted face text,
        // regardless of whether that face was green, red, or advisory yellow.
        detail: row.detail,
      };
      changed.push(id);
    }
    return ledger;
  } });
  return { changed, skipped: targets.filter((id) => !changed.includes(id)) };
}

// A refresh SUCCEEDED and the live QC proved it. This is the ONLY way a row
// becomes green. Two callers own it: refresh-card.js Gate B (applied to board,
// exact row's generation-bound live proof matches its successful producer) and
// verify-dashboard-cards-live.js writeCanonicalArtifactFromResult with the same
// metric predicate. A failed sibling never cancels that individual proof.
function markProven({ dataDir, id, at = new Date(), proof = null, detail = '', name = '' } = {}) {
  const now = at instanceof Date ? at : new Date(at);
  const key = String(id || '').trim();
  if (isOwnerDisabledGraphitiItem({ id: key })) return { changed: false, receipt: null, reason: 'owner-disabled-advisory' };
  const root = resolveLedgerDataDir(dataDir);
  if (!key || !root) return { changed: false, receipt: null };
  let changed = false;
  let receipt = null;
  mutateLedger({
    dataDir: root,
    now,
    mutate: (ledger) => {
      const row = ledger.rows[key];
      if (!row) return ledger;
      const next = {
        ...row,
        name: name || row.name,
        color: 'green',
        provenAt: now.toISOString(),
        attemptStartedAt: null,
        attemptFinishedAt: row.attemptStartedAt ? now.toISOString() : row.attemptFinishedAt || null,
        attemptOutcome: row.attemptStartedAt ? 'proven-green' : row.attemptOutcome || '',
        proof:
          proof && typeof proof === 'object'
            ? {
                date: String(proof.date || ''),
                source: String(proof.source || ''),
                attemptId: String(proof.attemptId || ''),
              }
            : null,
        detail: detail || row.detail,
      };
      ledger.rows[key] = next;
      // The board write follows this transition and needs the green projection.
      // Keep an exact receipt so a failed write can restore only this row, and
      // never overwrite a later attempt or proof from another worker.
      receipt = { id: key, previous: { ...row }, expected: { ...next } };
      changed = true;
      return ledger;
    },
  });
  return { changed, receipt };
}

// Fresh generation/source-bound live QC can also prove a real regression.
// Admission and interruption never call this transition; only the two
// canonical QC writers do. Like markProven, it returns an exact CAS receipt so
// a failed dependent board write can restore only this mutation.
function markVerifiedRed({ dataDir, id, at = new Date(), proof = null, detail = '', name = '' } = {}) {
  const now = at instanceof Date ? at : new Date(at);
  const key = String(id || '').trim();
  const root = resolveLedgerDataDir(dataDir);
  if (!key || !root) return { changed: false, receipt: null };
  let changed = false;
  let receipt = null;
  mutateLedger({
    dataDir: root,
    now,
    mutate: (ledger) => {
      const row = ledger.rows[key];
      if (!row) return ledger;
      const next = {
        ...row,
        name: name || row.name,
        color: systemHealthChipStatus({ id: key, status: 'red' }),
        provenAt: null,
        attemptStartedAt: null,
        attemptFinishedAt: row.attemptStartedAt ? now.toISOString() : row.attemptFinishedAt || null,
        attemptOutcome: 'verified-red',
        proof:
          proof && typeof proof === 'object'
            ? {
                date: String(proof.date || ''),
                source: String(proof.source || ''),
                attemptId: String(proof.attemptId || ''),
                verdict: 'red',
              }
            : null,
        detail: detail || row.detail,
      };
      ledger.rows[key] = next;
      receipt = { id: key, previous: { ...row }, expected: { ...next } };
      changed = true;
      return ledger;
    },
  });
  return { changed, receipt };
}

function sameRow(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

// A publication can need the green ledger projection before the durable board
// write completes. Roll back only the exact markProven transition that failed
// to publish; a newer attempt/proof for that row and every sibling are left
// untouched.
function rollbackProven({ dataDir, receipt, at = new Date() } = {}) {
  const now = at instanceof Date ? at : new Date(at);
  const key = String(receipt && receipt.id || '').trim();
  const root = resolveLedgerDataDir(dataDir);
  if (!key || !root || !receipt?.previous || !receipt?.expected) {
    return { restored: false, skipped: true };
  }
  let restored = false;
  mutateLedger({
    dataDir: root,
    now,
    mutate: (ledger) => {
      if (!sameRow(ledger.rows[key], receipt.expected)) return ledger;
      ledger.rows[key] = { ...receipt.previous };
      restored = true;
      return ledger;
    },
  });
  return { restored, skipped: !restored };
}

function rollbackVerifiedRed(input = {}) {
  return rollbackProven(input);
}

// --------------------------------------------------------------------------
// Projection: the board's `systemHealthMeasurements` rows.
// --------------------------------------------------------------------------

function projectLedgerRows(ledger) {
  const rows = (ledger && ledger.rows) || {};
  return registeredLedgerIds()
    .map((id) => rows[id])
    .filter(Boolean)
    .map((row) => {
      const status = systemHealthChipStatus({id:row.id, status:row.color});
      const projected = {
        id: row.id,
        cardId: SYSTEM_HEALTH_CARD_ID,
        name: row.name,
        status,
        actionable: status === 'red' && row.planning === 'auto',
        detail: row.detail,
        provenAt: row.provenAt || null,
        attemptStartedAt: row.attemptStartedAt || null,
        attemptFinishedAt: row.attemptFinishedAt || null,
        attemptOutcome: row.attemptOutcome || '',
        asOf: row.attemptStartedAt || row.attemptFinishedAt || row.provenAt || null,
        planning: row.planning,
        repairClass: repairClassOf(row.id),
      };
      if (row.ownerCardId === FULL_LIFE_CARD_ID) projected.sourceCardId = FULL_LIFE_CARD_ID;
      return projected;
    });
}

// The one helper every board writer calls. The ledger owns the row set and the
// color; the night's artifact rows may only refresh a row's detail text and its
// rendered name.
function projectSystemHealthRows({ dataDir, artifactRows = [], now = new Date() } = {}) {
  const root = resolveLedgerDataDir(dataDir);
  if (!root) return (Array.isArray(artifactRows) ? artifactRows : []).map((row) => ({ ...row }));
  const ledger = readLedger({ dataDir: root, now });
  const detailById = new Map();
  for (const row of Array.isArray(artifactRows) ? artifactRows : []) {
    const id = String((row && row.id) || '').trim();
    if (!id) continue;
    detailById.set(id, row);
  }
  return projectLedgerRows(ledger).map((row) => {
    const artifactRow = detailById.get(row.id);
    if (!artifactRow) return row;
    return {
      ...row,
      name: String(artifactRow.name || row.name),
      detail: String(row.attemptFinishedAt && /^(refresh admitted by controller run|refresh in progress|agentic healer launched)\b/i.test(artifactRow.detail || '')
        ? row.detail : artifactRow.detail || row.detail),
    };
  });
}

module.exports = {
  LEDGER_REL_PATH,
  resolveLedgerDataDir,
  resetUnaddressedDataDirLog,
  LEDGER_SCHEMA,
  LEDGER_SCHEMA_FAMILY,
  LEDGER_SCHEMA_VERSION,
  acquireLedgerLease,
  releaseLedgerLease,
  NEVER_PROVEN_DETAIL,
  defaultDataDir,
  ledgerPath,
  registeredLedgerIds,
  RENDERABLE_SYSTEM_HEALTH_METRIC_IDS,
  isRenderableSystemHealthMetricId,
  canonicalMetricName,
  ownerCardIdForId,
  metricIdsForCard,
  planningForId,
  readLedger,
  seedLedger,
  markAttemptStarted,
  markAttemptFinished,
  markProven,
  markVerifiedRed,
  rollbackProven,
  rollbackVerifiedRed,
  projectLedgerRows,
  projectSystemHealthRows,
};
