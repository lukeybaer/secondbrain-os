'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HANDOFF_SCHEMA = 'life_archive_otter_call_healer_handoff.v2';
const ACTIVE_STATES = new Set(['queued', 'claimed', 'deferred', 'advanced']);
const TERMINAL_STATES = new Set(['closed', 'superseded_with_proof']);
const VALID_STATES = new Set([...ACTIVE_STATES, ...TERMINAL_STATES]);

function lockSlug(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || 'unknown'))
    .digest('hex')
    .slice(0, 32);
}

function readJson(file, fallback = null, fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function saveJsonAtomic(file, value, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fsApi.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fsApi.renameSync(temp, file);
}

function sleepMs(ms) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    Math.max(1, Number(ms) || 1),
  );
}

function acquireTransitionLock(
  file,
  {
    fsApi = fs,
    waitMs,
    staleMs,
    now = Date.now,
  } = {},
) {
  const lockDir = `${file}.transition-lock`;
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const resolvedWaitMs = Number.isFinite(Number(waitMs)) ? Number(waitMs) : 5_000;
  const resolvedStaleMs = Number.isFinite(Number(staleMs)) ? Number(staleMs) : 30_000;
  const deadline = now() + Math.max(0, resolvedWaitMs);
  fsApi.mkdirSync(path.dirname(lockDir), { recursive: true });
  while (true) {
    try {
      fsApi.mkdirSync(lockDir);
      try {
        fsApi.writeFileSync(
          path.join(lockDir, 'owner.json'),
          `${JSON.stringify({ token, pid: process.pid, acquired_at: new Date(now()).toISOString() })}\n`,
          'utf8',
        );
      } catch (error) {
        fsApi.rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }
      return { lockDir, token };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let ageMs = 0;
      try {
        ageMs = now() - fsApi.statSync(lockDir).mtimeMs;
      } catch {}
      if (ageMs > Math.max(1, resolvedStaleMs)) {
        const staleDir = `${lockDir}.stale.${process.pid}.${crypto.randomUUID()}`;
        try {
          fsApi.renameSync(lockDir, staleDir);
          fsApi.rmSync(staleDir, { recursive: true, force: true });
          continue;
        } catch {}
      }
      if (now() >= deadline) {
        throw new Error(`timed out acquiring Otter handoff transition lock: ${lockDir}`);
      }
      sleepMs(10);
    }
  }
}

function releaseTransitionLock(lock, fsApi = fs) {
  if (!lock?.lockDir || !lock?.token) return false;
  const owner = readJson(path.join(lock.lockDir, 'owner.json'), null, fsApi);
  if (String(owner?.token || '') !== String(lock.token)) return false;
  fsApi.rmSync(lock.lockDir, { recursive: true, force: true });
  return true;
}

// ExampleCo's owner correction on an already-closed call is a new repair process,
// not a retry of the one that closed it. Keying it by the correction problems
// lets the cycle ledger run it once instead of reporting the old process as
// cleared forever.
function ownerCorrectionTargetId(call, failedStage) {
  if (failedStage !== 'state_consistency') return '';
  const stage = call?.stages?.state_consistency || {};
  if (!/OWNER_CORRECTION_DIVERGENCE/i.test(String(stage.detail || ''))) return '';
  // The correction ids change with every new owner correction, even when the
  // problem text (which names only the track) stays the same.
  const ids = [...new Set((stage.owner_correction_ids || []).map(String))].sort();
  const problems = [...new Set((stage.owner_correction_problems || []).map(String))].sort();
  return `owner-correction:${crypto
    .createHash('sha256')
    .update(JSON.stringify({ ids, problems: problems.length ? problems : [String(stage.detail)] }))
    .digest('hex')}`;
}

function exactTargetId(call, failedStage) {
  const otid = String(call?.otid || '').trim();
  const correctionTarget = ownerCorrectionTargetId(call, failedStage);
  if (correctionTarget) return correctionTarget;
  const pendingTargets = [
    ...new Set(
      (call?.stages?.name_disposition?.pending_targets || []).map(String).filter(Boolean),
    ),
  ].sort();
  if (failedStage !== 'name_disposition' || !pendingTargets.length) return `call:${otid}`;
  if (pendingTargets.length === 1) return pendingTargets[0];
  return `name-target-set:${crypto
    .createHash('sha256')
    .update(JSON.stringify(pendingTargets))
    .digest('hex')}`;
}

