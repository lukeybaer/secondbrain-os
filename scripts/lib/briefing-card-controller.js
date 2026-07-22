'use strict';

// Cloud card controller for the Daily Briefing.
//
// The controller deliberately does not build a second briefing system.  It
// drives the proven refresh-card.js primitive one card at a time, retains its
// scoped live QC, and adds the missing operational guarantees around it:
// durable no-repeat attempts, a single publish lane, protected green cards,
// and one receipt that works for overnight, supervised midday, and a ExampleCo
// "action complete" button.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { CARDS, getCardById } = require('./briefing-card-manifest.js');
const { buildLiveBoardArtifact, readLiveBoardArtifact } = require('./live-board-truth.js');
const { buildBriefingDashboardUrl } = require('./briefing-auth.js');
const { notifyWithFallback } = require('./notify-with-fallback.js');
const { loadBriefingNotifyEnv, notifyBriefingPublished } = require('./briefing-notify.js');
const { getSourceContract, controllerSourceEnv } = require('./briefing-source-contracts.js');
const { artifactPathFor, isPerCardBoardSource } = require('./briefing-card-artifacts.js');
const {
  DERIVED_CARD_IDS,
  LIVE_VERDICT_ExampleCo_MARKER,
  MANIFEST_CARD_RENDER,
  markdownPathFor,
  withSharedBriefingLock,
  markCardExampleCoAndRepublish,
} = require('../refresh-card.js');
const {
  defectKey,
  hashTacticInput,
  recordAttempt,
  tacticAlreadyFailed,
} = require('../self-heal/briefing-repair-ledger.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONTROLLER_REL_DIR = path.join('agent', 'card-controller');
const DEFAULT_LEASE_MS = 60 * 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_SOURCE_CONCURRENCY = 3;
const DERIVED_CARD_SET = new Set(DERIVED_CARD_IDS);

function ctDayKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function defaultDataDir() {
  return process.env.SECONDBRAIN_DATA_DIR || path.join(REPO_ROOT, 'data');
}

function controllerDir(dataDir) {
  return path.join(dataDir, CONTROLLER_REL_DIR);
}

function safeJson(text, fallback = null) {
  try {
    return JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function readJson(file, fallback = null) {
  try {
    return safeJson(fs.readFileSync(file, 'utf8'), fallback);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
  return file;
}

function makeRunId(now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  return `${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

function parseCardList(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return [];
  if (raw.toLowerCase() === 'all') return ['all'];
  const ids = [];
  for (const item of raw.split(',')) {
    const id = item.trim().toLowerCase();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function primaryCardIds() {
  // Blockers is a projection rebuilt from canonical board truth after every
  // target. System Health is not merely a projection: its measurement roster
  // and evidence are independently produced and must earn a fresh verdict on
  // every all-card run.
  return CARDS.map((card) => card.id).filter((id) => id !== 'blockers');
}

function boundedCommandTimeoutMs(requestedMs, deadlineAtMs, nowMs = Date.now()) {
  const requested = Number.isFinite(requestedMs) && requestedMs > 0 ? requestedMs : null;
  if (!Number.isFinite(deadlineAtMs)) return requested;
  const remaining = Math.max(0, deadlineAtMs - nowMs);
  return requested == null ? remaining : Math.min(requested, remaining);
}

function deadlineExceededError() {
  const error = new Error('Controller wall-clock deadline reached; no new work was started.');
  error.code = 'CONTROLLER_DEADLINE_EXCEEDED';
  return error;
}

function assertWithinDeadline(signal, deadlineAtMs) {
  if (signal?.aborted || (Number.isFinite(deadlineAtMs) && Date.now() >= deadlineAtMs)) {
    throw deadlineExceededError();
  }
}

function awaitWithAbort(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(deadlineExceededError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(deadlineExceededError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function normalizeStatus(status) {
  return (
    String(status || '')
      .trim()
      .toLowerCase() || 'ExampleCo'
  );
}

function statusMap(artifact) {
  const map = new Map();
  for (const card of Array.isArray(artifact && artifact.cards) ? artifact.cards : []) {
    if (!card || !card.id) continue;
    map.set(String(card.id).toLowerCase(), normalizeStatus(card.status));
  }
  return map;
}

function defectCodesForCard(artifact, cardId) {
  const id = String(cardId || '').toLowerCase();
  const card = (Array.isArray(artifact && artifact.cards) ? artifact.cards : []).find(
    (entry) => entry && String(entry.id || '').toLowerCase() === id,
  );
  const fromCard = [
    ...(Array.isArray(card && card.defects) ? card.defects : []),
    ...(Array.isArray(card && card.defectCodes) ? card.defectCodes : []),
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fromArtifact = (Array.isArray(artifact && artifact.defects) ? artifact.defects : [])
    .map((value) => String(value || '').trim())
    .filter((value) => new RegExp(`(?:^|:\\s*)${escaped}(?:\\b|\\s|\\()`, 'i').test(value))
    .map((value) => value.split(':')[0].trim() || value);
  const precise = [...new Set([...fromCard, ...fromArtifact])];
  if (precise.length) return precise;
  return [...new Set(Array.isArray(card && card.defectKinds) ? card.defectKinds : [])]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function cardStatus(artifact, cardId) {
  return statusMap(artifact).get(String(cardId || '').toLowerCase()) || 'ExampleCo';
}

function mutualMergePartnerIds(cardId) {
  const id = String(cardId || '').toLowerCase();
  const card = getCardById(id);
  if (!card || !Array.isArray(card.mergedInto)) return [];
  return card.mergedInto
    .map((partnerId) => String(partnerId || '').toLowerCase())
    .filter((partnerId) => {
      const partner = getCardById(partnerId);
      return (
        partner &&
        Array.isArray(partner.mergedInto) &&
        partner.mergedInto.map((value) => String(value || '').toLowerCase()).includes(id)
      );
    });
}

function effectiveGreenGuardStatus(statuses, cardId) {
  const id = String(cardId || '').toLowerCase();
  const ownStatus = statuses.get(id) || 'missing';
  if (ownStatus === 'clean') return 'clean';
  const cleanPartner = mutualMergePartnerIds(id).find(
    (partnerId) => statuses.get(partnerId) === 'clean',
  );
  return cleanPartner ? 'clean' : ownStatus;
}

function unrelatedGreenRegressions(
  beforeArtifact,
  afterArtifact,
  { cardId, protectedCardIds = [] } = {},
) {
  const before = statusMap(beforeArtifact);
  const after = statusMap(afterArtifact);
  const excluded = new Set([
    String(cardId || '').toLowerCase(),
    ...(protectedCardIds || []).map((id) => String(id).toLowerCase()),
  ]);
  const regressions = [];
  for (const [id, beforeStatus] of before.entries()) {
    if (excluded.has(id) || beforeStatus !== 'clean') continue;
    const afterStatus = effectiveGreenGuardStatus(after, id);
    if (afterStatus !== 'clean') regressions.push({ id, beforeStatus, afterStatus });
  }
  return regressions;
}

function greenRegressions(
  beforeArtifact,
  afterArtifact,
  { cardId, protectedCardIds = [], protectTarget = false } = {},
) {
  const regressions = unrelatedGreenRegressions(beforeArtifact, afterArtifact, {
    cardId,
    protectedCardIds,
  });
  const targetId = String(cardId || '').toLowerCase();
  const after = statusMap(afterArtifact);
  if (
    protectTarget &&
    targetId &&
    cardStatus(beforeArtifact, targetId) === 'clean' &&
    effectiveGreenGuardStatus(after, targetId) !== 'clean'
  ) {
    regressions.push({
      id: targetId,
      beforeStatus: 'clean',
      afterStatus: effectiveGreenGuardStatus(after, targetId),
    });
  }
  return regressions;
}

function controllerImplementationDigest(contract = {}) {
  // A new implementation is changed input. Otherwise the no-spin ledger would
  // incorrectly suppress the first retry after an actual code repair.
  const files = [__filename, path.join(REPO_ROOT, 'scripts', 'refresh-card.js')];
  if (contract && typeof contract.refresh === 'function') {
    files.push(path.join(REPO_ROOT, 'scripts', 'lib', 'briefing-source-contracts.js'));
  }
  const parts = files.map((file) => {
    try {
      return `${file}:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
    } catch {
      return `${file}:unreadable`;
    }
  });
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

function cardEntry(artifact, cardId) {
  const id = String(cardId || '').toLowerCase();
  return (
    (Array.isArray(artifact && artifact.cards) ? artifact.cards : []).find(
      (card) => card && String(card.id || '').toLowerCase() === id,
    ) || null
  );
}

function scopedLiveProofSignals({ command, beforeArtifact, afterArtifact, cardId, date } = {}) {
  const afterCard = cardEntry(afterArtifact, cardId);
  if (!afterCard || !afterArtifact || afterArtifact.retry === true) return null;
  if (date && afterArtifact.date && String(afterArtifact.date) !== String(date)) return null;
  const beforeTs = Date.parse(beforeArtifact && beforeArtifact.ts);
  const afterTs = Date.parse(afterArtifact && afterArtifact.ts);
  const beforeCardTs = Date.parse(cardEntry(beforeArtifact, cardId)?.asOf);
  const afterCardTs = Date.parse(afterCard.asOf);
  const timestampAdvanced =
    (Number.isFinite(afterTs) && (!Number.isFinite(beforeTs) || afterTs > beforeTs)) ||
    (Number.isFinite(afterCardTs) &&
      (!Number.isFinite(beforeCardTs) || afterCardTs > beforeCardTs));
  const stdout = String((command && command.stdout) || '');
  const escapedCardId = String(cardId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const printedScopedProof =
    afterArtifact.ran === true &&
    stdout.includes('[refresh-card] --verify: wrote canonical dashboard artifact') &&
    new RegExp(`\\[refresh-card\\] --verify: card='${escapedCardId}' status=`).test(stdout);
  // Board-level freshness is NOT enough here. A scoped union publish always
  // stamps a new board `ts` while copying sibling cards forward, so the board
  // clock advances even when the refreshed target itself is stale. The
  // artifact-union branch therefore demands the TARGET card's own asOf moved.
  const targetCardAdvanced =
    Number.isFinite(afterCardTs) && (!Number.isFinite(beforeCardTs) || afterCardTs > beforeCardTs);
  const builtScopedUnion =
    targetCardAdvanced &&
    isPerCardBoardSource(afterArtifact.source) &&
    new RegExp(`\\[refresh-card\\] produced artifact card='${escapedCardId}' status=`).test(
      stdout,
    ) &&
    stdout.includes('[refresh-card] published artifact union');
  return {
    timestampAdvanced,
    printedScopedProof,
    builtScopedUnion,
    exitedZero: Number(command && command.exitCode) === 0,
    stdout,
  };
}

function hasVerifiedScopedLiveResult(input = {}) {
  if (input.command && input.command.verified === true) return true;
  const signals = scopedLiveProofSignals(input);
  if (!signals) return false;
  const printedArtifactUnionProof = signals.exitedZero && signals.builtScopedUnion;
  return signals.timestampAdvanced && (signals.printedScopedProof || printedArtifactUnionProof);
}

// UNREACHABLE is not UNVERIFIED. When refresh-card could not consult the live
// dashboard at all it prints LIVE_VERDICT_ExampleCo_MARKER and still exits
// nonzero, because verification did not happen. Treating that nonzero exit as a
// failed verdict would roll back a card that BUILT CLEAN over a transient
// outage, which is the same destructive class da4dde67 fixed, re-entered
// through a different trigger. An ExampleCo verdict therefore requires real build
// proof (the target's own artifact advanced and the scoped union published) and
// leaves the card standing, while the run still reports as not clean.
function hasExampleCoLiveVerdict(input = {}) {
  if (hasVerifiedScopedLiveResult(input)) return false;
  const signals = scopedLiveProofSignals(input);
  if (!signals) return false;
  if (!signals.stdout.includes(LIVE_VERDICT_ExampleCo_MARKER)) return false;
  return signals.timestampAdvanced && signals.builtScopedUnion;
}

const ExampleCo_VERDICT_DEFECT = 'LIVE-VERIFY-ExampleCo';

// Keeping an unproven build is only honest if the BOARD says so too. A card
// left at 'clean' would show ExampleCo no badge (cardDefectBadge suppresses clean)
// and would be filtered straight out of the next controller plan (resolvePlan
// skips clean cards), so an unverified card would masquerade as verified and
// never be retried. Codex peer review 3722e41ba53b caught this. The markdown
// build survives; the card's VERIFICATION state drops to 'stale' with a named
// defect, which is visible on the dashboard and re-selected on the next run.
function markCardVerificationExampleCo({ artifactFile, artifact, cardId }) {
  const id = String(cardId || '').toLowerCase();
  const note = `${ExampleCo_VERDICT_DEFECT}: ${id} built clean but the live dashboard could not be consulted, so the card is unproven`;
  const cards = (Array.isArray(artifact && artifact.cards) ? artifact.cards : []).map((card) => {
    if (!card || String(card.id || '').toLowerCase() !== id) return card;
    return {
      ...card,
      status: 'stale',
      defectKinds: [
        ...new Set([
          ...(Array.isArray(card.defectKinds) ? card.defectKinds : []),
          ExampleCo_VERDICT_DEFECT,
        ]),
      ],
      defects: [...new Set([...(Array.isArray(card.defects) ? card.defects : []), note])],
    };
  });
  const next = {
    ...artifact,
    cards,
    defects: [
      ...new Set([...(Array.isArray(artifact && artifact.defects) ? artifact.defects : []), note]),
    ],
    defectiveCardCount: cards.filter((card) => card && normalizeStatus(card.status) !== 'clean')
      .length,
  };
  writeJsonAtomic(artifactFile, next);
  return next;
}

function resolvePlan({ cards, artifact } = {}) {
  const requested = Array.isArray(cards) ? cards : parseCardList(cards);
  if (requested.includes('all')) {
    return primaryCardIds().map((cardId) => ({ cardId, forced: true, requestedBy: 'all' }));
  }
  if (requested.length) {
    return requested.map((cardId) => {
      if (!getCardById(cardId)) throw new Error(`ExampleCo briefing card '${cardId}'`);
      return { cardId, forced: true, requestedBy: 'explicit' };
    });
  }
  return primaryCardIds()
    .filter((cardId) => cardStatus(artifact, cardId) !== 'clean')
    .map((cardId) => ({ cardId, forced: false, requestedBy: 'defect' }));
}

function snapshotFile(source, destination) {
  const existed = fs.existsSync(source);
  if (existed) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  return { source, destination, existed };
}

function restoreSnapshot(snapshot) {
  if (!snapshot) return;
  if (!snapshot.existed) {
    if (fs.existsSync(snapshot.source)) fs.unlinkSync(snapshot.source);
    return;
  }
  if (!fs.existsSync(snapshot.destination)) {
    throw new Error(`backup missing for ${snapshot.source}`);
  }
  const temp = `${snapshot.source}.${process.pid}.${Date.now()}.restore`;
  fs.copyFileSync(snapshot.destination, temp);
  fs.renameSync(temp, snapshot.source);
}

function restoreTransactionBackups(backups) {
  if (!backups) return;
  for (const key of ['markdown', 'artifact', 'cardArtifact', 'blockersArtifact']) {
    restoreSnapshot(backups[key]);
  }
}

function activeTransactionPath(dataDir) {
  return path.join(controllerDir(dataDir), 'active-transaction.json');
}

function writeActiveTransaction(dataDir, transaction, { signal = null, deadlineAtMs = null } = {}) {
  assertWithinDeadline(signal, deadlineAtMs);
  const file = activeTransactionPath(dataDir);
  writeJsonAtomic(file, transaction);
  return file;
}

function clearActiveTransaction(dataDir, runId) {
  const file = activeTransactionPath(dataDir);
  const current = readJson(file, null);
  if (current && current.runId === runId && fs.existsSync(file)) fs.unlinkSync(file);
}

// A controller can be interrupted by a deploy, reboot, or an operator stop
// between refresh-card's markdown write and the live-QC/green-card guard. The
// next controller starts by restoring this transaction's pair. This is
// deliberately conservative: if the previous process died after a good write
// but before it recorded completion, we repaint that one card rather than ever
// keep a partially-proven update.
function recoverIncompleteTransaction(dataDir) {
  const file = activeTransactionPath(dataDir);
  const transaction = readJson(file, null);
  if (!transaction || !transaction.backups) return null;
  try {
    restoreTransactionBackups(transaction.backups);
    fs.unlinkSync(file);
    return {
      recovered: true,
      runId: transaction.runId || '',
      cardId: transaction.cardId || '',
      startedAt: transaction.startedAt || '',
    };
  } catch (error) {
    return {
      recovered: false,
      runId: transaction.runId || '',
      cardId: transaction.cardId || '',
      error: String((error && error.message) || error),
    };
  }
}

function leaseOwnerAlive(
  lease,
  {
    hostname = os.hostname(),
    pidAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return !!(error && error.code === 'EPERM');
      }
    },
  } = {},
) {
  const pid = Number(lease && lease.pid);
  const ownerHost = String((lease && lease.hostname) || '');
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (ownerHost && ownerHost !== hostname) return null;
  return !!pidAlive(pid);
}

function acquireLease({
  dataDir,
  runId,
  mode,
  date,
  now = Date.now(),
  leaseMs = DEFAULT_LEASE_MS,
  pid = process.pid,
  hostname = os.hostname(),
  pidAlive,
}) {
  const file = path.join(controllerDir(dataDir), 'active-lease.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = {
    runId,
    mode,
    date,
    acquiredAt: new Date(now).toISOString(),
    leaseMs,
    pid,
    hostname,
  };
  const tryWrite = () => {
    try {
      fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx' });
      return { acquired: true, file, lease: body };
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error;
      return null;
    }
  };
  const fresh = tryWrite();
  if (fresh) return fresh;
  const existing = readJson(file, {});
  const acquiredAt = Date.parse(existing && existing.acquiredAt);
  const stale =
    !Number.isFinite(acquiredAt) || now - acquiredAt > Number(existing.leaseMs || leaseMs);
  const ownerAlive = leaseOwnerAlive(existing, { hostname, pidAlive });
  const deadOwner = ownerAlive === false;
  if (!stale && !deadOwner) return { acquired: false, file, lease: existing, stale: false };
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  const reclaimed = deadOwner ? 'dead-owner' : 'expired';
  const recovered = tryWrite();
  if (recovered) return { ...recovered, reclaimed };
  return { acquired: false, file, lease: readJson(file, {}), stale: true, reclaimed };
}

function releaseLease(lease, runId) {
  if (!lease || !lease.file) return;
  const current = readJson(lease.file, null);
  if (current && current.runId === runId && fs.existsSync(lease.file)) fs.unlinkSync(lease.file);
}

function runProcess(
  command,
  args,
  {
    cwd = REPO_ROOT,
    env = process.env,
    timeoutMs = DEFAULT_REFRESH_TIMEOUT_MS,
    hardDeadlineAtMs = null,
    signal = null,
  } = {},
) {
  if (signal?.aborted || (Number.isFinite(hardDeadlineAtMs) && Date.now() >= hardDeadlineAtMs)) {
    return Promise.resolve({
      stdout: '',
      stderr: 'Controller wall-clock deadline reached before process spawn.',
      exitCode: 124,
      timedOut: true,
      deadlineExpired: true,
    });
  }
  return new Promise((resolve) => {
    // The cloud uses GNU timeout as a child-owned deadline as well as this
    // parent's process-group fallback. If the controller itself is stopped,
    // its child still has a finite lifetime instead of becoming an orphaned
    // writer. Windows keeps the in-process fallback for local test/dev use.
    const externalTimeout =
      process.platform !== 'win32' && Number.isFinite(timeoutMs) && timeoutMs > 0;
    const childCommand = externalTimeout ? 'timeout' : command;
    const childArgs = externalTimeout
      ? ['--kill-after=15s', `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`, command, ...args]
      : args;
    const child = spawn(childCommand, childArgs, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killGraceTimer = null;
    let timer = null;
    let hardTimer = null;
    let abortHandler = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      resolve({ stdout, stderr, ...result });
    };
    const hardKill = () => {
      timedOut = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // The process may have completed in the race before the deadline.
      }
      finish({ exitCode: 124, timedOut: true, deadlineExpired: true, signal: 'SIGKILL' });
    };
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-200000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-200000);
    });
    child.on('error', (error) =>
      finish({ exitCode: 1, error: String((error && error.message) || error), timedOut }),
    );
    child.on('close', (code, signal) =>
      finish({
        exitCode: Number(code == null ? 1 : code),
        signal,
        timedOut: timedOut || Number(code) === 124,
      }),
    );
    timer = setTimeout(
      () => {
        timedOut = true;
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
          else child.kill('SIGTERM');
        } catch {
          // The process may have completed in the race before the timeout.
        }
        killGraceTimer = setTimeout(() => {
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            // The child may have exited in the grace window.
          }
          finish({ exitCode: 124, timedOut: true, signal: 'SIGKILL' });
        }, 15 * 1000);
      },
      timeoutMs + 20 * 1000,
    );
    if (Number.isFinite(hardDeadlineAtMs)) {
      hardTimer = setTimeout(hardKill, Math.max(0, hardDeadlineAtMs - Date.now()));
    }
    if (signal) {
      abortHandler = hardKill;
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });
}

