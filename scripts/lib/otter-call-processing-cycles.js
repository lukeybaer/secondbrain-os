'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  attemptRowsFromCycleReceipts,
} = require('./healer-attempt-history.js');

const MAX_CYCLES = 8;
const NO_PROGRESS_LIMIT = 8;
const DEFAULT_LEASE_MS = 60 * 60 * 1000;
const BLOCKED_EXHAUSTED = 'BLOCKED_EXHAUSTED';
const BLOCKED_NO_PROGRESS = 'BLOCKED_NO_PROGRESS';
const BLOCKED_TACTIC_REPEAT = 'BLOCKED_TACTIC_REPEAT';
const BLOCKED_NO_NEW_APPROACH = 'BLOCKED_NO_NEW_APPROACH';
const BLOCKED_AGENT_FAILED = 'BLOCKED_AGENT_FAILED';
const PROCESS_CLEARED = 'PROCESS_CLEARED';
const REPAIR_GENERATION_STARTED = 'REPAIR_GENERATION_STARTED';
const LEASE_HELD = 'LEASE_HELD';
const LEASE_ACQUIRED = 'LEASE_ACQUIRED';
const FAILED_OUTCOMES = new Set([
  'FAILED',
  'NO_PROGRESS',
  'UNCHANGED',
  'CRASHED_LEASE_EXPIRED',
  'ERROR',
]);
const NO_PROGRESS_OUTCOMES = new Set([
  'NO_PROGRESS',
  'UNCHANGED',
  'CRASHED_LEASE_EXPIRED',
]);
const DEFERRED_OUTCOMES = new Set([
  'DEFERRED_CAPACITY',
  'DEFERRED_ASYNC',
  'WAITING_CAPACITY',
]);

class FencedLeaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FencedLeaseError';
    this.code = 'FENCED_LEASE';
  }
}

function requiredString(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`Otter call-stage process requires ${field}`);
  return normalized;
}

function normalizeIdentity(identity = {}) {
  return {
    otid: requiredString(identity.otid, 'otid'),
    source_revision_hash: requiredString(
      identity.source_revision_hash,
      'source_revision_hash',
    ),
    stage: requiredString(identity.stage, 'stage'),
    target_id: requiredString(identity.target_id, 'target_id'),
  };
}

function exactProcessKey(identity) {
  const row = normalizeIdentity(identity);
  return `otter-call-stage:${JSON.stringify([
    row.otid,
    row.source_revision_hash,
    row.stage,
    row.target_id,
  ])}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function tacticFingerprint(tactic) {
  if (typeof tactic === 'string' && tactic.trim()) {
    return crypto.createHash('sha256').update(tactic.trim()).digest('hex');
  }
  if (!tactic || typeof tactic !== 'object' || Array.isArray(tactic)) {
    throw new Error('Otter call-stage cycle requires a nonempty tactic');
  }
  const serialized = JSON.stringify(stableValue(tactic));
  if (serialized === '{}') {
    throw new Error('Otter call-stage cycle requires a nonempty tactic');
  }
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

function tacticDescriptor(tactic) {
  if (typeof tactic === 'string' && tactic.trim()) {
    return { kind: 'named-tactic', tactic: tactic.trim() };
  }
  if (!tactic || typeof tactic !== 'object' || Array.isArray(tactic)) {
    throw new Error('Otter call-stage cycle requires a nonempty tactic');
  }
  const descriptor = stableValue(tactic);
  if (JSON.stringify(descriptor) === '{}') {
    throw new Error('Otter call-stage cycle requires a nonempty tactic');
  }
  return descriptor;
}

function receiptChainFingerprint(receipts = []) {
  return crypto
    .createHash('sha256')
    .update(
      (receipts || [])
        .map((receipt) => JSON.stringify(stableValue(receipt)))
        .join('\n'),
    )
    .digest('hex');
}

function processSlug(processKey) {
  return crypto.createHash('sha256').update(processKey).digest('hex');
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function saveJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function parseReceipts(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Corrupt Otter call-stage cycle receipt ${file}:${index + 1}: ${error.message}`,
        );
      }
    });
}

function appendReceiptDurably(file, receipt, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const payload = Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8');
  const descriptor = fsApi.openSync(
    file,
    fsApi.constants.O_WRONLY | fsApi.constants.O_CREAT | fsApi.constants.O_APPEND,
    0o600,
  );
  try {
    const written = fsApi.writeSync(descriptor, payload, 0, payload.length);
    if (written !== payload.length) {
      throw new Error(
        `Short Otter call-stage receipt append for ${file}: ${written}/${payload.length}`,
      );
    }
    fsApi.fsyncSync(descriptor);
  } finally {
    fsApi.closeSync(descriptor);
  }
}

