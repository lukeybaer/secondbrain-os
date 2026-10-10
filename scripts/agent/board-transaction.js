'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const SCHEMA_VERSION = 1;
const BOARD_OWNER_ID = 'briefing_board';
const GENERATION_REL_DIR = path.join('agent', 'briefing-card-generations');
const JOURNAL_REL_DIR = path.join('agent', 'briefing-card-publish-journal');
const QC_RECEIPT_REL_DIR = path.join('agent', 'briefing-card-qc-receipts');
const BOARD_SIGNAL_FILE = 'briefing-board-qc-signals.json';
const LEGACY_SINGLETON_REL = path.join('agent', 'card-controller', 'active-transaction.json');
// A candidate journal embeds its whole qcReceipt, and a qcReceipt embeds the
// scoped live-board result (every tile, including raw inner markup). Those
// payloads reach tens of megabytes per card. listCandidateJournals is called at
// controller startup across every journal of the day, so it must retain only
// bounded index fields, never the payloads.
const JOURNAL_INDEX_KEYS = [
  'schemaVersion',
  'date',
  'cardId',
  'generationId',
  'generationHash',
  'workUnitId',
  'state',
  'preparedAt',
  'updatedAt',
  'humanActionToken',
];
const JOURNAL_FULL_PARSE_MAX_BYTES = 4 * 1024 * 1024;
const JOURNAL_SCAN_CHUNK_BYTES = 64 * 1024;
const JOURNAL_SCALAR_MAX_CHARS = 4096;
const QC_ATTEMPT_HISTORY_LIMIT = 25;
const QC_RAW_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
// Cold-sidecar record format: 1 = full payload per attempt, 2 = snapshot + deltas.
const QC_RAW_SIDECAR_VERSION = 2;
// Ceiling on how many delta records may follow one snapshot. See the block
// above archiveAttemptRawResult for why 16.
const QC_RAW_SNAPSHOT_INTERVAL = 16;
// A delta that is not clearly smaller than the payload buys nothing and only
// lengthens the replay chain, so it is written as a snapshot instead.
const QC_RAW_DIFF_MAX_RATIO = 0.5;
const QC_RAW_READ_CHUNK_BYTES = 256 * 1024;
// One cross-process writer at a time per (date, card, generation). Every step
// of an archive write is a read-then-write on shared state, so interleaving
// them loses evidence while both callers still see ok:true.
const QC_RAW_LOCK_STALE_MS = 30 * 1000;
const QC_RAW_LOCK_WAIT_MS = 10 * 1000;