function liveArtifact(dataDir) {
  return readLiveBoardArtifact({ dataDir }).artifact || { cards: [], defects: [] };
}

function sourceRefreshPlan(plan, getContract = getSourceContract) {
  const families = new Map();
  for (const item of plan) {
    const contract = getContract(item.cardId);
    if (!contract || typeof contract.refresh !== 'function') continue;
    if (!families.has(contract.family)) families.set(contract.family, { contract, cardIds: [] });
    families.get(contract.family).cardIds.push(item.cardId);
  }
  return [...families.values()];
}

async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Math.min(list.length || 1, Number(limit) || 1));
  const results = new Array(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= list.length) return;
        results[index] = await worker(list[index], index);
      }
    }),
  );
  return results;
}

function scheduleWithConcurrency(items, limit, worker, controls = {}) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Math.min(list.length || 1, Number(limit) || 1));
  const results = new Array(list.length);
  const deferred = list.map(() => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  });
  let next = 0;
  const stopRemaining = () => {
    const start = next;
    next = list.length;
    for (let index = start; index < list.length; index += 1) {
      const result = controls.onSkipped
        ? controls.onSkipped(list[index], index)
        : undefined;
      results[index] = result;
      deferred[index].resolve(result);
    }
  };
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      if (controls.shouldStart && !controls.shouldStart()) {
        stopRemaining();
        return;
      }
      const index = next;
      next += 1;
      if (index >= list.length) return;
      try {
        results[index] = await worker(list[index], index);
        deferred[index].resolve(results[index]);
      } catch (error) {
        deferred[index].reject(error);
        throw error;
      }
    }
  });
  return {
    promises: deferred.map((entry) => entry.promise),
    all: Promise.all(workers).then(() => results),
  };
}