function handoffPath(handoffDir, otid, sourceRevision) {
  return path.join(
    handoffDir,
    `${lockSlug(`${String(otid || '')}\u0000${String(sourceRevision || '')}`)}.json`,
  );
}

function normalizedStageDetail(call, failedStage) {
  return (
    call?.stages?.[failedStage]?.detail ||
    call?.orchestration?.[failedStage]?.detail ||
    ''
  );
}

function handoffProblems(handoff) {
  const problems = [];
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) {
    return ['handoff is not an object'];
  }
  if (handoff.schema !== HANDOFF_SCHEMA) problems.push('handoff schema is invalid');
  if (!String(handoff.handoff_id || '').trim()) problems.push('handoff id is missing');
  if (!String(handoff.otid || '').trim()) problems.push('handoff otid is missing');
  if (!String(handoff.source_revision_hash || '').trim()) {
    problems.push('handoff source revision is missing');
  }
  if (!String(handoff.failed_stage || '').trim()) problems.push('handoff failed stage is missing');
  if (!VALID_STATES.has(String(handoff.state || ''))) problems.push('handoff state is invalid');
  if (!Array.isArray(handoff.history) || !handoff.history.length) {
    problems.push('handoff history is missing');
  }
  if (handoff.state === 'closed' && !handoff.closure_proof) {
    problems.push('closed handoff lacks closure proof');
  }
  if (handoff.state === 'superseded_with_proof' && !handoff.supersession_proof) {
    problems.push('superseded handoff lacks supersession proof');
  }
  return problems;
}

function transitionHandoffUnlocked(
  file,
  nextState,
  {
    reason,
    at = new Date().toISOString(),
    failedStage,
    targetId,
    failedStages,
    stageDeadlineAt,
    stageDetail,
    envelopeHash,
    closureProof,
    supersessionProof,
    cycle = {},
    claim = {},
    expectedClaimOwner = '',
    fsApi = fs,
  } = {},
) {
  if (!VALID_STATES.has(String(nextState || ''))) {
    throw new Error(`invalid Otter handoff state: ${nextState}`);
  }
  const current = readJson(file, null, fsApi);
  if (!current) throw new Error(`Otter handoff is missing: ${file}`);
  if (
    expectedClaimOwner &&
    (current.state !== 'claimed' ||
      String(current.claim?.owner || '') !== String(expectedClaimOwner))
  ) {
    throw new Error(
      `claimed Otter handoff owner changed before settlement: ${current.claim?.owner || 'missing'}`,
    );
  }
  if (TERMINAL_STATES.has(current.state) && current.state !== nextState) {
    throw new Error(`terminal Otter handoff cannot transition from ${current.state}`);
  }
  if (nextState === 'closed' && !closureProof) {
    throw new Error('Otter handoff cannot close without exact closure proof');
  }
  if (nextState === 'superseded_with_proof' && !supersessionProof) {
    throw new Error('Otter handoff cannot supersede without revision proof');
  }
  const next = {
    ...current,
    state: nextState,
    updated_at: at,
    revision: Number(current.revision || 0) + 1,
    failed_stage: String(failedStage || current.failed_stage || ''),
    target_id: String(targetId || current.target_id || ''),
    failed_stages: Array.isArray(failedStages)
      ? failedStages
      : current.failed_stages || [],
    stage_deadline_at:
      stageDeadlineAt == null ? current.stage_deadline_at || '' : String(stageDeadlineAt),
    stage_detail: stageDetail == null ? current.stage_detail || '' : String(stageDetail),
    envelope_hash:
      envelopeHash == null ? current.envelope_hash || '' : String(envelopeHash),
    terminal_blocked: nextState === 'deferred' && cycle.terminal === true,
    terminal_blocked_reason:
      nextState === 'deferred' && cycle.terminal === true
        ? String(cycle.status || reason || 'BLOCKED')
        : '',
    cycle_status: cycle.status || current.cycle_status || '',
    cycles_consumed:
      cycle.cycles_consumed == null
        ? Number(current.cycles_consumed || 0)
        : Number(cycle.cycles_consumed || 0),
    no_progress_streak:
      cycle.no_progress_streak == null
        ? Number(current.no_progress_streak || 0)
        : Number(cycle.no_progress_streak || 0),
    claim:
      nextState === 'claimed'
        ? {
            claimed_at: at,
            owner: String(claim.owner || ''),
            lease_id: String(claim.lease_id || ''),
          }
        : null,
    closure_proof: closureProof || current.closure_proof || null,
    supersession_proof: supersessionProof || current.supersession_proof || null,
    history: [
      ...(current.history || []),
      {
        at,
        from: current.state,
        to: nextState,
        reason: String(reason || ''),
        failed_stage: String(failedStage || current.failed_stage || ''),
        cycles_consumed:
          cycle.cycles_consumed == null ? null : Number(cycle.cycles_consumed || 0),
        no_progress_streak:
          cycle.no_progress_streak == null ? null : Number(cycle.no_progress_streak || 0),
        proof:
          nextState === 'closed'
            ? closureProof
            : nextState === 'superseded_with_proof'
              ? supersessionProof
              : null,
      },
    ],
  };
  const problems = handoffProblems(next);
  if (problems.length) {
    throw new Error(`invalid Otter healer handoff transition: ${problems.join('; ')}`);
  }
  saveJsonAtomic(file, next, fsApi);
  return { ...next, file };
}