const TERMINAL_STATES = new Set([
  'gate-b-committed',
  'superseded-before-gate-b',
  'rolled-back-pre-gate-a',
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

function safeSegment(value, label) {
  const text = String(value || '').trim();
  if (!text || !/^[A-Za-z0-9._-]+$/.test(text) || text === '.' || text === '..') {
    throw new Error(`invalid ${label || 'path'} segment`);
  }
  return text;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  return file;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function generationIdForArtifact(artifact) {
  if (!artifact || !artifact.id || !artifact.date) {
    throw new Error('generation artifact requires id and date');
  }
  return sha256(stableJson(artifact));
}

function generationDir({ dataDir, date, cardId, generationId }) {
  return path.join(
    dataDir,
    GENERATION_REL_DIR,
    safeSegment(date, 'date'),
    safeSegment(cardId, 'card id'),
    safeSegment(generationId, 'generation id'),
  );
}

function generationArtifactPath(input) {
  return path.join(generationDir(input), 'artifact.json');
}

function acceptedGenerationArtifactPath({ dataDir, date, cardId, generationId, artifactHash }) {
  return path.join(
    generationDir({ dataDir, date, cardId, generationId }),
    'accepted',
    `${safeSegment(artifactHash, 'artifact hash')}.json`,
  );
}

function writeImmutableGeneration({ dataDir, date, cardId, generationId, artifact }) {
  const computedHash = generationIdForArtifact(artifact);
  const id = String(generationId || computedHash);
  if (id !== computedHash) {
    throw new Error('immutable generation hash mismatch: generation id does not match artifact');
  }
  if (artifact.id !== cardId || artifact.date !== date) {
    throw new Error('immutable generation identity does not match artifact body');
  }
  const artifactPath = generationArtifactPath({ dataDir, date, cardId, generationId: id });
  const existing = readJson(artifactPath, null);
  if (existing) {
    if (generationIdForArtifact(existing) !== computedHash) {
      throw new Error('immutable generation hash mismatch');
    }
    return { artifactPath, generationId: id, generationHash: computedHash, created: false };
  }
  writeJsonAtomic(artifactPath, artifact);
  try {
    fs.chmodSync(artifactPath, 0o444);
  } catch {
    // Some mounted filesystems and Windows do not enforce POSIX mode bits.
  }
  return { artifactPath, generationId: id, generationHash: computedHash, created: true };
}

function readImmutableGeneration({ dataDir, date, cardId, generationId }) {
  const artifactPath = generationArtifactPath({ dataDir, date, cardId, generationId });
  const artifact = readJson(artifactPath, null);
  if (!artifact || generationIdForArtifact(artifact) !== generationId) return null;
  return artifact;
}

// A producer generation remains the CAS identity through Gate B, while the
// accepted card artifact can gain a live-QC projection (status, failures, and
// verification timestamp). Keep those accepted projections immutable too,
// keyed by the manifest's exact artifact hash beneath the producer generation.
// This lets every publisher resolve the manifest pointer without consulting a
// mutable card file that another candidate may be halfway through replacing.
function writeImmutableAcceptedArtifact({
  dataDir,
  date,
  cardId,
  generationId,
  artifactHash = '',
  artifact,
}) {
  if (!artifact || artifact.id !== cardId || artifact.date !== date) {
    throw new Error('accepted generation identity does not match artifact body');
  }
  const computedHash = generationIdForArtifact(artifact);
  const hash = String(artifactHash || computedHash);
  if (hash !== computedHash) {
    throw new Error('accepted generation artifact hash mismatch');
  }
  const artifactPath = acceptedGenerationArtifactPath({
    dataDir,
    date,
    cardId,
    generationId,
    artifactHash: hash,
  });
  const existing = readJson(artifactPath, null);
  if (existing) {
    if (generationIdForArtifact(existing) !== hash) {
      throw new Error('immutable accepted generation hash mismatch');
    }
    return { artifactPath, artifactHash: hash, created: false };
  }
  writeJsonAtomic(artifactPath, artifact);
  try {
    fs.chmodSync(artifactPath, 0o444);
  } catch {
    // Some mounted filesystems and Windows do not enforce POSIX mode bits.
  }
  return { artifactPath, artifactHash: hash, created: true };
}

function readImmutableAcceptedArtifact({
  dataDir,
  date,
  cardId,
  generationId,
  artifactHash,
}) {
  if (!generationId || !artifactHash) return null;
  const artifactPath = acceptedGenerationArtifactPath({
    dataDir,
    date,
    cardId,
    generationId,
    artifactHash,
  });
  const artifact = readJson(artifactPath, null);
  if (!artifact || generationIdForArtifact(artifact) !== artifactHash) return null;
  return artifact;
}

function candidateJournalPath({ dataDir, date, cardId, generationId }) {
  return path.join(
    dataDir,
    JOURNAL_REL_DIR,
    safeSegment(date, 'date'),
    safeSegment(cardId, 'card id'),
    `${safeSegment(generationId, 'generation id')}.json`,
  );
}

function candidateRollbackDir({ dataDir, date, cardId, generationId }) {
  const journal = candidateJournalPath({ dataDir, date, cardId, generationId });
  return journal.replace(/\.json$/i, '.rollback');
}

function snapshotFiles({ files = {}, backupDir } = {}) {
  const snapshots = {};
  fs.mkdirSync(backupDir, { recursive: true });
  for (const [key, source] of Object.entries(files || {})) {
    const existed = fs.existsSync(source);
    const destination = path.join(backupDir, `${safeSegment(key, 'snapshot key')}.snapshot`);
    if (existed) fs.copyFileSync(source, destination);
    snapshots[key] = { source, destination, existed };
  }
  return snapshots;
}

function restoreSnapshots(snapshots = {}) {
  for (const snapshot of Object.values(snapshots || {})) {
    if (!snapshot || !snapshot.source) continue;
    if (!snapshot.existed) {
      if (fs.existsSync(snapshot.source)) fs.unlinkSync(snapshot.source);
      continue;
    }
    if (!snapshot.destination || !fs.existsSync(snapshot.destination)) {
      throw new Error(`candidate rollback snapshot missing for ${snapshot.source}`);
    }
    fs.mkdirSync(path.dirname(snapshot.source), { recursive: true });
    const temp = `${snapshot.source}.${process.pid}.${Date.now()}.restore`;
    fs.copyFileSync(snapshot.destination, temp);
    fs.renameSync(temp, snapshot.source);
  }
}

function readCandidateJournal({ dataDir, date, cardId, generationId }) {
  return readJson(candidateJournalPath({ dataDir, date, cardId, generationId }), null);
}

function prepareCandidateJournal({
  dataDir,
  date,
  cardId,
  generationId,
  generationHash,
  expectedLineage = {},
  dependencyCardIds = [],
  snapshots = {},
  humanActionToken = '',
  workUnitId = '',
  now = new Date(),
} = {}) {
  const file = candidateJournalPath({ dataDir, date, cardId, generationId });
  const existing = readJson(file, null);
  if (existing) {
    if (
      existing.generationId !== generationId ||
      existing.generationHash !== generationHash ||
      existing.cardId !== cardId ||
      String(existing.workUnitId || '') !== String(workUnitId || '')
    ) {
      throw new Error('candidate journal identity conflict');
    }
    return existing;
  }
  const journal = {
    schemaVersion: SCHEMA_VERSION,
    date,
    cardId,
    generationId,
    generationHash,
    ...(workUnitId ? { workUnitId: String(workUnitId) } : {}),
    state: 'prepared',
    preparedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expectedLineage,
    dependencyCardIds: [...new Set((dependencyCardIds || []).map(String).filter(Boolean))].sort(),
    snapshots,
    humanActionToken: String(humanActionToken || '') || null,
  };
  writeJsonAtomic(file, journal);
  return journal;
}

function transitionCandidateJournal({
  dataDir,
  date,
  cardId,
  generationId,
  expectedState,
  nextState,
  patch = {},
  now = new Date(),
} = {}) {
  const file = candidateJournalPath({ dataDir, date, cardId, generationId });
  const current = readJson(file, null);
  if (!current) throw new Error('candidate journal missing');
  const expected = Array.isArray(expectedState) ? expectedState : [expectedState];
  if (expectedState && !expected.includes(current.state)) {
    const error = new Error(
      `candidate journal state conflict: expected ${expected.join('|')}, found ${current.state}`,
    );
    error.code = 'BRIEFING_CANDIDATE_JOURNAL_CONFLICT';
    throw error;
  }
  const projectedPatch =
    patch && patch.qcReceipt
      ? { ...patch, qcReceipt: projectReceiptForDisk(patch.qcReceipt, { dataDir, date, cardId }) }
      : patch;
  const next = { ...current, ...projectedPatch, state: nextState, updatedAt: now.toISOString() };
  writeJsonAtomic(file, next);
  return next;
}

function projectJournalIndex(journal) {
  if (!journal || typeof journal !== 'object') return null;
  const out = {};
  for (const key of JOURNAL_INDEX_KEYS) {
    if (journal[key] !== undefined) out[key] = journal[key];
  }
  return out;
}

// Streams the file and keeps only top-level scalar index fields. Nested values
// are skipped by depth counting and never materialised, so peak memory is
// O(JOURNAL_SCAN_CHUNK_BYTES) no matter how large the journal grew.
function scanJournalIndexStreaming(file) {
  const wanted = new Set(JOURNAL_INDEX_KEYS);
  // workUnitId is optional on legacy journals and appears before the required
  // state/timestamp tail on current journals. Do not make an absent optional
  // scalar force the streaming reader across a multi-megabyte embedded receipt.
  const remaining = new Set(JOURNAL_INDEX_KEYS.filter((key) => key !== 'workUnitId'));
  const out = {};
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  const { StringDecoder } = require('node:string_decoder');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(JOURNAL_SCAN_CHUNK_BYTES);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let capturing = false;
  let token = '';
  let pendingKey = '';
  let awaitingValue = false;
  let literal = '';
  let done = false;
  const decodeToken = (raw) => {
    try {
      return JSON.parse(`"${raw}"`);
    } catch {
      return raw;
    }
  };
  const assign = (key, value) => {
    if (key && wanted.has(key)) {
      out[key] = value;
      remaining.delete(key);
      if (remaining.size === 0) done = true;
    }
  };
  const flushLiteral = () => {
    if (depth === 1 && awaitingValue && literal) {
      let value = literal;
      try {
        value = JSON.parse(literal);
      } catch {
        /* keep the raw text when the literal is truncated */
      }
      assign(pendingKey, value);
    }
    literal = '';
    if (depth === 1) {
      awaitingValue = false;
      pendingKey = '';
    }
  };
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, JOURNAL_SCAN_CHUNK_BYTES, null);
      if (read <= 0) break;
      const text = decoder.write(buffer.subarray(0, read));
      for (let i = 0; i < text.length; i += 1) {
        if (done) break;
        const c = text[i];
        if (inString) {
          if (escaped) {
            escaped = false;
            if (capturing && token.length < JOURNAL_SCALAR_MAX_CHARS) token += c;
            continue;
          }
          if (c === '\\') {
            escaped = true;
            if (capturing && token.length < JOURNAL_SCALAR_MAX_CHARS) token += c;
            continue;
          }
          if (c === '"') {
            inString = false;
            if (capturing) {
              if (awaitingValue) {
                assign(pendingKey, decodeToken(token));
                awaitingValue = false;
                pendingKey = '';
              } else {
                pendingKey = decodeToken(token);
              }
            }
            capturing = false;
            token = '';
            continue;
          }
          if (capturing && token.length < JOURNAL_SCALAR_MAX_CHARS) token += c;
          continue;
        }
        if (c === '"') {
          inString = true;
          capturing = depth === 1;
          token = '';
          continue;
        }
        if (c === '{' || c === '[') {
          if (depth === 1) {
            awaitingValue = false;
            pendingKey = '';
            literal = '';
          }
          depth += 1;
          continue;
        }
        if (c === '}' || c === ']') {
          flushLiteral();
          depth -= 1;
          if (depth <= 0) {
            done = true;
            break;
          }
          continue;
        }
        if (c === ':') {
          if (depth === 1) awaitingValue = true;
          continue;
        }
        if (c === ',') {
          flushLiteral();
          continue;
        }
        if (depth === 1 && awaitingValue && !/\s/.test(c)) {
          if (literal.length < JOURNAL_SCALAR_MAX_CHARS) literal += c;
        }
      }
      if (done) break;
    }
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* the descriptor is already gone */
    }
  }
  return Object.keys(out).length ? out : null;
}

// Always returns the bounded index projection. Small journals take the fast
// full-parse path; anything larger is streamed so an arbitrarily large journal
// can never exhaust the controller heap at startup.
function readCandidateJournalIndex(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  if (size <= JOURNAL_FULL_PARSE_MAX_BYTES) {
    return projectJournalIndex(readJson(file, null));
  }
  return scanJournalIndexStreaming(file);
}

function listCandidateJournals({ dataDir, date = '', cardIds = [] } = {}) {
  const root = path.join(dataDir, JOURNAL_REL_DIR, ...(date ? [safeSegment(date, 'date')] : []));
  const out = [];
  if (!fs.existsSync(root)) return out;
  const scopedCardIds = [
    ...new Set(
      (Array.isArray(cardIds) ? cardIds : [])
        .map((cardId) => String(cardId || '').trim())
        .filter(Boolean),
    ),
  ];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        const journal = readCandidateJournalIndex(file);
        if (journal && journal.schemaVersion === SCHEMA_VERSION && journal.generationId) {
          out.push({ ...journal, journalPath: file });
        }
      }
    }
  };
  // Exact-card recovery must not stream every journal for the day before it can
  // start one scoped reverify. The production journals are already partitioned
  // by date/card, so enter only the requested card directories when both parts
  // of that identity are known. Unscoped callers retain the full-day sweep.
  if (date && scopedCardIds.length) {
    for (const cardId of scopedCardIds) {
      const cardRoot = path.join(root, safeSegment(cardId, 'card id'));
      if (fs.existsSync(cardRoot)) visit(cardRoot);
    }
  } else {
    visit(root);
  }
  return out.sort((a, b) =>
    `${a.preparedAt || ''}:${a.cardId}:${a.generationId}`.localeCompare(
      `${b.preparedAt || ''}:${b.cardId}:${b.generationId}`,
    ),
  );
}