function safeJobName(value) {
  return (
    String(value || 'job')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'job'
  );
}

function createJobWorkspace({ runId, jobId, input }) {
  const root = path.join(os.tmpdir(), 'secondbrain-card-controller', safeJobName(runId));
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, `${safeJobName(jobId)}-`));
  const inputFile = path.join(dir, 'input.json');
  const serialized = `${JSON.stringify(input || {}, null, 2)}\n`;
  fs.writeFileSync(inputFile, serialized, { encoding: 'utf8', mode: 0o444 });
  return {
    path: dir,
    inputFile,
    inputHash: crypto.createHash('sha256').update(serialized).digest('hex'),
    createdAt: new Date().toISOString(),
  };
}

function disposeJobWorkspace(workspace) {
  if (!workspace || !workspace.path) return { removed: false, reason: 'missing' };
  const resolved = path.resolve(workspace.path);
  const allowedRoot = path.resolve(path.join(os.tmpdir(), 'secondbrain-card-controller'));
  const inside = resolved.startsWith(`${allowedRoot}${path.sep}`) && resolved !== allowedRoot;
  if (!inside) return { removed: false, reason: 'outside-controller-temp-root' };
  fs.rmSync(resolved, { recursive: true, force: true });
  return { removed: !fs.existsSync(resolved), removedAt: new Date().toISOString() };
}

