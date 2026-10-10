'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { briefingUnitCounts } = require('./live-board-truth.js');
const { projectSystemHealthRows, resolveLedgerDataDir } = require('./system-health-ledger.js');

// Keep the wire schema additive so a rolling EC2/local deployment can read
// either side of the change. schemaRevision identifies the richer payload.
const ROSTER_SCHEMA = 'overnight-red-roster@1';
const ROSTER_SCHEMA_REVISION = 2;
const ROSTER_CANDIDATE_SCHEMA = 'overnight-red-roster-candidate@1';
const ROSTER_CANDIDATE_SCHEMA_REVISION = 2;
const RECEIPT_RECOVERY_DATE = '2026-08-31';

function safeDate(value) {
  const date = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('overnight red roster date must be YYYY-MM-DD');
  }
  return date;
}

function rosterPath(dataDir, date) {
  if (!dataDir) throw new Error('overnight red roster dataDir is required');
  return path.join(String(dataDir), 'agent', 'overnight-red-rosters', `${safeDate(date)}.json`);
}

function rosterCandidatePath(dataDir, date) {
  if (!dataDir) throw new Error('overnight red roster dataDir is required');
  return path.join(
    String(dataDir),
    'agent',
    'overnight-red-roster-candidates',
    `${safeDate(date)}.json`,
  );
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function stableOwner(value, fallback) {
  const row = value && typeof value === 'object' ? value : {};
  return String(row.owner || row.ownerCardId || row.producer || fallback || '').trim();
}

function evidenceIdentity(value) {
  return sha256(JSON.stringify(value));
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function defectEvidenceForCard(board, cardId) {
  const id = String(cardId || '').toLowerCase();
  const defects = Array.isArray(board && board.defects) ? board.defects : [];
  if (id === 'system_health') {
    return (Array.isArray(board && board.systemHealthMeasurements)
      ? board.systemHealthMeasurements
      : [])
      .filter(
        (row) =>
          row &&
          String(row.status || '').toLowerCase() !== 'green',
      )
      .map((row) => `${row.name || row.id}: ${row.detail || row.status || 'red'}`);
  }
  return defects
    .map(String)
    .filter((defect) => defect.toLowerCase().includes(id))
    .slice(0, 12);
}

function buildOvernightRedRoster({
  date,
  board,
  capturedAt = new Date().toISOString(),
  dataDir = null,
  // A RECONSTRUCTED board is rebuilt from a controller receipt's exact work
  // units, not read from the live board, so it carries only the metrics that
  // receipt proved. It still must carry exact proof; it just cannot be held to
  // the permanent ledger's whole row set, which only the live board projects.
  reconstructedMeasurements = false,
} = {}) {
  const day = safeDate(date);
  if (!board || typeof board !== 'object') throw new Error('current live board is required');
  if (String(board.date || '').slice(0, 10) !== day) {
    throw new Error(`live board date ${board.date || 'missing'} does not match ${day}`);
  }
  if (board.ran !== true) throw new Error('live board has not completed live QC');
  const capturedAtMs = Date.parse(String(capturedAt || ''));
  if (!Number.isFinite(capturedAtMs)) throw new Error('capturedAt must be an ISO timestamp');

  // A BOARD THAT PREDATES THE LEDGER IS PROJECTED, NOT REFUSED. EC2 holds the
  // last pre-deploy board (39 rows) until the first post-deploy publish, and
  // an incomplete row set used to throw here, so the night froze no roster at
  // all. The ledger is the permanent row set: project it over whatever the
  // board carries (board rows keep their detail text) and the roster is
  // complete by construction.
  let measurementSource = 'live-board';
  const preCounts = briefingUnitCounts(board);
  if (!reconstructedMeasurements && (!preCounts || preCounts.complete !== true)) {
    const root = resolveLedgerDataDir(dataDir);
    if (root) {
      board = {
        ...board,
        systemHealthMeasurements: projectSystemHealthRows({
          dataDir: root,
          artifactRows: Array.isArray(board.systemHealthMeasurements)
            ? board.systemHealthMeasurements
            : [],
        }),
      };
      measurementSource = 'ledger-projection';
    }
  }

  const cardRows = (Array.isArray(board.cards) ? board.cards : [])
    .filter((card) => card && String(card.status || '').toLowerCase() !== 'clean')
    .map((card) => {
      const id = String(card.id || '');
      const state = String(card.status || 'defect').toLowerCase();
      const defectKinds = Array.isArray(card.defectKinds) ? card.defectKinds.map(String) : [];
      const evidence = defectEvidenceForCard(board, card.id);
      const asOf = String(card.asOf || board.ts || '');
      return {
        id,
        title: String(card.title || card.id || 'Unknown card'),
        status: state,
        state,
        owner: stableOwner(card, id),
        defectKinds,
        evidence,
        evidenceHash: evidenceIdentity({ id, state, defectKinds, evidence, asOf }),
        asOf,
      };
    });
  const counts = briefingUnitCounts(board);
  const measurementProof = reconstructedMeasurements
    ? !!counts && counts.systemHealthMetricTotal > 0
    : !!counts && counts.complete === true;
  if (!measurementProof) {
    throw new Error('live board is missing exact System Health measurement proof');
  }
  const exactRepairUnits = counts.redUnits.map((unit) => {
    const id = String(unit.id || '');
    const state = String(unit.status || 'red');
    const kind = String(unit.kind || 'card');
    const source = kind === 'system-health-measurement'
      ? (Array.isArray(board.systemHealthMeasurements) ? board.systemHealthMeasurements : [])
          .find((row) => String(row && (row.id || row.name) || '') === id)
      : (Array.isArray(board.cards) ? board.cards : [])
          .find((row) => String(row && row.id || '') === id);
    const evidence = kind === 'system-health-measurement'
      ? [String(source && (source.detail || source.status) || state)]
      : defectEvidenceForCard(board, id);
    return {
      id,
      title: String(unit.title || unit.id || 'Unknown unit'),
      kind,
      status: state,
      state,
      owner: stableOwner(source, kind === 'system-health-measurement' ? 'system_health' : id),
      evidenceHash: evidenceIdentity({ id, kind, state, evidence }),
    };
  });
  return {
    schema: ROSTER_SCHEMA,
    schemaRevision: ROSTER_SCHEMA_REVISION,
    date: day,
    capturedAt: new Date(capturedAtMs).toISOString(),
    boardAsOf: String(board.ts || ''),
    boardSha256: sha256(JSON.stringify(board)),
    measurementSource,
    cardCount: cardRows.length,
    exactRepairUnitCount: exactRepairUnits.length,
    canonicalDefectiveCardCount: Number(board.defectiveCardCount || cardRows.length),
    cards: cardRows,
    exactRepairUnits,
  };
}

function buildOvernightRedRosterCandidate({
  date,
  board,
  capturedAt = new Date().toISOString(),
} = {}) {
  const day = safeDate(date);
  if (!board || typeof board !== 'object') throw new Error('bootstrap live board is required');
  if (String(board.date || '').slice(0, 10) !== day) {
    throw new Error(`live board date ${board.date || 'missing'} does not match ${day}`);
  }
  if (board.ran !== true) throw new Error('bootstrap live board has not completed live QC');
  const capturedAtMs = Date.parse(String(capturedAt || ''));
  if (!Number.isFinite(capturedAtMs)) throw new Error('capturedAt must be an ISO timestamp');
  const cards = (Array.isArray(board.cards) ? board.cards : [])
    .filter(
      (card) =>
        card &&
        String(card.id || '') !== 'blockers' &&
        String(card.status || '').toLowerCase() !== 'clean',
    )
    .map((card) => {
      const id = String(card.id || '');
      const state = String(card.status || 'defect').toLowerCase();
      const defectKinds = Array.isArray(card.defectKinds) ? card.defectKinds.map(String) : [];
      const asOf = String(card.asOf || board.ts || capturedAt);
      return {
        id,
        title: String(card.title || card.id || 'Unknown card'),
        status: state,
        state,
        owner: stableOwner(card, id),
        evidenceHash: evidenceIdentity({ id, state, defectKinds, asOf }),
        defectKinds,
        representedBy: card.representedBy ? String(card.representedBy) : undefined,
        asOf,
      };
    });
  if (!cards.length) throw new Error('bootstrap live board has no non-clean source cards');
  return {
    schema: ROSTER_CANDIDATE_SCHEMA,
    schemaRevision: ROSTER_CANDIDATE_SCHEMA_REVISION,
    date: day,
    capturedAt: new Date(capturedAtMs).toISOString(),
    boardAsOf: String(board.ts || capturedAt),
    boardSha256: sha256(JSON.stringify(board)),
    cards,
    defects: Array.isArray(board.defects) ? board.defects.map(String) : [],
  };
}

function readOvernightRedRosterCandidate({ dataDir, date } = {}) {
  const file = rosterCandidatePath(dataDir, date);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      !parsed ||
      parsed.schema !== ROSTER_CANDIDATE_SCHEMA ||
      parsed.date !== safeDate(date) ||
      !Array.isArray(parsed.cards) ||
      parsed.cards.length === 0
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function captureOvernightRedRosterCandidate({ dataDir, date, board, capturedAt } = {}) {
  const file = rosterCandidatePath(dataDir, date);
  const existing = readOvernightRedRosterCandidate({ dataDir, date });
  if (existing) return { file, candidate: existing, wasAlreadyCaptured: true };
  const candidate = buildOvernightRedRosterCandidate({ date, board, capturedAt });
  atomicWriteJson(file, candidate);
  return { file, candidate, wasAlreadyCaptured: false };
}

function finalizeOvernightRedRosterCandidate({ dataDir, date, board } = {}) {
  const existing = readOvernightRedRoster({ dataDir, date });
  if (existing) {
    return { completed: true, roster: existing, wasAlreadyFrozen: true };
  }
  const candidate = readOvernightRedRosterCandidate({ dataDir, date });
  if (!candidate) return { completed: false, reason: 'missing-bootstrap-candidate' };
  const measurements = Array.isArray(board && board.systemHealthMeasurements)
    ? board.systemHealthMeasurements
    : [];
  if (!board || String(board.date || '').slice(0, 10) !== safeDate(date)) {
    return { completed: false, reason: 'missing-current-board' };
  }
  if (!measurements.length) {
    return { completed: false, reason: 'exact-system-health-not-ready' };
  }
  const combinedBoard = {
    ...board,
    ts: candidate.boardAsOf || candidate.capturedAt,
    ran: true,
    ok: false,
    cards: candidate.cards,
    defects: candidate.defects,
    defectiveCardCount: candidate.cards.length,
    systemHealthMeasurements: measurements,
  };
  const frozen = freezeOvernightRedRoster({
    dataDir,
    date,
    board: combinedBoard,
    capturedAt: candidate.capturedAt,
  });
  return {
    completed: true,
    candidate,
    ...frozen,
  };
}

function readOvernightRedRoster({ dataDir, date } = {}) {
  const file = rosterPath(dataDir, date);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      !parsed ||
      parsed.schema !== ROSTER_SCHEMA ||
      parsed.date !== safeDate(date)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function freezeOvernightRedRoster({ dataDir, date, board, capturedAt } = {}) {
  const file = rosterPath(dataDir, date);
  const existing = readOvernightRedRoster({ dataDir, date });
  if (existing) return { file, roster: existing, wasAlreadyFrozen: true };
  const roster = buildOvernightRedRoster({ date, board, capturedAt, dataDir });
  atomicWriteJson(file, roster);
  return { file, roster, wasAlreadyFrozen: false };
}

function recoverOvernightRedRosterFromControllerReceipt({
  dataDir,
  date,
  receiptPath = '',
  recoveredAt = new Date().toISOString(),
  dryRun = false,
} = {}) {
  const day = safeDate(date);
  if (day !== RECEIPT_RECOVERY_DATE) {
    throw new Error(`controller-receipt roster recovery is authorized only for ${RECEIPT_RECOVERY_DATE}`);
  }
  const existing = readOvernightRedRoster({ dataDir, date: day });
  if (existing) {
    return { file: rosterPath(dataDir, day), roster: existing, wasAlreadyFrozen: true };
  }
  const resolvedReceiptPath = path.resolve(String(receiptPath || ''));
  const canonicalRunDir = path.resolve(
    String(dataDir || ''),
    'agent',
    'card-controller',
    'runs',
    day,
  );
  if (!receiptPath || !fs.existsSync(resolvedReceiptPath)) {
    throw new Error('existing controller receipt path is required for red-roster recovery');
  }
  if (path.dirname(resolvedReceiptPath) !== canonicalRunDir) {
    throw new Error(
      `controller receipt must be inside the canonical same-date run directory ${canonicalRunDir}`,
    );
  }
  const rawReceipt = fs.readFileSync(resolvedReceiptPath, 'utf8');
  const receipt = JSON.parse(rawReceipt);
  if (String(receipt.date || '').slice(0, 10) !== day || receipt.mode !== 'overnight') {
    throw new Error('controller receipt must be an overnight run for the requested date');
  }
  const receiptScanFailures = [];
  const eligibleReceipts = fs
    .readdirSync(canonicalRunDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const file = path.join(canonicalRunDir, entry.name);
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const actions = Array.isArray(parsed.cards) ? parsed.cards : [];
        const evidenceBearing = actions.some(
          (action) =>
            action &&
            String(action.cardId || '').trim() &&
            ((Array.isArray(action.defectsBefore) && action.defectsBefore.length) ||
              (Array.isArray(action.workUnitIds) && action.workUnitIds.length)),
        );
        const startedAtMs = Date.parse(String(parsed.startedAt || ''));
        const sameDateOvernight =
          String(parsed.date || '').slice(0, 10) === day && parsed.mode === 'overnight';
        if (sameDateOvernight && evidenceBearing && !Number.isFinite(startedAtMs)) {
          receiptScanFailures.push(`${entry.name}:missing-valid-startedAt`);
          return null;
        }
        return sameDateOvernight && evidenceBearing
          ? { file: path.resolve(file), startedAtMs }
          : null;
      } catch (error) {
        receiptScanFailures.push(`${entry.name}:unreadable-json`);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.startedAtMs - b.startedAtMs || a.file.localeCompare(b.file));
  if (receiptScanFailures.length) {
    throw new Error(
      `cannot prove the earliest controller receipt while sibling receipt(s) are unreadable: ${receiptScanFailures.join(', ')}`,
    );
  }
  if (!eligibleReceipts.length || eligibleReceipts[0].file !== resolvedReceiptPath) {
    throw new Error('supplied receipt is not the earliest evidence-bearing overnight controller receipt');
  }
  const startedAtMs = Date.parse(String(receipt.startedAt || ''));
  if (!Number.isFinite(startedAtMs)) {
    throw new Error('controller receipt is missing a valid startedAt timestamp');
  }
  const actions = Array.isArray(receipt.cards) ? receipt.cards : [];
  const evidenceByCard = new Map();
  const evidenceByWorkUnit = new Map();
  for (const action of actions) {
    const cardId = String(action && action.cardId || '').trim();
    if (!cardId) continue;
    const defectsBefore = Array.isArray(action.defectsBefore)
      ? action.defectsBefore.map(String).filter(Boolean)
      : [];
    const workUnitIds = Array.isArray(action.workUnitIds)
      ? action.workUnitIds.map(String).filter(Boolean)
      : [];
    const reportEvidence = action.reportEvidence || {};
    // The pinned 2026-08-31 recovery uses the full overnight bootstrap receipt:
    // its proven red System Health parent establishes that every exact planned
    // measurement began red, while later actions may carry the per-unit prose.
    for (const workUnitId of workUnitIds.filter((id) => id.startsWith('system_health:'))) {
      const reportEvidenceId = String(reportEvidence.id || '').trim();
      const exact = reportEvidenceId
        ? reportEvidenceId === workUnitId
        : workUnitIds.length === 1;
      if (!evidenceByWorkUnit.has(workUnitId)) {
        evidenceByWorkUnit.set(workUnitId, exact ? reportEvidence : null);
      } else if (exact && evidenceByWorkUnit.get(workUnitId) === null) {
        evidenceByWorkUnit.set(workUnitId, reportEvidence);
      }
    }
    if (defectsBefore.length && !evidenceByCard.has(cardId)) {
      evidenceByCard.set(cardId, { action, defectsBefore, workUnitIds });
    }
  }
  const finalRedIds = (Array.isArray(receipt.final && receipt.final.nonCleanCards)
    ? receipt.final.nonCleanCards
    : [])
    .map((row) => String(row && row.id || '').trim())
    .filter(Boolean);
  const unprovedFinalReds = finalRedIds.filter((cardId) => !evidenceByCard.has(cardId));
  if (unprovedFinalReds.length) {
    throw new Error(
      `controller receipt cannot prove the starting state of final red card(s): ${unprovedFinalReds.join(', ')}`,
    );
  }
  const plannedWorkUnits = [...new Set(
    (Array.isArray(receipt.plannedWorkUnits) ? receipt.plannedWorkUnits : [])
      .map(String)
      .filter((id) => id.startsWith('system_health:')),
  )].sort();
  const evidencedWorkUnits = [...evidenceByWorkUnit.keys()].sort();
  if (
    plannedWorkUnits.length !== evidencedWorkUnits.length ||
    plannedWorkUnits.some((id, index) => id !== evidencedWorkUnits[index])
  ) {
    throw new Error('controller receipt exact System Health work units do not reconcile');
  }
  if (!evidenceByCard.size) {
    throw new Error('controller receipt contains no proven starting red cards');
  }
  if (evidenceByWorkUnit.size && !evidenceByCard.has('system_health')) {
    throw new Error('controller receipt has exact System Health work units without a proven red parent card');
  }
  const cards = [...evidenceByCard.entries()].map(([cardId, { action, defectsBefore }]) => {
    const reportEvidence = action.reportEvidence || {};
    return {
      id: cardId,
      title: String(reportEvidence.title || cardId),
      status: 'defect',
      defectKinds: defectsBefore,
      asOf: new Date(startedAtMs).toISOString(),
    };
  });
  const systemHealthMeasurements = evidencedWorkUnits.map((id) => {
    const exactEvidence = evidenceByWorkUnit.get(id);
    const title = String(exactEvidence?.title || '')
      .replace(/^SYSTEM HEALTH\s*[·:-]\s*/i, '')
      .trim();
    return {
      id,
      name: title || id,
      status: 'red',
      detail: exactEvidence
        ? String(exactEvidence.whyRed || 'Red in the first overnight controller receipt.')
        : 'Recovered as red from the exact planned work-unit set; per-unit starting prose was not preserved.',
    };
  });
  if (cards.some((card) => card.id === 'system_health') && !systemHealthMeasurements.length) {
    throw new Error('controller receipt has a red System Health card without exact work-unit proof');
  }
  const recoveryBoard = {
    date: day,
    ts: new Date(startedAtMs).toISOString(),
    ran: true,
    ok: false,
    defectiveCardCount: cards.length,
    cards,
    defects: [...evidenceByCard.entries()].map(([cardId, { action, defectsBefore }]) => {
      const whyRed = String(action.reportEvidence?.whyRed || '').trim();
      return `DEFECT: ${cardId} ${whyRed || defectsBefore.join(', ')}`;
    }),
    systemHealthMeasurements,
  };
  const roster = {
    ...buildOvernightRedRoster({
      date: day,
      board: recoveryBoard,
      capturedAt: new Date(startedAtMs).toISOString(),
      reconstructedMeasurements: true,
    }),
    recovery: {
      source: 'first-overnight-controller-receipt',
      reconciledAgainst: 'first-controller-receipt-final-non-clean-cards',
      runId: String(receipt.runId || ''),
      receiptPath: resolvedReceiptPath,
      receiptSha256: sha256(rawReceipt),
      recoveredAt: new Date(recoveredAt).toISOString(),
    },
  };
  const file = rosterPath(dataDir, day);
  if (!dryRun) atomicWriteJson(file, roster);
  return { file, roster, wasAlreadyFrozen: false, recovered: true, dryRun };
}

function rosterOutcomes(roster, board) {
  if (!roster || !Array.isArray(roster.cards)) return [];
  const currentCards = new Map(
    (Array.isArray(board && board.cards) ? board.cards : []).map((card) => [
      String((card && card.id) || ''),
      card,
    ]),
  );
  return roster.cards.map((item) => {
    const current = currentCards.get(String(item.id || ''));
    const finalStatus = current ? String(current.status || 'unknown').toLowerCase() : 'missing';
    return {
      ...item,
      startingStatus: String(item.status || 'red').toLowerCase(),
      finalStatus,
      cleared: finalStatus === 'clean',
      finalAsOf: String((current && current.asOf) || (board && board.ts) || ''),
    };
  });
}

module.exports = {
  ROSTER_SCHEMA,
  ROSTER_SCHEMA_REVISION,
  ROSTER_CANDIDATE_SCHEMA,
  ROSTER_CANDIDATE_SCHEMA_REVISION,
  RECEIPT_RECOVERY_DATE,
  rosterPath,
  rosterCandidatePath,
  buildOvernightRedRoster,
  buildOvernightRedRosterCandidate,
  readOvernightRedRoster,
  readOvernightRedRosterCandidate,
  freezeOvernightRedRoster,
  recoverOvernightRedRosterFromControllerReceipt,
  captureOvernightRedRosterCandidate,
  finalizeOvernightRedRosterCandidate,
  rosterOutcomes,
};