function legacySingletonPath(dataDir) {
  return path.join(dataDir, LEGACY_SINGLETON_REL);
}

function migrateLegacySingletonJournal({ dataDir, restoreSnapshots, now = new Date() } = {}) {
  const singleton = legacySingletonPath(dataDir);
  const legacy = readJson(singleton, null);
  if (!legacy) return { migrated: false, reason: 'absent' };
  const runId = String(legacy.runId || 'unknown');
  const receiptPath = path.join(
    dataDir,
    JOURNAL_REL_DIR,
    'legacy-migrations',
    `${safeSegment(runId.replace(/[^A-Za-z0-9._-]+/g, '_'), 'legacy run id')}.json`,
  );
  if (fs.existsSync(receiptPath)) {
    if (fs.existsSync(singleton)) fs.unlinkSync(singleton);
    return { migrated: false, reason: 'already-migrated', receiptPath, runId };
  }
  if (!legacy.backups || typeof restoreSnapshots !== 'function') {
    throw new Error('legacy singleton journal cannot be migrated without restorable backups');
  }
  restoreSnapshots(legacy.backups, legacy);
  const receipt = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'legacy-singleton-journal-migration',
    runId,
    cardId: String(legacy.cardId || ''),
    migratedAt: now.toISOString(),
    rolledBack: true,
  };
  writeJsonAtomic(receiptPath, receipt);
  fs.unlinkSync(singleton);
  return { migrated: true, runId, cardId: receipt.cardId, rolledBack: true, receiptPath };
}

async function recoverCandidateJournals({
  dataDir,
  date = '',
  cardIds = [],
  workUnitsByCard = {},
  restoreSnapshots,
  resumePinnedQc,
  migrateLegacy = true,
} = {}) {
  const scopedCardIds = new Set(
    (Array.isArray(cardIds) ? cardIds : []).map((cardId) => String(cardId || '')).filter(Boolean),
  );
  const scopedWorkUnitsByCard = new Map(
    Object.entries(workUnitsByCard && typeof workUnitsByCard === 'object' ? workUnitsByCard : {}).map(
      ([cardId, workUnitIds]) => [
        String(cardId || '').trim(),
        new Set(
          (Array.isArray(workUnitIds) ? workUnitIds : [])
            .map((workUnitId) => String(workUnitId || '').trim().toLowerCase())
            .filter(Boolean),
        ),
      ],
    ),
  );
  const result = {
    rolledBack: 0,
    rolledForward: 0,
    superseded: 0,
    failed: 0,
    rows: [],
    legacyMigration: null,
  };
  if (migrateLegacy) {
    const legacy = scopedCardIds.size ? readJson(legacySingletonPath(dataDir), null) : null;
    const legacyWorkUnitIds = scopedWorkUnitsByCard.get(String((legacy && legacy.cardId) || '')) || new Set();
    result.legacyMigration =
      legacy && legacyWorkUnitIds.size
        ? {
            migrated: false,
            reason: 'ambiguous-exact-work-unit-scope',
            cardId: String(legacy.cardId || ''),
          }
        : legacy && !scopedCardIds.has(String(legacy.cardId || ''))
        ? {
            migrated: false,
            reason: 'out-of-scope',
            cardId: String(legacy.cardId || ''),
          }
        : migrateLegacySingletonJournal({ dataDir, restoreSnapshots });
  }
  for (const journal of listCandidateJournals({ dataDir, date, cardIds })) {
    if (scopedCardIds.size && !scopedCardIds.has(String(journal.cardId || ''))) continue;
    const scopedWorkUnitIds = scopedWorkUnitsByCard.get(String(journal.cardId || '')) || new Set();
    const journalWorkUnitId = String(journal.workUnitId || '').trim().toLowerCase();
    if (scopedWorkUnitIds.size && journalWorkUnitId && !scopedWorkUnitIds.has(journalWorkUnitId)) {
      continue;
    }
    // Older card-only journals remain recoverable for one exact requested unit.
    // With several requested siblings there is no safe way to infer which one
    // owns a legacy journal, so leave it untouched for a later card-wide or
    // single-unit recovery instead of widening Gate B proof.
    if (scopedWorkUnitIds.size > 1 && !journalWorkUnitId) continue;
    if (TERMINAL_STATES.has(journal.state)) continue;
    try {
      if (journal.state === 'prepared') {
        // `prepared` is strictly pre-install. Gate A changes state to
        // `gate-a-installing` while holding the publish lock before its first
        // shared write. Therefore there is nothing shared to restore here.
        // Restoring board-wide snapshots later could clobber an independent
        // candidate that committed after this process died.
        transitionCandidateJournal({
          dataDir,
          date: journal.date,
          cardId: journal.cardId,
          generationId: journal.generationId,
          expectedState: 'prepared',
          nextState: 'rolled-back-pre-gate-a',
          patch: { recoveredAt: new Date().toISOString() },
        });
        result.rolledBack += 1;
        result.rows.push({ cardId: journal.cardId, generationId: journal.generationId, action: 'rolled-back' });
        continue;
      }
      if (journal.state === 'gate-a-installing' || journal.state === 'gate-a-committed') {
        if (typeof resumePinnedQc !== 'function') {
          throw new Error('Gate A journal recovery requires pinned QC resumption');
        }
        // listCandidateJournals hands back a bounded index record so the whole
        // day of journals never sits in memory at once. Resumption needs the
        // full document, so hydrate exactly one journal here.
        const hydrated =
          readCandidateJournal({
            dataDir,
            date: journal.date,
            cardId: journal.cardId,
            generationId: journal.generationId,
          }) || journal;
        const resumed = (await resumePinnedQc({ ...hydrated, journalPath: journal.journalPath })) || {};
        const afterResume = readCandidateJournal({
          dataDir,
          date: journal.date,
          cardId: journal.cardId,
          generationId: journal.generationId,
        });
        const alreadyTerminal = TERMINAL_STATES.has(afterResume && afterResume.state);
        if (
          !alreadyTerminal &&
          resumed.appliedToBoard !== true &&
          resumed.superseded !== true
        ) {
          throw new Error(
            'pinned QC recovery did not reach a durable Gate B or superseded journal state',
          );
        }
        const nextState = alreadyTerminal
          ? afterResume.state
          : resumed.superseded === true
            ? 'superseded-before-gate-b'
            : 'gate-b-committed';
        if (!TERMINAL_STATES.has(afterResume && afterResume.state)) {
          transitionCandidateJournal({
            dataDir,
            date: journal.date,
            cardId: journal.cardId,
            generationId: journal.generationId,
            expectedState: ['gate-a-installing', 'gate-a-committed'],
            nextState,
            patch: { recoveryResult: resumed, recoveredAt: new Date().toISOString() },
          });
        }
        if (nextState === 'gate-b-committed') result.rolledForward += 1;
        else result.superseded += 1;
        result.rows.push({ cardId: journal.cardId, generationId: journal.generationId, action: nextState });
      }
    } catch (error) {
      result.failed += 1;
      result.rows.push({
        cardId: journal.cardId,
        generationId: journal.generationId,
        action: 'failed',
        error: String((error && error.message) || error),
      });
    }
  }
  return result;
}

function isPageWideSignal(message) {
  return /^(?:LIVE-RENDER-PARSE|DASHBOARD-(?:ORDER|LAYOUT|HEADER|PAGE)|PAGE-(?:LAYOUT|RENDER)|AUTH-|GLOBAL-)/i.test(
    String(message || '').trim(),
  );
}

function partitionQcSignals({ targetCardId, cardStatuses = [], defects = [] } = {}) {
  const targetSignals = [];
  const siblingSignals = [];
  const boardSignals = [];
  const seen = new Set();
  const add = (bucket, ownerId, message) => {
    const text = String(message || '').trim();
    if (!text) return;
    const key = `${ownerId}\u0000${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    bucket.push({ ownerId, message: text });
  };
  const statusOwners = new Map();
  for (const status of cardStatuses || []) {
    const owner = String((status && status.id) || '').trim();
    if (!owner) continue;
    for (const defect of status.defects || []) {
      if (isPageWideSignal(defect)) add(boardSignals, BOARD_OWNER_ID, defect);
      else if (owner === targetCardId) add(targetSignals, owner, defect);
      else add(siblingSignals, owner, defect);
    }
    statusOwners.set(owner, status);
  }
  for (const defect of defects || []) {
    if (isPageWideSignal(defect)) {
      add(boardSignals, BOARD_OWNER_ID, defect);
      continue;
    }
    const namedOwner = [...statusOwners.keys()].find((id) =>
      new RegExp(`(^|[^A-Za-z0-9_])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'i').test(
        String(defect || ''),
      ),
    );
    if (namedOwner === targetCardId) add(targetSignals, namedOwner, defect);
    else if (namedOwner) add(siblingSignals, namedOwner, defect);
  }
  return { targetSignals, siblingSignals, boardSignals };
}