function currentEvidence(contract, dataDir, date) {
  try {
    return typeof contract.evidence === 'function'
      ? contract.evidence({ dataDir, date })
      : { digest: 'no-source-evidence', facts: {} };
  } catch (error) {
    return {
      digest: 'source-evidence-error',
      facts: { error: String((error && error.message) || error) },
    };
  }
}

function verificationInputsForCard(artifact, cardId) {
  const found = defectCodesForCard(artifact, cardId);
  return found.length ? found : ['REFRESH-VERIFY'];
}

function controllerPaths({ dataDir, date, runId }) {
  const root = controllerDir(dataDir);
  return {
    root,
    runDir: path.join(root, 'runs', date),
    receipt: path.join(root, 'runs', date, `${runId}.json`),
    backupDir: path.join(root, 'backups', date, runId),
    artifact: path.join(dataDir, 'agent', 'dashboard-qc-result.json'),
  };
}

function cardShellTitle(cardId) {
  const render = MANIFEST_CARD_RENDER[cardId];
  if (render && render.title) return String(render.title).replace(/:\s*$/, '');
  return String(cardId || '')
    .replace(/_/g, ' ')
    .toUpperCase();
}

function controllerShellMarkdown({ date, now = new Date(), mode = 'overnight' }) {
  const displayDate = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(now);
  const lines = [
    // The bootstrap is a real briefing shell, not a private controller format.
    // Its heading must satisfy the same scoped card QC that subsequent refreshes use.
    `# Daily Briefing - ${displayDate}`,
    '',
    `Briefing mode: ${mode === 'overnight' ? 'overnight' : 'off-cycle'}`,
    'Controller state: cloud card-controller bootstrap.',
    `Freshness: new ${date} board opened ${now.toISOString()}; each card must earn clean through its own scoped refresh and live QC.`,
    '',
  ];
  for (const card of CARDS) {
    const title = cardShellTitle(card.id);
    lines.push(`${title}:`);
    if (card.id === 'blockers') {
      lines.push('', 'Issue count: card refresh in progress. This new board is not a clean claim.');
    } else if (card.id === 'system_health') {
      lines.push(
        '',
        'Controller bootstrap: every subsystem remains unverified until its owning card passes scoped live QC.',
      );
    } else {
      lines.push('', 'Card refresh pending: fresh data and scoped live QC are still in progress.');
    }
    lines.push('', '---', '');
  }
  return `${lines.join('\n').replace(/\n---\n\s*$/, '\n')}`;
}

function bootstrapArtifact({ date, now }) {
  const cardTitles = Object.fromEntries(CARDS.map((card) => [card.id, cardShellTitle(card.id)]));
  const pending = CARDS.map((card) => ({
    id: card.id,
    title: cardShellTitle(card.id),
    defects: [`BOOTSTRAP-PENDING: ${card.id} requires scoped refresh and live QC`],
  }));
  return {
    ...buildLiveBoardArtifact({
      dashQc: { ran: true, ok: false, retry: false, cardStatuses: pending },
      date,
      cardTitles,
      now: () => now,
    }),
    defects: pending.map((card) => card.defects[0]),
    bootstrap: true,
  };
}

function isFullyUnverifiedBootstrap({ markdown, artifact, date }) {
  const hasBootstrapMarker =
    /^Briefing mode:\s*cloud card-controller bootstrap\./m.test(String(markdown || '')) ||
    /^Controller state:\s*cloud card-controller bootstrap\./m.test(String(markdown || ''));
  const hasCanonicalHeading = /^# Daily Briefing\b/m.test(String(markdown || ''));
  const hasCanonicalMode = /^Briefing mode:\s*(?:overnight|off-cycle)\s*$/m.test(
    String(markdown || ''),
  );
  const cards = Array.isArray(artifact && artifact.cards) ? artifact.cards : [];
  const defects = Array.isArray(artifact && artifact.defects) ? artifact.defects : [];
  const expectedPending = new Set(
    CARDS.map((card) => `BOOTSTRAP-PENDING: ${card.id} requires scoped refresh and live QC`),
  );
  return (
    hasBootstrapMarker &&
    (!hasCanonicalHeading || !hasCanonicalMode) &&
    artifact &&
    artifact.bootstrap === true &&
    String(artifact.date || '') === String(date || '') &&
    cards.length === CARDS.length &&
    cards.every((card) => card && card.status === 'defect') &&
    defects.length === expectedPending.size &&
    defects.every((defect) => expectedPending.has(String(defect || '')))
  );
}