function transitionHandoff(file, nextState, options = {}) {
  const fsApi = options.fsApi || fs;
  const lock = acquireTransitionLock(file, {
    fsApi,
    waitMs: options.lockWaitMs,
    staleMs: options.lockStaleMs,
    now: options.now,
  });
  try {
    return transitionHandoffUnlocked(file, nextState, options);
  } finally {
    releaseTransitionLock(lock, fsApi);
  }
}

function publishHealerHandoff(
  call,
  handoffDir,
  {
    envelopeHash = '',
    trigger = 'exact_call_post_publish_live_qc_red',
    now = new Date(),
    fsApi = fs,
    reopenTerminal = false,
  } = {},
) {
  const otid = String(call?.otid || '').trim();
  const sourceRevision = String(call?.source_revision_hash || '').trim();
  const failedStage = String(call?.repair_stage || call?.next_failed_stage || '').trim();
  if (!handoffDir) throw new Error('Otter healer handoff requires handoffDir');
  if (!otid || !sourceRevision || !failedStage || call?.closed === true) {
    throw new Error('Otter healer handoff requires an open exact call, revision, and stage');
  }
  const file = handoffPath(handoffDir, otid, sourceRevision);
  const at = now.toISOString();
  let existing = readJson(file, null, fsApi);
  let reopenedFrom = null;
  let reopenLock = null;
  if (existing && reopenTerminal && TERMINAL_STATES.has(existing.state)) {
    // Settlement transitions the same file under this lock; re-read under it
    // so a concurrent transition can never be renamed into the archive.
    reopenLock = acquireTransitionLock(file, { fsApi });
    existing = readJson(file, null, fsApi);
    if (!existing || !TERMINAL_STATES.has(existing.state)) {
      // A peer already moved it; the normal locked transition path handles it.
      releaseTransitionLock(reopenLock, fsApi);
      reopenLock = null;
    }
  }
  try {
  if (existing && reopenTerminal && TERMINAL_STATES.has(existing.state)) {
    // The ledger reopened a call this handoff already closed (an owner
    // correction, or a closure requirement added later). The closed record
    // stays immutable in the archive; a fresh handoff carries the new work.
    const archiveDir = path.join(handoffDir, 'reopened-archive');
    const archived = path.join(
      archiveDir,
      `${path.basename(file, '.json')}.${lockSlug(String(existing.updated_at || at))}.json`,
    );
    fsApi.mkdirSync(archiveDir, { recursive: true });
    if (fsApi.existsSync(archived)) {
      throw new Error(`reopen archive already exists: ${archived}`);
    }
    fsApi.renameSync(file, archived);
    reopenedFrom = {
      handoff_id: existing.handoff_id || '',
      state: existing.state,
      updated_at: existing.updated_at || '',
      archived_file: archived,
    };
    existing = null;
  }
  if (existing) {
    if (existing.schema !== HANDOFF_SCHEMA) {
      throw new Error(`legacy or invalid handoff blocks v2 publication: ${file}`);
    }
    if (TERMINAL_STATES.has(existing.state)) {
      throw new Error(`terminal exact-call handoff cannot be republished: ${existing.state}`);
    }
    if (existing.state === 'deferred' && existing.terminal_blocked === true) {
      return {
        ...existing,
        file,
        publication_deferred: 'terminal_process_preserved',
      };
    }
    if (existing.state === 'claimed') {
      return {
        ...existing,
        file,
        publication_deferred: 'active_claim_preserved',
      };
    }
    const stageChanged = String(existing.failed_stage || '') !== failedStage;
    return transitionHandoff(file, stageChanged ? 'advanced' : 'queued', {
      reason: stageChanged ? 'ledger_repair_stage_advanced' : 'live_qc_reasserted',
      at,
      failedStage,
      targetId: exactTargetId(call, failedStage),
      failedStages: call.failed_stages || [],
      stageDeadlineAt: call.orchestration?.[failedStage]?.deadline_at || '',
      stageDetail: normalizedStageDetail(call, failedStage),
      envelopeHash:
        envelopeHash ||
        call?.exact_completion_envelope?.bundle_hash ||
        existing.envelope_hash ||
        '',
      fsApi,
    });
  }
  const handoffId = `otter-call-handoff:${lockSlug(`${otid}\u0000${sourceRevision}`)}`;
  const handoff = {
    schema: HANDOFF_SCHEMA,
    handoff_id: handoffId,
    state: 'queued',
    revision: 1,
    emitted_at: at,
    updated_at: at,
    otid,
    source_revision_hash: sourceRevision,
    envelope_hash:
      String(envelopeHash || call?.exact_completion_envelope?.bundle_hash || ''),
    failed_stage: failedStage,
    target_id: exactTargetId(call, failedStage),
    failed_stages: call.failed_stages || [],
    stage_deadline_at: call.orchestration?.[failedStage]?.deadline_at || '',
    stage_detail: normalizedStageDetail(call, failedStage),
    trigger,
    terminal_blocked: false,
    terminal_blocked_reason: '',
    cycle_status: '',
    cycles_consumed: 0,
    no_progress_streak: 0,
    claim: null,
    closure_proof: null,
    supersession_proof: null,
    ...(reopenedFrom ? { reopened_from: reopenedFrom } : {}),
    history: [
      {
        at,
        from: reopenedFrom ? reopenedFrom.state : '',
        to: 'queued',
        reason: trigger,
        failed_stage: failedStage,
        cycles_consumed: 0,
        no_progress_streak: 0,
        proof: null,
      },
    ],
  };
  const problems = handoffProblems(handoff);
  if (problems.length) {
    throw new Error(`invalid Otter healer handoff: ${problems.join('; ')}`);
  }
  saveJsonAtomic(file, handoff, fsApi);
  return { ...handoff, file };
  } finally {
    if (reopenLock) releaseTransitionLock(reopenLock, fsApi);
  }
}