function qcReceiptPath({ dataDir, date, cardId, generationId }) {
  return path.join(
    dataDir,
    QC_RECEIPT_REL_DIR,
    safeSegment(date, 'date'),
    safeSegment(cardId, 'card id'),
    `${safeSegment(generationId, 'generation id')}.json`,
  );
}

function boardSignalLedgerPath({ dataDir, date }) {
  return path.join(dataDir, 'agent', safeSegment(date, 'date'), BOARD_SIGNAL_FILE);
}

function readQcReceipt({ dataDir, date, cardId, generationId }) {
  const receipt = readJson(qcReceiptPath({ dataDir, date, cardId, generationId }), null);
  return hydrateReceiptRawResult(receipt, { dataDir, date });
}

function rawAttemptArchivePath({ dataDir, date, cardId, generationId }) {
  return path.join(
    dataDir,
    QC_RECEIPT_REL_DIR,
    safeSegment(date, 'date'),
    safeSegment(cardId, 'card id'),
    `${safeSegment(generationId, 'generation id')}.raw-attempts.jsonl`,
  );
}

// Busy-wait scratch for the writer lock. The lock is held for a single verified
// append (microseconds to low milliseconds), so parking a whole event-loop tick
// costs more than it saves.
const RAW_LOCK_WAIT_SLOT = new Int32Array(new SharedArrayBuffer(4));
// Re-entrancy inside one process: archiveAttemptRawResult is called both on its
// own and from inside writeQcReceipt, which already holds the same lock.
const HELD_RAW_LOCKS = new Set();

// Cross-process mutual exclusion via mkdir, which is atomic create-or-fail on
// every filesystem this runs on. A holder that died mid-write is reaped by age;
// that is safe because every step inside the lock is verified after the fact
// rather than assumed.
function withRawArchiveLock(lockDir, fn, { waitMs = QC_RAW_LOCK_WAIT_MS, staleMs = QC_RAW_LOCK_STALE_MS } = {}) {
  if (HELD_RAW_LOCKS.has(lockDir)) return fn();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      let age = Infinity;
      try {
        age = Date.now() - fs.statSync(lockDir).mtimeMs;
      } catch {
        age = Infinity;
      }
      if (age > staleMs) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          /* another writer reaped it first */
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error('qc raw archive lock timeout');
      try {
        Atomics.wait(RAW_LOCK_WAIT_SLOT, 0, 0, 5);
      } catch {
        /* Atomics.wait is disallowed on the main thread in some hosts */
      }
    }
  }
  HELD_RAW_LOCKS.add(lockDir);
  try {
    return fn();
  } finally {
    HELD_RAW_LOCKS.delete(lockDir);
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

// The lock is taken on the RECEIPT path, not the sidecar path, because the
// receipt read-modify-write and the sidecar append are one transaction: a
// last-writer-wins receipt would drop an attempt row whose payload had already
// been stripped from it.
function qcWriteLockDir({ dataDir, date, cardId, generationId }) {
  return `${qcReceiptPath({ dataDir, date, cardId, generationId })}.write.lock`;
}

function newRawArchiveSegmentId() {
  return crypto.randomBytes(12).toString('hex');
}

// Rotation is a rename to a dated cold file, never a delete, so the sidecar
// cannot grow without bound while every archived byte stays on disk. The live
// pathname is REUSED after rotation, so a pathname alone is not an address:
// each file carries an immutable segment id and receipts record it.
function rotateRawArchiveIfLarge(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size < QC_RAW_ARCHIVE_MAX_BYTES) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotated = file.replace(/\.jsonl$/i, `.${stamp}.jsonl`);
    fs.renameSync(file, rotated);
    return rotated;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cold sidecar storage: per-attempt DIFFS with periodic full snapshots.
//
// Storing a whole ~9MB board copy per attempt made the sidecar grow as
// O(board bytes x attempts), so a long healing day rotated the 64MB cold file
// many times over for evidence that is nearly identical attempt to attempt (a
// heal attempt usually changes one tile). Each record now stores either a full
// SNAPSHOT or a structural DELTA against the immediately preceding record, so
// growth is O(board bytes / snapshot interval + sum of real changes).
//
// Snapshot interval = 16, chosen against three constraints:
//   1. Storage: full copies drop from N to ceil(N/16), 6.25% of the linear
//      growth. A 9MB board over 100 attempts falls from ~900MB of snapshots to
//      ~56MB, which stays under QC_RAW_ARCHIVE_MAX_BYTES (64MB) for a normal
//      healing day instead of rotating a dozen times.
//   2. Reconstruction cost: rebuilding any attempt reads at most 1 snapshot
//      plus 15 deltas, a bounded and small replay.
//   3. Retained-history alignment: QC_ATTEMPT_HISTORY_LIMIT is 25 rows, so a
//      16-record chain never spans more than one retained history window. Any
//      attempt still named by the receipt is at most one snapshot boundary
//      away from a full copy.
// The interval is a ceiling, not a schedule: a delta that is not clearly
// smaller than the payload, or one that cannot be proven to rebuild the exact
// payload from the exact base on disk, is written as a snapshot instead.
//
// `seq` is the record's ordinal WITHIN ITS FILE. Rotation renames the file, so
// a rotated cold file keeps its own seq space and the live sidecar restarts at
// a snapshot. An attempt row identifies its evidence with the pair
// (rawResultArchive, rawResultArchiveSeq).
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Structural delta between two ALREADY key-sorted (stableValue) documents.
// Returns undefined when a subtree is unchanged so callers can omit it.
function diffStableSubtree(prev, next) {
  if (prev === next) return undefined;
  if (Array.isArray(prev) && Array.isArray(next)) {
    const set = {};
    let changed = prev.length !== next.length;
    for (let i = 0; i < next.length; i += 1) {
      if (i >= prev.length) {
        set[i] = { t: 'v', v: next[i] };
        changed = true;
        continue;
      }
      const delta = diffStableSubtree(prev[i], next[i]);
      if (delta !== undefined) {
        set[i] = delta;
        changed = true;
      }
    }
    if (!changed) return undefined;
    return { t: 'a', n: next.length, s: set };
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const set = {};
    const del = [];
    let changed = false;
    for (const key of Object.keys(prev)) {
      if (!Object.prototype.hasOwnProperty.call(next, key)) {
        del.push(key);
        changed = true;
      }
    }
    for (const key of Object.keys(next)) {
      if (!Object.prototype.hasOwnProperty.call(prev, key)) {
        set[key] = { t: 'v', v: next[key] };
        changed = true;
        continue;
      }
      const delta = diffStableSubtree(prev[key], next[key]);
      if (delta !== undefined) {
        set[key] = delta;
        changed = true;
      }
    }
    if (!changed) return undefined;
    return { t: 'o', s: set, d: del };
  }
  return { t: 'v', v: next };
}

function diffStableValue(prev, next) {
  const delta = diffStableSubtree(prev, next);
  return delta === undefined ? { t: 'n' } : delta;
}

function applyStableValueDiff(prev, delta) {
  if (!delta || typeof delta !== 'object')
    throw new Error('invalid raw-attempt delta');
  if (delta.t === 'n') return prev;
  if (delta.t === 'v') return delta.v;
  if (delta.t === 'a') {
    if (!Array.isArray(prev))
      throw new Error('raw-attempt delta expects an array base');
    const length = Number(delta.n);
    if (!Number.isInteger(length) || length < 0)
      throw new Error('invalid raw-attempt array length');
    const out = new Array(length);
    for (let i = 0; i < length; i += 1) {
      const child =
        delta.s && Object.prototype.hasOwnProperty.call(delta.s, String(i))
          ? delta.s[String(i)]
          : undefined;
      out[i] =
        child === undefined ? prev[i] : applyStableValueDiff(prev[i], child);
    }
    return out;
  }
  if (delta.t === 'o') {
    if (!isPlainObject(prev))
      throw new Error('raw-attempt delta expects an object base');
    const removed = new Set(Array.isArray(delta.d) ? delta.d : []);
    const merged = {};
    for (const key of Object.keys(prev))
      if (!removed.has(key)) merged[key] = prev[key];
    for (const key of Object.keys(delta.s || {})) {
      merged[key] = applyStableValueDiff(merged[key], delta.s[key]);
    }
    // Reconstruction must land back in canonical key order or the rebuilt
    // document would not serialize byte-identically to the original.
    return Object.fromEntries(
      Object.keys(merged)
        .sort()
        .map((key) => [key, merged[key]]),
    );
  }
  throw new Error(`unknown raw-attempt delta type ${delta.t}`);
}

// Streams the sidecar line by line. Peak memory is O(one record), not O(file),
// which is the whole reason the bound exists: this file is read by the same
// controller startup path that once OOM'd on a 2.2GB day of ledgers.
function forEachRawArchiveLine(file, onLine) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { readable: false, torn: false, completeBytes: 0, records: 0 };
  }
  const decoder = new StringDecoder('utf8');
  const buf = Buffer.allocUnsafe(QC_RAW_READ_CHUNK_BYTES);
  let pending = '';
  let ordinal = 0;
  let readable = true;
  let completeBytes = 0;
  let torn = false;
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read <= 0) break;
      pending += decoder.write(buf.subarray(0, read));
      let idx = pending.indexOf('\n');
      while (idx >= 0) {
        const line = pending.slice(0, idx);
        completeBytes += Buffer.byteLength(line, 'utf8') + 1;
        pending = pending.slice(idx + 1);
        if (line.trim()) {
          onLine(line, ordinal);
          ordinal += 1;
        }
        idx = pending.indexOf('\n');
      }
    }
    pending += decoder.end();
    // Every record this writer appends is newline terminated. A non-empty
    // remainder is therefore an INCOMPLETE SUFFIX, not a record. Parsing it as
    // one is how a torn write became permanent: the next append concatenated
    // onto the half line, produced one malformed combined line, and the size
    // check still reported ok:true while the only inline payload was dropped.
    if (pending.length) torn = true;
  } catch {
    // An unreadable sidecar (a directory in the way, a torn read) fails
    // closed: callers see 'no verified chain', which forces a snapshot on the
    // write path and a null rebuild on the read path. It never throws out.
    readable = false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best effort */
    }
  }
  return { readable, torn, completeBytes, records: ordinal };
}