function bootstrapBriefingShell({ dataDir, date, now = new Date(), mode = 'overnight' } = {}) {
  const markdown = markdownPathFor(dataDir, date);
  const artifactPath = path.join(dataDir, 'agent', 'dashboard-qc-result.json');
  const existingMarkdown = fs.existsSync(markdown) ? fs.readFileSync(markdown, 'utf8') : '';
  const existingArtifact = readJson(artifactPath, null);
  const replaceUnverified = isFullyUnverifiedBootstrap({
    markdown: existingMarkdown,
    artifact: existingArtifact,
    date,
  });
  if (fs.existsSync(markdown) && !replaceUnverified) {
    return { created: false, replaced: false, markdownPath: markdown, reason: 'already-exists' };
  }
  fs.mkdirSync(path.dirname(markdown), { recursive: true });
  const shell = controllerShellMarkdown({ date, now, mode });
  const temp = `${markdown}.${process.pid}.${Date.now()}.bootstrap`;
  fs.writeFileSync(temp, shell);
  fs.renameSync(temp, markdown);
  const artifact = bootstrapArtifact({ date, now });
  writeJsonAtomic(artifactPath, artifact);
  return { created: true, replaced: replaceUnverified, markdownPath: markdown, artifact };
}

async function runCardController(options = {}, injected = {}) {
  const now = options.now || new Date();
  const dataDir = options.dataDir || defaultDataDir();
  const date = options.date || ctDayKey(now);
  const mode = options.mode || 'midday';
  const runId = options.runId || makeRunId(now);
  const readArtifact = injected.readArtifact || (() => liveArtifact(dataDir));
  const getContract = injected.getSourceContract || getSourceContract;
  const commandRunner = injected.runCommand || runProcess;
  const sharedBriefingLock = injected.withSharedBriefingLock || withSharedBriefingLock;
  const createWorkspace = injected.createJobWorkspace || createJobWorkspace;
  const snapshot = injected.snapshotFile || snapshotFile;
  const startedAtMs = Number.isFinite(options.startedAtMs) ? options.startedAtMs : Date.now();
  const maxRunMs =
    Number.isFinite(options.maxRunMs) && options.maxRunMs > 0 ? options.maxRunMs : null;
  const deadlineAtMs = maxRunMs ? startedAtMs + maxRunMs : null;
  const deadlineController = new AbortController();
  let deadlineTimer = null;
  if (deadlineAtMs) {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) deadlineController.abort();
    else deadlineTimer = setTimeout(() => deadlineController.abort(), remainingMs);
  }
  const targetRefresh =
    injected.runTargetRefresh ||
    ((context) =>
      commandRunner(
        process.execPath,
        [
          'scripts/refresh-card.js',
          context.cardId,
          '--date',
          context.date,
          '--publish',
          '--verify',
        ],
        {
          cwd: REPO_ROOT,
          env: controllerSourceEnv(context.dataDir, {
            TMPDIR: context.workspaceDir,
            TMP: context.workspaceDir,
            TEMP: context.workspaceDir,
            BRIEFING_JOB_WORKSPACE: context.workspaceDir,
            BRIEFING_SHARED_LOCK_HELD: '1',
            // Only a controller-owned transaction may ask refresh-card to
            // publish. Direct CLI publication delegates back through this
            // entrypoint so journaling, rollback, and live proof cannot be
            // skipped by an operator or a legacy runner.
            BRIEFING_CONTROLLER_TRANSACTION: '1',
          }),
          timeoutMs: context.timeoutMs || options.refreshTimeoutMs || DEFAULT_REFRESH_TIMEOUT_MS,
          hardDeadlineAtMs: context.hardDeadlineAtMs,
          signal: context.signal,
        },
      ));
  const paths = controllerPaths({ dataDir, date, runId });
  let before = readArtifact();
  let plan = resolvePlan({ cards: options.cards, artifact: before });
  const receipt = {
    schemaVersion: 1,
    runId,
    mode,
    date,
    startedAt: now.toISOString(),
    shadow: !!options.shadow,
    supervised: !!options.supervised,
    humanActionToken: options.humanActionToken ? String(options.humanActionToken) : null,
    deadlineAt: deadlineAtMs ? new Date(deadlineAtMs).toISOString() : null,
    plannedCards: plan.map((item) => item.cardId),
    sourceFamilies: [],
    cards: [],
    frozen: false,
    outcome: 'running',
  };
  const persist = () => writeJsonAtomic(paths.receipt, receipt);
  persist();

  if (options.shadow) {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    receipt.outcome = 'shadow-planned';
    receipt.finishedAt = new Date().toISOString();
    persist();
    return receipt;
  }

  const lease = acquireLease({
    dataDir,
    runId,
    mode,
    date,
    now: now.getTime(),
    leaseMs: options.leaseMs,
  });
  if (!lease.acquired) {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    receipt.outcome = 'lease-held';
    receipt.lease = lease.lease || null;
    receipt.finishedAt = new Date().toISOString();
    persist();
    return receipt;
  }

  let sourceSchedule = null;
  let fatalError = null;
  try {
    const recovery = recoverIncompleteTransaction(dataDir);
    if (recovery) {
      receipt.recovery = recovery;
      if (!recovery.recovered) {
        receipt.frozen = true;
        receipt.freezeReason = `could not restore interrupted ${recovery.cardId || 'card'} transaction: ${recovery.error}`;
        receipt.outcome = 'frozen-recovery-failed';
        receipt.finishedAt = new Date().toISOString();
        persist();
        return receipt;
      }
      before = readArtifact();
      plan = resolvePlan({ cards: options.cards, artifact: before });
      receipt.plannedCards = plan.map((item) => item.cardId);
      persist();
    }
    if (options.bootstrap) {
      const bootstrap = bootstrapBriefingShell({ dataDir, date, now, mode });
      receipt.bootstrap = {
        created: bootstrap.created,
        replaced: !!bootstrap.replaced,
        markdownPath: bootstrap.markdownPath,
        reason: bootstrap.reason || null,
      };
      before = readArtifact();
      plan = resolvePlan({ cards: options.cards, artifact: before });
      receipt.plannedCards = plan.map((item) => item.cardId);
      persist();
    }
    // Data-only source pulls have no briefing markdown write. They can run in
    // parallel because the controller serializes only the shared publish lane.
    const sourceRows = sourceRefreshPlan(plan, getContract);
    const deadlineSourceResult = ({ contract, cardIds }, sourceIndex) => {
      const beforeEvidence = currentEvidence(contract, dataDir, date);
      const implementationDigest = controllerImplementationDigest(contract);
      const tactic = `source:${contract.family || 'card-local'}`;
      const tacticInputHash = hashTacticInput({
        family: contract.family || 'card-local',
        cardIds: [...cardIds].sort(),
        evidenceDigest: beforeEvidence.digest,
        implementationDigest,
        humanActionToken: options.humanActionToken ? String(options.humanActionToken) : null,
        mode,
      });
      return {
        family: contract.family,
        cardIds,
        ok: false,
        noSpin: false,
        deadlineSkipped: true,
        tactic,
        tacticInputHash,
        implementationDigest,
        beforeEvidence,
        afterEvidence: beforeEvidence,
        error: 'Controller deadline reached before this source family started.',
        commands: [],
        readyAt: new Date().toISOString(),
        sourceIndex,
      };
    };
    sourceSchedule = scheduleWithConcurrency(
      sourceRows,
      options.sourceConcurrency || DEFAULT_SOURCE_CONCURRENCY,
      async ({ contract, cardIds }, sourceIndex) => {
        if (deadlineController.signal.aborted) {
          return deadlineSourceResult({ contract, cardIds }, sourceIndex);
        }
        const beforeEvidence = currentEvidence(contract, dataDir, date);
        const implementationDigest = controllerImplementationDigest(contract);
        const humanActionToken = options.humanActionToken ? String(options.humanActionToken) : '';
        const tactic = `source:${contract.family || 'card-local'}`;
        const tacticInputHash = hashTacticInput({
          family: contract.family || 'card-local',
          cardIds: [...cardIds].sort(),
          evidenceDigest: beforeEvidence.digest,
          implementationDigest,
          humanActionToken: humanActionToken || null,
          mode,
        });
        const noSpin = cardIds.every((cardId) =>
          tacticAlreadyFailed(
            date,
            defectKey({ cardId, defectType: 'SOURCE-REFRESH' }),
            tactic,
            tacticInputHash,
            { dataDir },
          ),
        );
        if (noSpin) {
          return {
            family: contract.family,
            cardIds,
            ok: false,
            noSpin: true,
            tactic,
            tacticInputHash,
            implementationDigest,
            beforeEvidence,
            afterEvidence: beforeEvidence,
            error:
              'The identical source refresh already failed with unchanged source evidence today.',
            commands: [],
            readyAt: new Date().toISOString(),
            sourceIndex,
          };
        }
        const workspace = createJobWorkspace({
          runId,
          jobId: `source-${contract.family || sourceIndex}`,
          input: {
            schemaVersion: 1,
            kind: 'source-refresh',
            runId,
            date,
            family: contract.family || 'card-local',
            cardIds: [...cardIds],
            evidenceDigest: beforeEvidence.digest,
          },
        });
        let result;
        let error = null;
        let workspaceCleanup = null;
        try {
          const sourceCommandRunner = (command, args, runOptions = {}) => {
            const boundedTimeoutMs = boundedCommandTimeoutMs(
              runOptions.timeoutMs,
              deadlineAtMs,
            );
            if (boundedTimeoutMs === 0 || deadlineController.signal.aborted) {
              throw deadlineExceededError();
            }
            return commandRunner(command, args, {
              ...runOptions,
              ...(boundedTimeoutMs == null ? {} : { timeoutMs: boundedTimeoutMs }),
              hardDeadlineAtMs: deadlineAtMs,
              signal: deadlineController.signal,
              env: {
                ...(runOptions.env || process.env),
                TMPDIR: workspace.path,
                TMP: workspace.path,
                TEMP: workspace.path,
                BRIEFING_JOB_WORKSPACE: workspace.path,
              },
            });
          };
          result = await awaitWithAbort(
            contract.refresh({
              dataDir,
              date,
              cardIds,
              cwd: REPO_ROOT,
              node: process.execPath,
              runCommand: sourceCommandRunner,
              workspaceDir: workspace.path,
              signal: deadlineController.signal,
              deadlineAtMs,
            }),
            deadlineController.signal,
          );
        } catch (caught) {
          error = String((caught && caught.message) || caught);
          result = { ok: false, error };
        } finally {
          workspaceCleanup = disposeJobWorkspace(workspace);
        }
        const afterEvidence = currentEvidence(contract, dataDir, date);
        return {
          family: contract.family,
          cardIds,
          ok: !!(result && result.ok),
          noSpin: false,
          deadlineExpired:
            deadlineController.signal.aborted ||
            (error && /CONTROLLER_DEADLINE_EXCEEDED|wall-clock deadline/i.test(error)) ||
            undefined,
          // A contract may intentionally preserve a fresh proven source instead
          // of rewriting it (producer parity, frozen run 20260719103219). The
          // receipt must say so explicitly, or a skip is indistinguishable from
          // a refresh that ran. undefined drops out of the JSON receipt.
          skipped: result && result.skipped === true ? true : undefined,
          skipReason: (result && result.skipReason) || undefined,
          tactic,
          tacticInputHash,
          implementationDigest,
          beforeEvidence,
          afterEvidence,
          readyAt: new Date().toISOString(),
          sourceIndex,
          workspace: {
            path: workspace.path,
            inputHash: workspace.inputHash,
            createdAt: workspace.createdAt,
            ...workspaceCleanup,
          },
          error: error || String((result && result.error) || ''),
          // Keep the durable receipt inspectable without accidentally storing a
          // multi-megabyte child-process transcript on every overnight run.
          commands: Array.isArray(result && result.results)
            ? result.results.map((row) => ({
                args: row.args || [],
                ok: !!row.ok,
                exitCode: Number(row.result && row.result.exitCode),
                timedOut: !!(row.result && row.result.timedOut),
                stderr: String((row.result && row.result.stderr) || '').slice(-2000),
              }))
            : [],
        };
      },
      {
        shouldStart: () => !deadlineController.signal.aborted,
        onSkipped: deadlineSourceResult,
      },
    );
    const sourcePromiseByCard = new Map();
    sourceRows.forEach((row, index) => {
      for (const cardId of row.cardIds) {
        sourcePromiseByCard.set(cardId, sourceSchedule.promises[index]);
      }
    });
    const recordedSourceIndexes = new Set();
    const recordSourceResult = (source) => {
      if (!source || recordedSourceIndexes.has(source.sourceIndex)) return;
      recordedSourceIndexes.add(source.sourceIndex);
      receipt.sourceFamilies.push(source);
      if (source.ok || source.noSpin || source.deadlineSkipped || source.deadlineExpired) return;
      for (const cardId of source.cardIds) {
        recordAttempt(
          date,
          {
            defect: { cardId, defectType: 'SOURCE-REFRESH' },
            tactic: source.tactic,
            tacticInputHash: source.tacticInputHash,
            repairImplementationDigest: source.implementationDigest,
            humanActionToken: options.humanActionToken ? String(options.humanActionToken) : null,
            ownerCardId: cardId,
            affectedCardIds: [cardId],
            dependentCardIds: [],
            sourceHashes: { [source.family || 'card-local']: source.beforeEvidence.digest },
            qcScope: [],
            qcResult: 'source-failed',
            fix: 'source-failed',
            reflection:
              source.error || `Source family '${source.family}' failed before target render.`,
          },
          { dataDir },
        );
      }
    };

    const pendingCards = plan.map((item, planIndex) => ({
      item,
      planIndex,
      sourcePromise: sourcePromiseByCard.get(item.cardId) || Promise.resolve(null),
    }));

    // This is intentionally a single lane. refresh-card atomically splices into
    // the same briefing file, so parallel publishes would race even though card
    // source/QC reasoning is independent. The next lane entrant is whichever
    // card's declared source becomes ready first, not whichever source family
    // happens to be slowest.
    while (pendingCards.length) {
      const ready = await Promise.race(
        pendingCards.map((entry) =>
          entry.sourcePromise.then((source) => ({ entry, source })),
        ),
      );
      const pendingIndex = pendingCards.indexOf(ready.entry);
      if (pendingIndex >= 0) pendingCards.splice(pendingIndex, 1);
      const item = ready.entry.item;
      const source = ready.source;
      recordSourceResult(source);
      persist();
      if (receipt.frozen) break;
      if (deadlineAtMs && Date.now() >= deadlineAtMs) {
        receipt.timeBudgetExhausted = true;
        receipt.timeBudgetReason =
          'Controller deadline reached before the next scoped card repair; no new target was started.';
        break;
      }
      const cardId = item.cardId;
      const contract = getContract(cardId);
      const attemptBefore = readArtifact();
      const evidence = currentEvidence(contract, dataDir, date);
      const defects = defectCodesForCard(attemptBefore, cardId);
      const verificationInputs = verificationInputsForCard(attemptBefore, cardId);
      const tactic =
        source && typeof contract.refresh === 'function'
          ? `source:${contract.family}+targeted-refresh`
          : `targeted-refresh:${contract.family || 'card-local'}`;
      const implementationDigest = controllerImplementationDigest(contract);
      const humanActionToken = options.humanActionToken ? String(options.humanActionToken) : '';
      const tacticInput = {
        cardId,
        defects: [...verificationInputs].sort(),
        liveTs: attemptBefore.ts || null,
        evidenceDigest: evidence.digest,
        implementationDigest,
        humanActionToken: humanActionToken || null,
        mode,
      };
      const tacticInputHash = hashTacticInput(tacticInput);
      const noSpin = verificationInputs.every((code) =>
        tacticAlreadyFailed(
          date,
          defectKey({ cardId, defectType: code }),
          tactic,
          tacticInputHash,
          { dataDir },
        ),
      );
      const cardReceipt = {
        cardId,
        forced: item.forced,
        requestedBy: item.requestedBy,
        tactic,
        tacticInputHash,
        implementationDigest,
        humanActionToken: humanActionToken || null,
        defectsBefore: defects,
        verificationInputs,
        sourceFamily: contract.family || 'card-local',
        sourceOk: !source || source.ok,
        startedAt: new Date().toISOString(),
      };

      if (source && source.noSpin) {
        cardReceipt.outcome = 'source-no-spin-skip';
        cardReceipt.reflection = `source family '${contract.family}' already failed with unchanged evidence today; target refresh was not repeated.`;
      } else if (source && !source.ok) {
        cardReceipt.outcome = 'source-failed';
        cardReceipt.reflection = `source family '${contract.family}' failed before card render; target refresh was not attempted.`;
      } else if (noSpin) {
        cardReceipt.outcome = 'no-spin-skip';
        cardReceipt.reflection =
          'The identical tactic with identical live/source evidence already failed today.';
      } else {
        await sharedBriefingLock(
          async () => {
            assertWithinDeadline(deadlineController.signal, deadlineAtMs);
            const workspace = createWorkspace({
              runId,
              jobId: `card-${cardId}`,
              input: {
                schemaVersion: 1,
                kind: 'card-refresh',
                runId,
                date,
                cardId,
                sourceFamily: contract.family || 'card-local',
                evidenceDigest: evidence.digest,
                verificationInputs,
              },
            });
            const markdown = markdownPathFor(dataDir, date);
            assertWithinDeadline(deadlineController.signal, deadlineAtMs);
            const backups = {
              markdown: snapshot(markdown, path.join(paths.backupDir, `${cardId}.md`)),
              artifact: snapshot(
                paths.artifact,
                path.join(paths.backupDir, `${cardId}.dashboard-qc.json`),
              ),
              cardArtifact: snapshot(
                artifactPathFor({ dataDir, date, id: cardId }),
                path.join(paths.backupDir, `${cardId}.card-artifact.json`),
              ),
              blockersArtifact: snapshot(
                artifactPathFor({ dataDir, date, id: 'blockers' }),
                path.join(paths.backupDir, `${cardId}.blockers-artifact.json`),
              ),
            };
            cardReceipt.backups = {
              markdownExisted: backups.markdown.existed,
              artifactExisted: backups.artifact.existed,
              cardArtifactExisted: backups.cardArtifact.existed,
              blockersArtifactExisted: backups.blockersArtifact.existed,
            };
            assertWithinDeadline(deadlineController.signal, deadlineAtMs);
            writeActiveTransaction(
              dataDir,
              {
                runId,
                cardId,
                date,
                mode,
                startedAt: new Date().toISOString(),
                backups,
              },
              { signal: deadlineController.signal, deadlineAtMs },
            );
            let command;
            try {
              const remainingMs = deadlineAtMs ? Math.max(0, deadlineAtMs - Date.now()) : null;
              if (remainingMs === 0 || deadlineController.signal.aborted) {
                throw deadlineExceededError();
              }
              command = await awaitWithAbort(
                targetRefresh({
                  cardId,
                  date,
                  dataDir,
                  mode,
                  supervised: !!options.supervised,
                  workspaceDir: workspace.path,
                  timeoutMs: remainingMs
                    ? Math.min(options.refreshTimeoutMs || DEFAULT_REFRESH_TIMEOUT_MS, remainingMs)
                    : options.refreshTimeoutMs || DEFAULT_REFRESH_TIMEOUT_MS,
                  hardDeadlineAtMs: deadlineAtMs,
                  signal: deadlineController.signal,
                }),
                deadlineController.signal,
              );
            } catch (error) {
              command = {
                exitCode: 1,
                timedOut: false,
                stderr: String((error && error.stack) || error),
              };
            }
            const workspaceCleanup = disposeJobWorkspace(workspace);
            cardReceipt.workspace = {
              path: workspace.path,
              inputHash: workspace.inputHash,
              createdAt: workspace.createdAt,
              ...workspaceCleanup,
            };
            const attemptAfter = readArtifact();
            // A full-card practice is still only allowed to move cards red -> green.
            // Preserve a formerly green target too, not merely unrelated green cards.
            const regressions = greenRegressions(attemptBefore, attemptAfter, {
              cardId,
              protectTarget: true,
            });
            const verifiedLive = hasVerifiedScopedLiveResult({
              command,
              beforeArtifact: attemptBefore,
              afterArtifact: attemptAfter,
              cardId,
              date,
            });
            const liveVerdictExampleCo =
              !verifiedLive &&
              hasExampleCoLiveVerdict({
                command,
                beforeArtifact: attemptBefore,
                afterArtifact: attemptAfter,
                cardId,
                date,
              });
            cardReceipt.command = {
              exitCode: Number(command && command.exitCode),
              timedOut: !!(command && command.timedOut),
              verifiedLive,
              liveVerdictExampleCo,
              stderr: String((command && command.stderr) || '').slice(-4000),
            };
            cardReceipt.statusAfter = cardStatus(attemptAfter, cardId);
            cardReceipt.defectsAfter = defectCodesForCard(attemptAfter, cardId);
            cardReceipt.greenRegressions = regressions;
            if (regressions.length) {
              restoreTransactionBackups(backups);
              cardReceipt.outcome = 'rolled-back-green-regression';
              cardReceipt.reflection = `Rolled back: ${regressions.map((row) => `${row.id} ${row.beforeStatus}->${row.afterStatus}`).join(', ')}.`;
              receipt.frozen = true;
              receipt.freezeReason = cardReceipt.reflection;
            } else if (liveVerdictExampleCo && cardReceipt.statusAfter === 'clean') {
              // The card BUILT clean and its own artifact advanced; the live
              // dashboard simply could not be consulted, so the verdict is ExampleCo.
              // Destroying a good build over an infrastructure outage is the defect
              // class da4dde67 fixed. Keep the build, own the uncertainty out loud,
              // and refuse to call the run clean until live proof arrives.
              const markedPublished = await markCardExampleCoAndRepublish({
                dataDir,
                date,
                cardId,
              });
              const marked = markedPublished.board;
              cardReceipt.statusAfter = cardStatus(marked, cardId);
              cardReceipt.defectsAfter = defectCodesForCard(marked, cardId);
              cardReceipt.outcome = 'kept-unverified-live-unreachable';
              cardReceipt.liveVerdict = 'ExampleCo';
              cardReceipt.reflection =
                'Live dashboard could not be consulted, so the scoped verdict is ExampleCo, not failed. The target built clean and its own artifact advanced, so the build stands rather than being rolled back. Its verification state is published as stale so the board shows it unproven and the next run re-selects it.';
            } else if (!verifiedLive) {
              restoreTransactionBackups(backups);
              cardReceipt.outcome = 'rolled-back-unverified-target';
              cardReceipt.reflection =
                'Rolled back: targeted write did not produce fresh scoped live-QC proof, so a partial markdown/artifact update cannot remain published.';
            } else if (cardReceipt.statusAfter !== 'clean') {
              cardReceipt.outcome = 'target-remains-nonclean';
              cardReceipt.reflection =
                'Targeted refresh completed but scoped live QC still reports the card non-clean.';
            } else {
              cardReceipt.outcome = 'cleared';
              cardReceipt.reflection =
                'Targeted refresh and scoped live QC passed without regressing any unrelated green card.';
            }
            clearActiveTransaction(dataDir, runId);
          },
          { signal: deadlineController.signal, deadlineAtMs },
        );
      }

      const qcResult = cardReceipt.outcome === 'cleared' ? 'cleared' : cardReceipt.outcome;
      if (cardReceipt.outcome !== 'source-no-spin-skip') {
        for (const code of verificationInputs) {
          recordAttempt(
            date,
            {
              defect: { cardId, defectType: code },
              tactic,
              tacticInputHash,
              repairImplementationDigest: implementationDigest,
              humanActionToken: humanActionToken || null,
              ownerCardId: cardId,
              affectedCardIds: [cardId],
              dependentCardIds: DERIVED_CARD_IDS,
              sourceHashes: { [contract.family || 'card-local']: evidence.digest },
              qcScope: [cardId],
              qcResult,
              fix: cardReceipt.outcome,
              reflection: cardReceipt.reflection,
            },
            { dataDir },
          );
        }
      }
      cardReceipt.finishedAt = new Date().toISOString();
      receipt.cards.push(cardReceipt);
      persist();
    }
    const allSourceResults = await sourceSchedule.all;
    for (const source of allSourceResults) recordSourceResult(source);
    receipt.sourceFamilies.sort(
      (a, b) =>
        Date.parse(a.readyAt || 0) - Date.parse(b.readyAt || 0) ||
        Number(a.sourceIndex || 0) - Number(b.sourceIndex || 0),
    );
    persist();
  } catch (error) {
    fatalError = error;
    receipt.error = String((error && error.message) || error);
    if (
      deadlineController.signal.aborted ||
      (error && error.code === 'CONTROLLER_DEADLINE_EXCEEDED') ||
      /controller deadline|wall-clock deadline/i.test(receipt.error)
    ) {
      receipt.timeBudgetExhausted = true;
      receipt.timeBudgetReason =
        'Controller deadline reached while waiting for or holding the shared publish lock; no post-deadline transaction was started.';
    }
    if (sourceSchedule) {
      try {
        await sourceSchedule.all;
      } catch {
        // The original fatal error remains the receipt authority.
      }
    }
    receipt.outcome = receipt.timeBudgetExhausted ? 'time-budget-exhausted' : 'failed';
    receipt.finishedAt = new Date().toISOString();
    persist();
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    try {
      releaseLease(lease, runId);
    } catch (error) {
      fatalError = fatalError || error;
      receipt.error = receipt.error
        ? `${receipt.error}; lease release failed: ${String((error && error.message) || error)}`
        : `Lease release failed: ${String((error && error.message) || error)}`;
      receipt.outcome = 'failed';
      receipt.finishedAt = new Date().toISOString();
      persist();
    }
  }

  receipt.outcome = receipt.frozen
    ? 'frozen-after-rollback'
    : receipt.timeBudgetExhausted
      ? 'time-budget-exhausted'
      : fatalError
        ? 'failed'
      : receipt.cards.some((card) => card.outcome !== 'cleared')
        ? 'needs-attention'
        : 'clean';
  receipt.finishedAt = new Date().toISOString();
  persist();
  try {
    const finalArtifact = readArtifact();
    receipt.final = {
      ts: finalArtifact.ts || null,
      defectiveCardCount: Number.isFinite(finalArtifact.defectiveCardCount)
        ? finalArtifact.defectiveCardCount
        : statusMap(finalArtifact).size
          ? [...statusMap(finalArtifact).values()].filter((status) => status !== 'clean').length
          : null,
      nonCleanCards: [...statusMap(finalArtifact).entries()]
        .filter(([, status]) => status !== 'clean')
        .map(([id, status]) => ({ id, status })),
    };
    if (options.notify) {
      loadBriefingNotifyEnv(dataDir);
      receipt.notify = await notifyBriefingPublished({
        dataDir,
        date,
        artifact: finalArtifact,
        phase: 'final',
        url: buildBriefingDashboardUrl(
          process.env.BRIEFING_PUBLIC_BASE_URL || 'http://ExampleCo:3001/briefing',
          process.env.SB_BRIEFING_TOKEN || '',
        ),
        send: injected.notifySend || notifyWithFallback,
      });
    }
  } catch (error) {
    fatalError = fatalError || error;
    receipt.error = receipt.error
      ? `${receipt.error}; finalization failed: ${String((error && error.message) || error)}`
      : `Finalization failed: ${String((error && error.message) || error)}`;
    receipt.outcome = 'failed';
  } finally {
    receipt.finishedAt = new Date().toISOString();
    persist();
  }
  return receipt;
}