function defaultPidAlive(pid) {
  const normalized = Number(pid);
  if (!Number.isInteger(normalized) || normalized <= 0) return null;
  try {
    process.kill(normalized, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return null;
  }
}

function createOtterCallProcessingCycleLedger({
  rootDir,
  leaseMs = DEFAULT_LEASE_MS,
  maxCycles = MAX_CYCLES,
  noProgressLimit = NO_PROGRESS_LIMIT,
  hostId = os.hostname(),
  pidAlive = defaultPidAlive,
  now = Date.now,
} = {}) {
  const absoluteRoot = path.resolve(requiredString(rootDir, 'cycle ledger rootDir'));
  const receiptsDir = path.join(absoluteRoot, 'receipts');
  const locksDir = path.join(absoluteRoot, 'locks');
  const effectiveLeaseMs = Math.max(1, Number(leaseMs) || DEFAULT_LEASE_MS);
  const effectiveMaxCycles = Math.max(1, Number(maxCycles) || MAX_CYCLES);
  const effectiveNoProgressLimit = Math.max(
    1,
    Number(noProgressLimit) || NO_PROGRESS_LIMIT,
  );
  const effectiveHostId = requiredString(hostId, 'cycle ledger hostId');

  function deadLocalOwner(owner) {
    if (!owner || (owner.host_id && owner.host_id !== effectiveHostId)) return false;
    const ownerPid = Number(owner.pid);
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) return false;
    try {
      return pidAlive(ownerPid) === false;
    } catch {
      return false;
    }
  }

  function pathsFor(identity) {
    const normalized = normalizeIdentity(identity);
    const processKey = exactProcessKey(normalized);
    const slug = processSlug(processKey);
    return {
      identity: normalized,
      processKey,
      receiptFile: path.join(receiptsDir, `${slug}.jsonl`),
      lockDir: path.join(locksDir, `${slug}.lock`),
      ownerFile: path.join(locksDir, `${slug}.lock`, 'owner.json'),
      gateDir: path.join(locksDir, `${slug}.allocation-gate`),
    };
  }

  function timestamp() {
    return new Date(now()).toISOString();
  }

  function appendReceipt(file, receipt) {
    appendReceiptDurably(file, receipt);
  }

  function releaseOwnedLock(paths, leaseId) {
    const owner = readJson(paths.ownerFile, null);
    if (!owner || owner.lease_id !== leaseId) return false;
    const released = `${paths.lockDir}.released.${process.pid}.${crypto.randomUUID()}`;
    try {
      fs.renameSync(paths.lockDir, released);
    } catch {
      return false;
    }
    fs.rmSync(released, { recursive: true, force: true });
    return true;
  }

  function acquireRawLock(paths) {
    fs.mkdirSync(locksDir, { recursive: true });
    try {
      fs.mkdirSync(paths.gateDir);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let gateAgeMs = 0;
      try {
        gateAgeMs = now() - fs.statSync(paths.gateDir).mtimeMs;
      } catch {}
      if (gateAgeMs <= Math.min(effectiveLeaseMs, 30_000)) {
        return {
          acquired: false,
          owner: readJson(paths.ownerFile, null),
          expiredOwner: null,
        };
      }
      const staleGate = `${paths.gateDir}.expired.${process.pid}.${crypto.randomUUID()}`;
      try {
        fs.renameSync(paths.gateDir, staleGate);
        fs.rmSync(staleGate, { recursive: true, force: true });
        fs.mkdirSync(paths.gateDir);
      } catch (reclaimError) {
        if (!['ENOENT', 'EEXIST', 'EPERM'].includes(reclaimError?.code)) {
          throw reclaimError;
        }
        return {
          acquired: false,
          owner: readJson(paths.ownerFile, null),
          expiredOwner: null,
        };
      }
    }
    try {
      let expiredOwner = null;
      if (fs.existsSync(paths.lockDir)) {
        const owner = readJson(paths.ownerFile, null);
        const expiresMs = Date.parse(String(owner?.expires_at || ''));
        const leaseExpired = Number.isFinite(expiresMs) && now() >= expiresMs;
        const ownerPidDead = !leaseExpired && deadLocalOwner(owner);
        if (!leaseExpired && !ownerPidDead) {
          return { acquired: false, owner, expiredOwner: null };
        }
        const staleDir = `${paths.lockDir}.expired.${process.pid}.${crypto.randomUUID()}`;
        fs.renameSync(paths.lockDir, staleDir);
        fs.rmSync(staleDir, { recursive: true, force: true });
        expiredOwner = {
          ...owner,
          lease_reclaim_reason: ownerPidDead
            ? 'same_host_owner_pid_dead'
            : 'lease_expired',
        };
      }
      const leaseId = crypto.randomUUID();
      const acquiredAt = timestamp();
      const provisional = {
        lease_id: leaseId,
        process_key: paths.processKey,
        acquired_at: acquiredAt,
        expires_at: new Date(now() + effectiveLeaseMs).toISOString(),
        host_id: effectiveHostId,
        pid: process.pid,
      };
      fs.mkdirSync(paths.lockDir);
      saveJsonAtomic(paths.ownerFile, provisional);
      return { acquired: true, owner: provisional, expiredOwner };
    } finally {
      fs.rmSync(paths.gateDir, { recursive: true, force: true });
    }
  }

  function readReceipts(identity) {
    return parseReceipts(pathsFor(identity).receiptFile);
  }

  function processState(receipts) {
    const reopenRows = receipts.filter(
      (row) => row.event === 'repair_generation_started',
    );
    const latestReopen = reopenRows.at(-1) || null;
    const generationStart = latestReopen
      ? receipts.lastIndexOf(latestReopen) + 1
      : 0;
    const generationReceipts = receipts.slice(generationStart);
    const allAllocations = receipts.filter(
      (row) => row.event === 'cycle_allocated',
    );
    const allocations = generationReceipts.filter(
      (row) => row.event === 'cycle_allocated',
    );
    const allTerminal = receipts.filter(
      (row) => row.event === 'cycle_completed' || row.event === 'lease_expired',
    );
    const terminal = generationReceipts.filter(
      (row) => row.event === 'cycle_completed' || row.event === 'lease_expired',
    );
    const deferredLeaseIds = new Set(
      terminal
        .filter((row) => DEFERRED_OUTCOMES.has(String(row.outcome || '').toUpperCase()))
        .map((row) => row.lease_id)
        .filter(Boolean),
    );
    const consumedAllocations = allocations.filter(
      (row) => !deferredLeaseIds.has(row.lease_id),
    );
    const allDeferredLeaseIds = new Set(
      allTerminal
        .filter((row) =>
          DEFERRED_OUTCOMES.has(String(row.outcome || '').toUpperCase()),
        )
        .map((row) => row.lease_id)
        .filter(Boolean),
    );
    const allConsumedAllocations = allAllocations.filter(
      (row) => !allDeferredLeaseIds.has(row.lease_id),
    );
    const attemptTerminal = terminal.filter(
      (row) => !DEFERRED_OUTCOMES.has(String(row.outcome || '').toUpperCase()),
    );
    const explicitBlock =
      generationReceipts
        .filter((row) => row.event === 'process_blocked')
        .at(-1) || null;
    let consecutiveNoProgress = 0;
    for (let index = attemptTerminal.length - 1; index >= 0; index -= 1) {
      if (
        !NO_PROGRESS_OUTCOMES.has(
          String(attemptTerminal[index].outcome || '').toUpperCase(),
        )
      ) {
        break;
      }
      consecutiveNoProgress += 1;
    }
    return {
      cyclesConsumed: consumedAllocations.length,
      totalCyclesConsumed: allConsumedAllocations.length,
      allocationCount: allocations.length,
      totalAllocationCount: allAllocations.length,
      maxCycle: allAllocations.reduce(
        (max, row) => Math.max(max, Number(row.cycle || 0)),
        0,
      ),
      maxFencingToken: allAllocations.reduce(
        (max, row) => Math.max(max, Number(row.fencing_token || 0)),
        0,
      ),
      failedTactics: new Set(
        attemptTerminal
          .filter((row) => FAILED_OUTCOMES.has(String(row.outcome || '').toUpperCase()))
          .map((row) => row.tactic_fingerprint)
          .filter(Boolean),
      ),
      consecutiveNoProgress,
      // A repair generation is an explicit, append-only invalidation boundary.
      // A CLEARED receipt remains terminal until such a boundary is written,
      // but it must not poison the newly approved generation forever.
      cleared:
        String(attemptTerminal.at(-1)?.outcome || '').toUpperCase() ===
        'CLEARED',
      explicitBlock,
      repairGeneration: Number(latestReopen?.repair_generation || 1),
      latestReopen,
      generationReceipts,
    };
  }

  function processStatus(state) {
    if (state.cleared) return PROCESS_CLEARED;
    if (state.explicitBlock) {
      return String(
        state.explicitBlock.status || BLOCKED_NO_NEW_APPROACH,
      );
    }
    if (state.consecutiveNoProgress >= effectiveNoProgressLimit) {
      return BLOCKED_NO_PROGRESS;
    }
    if (state.cyclesConsumed >= effectiveMaxCycles) return BLOCKED_EXHAUSTED;
    return 'ACTIVE';
  }

  function priorImplementationFingerprints(receipts) {
    return [
      ...new Set(
        receipts
          .filter((row) => row.event === 'cycle_allocated')
          .map((row) =>
            String(
              row?.tactic_descriptor?.implementation_revision_hash || '',
            ).toLowerCase(),
          )
          .filter((value) => /^[a-f0-9]{64}$/.test(value)),
      ),
    ].sort();
  }

  function priorTacticFingerprints(receipts) {
    return [
      ...new Set(
        receipts
          .flatMap((row) => [
            String(row?.tactic_fingerprint || '').toLowerCase(),
            ...((row?.attempted_tactic_fingerprints || []).map((value) =>
              String(value || '').toLowerCase(),
            )),
          ])
          .filter((value) => /^[a-f0-9]{64}$/.test(value)),
      ),
    ].sort();
  }

  function normalizeOpenStageProof(proof, identity) {
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
      throw new Error(
        'reopening a cleared voice process requires an exact open-stage proof',
      );
    }
    const normalized = {
      schema: String(proof.schema || ''),
      otid: String(proof.otid || ''),
      source_revision_hash: String(
        proof.source_revision_hash || '',
      ).toLowerCase(),
      stage: String(proof.stage || ''),
      target_id: String(proof.target_id || ''),
      call_closed: proof.call_closed === true,
      repair_stage: String(proof.repair_stage || ''),
      next_failed_stage: String(proof.next_failed_stage || ''),
      failed_stages: [
        ...new Set(
          (Array.isArray(proof.failed_stages) ? proof.failed_stages : [])
            .map((value) => String(value || '').trim())
            .filter(Boolean),
        ),
      ].sort(),
      ledger_sha256: String(proof.ledger_sha256 || '').toLowerCase(),
      observed_at: String(proof.observed_at || ''),
    };
    if (
      normalized.schema !==
      'life_archive_otter_call_processing_open_stage_proof.v1'
    ) {
      throw new Error('open-stage proof schema is invalid');
    }
    if (
      normalized.otid !== identity.otid ||
      normalized.source_revision_hash !== identity.source_revision_hash ||
      normalized.stage !== identity.stage ||
      normalized.target_id !== identity.target_id
    ) {
      throw new Error('open-stage proof does not match the exact process identity');
    }
    if (
      normalized.call_closed ||
      normalized.repair_stage !== identity.stage ||
      !normalized.failed_stages.length
    ) {
      throw new Error('open-stage proof does not prove the cleared stage is still open');
    }
    if (!/^[a-f0-9]{64}$/.test(normalized.ledger_sha256)) {
      throw new Error('open-stage proof requires the exact ledger SHA-256');
    }
    if (!Number.isFinite(Date.parse(normalized.observed_at))) {
      throw new Error('open-stage proof requires a valid observation timestamp');
    }
    return normalized;
  }

  function reopenPlan({
    identity,
    tactic,
    implementationFingerprint,
    expectedStatus,
    openStageProof = null,
    receipts,
  }) {
    const paths = pathsFor(identity);
    if (
      !['exact_revision_closure', 'voice_completion'].includes(
        paths.identity.stage,
      )
    ) {
      throw new Error(
        'repair generation reopen is restricted to exact_revision_closure or voice_completion',
      );
    }
    const descriptor = tacticDescriptor(tactic);
    const tacticFp = tacticFingerprint(tactic);
    const implementationFp = String(
      implementationFingerprint || '',
    ).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(implementationFp)) {
      throw new Error(
        'repair generation reopen requires a 64-character implementation fingerprint',
      );
    }
    if (
      String(descriptor.implementation_revision_hash || '').toLowerCase() !==
      implementationFp
    ) {
      throw new Error(
        'repair generation implementation fingerprint differs from the tactic descriptor',
      );
    }
    const state = processState(receipts);
    const status = processStatus(state);
    if (status === 'ACTIVE') {
      throw new Error('only a terminal exact-call process can start a repair generation');
    }
    const expected = requiredString(
      expectedStatus,
      'expected terminal status',
    );
    if (status !== expected) {
      throw new Error(
        `terminal status changed: expected ${expected}, found ${status}`,
      );
    }
    let normalizedOpenStageProof = null;
    if (status === PROCESS_CLEARED) {
      if (paths.identity.stage !== 'voice_completion') {
        throw new Error('a cleared exact-closure process cannot be reopened');
      }
      normalizedOpenStageProof = normalizeOpenStageProof(
        openStageProof,
        paths.identity,
      );
    }
    const priorTactics = priorTacticFingerprints(receipts);
    if (priorTactics.includes(tacticFp)) {
      throw new Error(
        'repair generation requires a tactic fingerprint not present in immutable history',
      );
    }
    const priorImplementations =
      priorImplementationFingerprints(receipts);
    if (!priorImplementations.length) {
      throw new Error(
        'repair generation cannot prove the prior implementation fingerprint',
      );
    }
    if (priorImplementations.includes(implementationFp)) {
      throw new Error(
        'repair generation requires a materially different implementation fingerprint',
      );
    }
    const receiptChainSha256 = receiptChainFingerprint(receipts);
    const repairGeneration = state.repairGeneration + 1;
    const generationFingerprint = crypto
      .createHash('sha256')
      .update(
        JSON.stringify(
          stableValue({
            process_key: paths.processKey,
            prior_receipt_chain_sha256: receiptChainSha256,
            prior_repair_generation: state.repairGeneration,
            prior_status: status,
            repair_generation: repairGeneration,
            tactic_fingerprint: tacticFp,
            implementation_revision_hash: implementationFp,
            open_stage_proof: normalizedOpenStageProof,
          }),
        ),
      )
      .digest('hex');
    return {
      process_key: paths.processKey,
      ...paths.identity,
      prior_status: status,
      prior_repair_generation: state.repairGeneration,
      repair_generation: repairGeneration,
      prior_cycles_consumed: state.cyclesConsumed,
      total_cycles_consumed: state.totalCyclesConsumed,
      prior_receipt_chain_sha256: receiptChainSha256,
      tactic_fingerprint: tacticFp,
      tactic_descriptor: descriptor,
      implementation_revision_hash: implementationFp,
      prior_tactic_fingerprints: priorTactics,
      prior_implementation_fingerprints: priorImplementations,
      open_stage_proof: normalizedOpenStageProof,
      generation_fingerprint: generationFingerprint,
    };
  }

  function previewReopenProcess({
    identity,
    tactic,
    implementationFingerprint,
    expectedStatus,
    openStageProof = null,
  } = {}) {
    const paths = pathsFor(identity);
    const receipts = parseReceipts(paths.receiptFile);
    return {
      schema: 'life_archive_otter_call_processing_repair_generation_plan.v1',
      ...reopenPlan({
        identity,
        tactic,
        implementationFingerprint,
        expectedStatus,
        openStageProof,
        receipts,
      }),
      receipt_file: paths.receiptFile,
    };
  }

  function reopenProcess({
    identity,
    tactic,
    implementationFingerprint,
    expectedStatus,
    openStageProof = null,
    expectedGenerationFingerprint,
    detail = '',
    operator = '',
  } = {}) {
    const paths = pathsFor(identity);
    const expectedGeneration = requiredString(
      expectedGenerationFingerprint,
      'expected generation fingerprint',
    ).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedGeneration)) {
      throw new Error(
        'expected generation fingerprint must be a 64-character hash',
      );
    }
    const rawLock = acquireRawLock(paths);
    if (!rawLock.acquired) {
      throw new Error('exact-call process lease is held; reopen refused');
    }
    try {
      const receipts = parseReceipts(paths.receiptFile);
      const plan = reopenPlan({
        identity,
        tactic,
        implementationFingerprint,
        expectedStatus,
        openStageProof,
        receipts,
      });
      if (plan.generation_fingerprint !== expectedGeneration) {
        throw new Error(
          'repair generation fingerprint changed after preview; reopen refused',
        );
      }
      const receipt = {
        schema: 'life_archive_otter_call_processing_cycle_receipt.v1',
        event: 'repair_generation_started',
        timestamp: timestamp(),
        outcome: REPAIR_GENERATION_STARTED,
        ...plan,
        detail: String(detail || '').slice(0, 1000),
        operator: requiredString(operator, 'operator'),
      };
      appendReceipt(paths.receiptFile, receipt);
      return {
        created: true,
        receipt_file: paths.receiptFile,
        receipt,
      };
    } finally {
      releaseOwnedLock(paths, rawLock.owner.lease_id);
    }
  }

  function rejection(paths, rawLock, state, status, extra = {}) {
    const receipt = {
      schema: 'life_archive_otter_call_processing_cycle_receipt.v1',
      event: 'allocation_rejected',
      timestamp: timestamp(),
      process_key: paths.processKey,
      ...paths.identity,
      status,
      outcome: status,
      cycles_consumed: state.cyclesConsumed,
      total_cycles_consumed: state.totalCyclesConsumed,
      repair_generation: state.repairGeneration,
      ...extra,
    };
    appendReceipt(paths.receiptFile, receipt);
    releaseOwnedLock(paths, rawLock.owner.lease_id);
    return receipt;
  }

  function beginCycle({ identity, tactic, inputFingerprint = '' } = {}) {
    const paths = pathsFor(identity);
    const descriptor = tacticDescriptor(tactic);
    const fingerprint = tacticFingerprint(tactic);
    const rawLock = acquireRawLock(paths);
    if (!rawLock.acquired) {
      const receipts = parseReceipts(paths.receiptFile);
      return {
        schema: 'life_archive_otter_call_processing_cycle_lease.v1',
        status: LEASE_HELD,
        process_key: paths.processKey,
        ...paths.identity,
        cycles_consumed: processState(receipts).cyclesConsumed,
        held_by_lease_id: rawLock.owner?.lease_id || '',
        lease_expires_at: rawLock.owner?.expires_at || '',
      };
    }

    let receipts = parseReceipts(paths.receiptFile);
    if (rawLock.expiredOwner?.cycle) {
      const priorAllocation = receipts.find(
        (row) =>
          row.event === 'cycle_allocated' &&
          row.lease_id === rawLock.expiredOwner.lease_id,
      );
      if (!priorAllocation) {
        appendReceipt(paths.receiptFile, {
          schema: 'life_archive_otter_call_processing_cycle_receipt.v1',
          event: 'cycle_allocated',
          timestamp: rawLock.expiredOwner.acquired_at || timestamp(),
          process_key: paths.processKey,
          ...paths.identity,
          cycle: rawLock.expiredOwner.cycle,
          repair_generation:
            Number(rawLock.expiredOwner.repair_generation || 1),
          fencing_token: rawLock.expiredOwner.fencing_token,
          lease_id: rawLock.expiredOwner.lease_id,
          lease_expires_at: rawLock.expiredOwner.expires_at || '',
          tactic_fingerprint: rawLock.expiredOwner.tactic_fingerprint || '',
          tactic_descriptor: rawLock.expiredOwner.tactic_descriptor || {},
          input_fingerprint: rawLock.expiredOwner.input_fingerprint || '',
          outcome: 'STARTED',
          recovered_after_incomplete_allocation_write: true,
        });
        receipts = parseReceipts(paths.receiptFile);
      }
      const priorTerminal = receipts.find(
        (row) =>
          (row.event === 'cycle_completed' || row.event === 'lease_expired') &&
          row.lease_id === rawLock.expiredOwner.lease_id,
      );
      if (!priorTerminal) {
        appendReceipt(paths.receiptFile, {
          schema: 'life_archive_otter_call_processing_cycle_receipt.v1',
          event: 'lease_expired',
          timestamp: timestamp(),
          process_key: paths.processKey,
          ...paths.identity,
          cycle: rawLock.expiredOwner.cycle,
          repair_generation:
            Number(rawLock.expiredOwner.repair_generation || 1),
          fencing_token: rawLock.expiredOwner.fencing_token,
          lease_id: rawLock.expiredOwner.lease_id,
          tactic_fingerprint: rawLock.expiredOwner.tactic_fingerprint || '',
          tactic_descriptor: rawLock.expiredOwner.tactic_descriptor || {},
          input_fingerprint: rawLock.expiredOwner.input_fingerprint || '',
          outcome: 'CRASHED_LEASE_EXPIRED',
          lease_expired_at: rawLock.expiredOwner.expires_at || '',
          lease_reclaim_reason:
            rawLock.expiredOwner.lease_reclaim_reason || 'lease_expired',
        });
      }
      receipts = parseReceipts(paths.receiptFile);
    }
    const state = processState(receipts);
    if (state.cleared) {
      return rejection(paths, rawLock, state, PROCESS_CLEARED);
    }
    if (state.explicitBlock) {
      return rejection(
        paths,
        rawLock,
        state,
        String(state.explicitBlock.status || BLOCKED_NO_NEW_APPROACH),
        {
        blocked_receipt_timestamp: state.explicitBlock.timestamp || '',
        },
      );
    }
    if (state.failedTactics.has(fingerprint)) {
      return rejection(paths, rawLock, state, BLOCKED_TACTIC_REPEAT, {
        tactic_fingerprint: fingerprint,
      });
    }
    if (state.consecutiveNoProgress >= effectiveNoProgressLimit) {
      return rejection(paths, rawLock, state, BLOCKED_NO_PROGRESS, {
        consecutive_no_progress: state.consecutiveNoProgress,
      });
    }
    if (state.cyclesConsumed >= effectiveMaxCycles) {
      return rejection(paths, rawLock, state, BLOCKED_EXHAUSTED, {
        max_cycles: effectiveMaxCycles,
      });
    }

    const cycle = state.maxCycle + 1;
    const attempt = state.totalCyclesConsumed + 1;
    const fencingToken = state.maxFencingToken + 1;
    const owner = {
      ...rawLock.owner,
      ...paths.identity,
      cycle,
      attempt,
      repair_generation: state.repairGeneration,
      fencing_token: fencingToken,
      tactic_fingerprint: fingerprint,
      tactic_descriptor: descriptor,
      input_fingerprint: String(inputFingerprint || ''),
    };
    saveJsonAtomic(paths.ownerFile, owner);
    const receipt = {
      schema: 'life_archive_otter_call_processing_cycle_receipt.v1',
      event: 'cycle_allocated',
      timestamp: timestamp(),
      process_key: paths.processKey,
      ...paths.identity,
      cycle,
      attempt,
      repair_generation: state.repairGeneration,
      fencing_token: fencingToken,
      lease_id: owner.lease_id,
      lease_expires_at: owner.expires_at,
      tactic_fingerprint: fingerprint,
      tactic_descriptor: descriptor,
      input_fingerprint: String(inputFingerprint || ''),
      outcome: 'STARTED',
    };
    appendReceipt(paths.receiptFile, receipt);
    return {
      schema: 'life_archive_otter_call_processing_cycle_lease.v1',
      status: LEASE_ACQUIRED,
      process_key: paths.processKey,
      ...paths.identity,
      cycle,
      attempt,
      repair_generation: state.repairGeneration,
      fencing_token: fencingToken,
      lease_id: owner.lease_id,
      lease_expires_at: owner.expires_at,
      tactic_fingerprint: fingerprint,
      tactic_descriptor: descriptor,
      input_fingerprint: String(inputFingerprint || ''),
      receipt_file: paths.receiptFile,
      reclaimed_expired_cycle: Number(rawLock.expiredOwner?.cycle || 0),
    };
  }

  function assertCurrentLease(lease) {
    if (!lease || lease.status !== LEASE_ACQUIRED) {
      throw new FencedLeaseError('Otter call-stage write rejected without an acquired lease');
    }
    const paths = pathsFor(lease);
    const owner = readJson(paths.ownerFile, null);
    if (
      !owner ||
      owner.lease_id !== lease.lease_id ||
      Number(owner.fencing_token) !== Number(lease.fencing_token) ||
      Number(owner.cycle) !== Number(lease.cycle)
    ) {
      throw new FencedLeaseError(
        `Otter call-stage write fenced for ${lease.process_key || paths.processKey}`,
      );
    }
    const expiresMs = Date.parse(String(owner.expires_at || ''));
    if (!Number.isFinite(expiresMs) || now() >= expiresMs) {
      throw new FencedLeaseError(
        `Otter call-stage lease expired for ${lease.process_key || paths.processKey}`,
      );
    }
    return owner;
  }

  function renewLease(lease) {
    const paths = pathsFor(lease);
    const owner = assertCurrentLease(lease);
    const renewed = {
      ...owner,
      renewed_at: timestamp(),
      expires_at: new Date(now() + effectiveLeaseMs).toISOString(),
    };
    saveJsonAtomic(paths.ownerFile, renewed);
    lease.lease_expires_at = renewed.expires_at;
    appendReceipt(paths.receiptFile, {
      schema: 'life_archive_otter_call_processing_cycle_receipt.v1',
      event: 'lease_renewed',
      timestamp: timestamp(),
      process_key: paths.processKey,
      ...paths.identity,
      cycle: lease.cycle,
      repair_generation: Number(
        owner.repair_generation || lease.repair_generation || 1,
      ),
      fencing_token: lease.fencing_token,
      lease_id: lease.lease_id,
      lease_expires_at: renewed.expires_at,
      tactic_fingerprint: lease.tactic_fingerprint,
      tactic_descriptor: owner.tactic_descriptor || lease.tactic_descriptor || {},
      input_fingerprint: owner.input_fingerprint || lease.input_fingerprint || '',
      outcome: 'RUNNING',
    });
    return lease;
  }

  function finishCycle(lease, result = {}) {
    const paths = pathsFor(lease);
    const owner = assertCurrentLease(lease);
    let outcome = requiredString(result.outcome, 'cycle outcome').toUpperCase();
    if (
      outcome !== 'CLEARED' &&
      !DEFERRED_OUTCOMES.has(outcome) &&
      result.input_fingerprint &&
      result.result_fingerprint &&
      result.input_fingerprint === result.result_fingerprint
    ) {
      outcome = 'NO_PROGRESS';
    }
    const receipt = {
      schema: 'life_archive_otter_call_processing_cycle_receipt.v1',
      event: 'cycle_completed',
      timestamp: timestamp(),
      process_key: paths.processKey,
      ...paths.identity,
      cycle: lease.cycle,
      attempt: lease.attempt || owner.attempt || lease.cycle,
      repair_generation: Number(
        owner.repair_generation || lease.repair_generation || 1,
      ),
      fencing_token: lease.fencing_token,
      lease_id: lease.lease_id,
      tactic_fingerprint: lease.tactic_fingerprint,
      tactic_descriptor: owner.tactic_descriptor || lease.tactic_descriptor || {},
      input_fingerprint: String(
        result.input_fingerprint || owner.input_fingerprint || lease.input_fingerprint || '',
      ),
      outcome,
      result_fingerprint: String(result.result_fingerprint || ''),
      hypothesis: String(
        result.hypothesis || owner.tactic_descriptor?.hypothesis || '',
      ),
      action: String(result.action || owner.tactic_descriptor?.action || ''),
      detail: String(result.detail || ''),
    };
    appendReceipt(paths.receiptFile, receipt);
    if (!releaseOwnedLock(paths, lease.lease_id)) {
      throw new FencedLeaseError(
        `Otter call-stage completion lost its fence for ${paths.processKey}`,
      );
    }
    return receipt;
  }

  function blockProcess({
    identity,
    status = BLOCKED_NO_NEW_APPROACH,
    detail = 'No materially new repair approach remained.',
    attemptedFingerprints = [],
  } = {}) {
    if (![BLOCKED_NO_NEW_APPROACH, BLOCKED_AGENT_FAILED].includes(status)) {
      throw new Error(`unsupported exact-call terminal block status: ${status}`);
    }
    const paths = pathsFor(identity);
    const rawLock = acquireRawLock(paths);
    if (!rawLock.acquired) {
      const receipts = parseReceipts(paths.receiptFile);
      return {
        schema: 'life_archive_otter_call_processing_cycle_state.v1',
        status: LEASE_HELD,
        terminal: false,
        process_key: paths.processKey,
        ...paths.identity,
        cycles_consumed: processState(receipts).cyclesConsumed,
        repair_generation: processState(receipts).repairGeneration,
      };
    }
    const receipts = parseReceipts(paths.receiptFile);
    const state = processState(receipts);
    if (state.explicitBlock) {
      releaseOwnedLock(paths, rawLock.owner.lease_id);
      return state.explicitBlock;
    }
    const receipt = {
      schema: 'life_archive_otter_call_processing_cycle_receipt.v1',
      event: 'process_blocked',
      timestamp: timestamp(),
      process_key: paths.processKey,
      ...paths.identity,
      status,
      outcome: status,
      cycles_consumed: state.cyclesConsumed,
      total_cycles_consumed: state.totalCyclesConsumed,
      repair_generation: state.repairGeneration,
      attempted_tactic_fingerprints: [...new Set(attemptedFingerprints.map(String))].sort(),
      detail: String(detail || '').slice(0, 1000),
    };
    appendReceipt(paths.receiptFile, receipt);
    releaseOwnedLock(paths, rawLock.owner.lease_id);
    return receipt;
  }

  function blockNoNewApproach(options = {}) {
    return blockProcess({ ...options, status: BLOCKED_NO_NEW_APPROACH });
  }

  function inspectProcess(identity) {
    const paths = pathsFor(identity);
    const receipts = parseReceipts(paths.receiptFile);
    const state = processState(receipts);
    const status = processStatus(state);
    return {
      schema: 'life_archive_otter_call_processing_cycle_state.v1',
      status,
      terminal: status !== 'ACTIVE',
      process_key: paths.processKey,
      ...paths.identity,
      cycles_consumed: state.cyclesConsumed,
      allocation_count: state.allocationCount,
      total_cycles_consumed: state.totalCyclesConsumed,
      total_allocation_count: state.totalAllocationCount,
      repair_generation: state.repairGeneration,
      latest_reopen: state.latestReopen,
      max_cycles: effectiveMaxCycles,
      consecutive_no_progress: state.consecutiveNoProgress,
      failed_tactic_fingerprints: [...state.failedTactics].sort(),
      attempt_history: attemptRowsFromCycleReceipts(receipts, {
        processKey: paths.processKey,
      }),
      blocked_detail: String(state.explicitBlock?.detail || ''),
      receipt_file: paths.receiptFile,
      receipt_count: receipts.length,
    };
  }

  return {
    beginCycle,
    assertCurrentLease,
    renewLease,
    finishCycle,
    blockProcess,
    blockNoNewApproach,
    previewReopenProcess,
    reopenProcess,
    inspectProcess,
    readReceipts,
    pathsFor,
  };
}

module.exports = {
  MAX_CYCLES,
  NO_PROGRESS_LIMIT,
  DEFERRED_OUTCOMES,
  DEFAULT_LEASE_MS,
  BLOCKED_EXHAUSTED,
  BLOCKED_NO_PROGRESS,
  BLOCKED_TACTIC_REPEAT,
  BLOCKED_NO_NEW_APPROACH,
  BLOCKED_AGENT_FAILED,
  PROCESS_CLEARED,
  REPAIR_GENERATION_STARTED,
  LEASE_HELD,
  LEASE_ACQUIRED,
  FencedLeaseError,
  normalizeIdentity,
  exactProcessKey,
  tacticFingerprint,
  tacticDescriptor,
  receiptChainFingerprint,
  appendReceiptDurably,
  defaultPidAlive,
  createOtterCallProcessingCycleLedger,
};