// WRITER-LOCK ONLY. The incomplete suffix is moved to an immutable quarantine
// file (never deleted, this is evidence) and the sidecar is truncated back to
// its last complete record, so the next append starts on a record boundary.
function repairTornRawArchive(file) {
  const scan = forEachRawArchiveLine(file, () => {});
  if (!scan.readable || !scan.torn) return null;
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  if (size <= scan.completeBytes) return null;
  const suffixLength = size - scan.completeBytes;
  let fd = null;
  try {
    fd = fs.openSync(file, 'r+');
    const suffix = Buffer.allocUnsafe(suffixLength);
    fs.readSync(fd, suffix, 0, suffixLength, scan.completeBytes);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantine = `${file}.torn-${stamp}.quarantine`;
    fs.writeFileSync(quarantine, suffix);
    fs.ftruncateSync(fd, scan.completeBytes);
    fs.fsyncSync(fd);
    return { quarantine, bytes: suffixLength };
  } catch {
    return null;
  } finally {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
      /* best effort */
    }
  }
}

// The immutable id of the segment stored in a given pathname, read from its
// first record. Rotation reuses the live pathname, so this is what makes a
// receipt's stored address stable across rotation, recreation, and truncation.
function rawArchiveSegmentOf(file) {
  let found = null;
  let stop = false;
  const scan = forEachRawArchiveLine(file, (line) => {
    if (stop) return;
    stop = true;
    try {
      const record = JSON.parse(line);
      if (record && typeof record.segment === 'string' && record.segment) found = record.segment;
    } catch {
      found = null;
    }
  });
  return scan.readable ? found : null;
}

// Resolve the pathname that ACTUALLY holds a receipt's segment. Without this an
// old (path, seq) silently aliases whatever record now sits at that ordinal in
// a rotated-then-recreated live file, or returns null for evidence that is
// still on disk under its rotated name.
function resolveRawArchiveSegmentFile(file, segment) {
  if (!segment) return file;
  if (rawArchiveSegmentOf(file) === segment) return file;
  const dir = path.dirname(file);
  const live = path.basename(file);
  const base = live.replace(/\.jsonl$/i, '');
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry === live) continue;
    if (!entry.startsWith(`${base}.`) || !/\.jsonl$/i.test(entry)) continue;
    const candidate = path.join(dir, entry);
    if (rawArchiveSegmentOf(candidate) === segment) return candidate;
  }
  return null;
}

// The number of complete records on disk. `seq` is a POSITION, so it must come
// from the file's record count, never from the last VERIFIED record's ordinal:
// a broken chain in the middle would otherwise make the next append claim a seq
// that is already taken, and a v2 seq that disagrees with its position is now
// (correctly) rejected as corruption.
function rawArchiveRecordCount(file) {
  const scan = forEachRawArchiveLine(file, () => {});
  return scan.readable ? scan.records : 0;
}

function isV2RawRecord(record) {
  return Number(record && record.v) >= QC_RAW_SIDECAR_VERSION;
}

// v1 rows predate the ordinal and metadata contract, so they stay relaxed. A v2
// row that disagrees with its own recorded seq, digest, or bytes is corruption
// that still parses as JSON, and must never become a trusted base for a delta.
function v2RawRecordSeqOk(record, ordinal) {
  if (!isV2RawRecord(record)) return true;
  return Number(record.seq) === ordinal;
}

function rawArchiveRecordKind(record) {
  if (!record || typeof record !== 'object') return 'unknown';
  if (record.kind === 'diff') return 'diff';
  // A v1 row (and a v2 snapshot) is identified by carrying the payload itself.
  if (record.rawResult !== undefined) return 'snapshot';
  return 'unknown';
}

// Replays the sidecar to `untilSeq` (or to the end). Every step is verified
// against the digest recorded with it, and any break in the chain resets the
// state to null so a caller can never diff against, or claim to have rebuilt,
// evidence it could not actually verify.
function readRawArchiveChain(file, { untilSeq = null } = {}) {
  const target = untilSeq == null ? null : Number(untilSeq);
  let state = null;
  let stop = false;
  let segment = null;
  const scan = forEachRawArchiveLine(file, (line, ordinal) => {
    if (stop) return;
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      record = null;
    }
    const kind = rawArchiveRecordKind(record);
    if (ordinal === 0 && record && typeof record.segment === 'string') segment = record.segment;
    // A v2 row whose own recorded ordinal disagrees with its position, or whose
    // segment disagrees with the file it is in, is corruption that parses.
    if (
      record &&
      isV2RawRecord(record) &&
      (!v2RawRecordSeqOk(record, ordinal) ||
        (segment && typeof record.segment === 'string' && record.segment !== segment))
    ) {
      state = null;
      if (target != null && ordinal >= target) stop = true;
      return;
    }
    if (kind === 'diff') {
      const baseSeq = record.baseSeq == null ? null : Number(record.baseSeq);
      if (
        !state ||
        (baseSeq != null && baseSeq !== state.seq) ||
        (record.baseDigest && record.baseDigest !== state.digest)
      ) {
        state = null;
      } else {
        let value = null;
        try {
          value = applyStableValueDiff(state.value, record.delta);
        } catch {
          value = undefined;
        }
        if (value === undefined) {
          state = null;
        } else {
          const text = JSON.stringify(value);
          const digest = sha256(text);
          const bytes = Buffer.byteLength(text, 'utf8');
          const metadataOk =
            !isV2RawRecord(record) ||
            ((!record.digest || record.digest === digest) &&
              (!Number.isFinite(Number(record.bytes)) || Number(record.bytes) === bytes));
          if (!metadataOk || (record.digest && record.digest !== digest)) {
            state = null;
          } else {
            state = {
              seq: ordinal,
              kind: 'diff',
              digest,
              bytes,
              segment,
              value,
              sinceSnapshot: state.sinceSnapshot + 1,
              checkedAt: record.checkedAt == null ? null : record.checkedAt,
              archivedAt: record.archivedAt == null ? null : record.archivedAt,
            };
          }
        }
      }
    } else if (kind === 'snapshot') {
      const value = stableValue(record.rawResult);
      const text = JSON.stringify(value);
      const digest = sha256(text);
      const bytes = Buffer.byteLength(text, 'utf8');
      // A v2 snapshot MUST agree with its own recorded digest and byte count.
      // Accepting valid-JSON corruption here made it the trusted base for every
      // delta that followed, which is exactly the verified-chain contract this
      // format claims to provide.
      const metadataOk =
        !isV2RawRecord(record) ||
        ((!record.digest || record.digest === digest) &&
          (!Number.isFinite(Number(record.bytes)) || Number(record.bytes) === bytes));
      state = metadataOk
        ? {
            seq: ordinal,
            kind: 'snapshot',
            digest,
            bytes,
            segment,
            value,
            sinceSnapshot: 0,
            checkedAt: record.checkedAt == null ? null : record.checkedAt,
            archivedAt: record.archivedAt == null ? null : record.archivedAt,
          }
        : null;
    } else {
      state = null;
    }
    if (target != null && ordinal >= target) stop = true;
  });
  if (!scan.readable) return null;
  // A torn final line means the file is mid-write or was truncated by a crash.
  // The chain up to the last COMPLETE record is still trustworthy, so a read at
  // an earlier seq still succeeds; only a read of the tail fails closed.
  if (scan.torn && target == null) return null;
  if (target != null && (!state || state.seq !== target)) return null;
  if (state) state.segment = segment;
  return state;
}