module.exports = {
  CONTROLLER_REL_DIR,
  DEFAULT_LEASE_MS,
  DEFAULT_REFRESH_TIMEOUT_MS,
  DEFAULT_SOURCE_CONCURRENCY,
  ctDayKey,
  defaultDataDir,
  controllerDir,
  makeRunId,
  parseCardList,
  primaryCardIds,
  boundedCommandTimeoutMs,
  statusMap,
  defectCodesForCard,
  cardStatus,
  mutualMergePartnerIds,
  effectiveGreenGuardStatus,
  unrelatedGreenRegressions,
  greenRegressions,
  controllerImplementationDigest,
  hasVerifiedScopedLiveResult,
  hasExampleCoLiveVerdict,
  markCardVerificationExampleCo,
  ExampleCo_VERDICT_DEFECT,
  resolvePlan,
  snapshotFile,
  restoreSnapshot,
  restoreTransactionBackups,
  activeTransactionPath,
  writeActiveTransaction,
  clearActiveTransaction,
  recoverIncompleteTransaction,
  leaseOwnerAlive,
  acquireLease,
  releaseLease,
  runProcess,
  sourceRefreshPlan,
  mapWithConcurrency,
  scheduleWithConcurrency,
  createJobWorkspace,
  disposeJobWorkspace,
  controllerPaths,
  cardShellTitle,
  controllerShellMarkdown,
  bootstrapBriefingShell,
  runCardController,
};