function exactClosureProof(call, handoff) {
  const closure = call?.receipt_closure;
  const sourceRevision = String(handoff?.source_revision_hash || '');
  if (
    call?.closed !== true ||
    closure?.closed !== true ||
    closure?.status !== 'closed' ||
    String(closure?.source_revision || '') !== sourceRevision
  ) {
    return null;
  }
  return {
    schema: 'life_archive_otter_call_handoff_closure_proof.v1',
    source_revision_hash: sourceRevision,
    manifest_path: closure.manifest_path || closure.path || '',
    manifest_hash: closure.manifest_hash || closure.manifest?.manifest_hash || '',
    receipt_count: Number(closure.manifest?.receipt_count || 0),
    terminal_disposition: closure.terminal_disposition === true,
    terminal_kind: closure.terminal_disposition === true ? String(closure.kind || '') : '',
    verified_at: call?.orchestration?.exact_revision_closure?.completed_at || '',
  };
}

function exactSupersessionProof(call, handoff) {
  const queuedRevision = String(handoff?.source_revision_hash || '');
  const currentRevision = String(call?.source_revision_hash || '');
  if (!queuedRevision || !currentRevision || queuedRevision === currentRevision) return null;
  return {
    schema: 'life_archive_otter_call_handoff_supersession_proof.v1',
    superseded_source_revision_hash: queuedRevision,
    current_source_revision_hash: currentRevision,
    current_bundle_hash: call?.exact_completion_envelope?.bundle_hash || '',
    observed_at: new Date().toISOString(),
  };
}

module.exports = {
  ACTIVE_STATES,
  HANDOFF_SCHEMA,
  TERMINAL_STATES,
  exactClosureProof,
  exactSupersessionProof,
  exactTargetId,
  ownerCorrectionTargetId,
  handoffPath,
  handoffProblems,
  lockSlug,
  publishHealerHandoff,
  readJson,
  transitionHandoff,
};