// Public evidence reader: rebuilds one archived attempt exactly, from the last
// snapshot plus the intervening deltas.
function readArchivedAttemptRawResult({
  dataDir,
  date,
  cardId,
  generationId,
  seq = null,
  file = '',
  segment = '',
} = {}) {
  const named =
    file || rawAttemptArchivePath({ dataDir, date, cardId, generationId });
  // Resolve the pathname that still holds this segment before trusting the seq.
  const target = resolveRawArchiveSegmentFile(named, String(segment || ''));
  if (!target) return null;
  const state = readRawArchiveChain(target, { untilSeq: seq });
  if (!state) return null;
  if (segment && state.segment && state.segment !== segment) return null;
  const text = JSON.stringify(state.value);
  return {
    seq: state.seq,
    kind: state.kind,
    digest: state.digest,
    segment: state.segment || null,
    file: target,
    bytes: Buffer.byteLength(text, 'utf8'),
    checkedAt: state.checkedAt,
    archivedAt: state.archivedAt,
    rawResult: state.value,
  };
}

// Bounded index over the sidecar: what is stored at each seq, without claiming
// to have rebuilt anything.
function listArchivedAttempts({
  dataDir,
  date,
  cardId,
  generationId,
  file = '',
} = {}) {
  const target =
    file || rawAttemptArchivePath({ dataDir, date, cardId, generationId });
  const rows = [];
  const scan = forEachRawArchiveLine(target, (line, ordinal) => {
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      rows.push({
        seq: ordinal,
        kind: 'unreadable',
        v: null,
        digest: null,
        bytes: null,
        baseSeq: null,
      });
      return;
    }
    rows.push({
      seq: ordinal,
      kind: rawArchiveRecordKind(record),
      v: Number(record && record.v) || 1,
      digest: (record && record.digest) || null,
      bytes: Number.isFinite(Number(record && record.bytes))
        ? Number(record.bytes)
        : null,
      checkedAt: record && record.checkedAt != null ? record.checkedAt : null,
      archivedAt:
        record && record.archivedAt != null ? record.archivedAt : null,
      segment: (record && record.segment) || null,
      baseSeq: record && record.baseSeq != null ? Number(record.baseSeq) : null,
    });
  });
  return scan.readable ? rows : [];
}

// Raw archival: every attempt's evidence is appended to the cold sidecar before
// it leaves the receipt, as a snapshot or as a delta against the record already
// on disk. The append is verified by re-stat, and an unverified append reports
// ok:false so the caller keeps the payload inline rather than dropping evidence.
// A delta is written ONLY when it has been proven, in memory, to rebuild the
// exact payload from the exact verified base on disk. Anything less writes a
// snapshot, so the sidecar can never contain evidence it cannot reconstruct.
function archiveAttemptRawResult({ dataDir, date, cardId, generationId, checkedAt, rawResult }) {
  const missed = { ok: false, file: null, rotated: null, seq: null, kind: null, segment: null, reason: 'error' };
  // DECIDED (Codex open question 2026-08-24): JSON null is NOT valid evidence.
  // A QC attempt that produced no scoped board result has nothing to archive,
  // and a rebuilt null is indistinguishable from a failed rebuild, so it would
  // make the reader unable to tell "archived nothing" from "lost everything".
  // The rejection is explicit and reported, and receiptAttempt records
  // rawResultPayloadPresent:false so a reader never has to infer it.
  if (rawResult == null) return { ...missed, reason: 'no-payload' };
  if (!dataDir) return { ...missed, reason: 'no-data-dir' };
  const file = rawAttemptArchivePath({ dataDir, date, cardId, generationId });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // ONE cross-process transaction. Rotation, torn-suffix repair, base
    // selection, append, fsync, and exact reconstruction verification are all
    // read-then-write steps on the same file; interleaving two writers made
    // both emit the same seq and baseSeq, invalidated the loser on replay, and
    // still returned ok:true to both, so both stripped their inline payload.
    return withRawArchiveLock(qcWriteLockDir({ dataDir, date, cardId, generationId }), () => {
      // Rotate first. A delta's base must live in the same file as the delta, so
      // rotation always restarts the chain with a snapshot in a new segment.
      const rotated = rotateRawArchiveIfLarge(file);
      // Then repair: a crash mid-append leaves an incomplete suffix, and
      // appending after it welds the two into one malformed line forever.
      const repaired = repairTornRawArchive(file);
      const value = stableValue(rawResult);
      const text = JSON.stringify(value);
      const digest = sha256(text);
      const bytes = Buffer.byteLength(text, 'utf8');
      const tail = readRawArchiveChain(file);
      const nextSeq = rawArchiveRecordCount(file);
      const segment =
        (tail && tail.segment) || rawArchiveSegmentOf(file) || newRawArchiveSegmentId();
      let record = null;
      if (tail && tail.seq === nextSeq - 1 && tail.sinceSnapshot + 1 < QC_RAW_SNAPSHOT_INTERVAL) {
        const delta = diffStableValue(tail.value, value);
        const deltaBytes = Buffer.byteLength(JSON.stringify(delta), 'utf8');
        let usable = deltaBytes < bytes * QC_RAW_DIFF_MAX_RATIO;
        if (usable) {
          try {
            usable = JSON.stringify(applyStableValueDiff(tail.value, delta)) === text;
          } catch {
            usable = false;
          }
        }
        if (usable) {
          record = {
            v: QC_RAW_SIDECAR_VERSION,
            segment,
            seq: nextSeq,
            kind: 'diff',
            archivedAt: new Date().toISOString(),
            checkedAt: checkedAt || null,
            baseSeq: tail.seq,
            baseDigest: tail.digest,
            // digest/bytes always describe the FULL evidence at this seq, never
            // the delta, so a reader can verify a rebuild without a second lookup.
            digest,
            bytes,
            delta,
          };
        }
      }
      if (!record) {
        record = {
          v: QC_RAW_SIDECAR_VERSION,
          segment,
          seq: nextSeq,
          kind: 'snapshot',
          archivedAt: new Date().toISOString(),
          checkedAt: checkedAt || null,
          digest,
          bytes,
          rawResult: value,
        };
      }
      const appendVerified = (candidate) => {
        let priorSize = 0;
        try {
          priorSize = fs.statSync(file).size;
        } catch {
          priorSize = 0;
        }
        const line = `${JSON.stringify(candidate)}\n`;
        const expected = Buffer.byteLength(line, 'utf8');
        let fd = null;
        try {
          fd = fs.openSync(file, 'a');
          fs.writeSync(fd, line, null, 'utf8');
          // Durable before the caller is told it may drop its only copy.
          fs.fsyncSync(fd);
        } finally {
          try {
            if (fd !== null) fs.closeSync(fd);
          } catch {
            /* best effort */
          }
        }
        if (fs.statSync(file).size - priorSize < expected) return false;
        // A byte count is not archival. Re-read the chain to this exact seq and
        // require it to rebuild the exact payload, or the caller keeps its copy.
        const settled = readRawArchiveChain(file, { untilSeq: candidate.seq });
        return Boolean(
          settled && settled.digest === digest && JSON.stringify(settled.value) === text,
        );
      };
      if (appendVerified(record)) {
        return {
          ok: true,
          file,
          rotated,
          repaired: repaired || null,
          seq: record.seq,
          kind: record.kind,
          segment,
          reason: null,
        };
      }
      // The verified append failed. A self-contained snapshot cannot be
      // orphaned by a base that moved, so retry once as a snapshot. Nothing is
      // removed: the failed record stays on disk, it just stops being the only
      // copy of this evidence.
      const rescue = {
        v: QC_RAW_SIDECAR_VERSION,
        segment,
        seq: rawArchiveRecordCount(file),
        kind: 'snapshot',
        archivedAt: new Date().toISOString(),
        checkedAt: checkedAt || null,
        digest,
        bytes,
        rawResult: value,
      };
      if (!appendVerified(rescue)) {
        return { ok: false, file: null, rotated, repaired: repaired || null, seq: null, kind: null, segment: null, reason: 'unverified-append' };
      }
      return {
        ok: true,
        file,
        rotated,
        repaired: repaired || null,
        seq: rescue.seq,
        kind: 'snapshot',
        segment,
        reason: null,
      };
    });
  } catch {
    return missed;
  }
}

