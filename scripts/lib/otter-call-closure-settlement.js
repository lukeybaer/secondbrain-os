'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  exactClosureProof,
  HANDOFF_SCHEMA,
  handoffPath,
  handoffProblems,
  transitionHandoff,
} = require('./otter-call-healer-handoff');

const SETTLEMENT_SCHEMA = 'life_archive_otter_call_closure_settlement.v1';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function saveJsonAtomic(file, value, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fsApi.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fsApi.renameSync(temp, file);
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(file, fsApi = fs) {
  return JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function settlementPath(settlementDir, otid, sourceRevision) {
  return path.join(
    path.resolve(settlementDir),
    `${sha256(`${String(otid || '')}\u0000${String(sourceRevision || '')}`)}.json`,
  );
}

function applyCommittedClosureSettlements({
  settlementDir,
  report,
  fsApi = fs,
} = {}) {
  for (const call of report?.calls || []) {
    const otid = String(call?.otid || '');
    const sourceRevision = String(call?.source_revision_hash || '');
    if (!otid || !/^[a-f0-9]{64}$/.test(sourceRevision)) continue;
    const file = settlementPath(settlementDir, otid, sourceRevision);
    if (!fsApi.existsSync(file)) continue;
    const settlement = readJson(file, fsApi);
    if (
      settlement.schema !== SETTLEMENT_SCHEMA ||
      settlement.state !== 'committed' ||
      String(settlement.otid || '') !== otid ||
      String(settlement.source_revision_hash || '') !== sourceRevision
    ) {
      continue;
    }
    const manifestHash = String(
      call?.receipt_closure?.manifest_hash ||
        call?.receipt_closure?.manifest?.manifest_hash ||
        '',
    );
    const settledManifestHash = String(
      settlement?.closure_proof?.manifest_hash || '',
    );
    const correctionAuthorization = call?.receipt_closure?.correction_authorization;
    const recoveredEvidenceSupersedesTerminal = Boolean(
      settlement?.closure_proof?.terminal_disposition === true &&
        call?.receipt_closure?.closed === true &&
        call?.receipt_closure?.terminal_disposition !== true &&
        manifestHash &&
        manifestHash !== settledManifestHash,
    );
    const settlementProofIsWellFormed = /^[a-f0-9]{64}$/.test(settledManifestHash);
    if (call.closed !== true && settlementProofIsWellFormed) {
      call.closure_settlement = {
        state: 'superseded_by_current_evaluation',
        file,
        settlement_id: settlement.settlement_id,
        manifest_hash: settledManifestHash,
        committed_at: settlement.committed_at,
        reason:
          'Current processing evidence no longer satisfies every required stage; the prior receipt settlement is retained for audit but cannot override the current evaluation.',
      };
      continue;
    }
    if (
      call?.receipt_closure?.closed !== true ||
      !manifestHash ||
      manifestHash !== settledManifestHash
    ) {
      if (recoveredEvidenceSupersedesTerminal) {
        call.closure_settlement = {
          state: 'superseded_by_recovered_source_evidence',
          file,
          settlement_id: settlement.settlement_id,
          manifest_hash: settledManifestHash,
          replacement_manifest_hash: manifestHash,
          committed_at: settlement.committed_at,
        };
        continue;
      }
      if (
        call?.receipt_closure?.closed === true &&
        manifestHash &&
        correctionAuthorization?.ok === true &&
        manifestHash !== settledManifestHash
      ) {
        call.closure_settlement = {
          state: 'superseded_by_authorized_receipt_correction',
          file,
          settlement_id: settlement.settlement_id,
          manifest_hash: settledManifestHash,
          replacement_manifest_hash: manifestHash,
          committed_at: settlement.committed_at,
          correction_authorization: correctionAuthorization.file || '',
        };
        continue;
      }
      throw new Error(
        `committed Otter closure settlement contradicts current exact receipts: ${otid}`,
      );
    }
    call.status = 'closed';
    call.closed = true;
    call.failed_stages = [];
    call.next_failed_stage = '';
    call.repair_stage = '';
    call.repair_deadline_breached = false;
    call.closure_settlement = {
      state: 'committed',
      file,
      settlement_id: settlement.settlement_id,
      manifest_hash: settledManifestHash,
      committed_at: settlement.committed_at,
    };
  }
  return report;
}

function materializeReceiptClosureHandoff({
  file,
  call,
  closureProof,
  now,
  fsApi = fs,
}) {
  const at = now();
  const handoff = {
    schema: HANDOFF_SCHEMA,
    handoff_id: `otter-call-handoff:${sha256(
      `${String(call.otid || '')}\u0000${String(call.source_revision_hash || '')}`,
    ).slice(0, 32)}`,
    state: 'closed',
    revision: 1,
    emitted_at: at,
    updated_at: at,
    otid: String(call.otid || ''),
    source_revision_hash: String(call.source_revision_hash || ''),
    envelope_hash: String(call?.exact_completion_envelope?.bundle_hash || ''),
    failed_stage: 'exact_revision_closure',
    target_id: `call:${String(call.otid || '')}`,
    failed_stages: [],
    stage_deadline_at: call?.orchestration?.exact_revision_closure?.deadline_at || '',
    stage_detail: 'recovered from verified exact-revision stage receipts',
    trigger: 'receipt_closure_settlement_recovery',
    terminal_blocked: false,
    terminal_blocked_reason: '',
    cycle_status: 'RECEIPT_CLOSURE_RECOVERED',
    cycles_consumed: 0,
    no_progress_streak: 0,
    claim: null,
    closure_proof: closureProof,
    supersession_proof: null,
    history: [
      {
        at,
        from: '',
        to: 'closed',
        reason: 'receipt_closure_settlement_recovery',
        failed_stage: 'exact_revision_closure',
        cycles_consumed: 0,
        no_progress_streak: 0,
        proof: closureProof,
      },
    ],
  };
  const problems = handoffProblems(handoff);
  if (problems.length) {
    throw new Error(`invalid recovered Otter closure handoff: ${problems.join('; ')}`);
  }
  saveJsonAtomic(file, handoff, fsApi);
  return handoff;
}

function publishLedgerWithHandoffSettlement({
  ledgerFile,
  handoffDir,
  settlementDir,
  report,
  fsApi = fs,
  transitionFn = transitionHandoff,
  saveJsonFn = saveJsonAtomic,
  now = () => new Date().toISOString(),
}) {
  const prepared = [];
  const ledgerHash = sha256(jsonBytes(report));
  for (const call of report?.calls || []) {
    if (call?.closed !== true) continue;
    const otid = String(call.otid || '');
    const sourceRevision = String(call.source_revision_hash || '');
    if (!otid || !/^[a-f0-9]{64}$/.test(sourceRevision)) {
      throw new Error('closed Otter call lacks exact raw revision');
    }
    const handoffFile = handoffPath(handoffDir, otid, sourceRevision);
    let handoff = fsApi.existsSync(handoffFile) ? readJson(handoffFile, fsApi) : null;
    let closureProof = exactClosureProof(
      call,
      handoff || { source_revision_hash: sourceRevision },
    );
    if (!handoff && closureProof) {
      handoff = materializeReceiptClosureHandoff({
        file: handoffFile,
        call,
        closureProof,
        now,
        fsApi,
      });
    }
    if (!handoff) continue;
    if (!closureProof) {
      throw new Error(`closed Otter call lacks exact handoff closure proof: ${otid}`);
    }
    const file = settlementPath(settlementDir, otid, sourceRevision);
    const prior = fsApi.existsSync(file) ? readJson(file, fsApi) : null;
    const correctionAuthorization = call?.receipt_closure?.correction_authorization;
    const terminalSupersededByRecoveredEvidence = Boolean(
      prior?.closure_proof?.terminal_disposition === true &&
        closureProof.terminal_disposition !== true,
    );
    let effectivePrior = prior;
    if (
      effectivePrior &&
      (
        effectivePrior.schema !== SETTLEMENT_SCHEMA ||
        String(effectivePrior.otid || '') !== otid ||
        String(effectivePrior.source_revision_hash || '') !== sourceRevision ||
        String(effectivePrior.closure_proof?.manifest_hash || '') !== closureProof.manifest_hash
      )
    ) {
      const priorManifestHash = String(effectivePrior.closure_proof?.manifest_hash || '');
      if (
        (correctionAuthorization?.ok === true || terminalSupersededByRecoveredEvidence) &&
        priorManifestHash &&
        priorManifestHash !== closureProof.manifest_hash
      ) {
        const archive = path.join(
          path.resolve(settlementDir),
          'superseded',
          path.basename(file, '.json'),
          `${priorManifestHash}.json`,
        );
        if (!fsApi.existsSync(archive)) {
          saveJsonFn(archive, {
            ...effectivePrior,
            state: 'superseded',
            superseded_at: now(),
            superseded_by_manifest_hash: closureProof.manifest_hash,
            correction_authorization: correctionAuthorization?.file || '',
            supersession_reason: terminalSupersededByRecoveredEvidence
              ? 'recovered_source_evidence_supersedes_terminal_disposition'
              : '',
          }, fsApi);
        }
        effectivePrior = null;
      } else {
        throw new Error(`existing Otter closure settlement contradicts exact closure: ${otid}`);
      }
    }
    let journal = effectivePrior || {
      schema: SETTLEMENT_SCHEMA,
      settlement_id: `otter-call-closure:${sha256(`${otid}\u0000${sourceRevision}`).slice(0, 24)}`,
      otid,
      source_revision_hash: sourceRevision,
      handoff_file: handoffFile,
      ledger_file: path.resolve(ledgerFile),
      closure_proof: closureProof,
      state: 'prepared',
      prepared_at: now(),
      handoff_settled_at: '',
      ledger_published_at: '',
      committed_at: '',
    };
    if (!effectivePrior) saveJsonFn(file, journal, fsApi);
    if (handoff.state === 'closed') {
      if (
        String(handoff.closure_proof?.source_revision_hash || '') !== sourceRevision ||
        String(handoff.closure_proof?.manifest_hash || '') !== closureProof.manifest_hash
      ) {
        if (correctionAuthorization?.ok === true || terminalSupersededByRecoveredEvidence) {
          transitionFn(handoffFile, 'closed', {
            closureProof,
            reason: terminalSupersededByRecoveredEvidence
              ? 'recovered_source_evidence_reclosed'
              : 'authorized_owner_identity_correction_reclosed',
            fsApi,
          });
        } else {
          throw new Error(`terminal Otter handoff contradicts exact closure: ${otid}`);
        }
      }
    } else {
      transitionFn(handoffFile, 'closed', {
        closureProof,
        reason: 'exact_receipt_closure_committed',
        fsApi,
      });
    }
    if (!['handoff_settled', 'ledger_published', 'committed'].includes(journal.state)) {
      journal = {
        ...journal,
        state: 'handoff_settled',
        handoff_settled_at: now(),
      };
      saveJsonFn(file, journal, fsApi);
    }
    prepared.push({ file, journal });
  }

  const currentLedgerHash = fsApi.existsSync(ledgerFile)
    ? sha256(fsApi.readFileSync(ledgerFile))
    : '';
  if (currentLedgerHash !== ledgerHash) {
    saveJsonFn(ledgerFile, report, fsApi);
  }

  const settlements = prepared.map(({ file, journal: preparedJournal }) => {
    let journal = preparedJournal;
    if (
      !['ledger_published', 'committed'].includes(journal.state) ||
      journal.ledger_hash !== ledgerHash
    ) {
      journal = {
        ...journal,
        state: 'ledger_published',
        ledger_hash: ledgerHash,
        ledger_published_at: now(),
        committed_at: '',
      };
      saveJsonFn(file, journal, fsApi);
    }
    const committed = {
      ...journal,
      state: 'committed',
      committed_at:
        journal.state === 'committed' && journal.ledger_hash === ledgerHash
          ? journal.committed_at
          : now(),
    };
    if (journal.state !== 'committed') saveJsonFn(file, committed, fsApi);
    return { ...committed, file };
  });
  return {
    ok: true,
    ledger_file: path.resolve(ledgerFile),
    settlements,
  };
}

module.exports = {
  SETTLEMENT_SCHEMA,
  applyCommittedClosureSettlements,
  publishLedgerWithHandoffSettlement,
  settlementPath,
};