function rawResultDigest(rawResult) {
  if (rawResult == null) return { rawResultBytes: 0, rawResultDigest: null };
  try {
    const text = stableJson(rawResult);
    return { rawResultBytes: Buffer.byteLength(text, 'utf8'), rawResultDigest: sha256(text) };
  } catch {
    return { rawResultBytes: -1, rawResultDigest: null };
  }
}

// ---------------------------------------------------------------------------
// Content-addressed whole-board snapshots.
//
// writeQcReceipt's `rawResult` argument is the SAME scoped live-board result
// (every rendered tile, including raw inner markup) described above the
// per-attempt archive: tens of megabytes. Before this, the receipt's TOP-LEVEL
// `rawResult` field carried a full copy of that inline on every single write,
// separate from the already-bounded `attempts` history -- one 9MB+ file per
// (card, generation) with no dedup, which is what actually filled the disk
// (438 qc-receipt files on one date, ~4-5.5GB). Refreshing several cards from
// the same live board render produces byte-identical `rawResult` values, so
// storing it once per DIGEST per DATE and having every receipt reference that
// digest turns N copies into 1.
//
// The snapshot directory sits beside the per-card receipt directories under
// the same date, so date-scoped retention (task 2) deletes it for free.
const QC_SNAPSHOT_DIR_NAME = '_snapshots';

function boardSnapshotDir({ dataDir, date }) {
  return path.join(dataDir, QC_RECEIPT_REL_DIR, safeSegment(date, 'date'), QC_SNAPSHOT_DIR_NAME);
}

function boardSnapshotPath({ dataDir, date, digest }) {
  return path.join(boardSnapshotDir({ dataDir, date }), `${safeSegment(digest, 'snapshot digest')}.json`);
}

// Content-addressed: identical bytes always hash to the same file, so a write
// that finds the file already present is a correct no-op, not a race.
function writeBoardSnapshotIfAbsent({ dataDir, date, digest, rawResult }) {
  if (!digest) return null;
  const file = boardSnapshotPath({ dataDir, date, digest });
  if (fs.existsSync(file)) return file;
  writeJsonAtomic(file, rawResult);
  try {
    fs.chmodSync(file, 0o444);
  } catch {
    // Some mounted filesystems and Windows do not enforce POSIX mode bits.
  }
  return file;
}

function readBoardSnapshot({ dataDir, date, digest }) {
  if (!digest) return null;
  return readJson(boardSnapshotPath({ dataDir, date, digest }), null);
}

function cardStatusFromRawResult(rawResult, cardId) {
  if (!rawResult || !Array.isArray(rawResult.cardStatuses)) return null;
  return rawResult.cardStatuses.find((status) => status && status.id === cardId) || null;
}

// Transforms an in-memory receipt (or a journal patch's embedded qcReceipt)
// that may carry a full `rawResult` into the small shape that actually gets
// written to disk: the whole-board payload is archived once as a
// content-addressed snapshot, and the receipt keeps only its own card's
// status plus a reference (digest + byte count) back to that snapshot. A null
// rawResult (verify never ran) passes through unchanged -- there is nothing to
// content-address and the legacy shape already handles that case.
function projectReceiptForDisk(receipt, { dataDir, date, cardId }) {
  if (!receipt || typeof receipt !== 'object' || receipt.rawResult == null) return receipt;
  const { rawResultBytes, rawResultDigest: digest } = rawResultDigest(receipt.rawResult);
  writeBoardSnapshotIfAbsent({ dataDir, date, digest, rawResult: receipt.rawResult });
  const disk = { ...receipt };
  delete disk.rawResult;
  disk.cardStatus = cardStatusFromRawResult(receipt.rawResult, cardId);
  disk.rawResultSnapshotDigest = digest;
  disk.rawResultBytes = rawResultBytes;
  return disk;
}

// Read-side counterpart: any receipt loaded from disk that references a
// snapshot gets `rawResult` rehydrated from it, so every existing reader that
// does `someReceipt.rawResult` keeps working unchanged. A receipt written
// before this change (or one whose rawResult was legitimately null) already
// carries the field it needs and passes through untouched.
function hydrateReceiptRawResult(receipt, { dataDir, date }) {
  if (!receipt || typeof receipt !== 'object') return receipt;
  if (receipt.rawResultSnapshotDigest) {
    return { ...receipt, rawResult: readBoardSnapshot({ dataDir, date, digest: receipt.rawResultSnapshotDigest }) };
  }
  if (receipt.rawResult !== undefined) return receipt;
  return { ...receipt, rawResult: null };
}

// An attempt row deliberately never inlines rawResult. rawResult carries the
// whole scoped live-board result (every tile plus its raw inner markup, ~9MB a
// pass) and the attempt list is unbounded, so inlining it grew each candidate
// journal by ~9MB per heal attempt until controller startup hit the V8 heap
// limit while JSON.parse-ing the day's journals.
function receiptAttempt(receipt, { archive = null, attemptId = '' } = {}) {
  const digest = rawResultDigest(receipt.rawResult);
  const archived = Boolean(archive && archive.ok);
  return {
    attemptId: String(attemptId || '') || null,
    ...(receipt.workUnitId ? { workUnitId: receipt.workUnitId } : {}),
    // Fail closed: the payload only leaves the row once the sidecar append was
    // verified on disk.
    ...(archived || receipt.rawResult == null ? {} : { rawResult: receipt.rawResult }),
    rawResultArchived: archived,
    checkedAt: receipt.checkedAt,
    verdict: receipt.verdict,
    appliedToBoard: receipt.appliedToBoard,
    superseded: receipt.superseded,
    supersededBy: receipt.supersededBy,
    targetSignals: receipt.targetSignals,
    siblingSignals: receipt.siblingSignals,
    boardSignals: receipt.boardSignals,
    humanGate: receipt.humanGate,
    humanActionToken: receipt.humanActionToken,
    rawResultBytes: digest.rawResultBytes,
    rawResultDigest: digest.rawResultDigest,
    rawResultArchive: (archive && archive.file) || null,
    // (rawResultArchive, rawResultArchiveSeq) is the exact address of this
    // attempt's evidence, because seq is an ordinal within its own file.
    rawResultArchiveSeq:
      archive && archive.ok && Number.isFinite(Number(archive.seq)) ? Number(archive.seq) : null,
    // The pathname is REUSED after rotation, so the segment is the half of the
    // address that is actually immutable.
    rawResultArchiveSegment: (archive && archive.ok && archive.segment) || null,
    // Explicit, never inferred: a null rawResult is not evidence, it is the
    // absence of evidence, and the archive rejects it on purpose.
    rawResultPayloadPresent: receipt.rawResult != null,
  };
}

// Carries a prior attempt row forward. Rows written before the bound existed,
// and rows whose archive append failed, are retried here. `fallbackRawResult`
// is the top-level copy about to be replaced by this write, so a payload whose
// archive failed is never dropped just because the receipt moved on.
function normalizePriorAttempt(attempt, context, fallbackRawResult = undefined) {
  if (!attempt || typeof attempt !== 'object') return attempt;
  if (attempt.rawResultArchived === true) return attempt;
  const payload = attempt.rawResult !== undefined ? attempt.rawResult : fallbackRawResult;
  if (payload == null) return attempt;
  const archive = archiveAttemptRawResult({
    ...context,
    checkedAt: attempt.checkedAt,
    rawResult: payload,
  });
  const digest = rawResultDigest(payload);
  if (!archive.ok) {
    // Still unarchived: keep the payload inline so nothing is deleted.
    return { ...attempt, ...digest, rawResult: payload, rawResultArchived: false };
  }
  const next = {
    ...attempt,
    ...digest,
    rawResultArchived: true,
    rawResultArchive: archive.file,
    rawResultArchiveSeq: Number.isFinite(Number(archive.seq)) ? Number(archive.seq) : null,
    rawResultArchiveSegment: archive.segment || null,
    rawResultPayloadPresent: true,
  };
  delete next.rawResult;
  return next;
}

function appendAppliedBoardSignals({ dataDir, date, cardId, generationId, boardSignals, now }) {
  if (!Array.isArray(boardSignals) || boardSignals.length === 0) return null;
  const file = boardSignalLedgerPath({ dataDir, date });
  const current = readJson(file, { schemaVersion: SCHEMA_VERSION, date, ownerId: BOARD_OWNER_ID, rows: [] });
  const row = {
    observedAt: now.toISOString(),
    sourceCardId: cardId,
    sourceGenerationId: generationId,
    signals: boardSignals.map((signal) => ({ ownerId: BOARD_OWNER_ID, message: signal.message })),
  };
  const next = { ...current, schemaVersion: SCHEMA_VERSION, date, ownerId: BOARD_OWNER_ID, rows: [...(current.rows || []), row] };
  writeJsonAtomic(file, next);
  return file;
}

function writeQcReceipt({
  dataDir,
  date,
  cardId,
  workUnitId = '',
  generationId,
  generationHash,
  verdict,
  appliedToBoard,
  supersededBy = '',
  targetSignals = [],
  siblingSignals = [],
  boardSignals = [],
  humanGate = null,
  humanActionToken = '',
  rawResult = null,
  attemptId = '',
  now = new Date(),
} = {}) {
  const receipt = {
    schemaVersion: SCHEMA_VERSION,
    date,
    cardId,
    ...(workUnitId ? { workUnitId: String(workUnitId) } : {}),
    generationId,
    generationHash,
    checkedAt: now.toISOString(),
    verdict: String(verdict || 'unknown'),
    appliedToBoard: appliedToBoard === true,
    superseded: appliedToBoard !== true && Boolean(supersededBy),
    supersededBy: String(supersededBy || '') || null,
    targetSignals,
    siblingSignals,
    boardSignals,
    humanGate: humanGate || null,
    humanActionToken: String(humanActionToken || '') || null,
    rawResult,
  };
  const file = qcReceiptPath({ dataDir, date, cardId, generationId });
  const archiveContext = { dataDir, date, cardId, generationId };
  const id = String(attemptId || '').trim();
  receipt.attemptId = id || null;
  // The receipt is a read-modify-write over an unbounded attempts list AND the
  // authority on whether each attempt's payload may leave the row. Two writers
  // outside one lock were last-writer-wins: the loser's attempt row vanished
  // after its payload had already been stripped, so the evidence was gone while
  // both callers had been told ok:true.
  return withRawArchiveLock(qcWriteLockDir(archiveContext), () => {
  const existing = hydrateReceiptRawResult(readJson(file, null), { dataDir, date });

  const rawExisting =
    existing && Array.isArray(existing.attempts) && existing.attempts.length
      ? existing.attempts
      : existing
        ? [receiptAttempt(existing)]
        : [];
  // One logical QC cycle writes this receipt several times (pending, then
  // applied or superseded). A stable attemptId makes those the same attempt, so
  // the payload is archived once instead of once per state transition.
  const matchIndex = id ? rawExisting.findIndex((row) => row && row.attemptId === id) : -1;
  const prior = rawExisting.map((attempt, index) =>
    index === matchIndex
      ? attempt
      : normalizePriorAttempt(
          attempt,
          archiveContext,
          index === rawExisting.length - 1 ? (existing && existing.rawResult) : undefined,
        ),
  );

  if (matchIndex >= 0) {
    const previous = prior[matchIndex];
    const alreadyArchived = previous && previous.rawResultArchived === true;
    const archive = alreadyArchived
      ? {
          ok: true,
          file: previous.rawResultArchive || null,
          seq: Number.isFinite(Number(previous.rawResultArchiveSeq))
            ? Number(previous.rawResultArchiveSeq)
            : null,
          segment: previous.rawResultArchiveSegment || null,
        }
      : archiveAttemptRawResult({ ...archiveContext, checkedAt: receipt.checkedAt, rawResult });
    // Update the existing attempt in place; do not append a second row.
    prior[matchIndex] = receiptAttempt(receipt, { archive, attemptId: id });
    receipt.attempts = prior.slice(-QC_ATTEMPT_HISTORY_LIMIT);
    const priorTotal = Number(existing && existing.attemptsTotal);
    receipt.attemptsTotal = Number.isFinite(priorTotal) && priorTotal > 0 ? priorTotal : prior.length;
    writeJsonAtomic(file, projectReceiptForDisk(receipt, { dataDir, date, cardId }));
  } else {
    const archive = archiveAttemptRawResult({
      ...archiveContext,
      checkedAt: receipt.checkedAt,
      rawResult,
    });
    const allAttempts = [...prior, receiptAttempt(receipt, { archive, attemptId: id })];
    const priorTotal = Number(existing && existing.attemptsTotal);
    receipt.attemptsTotal =
      Number.isFinite(priorTotal) && priorTotal > 0 ? priorTotal + 1 : allAttempts.length;
    // Bounded history: older rows stay recoverable from the raw sidecar, so the
    // receipt itself can never grow without limit across a long healing day.
    receipt.attempts = allAttempts.slice(-QC_ATTEMPT_HISTORY_LIMIT);
    writeJsonAtomic(file, projectReceiptForDisk(receipt, { dataDir, date, cardId }));
  }
  if (receipt.appliedToBoard) {
    appendAppliedBoardSignals({ dataDir, date, cardId, generationId, boardSignals, now });
  }
  return receipt;
  });
}

function markQcReceiptSuperseded({
  dataDir,
  date,
  cardId,
  generationId,
  supersededBy,
  now = new Date(),
} = {}) {
  const file = qcReceiptPath({ dataDir, date, cardId, generationId });
  return withRawArchiveLock(qcWriteLockDir({ dataDir, date, cardId, generationId }), () => {
  const existing = readJson(file, null);
  if (!existing) return null;
  const next = {
    ...existing,
    appliedToBoard: false,
    superseded: true,
    supersededBy: String(supersededBy || 'missing-current-generation'),
    supersededAt: now.toISOString(),
  };
  writeJsonAtomic(file, next);
  return next;
  });
}

module.exports = {
  SCHEMA_VERSION,
  BOARD_OWNER_ID,
  GENERATION_REL_DIR,
  JOURNAL_REL_DIR,
  QC_RECEIPT_REL_DIR,
  TERMINAL_STATES,
  stableJson,
  sha256,
  generationIdForArtifact,
  generationDir,
  generationArtifactPath,
  acceptedGenerationArtifactPath,
  writeImmutableGeneration,
  readImmutableGeneration,
  writeImmutableAcceptedArtifact,
  readImmutableAcceptedArtifact,
  candidateJournalPath,
  candidateRollbackDir,
  snapshotFiles,
  restoreSnapshots,
  readCandidateJournal,
  prepareCandidateJournal,
  transitionCandidateJournal,
  listCandidateJournals,
  readCandidateJournalIndex,
  rawAttemptArchivePath,
  readArchivedAttemptRawResult,
  listArchivedAttempts,
  repairTornRawArchive,
  rawArchiveSegmentOf,
  resolveRawArchiveSegmentFile,
  withRawArchiveLock,
  qcWriteLockDir,
  diffStableValue,
  applyStableValueDiff,
  QC_ATTEMPT_HISTORY_LIMIT,
  QC_RAW_ARCHIVE_MAX_BYTES,
  QC_RAW_SIDECAR_VERSION,
  QC_RAW_SNAPSHOT_INTERVAL,
  JOURNAL_FULL_PARSE_MAX_BYTES,
  legacySingletonPath,
  migrateLegacySingletonJournal,
  recoverCandidateJournals,
  isPageWideSignal,
  partitionQcSignals,
  qcReceiptPath,
  readQcReceipt,
  markQcReceiptSuperseded,
  boardSignalLedgerPath,
  writeQcReceipt,
  boardSnapshotDir,
  boardSnapshotPath,
  writeBoardSnapshotIfAbsent,
  readBoardSnapshot,
  cardStatusFromRawResult,
  projectReceiptForDisk,
  hydrateReceiptRawResult,
  rawResultDigest,
};
