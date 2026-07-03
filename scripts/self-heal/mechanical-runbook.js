'use strict';

// scripts/self-heal/mechanical-runbook.js
//
// ITEM W2a: the C1 MECHANICAL-FIRST HEAL TIER. The overnight self-heal loop's
// only tactic today is a 20-minute claude/codex code-editing worker (0/9 at
// 8min, 0/2 at 20min -- it has NEVER cleared a defect), yet every observed
// morning defect was MECHANICAL: a stale snapshot, an orphaned lock, a
// generator that ran but whose output the reader never picked up, or work
// finishing after the 5:30 snapshot. This module is the DEFECT-CLASS ->
// MECHANICAL-ACTION registry: given a render-QC defect (card id + defect
// kind), it resolves and RUNS the cheap, deterministic fix BEFORE any LLM
// worker is spawned.
//
// Consumes two existing seeds, does not invent a third registry:
//   (a) scripts/lib/briefing-card-manifest.js -- an OPTIONAL per-card `heal`
//       entry { command, prerequisites, timeoutMs } naming the generator that
//       refreshes that card's data. Highest precedence: it is the card's own
//       declared refresh command.
//   (b) dev-plans/_domains.json -- per-card failureModes[].healLadder arrays
//       (read through scripts/self-heal/verdict.js, the ONE runtime reader of
//       that contract). First rung, string or callable-object form.
// Falls through to GENERIC CLASS ACTIONS when neither seed has an entry:
//   - stale dated artifact -> re-run its generator (same shape as a manifest
//     heal entry, but keyed by a generic "stale" defect type)
//   - orphaned lock whose owner pid is dead -> reclaim it, reusing the
//     classifyOtterVoiceLock pattern from scripts/cloud-morning-briefing.js
//     (commit e4580451): dead pid, pid 1/init (reparented), or an unreadable
//     owner past a TTL are all "clearable", never a permanent wall.
//
// CODEX AMENDMENT 1 (same-reader postcondition): a mechanical action's exit
// code 0 is NOT trusted. After running it, the card's artifact is re-resolved
// through scripts/lib/data-root.js resolveDataArtifact (the same path a real
// card reader uses) and the action only counts as CLEARED when EITHER the
// artifactSha changed OR the artifact's freshness stamp is NEWER than the
// moment the action started (never merely "within window" -- a pre-existing
// artifact that happened to already be fresh must not false-clear a no-op
// run), AND a card-level render-QC re-check also passes. QC is FAIL-CLOSED:
// any artifact-backed action with no injected opts.rerunCardQc is recorded
// FAILED, never a silent pass. An action with no declared artifactPath (lock
// reclaim, an artifact-free callable rung) has nothing for a card-level QC to
// inspect and is exempt. Exit-0-but-nothing-changed (or exit-0-with-no-QC) is
// recorded as a FAILED attempt, not a silent no-op, so the no-repeat-tactic
// guard (briefing-repair-ledger.js) can see it and refuse to re-run the
// identical move -- the tactic-input hash includes the before-state
// (artifact sha/freshness, lock owner pid/age, raw defect evidence), so a
// genuinely changed input is still allowed through later the same day.
//
// Serialization: runMechanicalAction takes an injectable `lock` (flock-style)
// so the caller can serialize the whole mechanical tier to one job at a time
// (the box is t3.large and OOM-prone). Default lock is a no-op passthrough so
// unit tests do not need to wire one.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const cardManifest = require('../lib/briefing-card-manifest.js');
const dataRoot = require('../lib/data-root.js');
const verdict = require('./verdict.js');
const ledger = require('./briefing-repair-ledger.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── card id crosswalk ───────────────────────────────────────────────────────
//
// briefing-card-manifest.js ids are underscore-snake (e.g. "us_news");
// dev-plans/_domains.json cardIds are dash-kebab (e.g. "news-us"). Neither
// seed declares a crosswalk today (manifest-coverage.js only maps probe/
// channel keys, not general card ids), so the resolver owns a small,
// explicit table for the cards that actually have healLadders today. An
// unmapped id is not an error -- it just means the _domains.json seed has
// nothing for that card and the resolver falls through to manifest heal /
// generic class actions.
const MANIFEST_ID_TO_DOMAINS_ID = {
  us_news: 'news-us',
  world_news: 'news-world',
  ai_tech_news: 'news-aitech',
  us_immigration_news: 'news-immigration',
  mortgage_industry_news: 'news-mortgage',
  covid_news: 'news-covid',
  viral_tech_clips: 'viral-clips',
  shorts_proposals: 'shorts',
  video_approval_queue: 'video-approval-queue',
  kingdom_equipping: 'kingdom_equipping',
  self_heal_health: 'self_heal_health',
};

function domainsIdForCard(cardId) {
  return MANIFEST_ID_TO_DOMAINS_ID[cardId] || null;
}

// ── generic class actions ───────────────────────────────────────────────────
//
// Keyed by defect_type (the UPPER-CASE token the render-QC parser yields,
// see renderQcDefectType in overnight-self-heal-orchestrator.js). Each entry
// resolves to { command: [bin, ...args], timeoutMs } OR to a `reclaimLock`
// function for the orphaned-lock class (no subprocess involved).
const STALE_DEFECT_TYPES = new Set([
  'STALE',
  'STALE-ARTIFACT',
  'NEWS-STUB',
  'BUILDER-COUNT',
  'BLOCKED-TILE',
  'BLOCKED-CARD',
]);
const LOCK_DEFECT_TYPES = new Set(['LOCK-ORPHANED', 'LOCK-STALE', 'STALE-LOCK']);

// Signal-0 pid-liveness probe, same technique as
// scripts/cloud-morning-briefing.js otterVoiceLockPidAlive. Duplicated (not
// required) because that file is the briefing generator, not a reusable lib;
// keeping this module dependency-free of cloud-morning-briefing.js avoids a
// heavy circular require. Kept in lockstep by
// scripts/__tests__/mechanical-runbook.test.js (same classification cases).
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// Classify a lock (owner.json shape: { pid, started_at }) for reclaim
// eligibility. Mirrors classifyOtterVoiceLock's orphan rules generically:
// dead pid, pid===1 (reparented to init), or an unreadable owner past a TTL
// are all clearable. Pure + injectable (isPidAlive) for tests.
function classifyLockForReclaim({
  owner = null,
  present = owner != null,
  nowMs = Date.now(),
  lockAgeMs = null,
  isPidAlive = pidAlive,
  ttlMs = 3 * 60 * 60 * 1000,
} = {}) {
  if (!present) return { clearable: false, reason: 'no lock present' };
  const pid = owner ? Number(owner.pid) : NaN;
  const reparentedToInit = pid === 1;
  const ownerReadable = owner != null && Number.isInteger(pid) && pid > 0;
  const ownerDead = ownerReadable && !reparentedToInit && !isPidAlive(pid);
  const startedMs = owner && owner.started_at ? Date.parse(owner.started_at) : NaN;
  const effAgeMs = Number.isFinite(startedMs) ? nowMs - startedMs : lockAgeMs;
  const unreadableAndAbandoned =
    !ownerReadable && !reparentedToInit && effAgeMs != null && effAgeMs > ttlMs;
  if (reparentedToInit) return { clearable: true, reason: 'owner reparented to init (pid 1)' };
  if (ownerDead) return { clearable: true, reason: `owner pid ${pid} is dead` };
  if (unreadableAndAbandoned)
    return { clearable: true, reason: `owner unreadable and past TTL (${ttlMs}ms)` };
  return { clearable: false, reason: 'owner is a live, non-init process within TTL' };
}

// Reclaim a clearable lock directory: remove it so the next producer can
// acquire it fresh. Injectable rmDir for tests. Never throws; returns
// { ok, error? }.
function reclaimLockDir(lockDirPath, opts = {}) {
  const rm = opts.rm || ((p) => fs.rmSync(p, { recursive: true, force: true }));
  try {
    rm(lockDirPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ── artifact sha / freshness for the same-reader postcondition ─────────────

function shaOf(json) {
  if (json == null) return '';
  const s = typeof json === 'string' ? json : JSON.stringify(json);
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

// Re-resolve the SAME artifact a real card reader would see (through
// resolveDataArtifact, the one-data-root contract), and report whether it
// changed relative to a prior-observed sha, or is fresh within window.
function readCardArtifact(artifactRel, opts = {}) {
  if (!artifactRel) return { json: null, sha: '', freshnessMs: null, absPath: null };
  const resolved = dataRoot.resolveDataArtifact(artifactRel, opts);
  return {
    json: resolved.json,
    sha: shaOf(resolved.json),
    freshnessMs: resolved.freshnessMs,
    absPath: resolved.absPath,
  };
}

function isFreshWithin(freshnessMs, windowMs, nowMs = Date.now()) {
  if (!Number.isFinite(freshnessMs) || !Number.isFinite(windowMs)) return false;
  return nowMs - freshnessMs <= windowMs;
}

// ── resolution precedence ───────────────────────────────────────────────────
//
// manifest heal entry (a) > _domains.json healLadder first rung (b) > generic
// class action. Returns a normalized action descriptor:
//   { source, kind: 'command'|'lock-reclaim', command, timeoutMs,
//     prerequisites, label, artifactPath, freshnessWindowMs }
// or { source: 'none' } when nothing resolves (the caller must escalate to
// the LLM worker or an honest wall, never crash).
function resolveMechanicalAction(defect, opts = {}) {
  const cardId = String((defect && defect.card_id) || defect.cardId || '').trim();
  const defectType = String((defect && defect.defect_type) || defect.defectType || '')
    .trim()
    .toUpperCase();
  if (!cardId) return { source: 'none', reason: 'defect ExampleCos no card_id' };

  // (a) manifest heal entry -- highest precedence.
  const card = (opts.getCardById || cardManifest.getCardById)(cardId);
  if (card && card.heal && card.heal.command) {
    return {
      source: 'manifest-heal',
      kind: 'command',
      cardId,
      defectType,
      command: card.heal.command,
      timeoutMs: Number(card.heal.timeoutMs) || 120000,
      prerequisites: Array.isArray(card.heal.prerequisites) ? card.heal.prerequisites : [],
      label: `manifest-heal:${cardId}`,
      artifactPath: card.heal.artifactPath || null,
      freshnessWindowMs: Number(card.heal.freshnessWindowMs) || 6 * 60 * 60 * 1000,
    };
  }

  // (b) _domains.json healLadder first rung.
  const domainsId = domainsIdForCard(cardId);
  if (domainsId) {
    const contract = (opts.loadCardContract || verdict.loadCardContract)(domainsId, opts);
    const fm = contract && Array.isArray(contract.failureModes) ? contract.failureModes[0] : null;
    const rung = fm && Array.isArray(fm.healLadder) ? fm.healLadder[0] : null;
    if (rung != null && verdict.isCallableRung(rung)) {
      return {
        source: 'domains-heal-ladder',
        kind: 'callable',
        cardId,
        defectType,
        rung,
        label: verdict.healLadderRungLabel(rung),
        timeoutMs: Number(rung.timeoutMs) || 120000,
        prerequisites: Array.isArray(rung.prerequisites) ? rung.prerequisites : [],
        artifactPath: rung.artifactPath || null,
        freshnessWindowMs: Number(rung.freshnessWindowMs) || 6 * 60 * 60 * 1000,
      };
    }
    // A legacy free-text first rung is not directly executable. It does NOT
    // stop resolution here (Codex review 2026-07-03: stopping at 'none' left
    // any card mapped in MANIFEST_ID_TO_DOMAINS_ID with a text-only rung
    // unable to reach the generic class action below, even when its
    // defect_type is a plain lock/stale case). Fall through to (c); if a
    // generic action ALSO cannot resolve, the final 'none' reason mentions
    // the text rung so the WHY report still names the human-authored intent.
  }

  // (c) generic class actions.
  if (LOCK_DEFECT_TYPES.has(defectType)) {
    return {
      source: 'generic-lock-reclaim',
      kind: 'lock-reclaim',
      cardId,
      defectType,
      label: `lock-reclaim:${cardId}`,
      timeoutMs: 15000,
      prerequisites: ['lockDirPath', 'owner'],
    };
  }
  if (STALE_DEFECT_TYPES.has(defectType)) {
    return {
      source: 'generic-stale-none',
      kind: 'none',
      cardId,
      defectType,
      reason: `card '${cardId}' has no manifest heal entry and no callable _domains.json rung for a stale-artifact regen`,
    };
  }

  const textRung = domainsId
    ? (() => {
        const contract = (opts.loadCardContract || verdict.loadCardContract)(domainsId, opts);
        const fm =
          contract && Array.isArray(contract.failureModes) ? contract.failureModes[0] : null;
        const first = fm && Array.isArray(fm.healLadder) ? fm.healLadder[0] : null;
        return first != null && !verdict.isCallableRung(first) ? String(first) : null;
      })()
    : null;

  return {
    source: 'none',
    cardId,
    defectType,
    reason: textRung
      ? `no manifest heal entry and no generic class action for defect_type '${defectType}'; _domains.json names a free-text rung, not callable: "${textRung.slice(0, 160)}"`
      : `no manifest heal entry, no _domains.json healLadder rung, and no generic class action for defect_type '${defectType}'`,
  };
}

// ── serialization (one job at a time; OOM-prone box) ────────────────────────
//
// A trivial default in-process mutex so callers get real serialization
// without wiring anything, plus an injectable `lock` for a cross-process
// flock-style implementation (or a test double). withLock resolves the given
// async fn only after acquiring, and always releases, even on throw.
function createInProcessLock() {
  let chain = Promise.resolve();
  return {
    withLock(fn) {
      const run = chain.then(() => fn());
      // Chain continues regardless of fn's outcome, so one failed action
      // never wedges the queue for the next mechanical action.
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

const DEFAULT_LOCK = createInProcessLock();

// ── process-group kill wrapper ──────────────────────────────────────────────
//
// spawnSync with a timeout does not guarantee the whole process tree dies on
// Windows/POSIX alike; killSignal + treeKill-on-timeout mirrors
// heal-executor.js's treeKill so a hung mechanical action cannot leak a
// grandchild. Kept minimal (spawnSync already reaps its direct child on
// timeout via killSignal); documented here so a future extension to spawn()
// knows to reuse heal-executor's treeKill rather than re-deriving it.
function runCommand(command, opts = {}) {
  const [bin, ...args] = Array.isArray(command) ? command : [String(command)];
  const runner = opts.spawnSync || spawnSync;
  const result = runner(bin, args, {
    cwd: opts.cwd || REPO_ROOT,
    encoding: 'utf8',
    timeout: opts.timeoutMs || 120000,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const timedOut =
    result &&
    (result.signal === 'SIGKILL' ||
      result.signal === 'SIGTERM' ||
      /ETIMEDOUT/i.test(String((result.error && result.error.code) || '')));
  return {
    ok: !timedOut && result && result.status === 0,
    status: result ? result.status : null,
    signal: (result && result.signal) || null,
    timedOut: !!timedOut,
    stdout: String((result && result.stdout) || '').slice(-4000),
    stderr: String(
      (result && result.stderr) || (result && result.error && result.error.message) || '',
    ).slice(-4000),
  };
}

// ── prerequisites ───────────────────────────────────────────────────────────
//
// A missing prerequisite reports a NAMED WALL, never a crash. prerequisites
// is an array of dot-paths into opts.context that must be present/truthy.
function checkPrerequisites(action, context = {}) {
  const missing = [];
  for (const key of action.prerequisites || []) {
    const parts = String(key).split('.');
    let v = context;
    for (const p of parts) {
      v = v && typeof v === 'object' ? v[p] : undefined;
    }
    if (v == null || v === '') missing.push(key);
  }
  return { ok: missing.length === 0, missing };
}

// ── the executor: resolve -> prereq-check -> no-repeat-check -> run ->
//    same-reader postcondition -> re-QC -> ledger row ───────────────────────
//
// opts:
//   context           - values satisfying action.prerequisites (e.g. { lockDirPath, owner })
//   lock              - { withLock(fn) } serializer; default in-process one-at-a-time
//   date              - YYYY-MM-DD for the repair ledger
//   ledgerOpts        - passed through to briefing-repair-ledger (injectable dataDir in tests)
//   rerunCardQc(cardId, opts) -> { pass, reason } - card-level render QC re-check
//   nowMs, spawnSync, rm, isPidAlive, getCardById, loadCardContract - DI seams
// Returns a result row:
//   { status: 'cleared'|'failed'|'skipped', reason, action, artifactSha, readerFresh, wall }
async function runMechanicalAction(defect, opts = {}) {
  const action = (opts.resolveMechanicalAction || resolveMechanicalAction)(defect, opts);
  const cardId = action.cardId || (defect && (defect.card_id || defect.cardId)) || '';
  const defectType =
    action.defectType || (defect && (defect.defect_type || defect.defectType)) || '';
  const defectKeyStr = `${cardId}:${defectType}`;

  if (action.source === 'none' || action.kind === 'none') {
    return {
      status: 'skipped',
      reason: action.reason || 'no mechanical action resolved',
      action,
      wall: `no mechanical runbook entry for ${defectKeyStr}: ${action.reason || 'unresolved'}`,
    };
  }

  const context = opts.context || {};
  const prereq = checkPrerequisites(action, context);
  if (!prereq.ok) {
    return {
      status: 'skipped',
      reason: `missing prerequisite(s): ${prereq.missing.join(', ')}`,
      action,
      wall: `mechanical action '${action.label}' for ${defectKeyStr} cannot run: missing ${prereq.missing.join(', ')}`,
    };
  }

  // No-repeat-tactic guard: reuse the SAME briefing-repair-ledger the LLM
  // tier uses, so a mechanical tactic that already failed with the same
  // input is not blindly re-run. The input hash includes the BEFORE-state
  // (artifact sha/freshness, lock owner pid/age, raw defect evidence text),
  // not just the static action shape (Codex review 2026-07-03: a static hash
  // would block a legitimate retry later the same day once the underlying
  // input genuinely changed, e.g. a new lock owner pid or fresh raw defect
  // evidence, even though the resolved command/rung is identical).
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const tacticLabel = `mechanical:${action.label}`;
  const beforeArtifactForHash = action.artifactPath
    ? (opts.readCardArtifact || readCardArtifact)(action.artifactPath, opts)
    : null;
  const tacticInput = {
    cardId,
    defectType,
    source: action.source,
    command: action.command || action.rung || null,
    rawEvidence: String((defect && (defect.raw || defect.evidence)) || ''),
    beforeArtifactSha: beforeArtifactForHash ? beforeArtifactForHash.sha : null,
    beforeArtifactFreshnessMs: beforeArtifactForHash ? beforeArtifactForHash.freshnessMs : null,
    lockOwnerPid: context.owner ? context.owner.pid : null,
    lockOwnerStartedAt: context.owner ? context.owner.started_at : null,
    lockDirPath: context.lockDirPath || null,
  };
  const tacticInputHash = ledger.hashTacticInput(tacticInput);
  const recordLedger = opts.recordRepairLedger !== false;
  if (recordLedger) {
    const alreadyFailed = ledger.tacticAlreadyFailed(
      date,
      defectKeyStr,
      tacticLabel,
      tacticInputHash,
      opts.ledgerOpts || {},
    );
    if (alreadyFailed) {
      return {
        status: 'skipped',
        reason: ledger.tacticExhaustedReason(defectKeyStr, tacticLabel),
        action,
        wall: ledger.tacticExhaustedReason(defectKeyStr, tacticLabel),
      };
    }
  }

  const lock = opts.lock || DEFAULT_LOCK;
  // Reuse the SAME read taken above for the tactic-input hash -- one
  // pre-action artifact read, not two.
  const beforeArtifact = beforeArtifactForHash || { sha: '', freshnessMs: null };

  const runOne = async () => {
    let execResult;
    if (action.kind === 'lock-reclaim') {
      const cls = (opts.classifyLockForReclaim || classifyLockForReclaim)({
        owner: context.owner,
        nowMs: opts.nowMs,
        isPidAlive: opts.isPidAlive,
      });
      if (!cls.clearable) {
        execResult = { ok: false, reason: cls.reason };
      } else {
        const reclaim = (opts.reclaimLockDir || reclaimLockDir)(context.lockDirPath, opts);
        execResult = { ok: reclaim.ok, reason: cls.reason, error: reclaim.error };
      }
    } else if (action.kind === 'callable') {
      const resolved = (opts.resolveHealLadderRung || verdict.resolveHealLadderRung)(
        action.rung,
        opts,
      );
      if (!resolved.ok) {
        execResult = { ok: false, reason: resolved.error };
      } else {
        try {
          const args = Array.isArray(action.rung.args) ? action.rung.args : [];
          const out = await Promise.resolve(resolved.fn(...args));
          execResult = { ok: true, output: out };
        } catch (e) {
          execResult = { ok: false, reason: String((e && e.message) || e) };
        }
      }
    } else {
      execResult = (opts.runCommand || runCommand)(action.command, {
        cwd: opts.cwd,
        timeoutMs: action.timeoutMs,
        spawnSync: opts.spawnSync,
      });
    }
    return execResult;
  };

  const startedAtMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const execResult = await lock.withLock(runOne);

  // Same-reader postcondition: never trust exit 0. Re-resolve through the
  // same reader path and require artifactSha changed OR the artifact became
  // fresh AS OF THIS RUN (freshnessMs >= startedAtMs, not merely "young" --
  // Codex review 2026-07-03: a bad artifact that happened to already be
  // within the freshness window BEFORE this action ran must not false-clear
  // just because it is still "fresh" after a no-op run).
  let afterArtifact = beforeArtifact;
  let readerFresh = false;
  let artifactChanged = false;
  if (action.artifactPath) {
    afterArtifact = (opts.readCardArtifact || readCardArtifact)(action.artifactPath, opts);
    artifactChanged = !!afterArtifact.sha && afterArtifact.sha !== beforeArtifact.sha;
    const producedThisRun =
      Number.isFinite(afterArtifact.freshnessMs) && afterArtifact.freshnessMs >= startedAtMs;
    const freshEnough =
      producedThisRun &&
      isFreshWithin(afterArtifact.freshnessMs, action.freshnessWindowMs, opts.nowMs);
    readerFresh = artifactChanged || freshEnough;
  } else {
    // No declared artifact path (e.g. lock-reclaim, or a callable rung with
    // no artifact) -- the postcondition falls back to the action's own
    // reported success, since there is no card artifact to re-read.
    readerFresh = !!(execResult && execResult.ok);
  }

  // Card-level re-QC is REQUIRED for any artifact-backed action (Codex review
  // 2026-07-03: silently defaulting to pass when opts.rerunCardQc is not
  // injected let a generator that exits 0 while writing a bad-but-fresh
  // artifact clear the defect with nobody checking the content). An action
  // with NO artifact path (lock-reclaim, a callable rung with no card
  // artifact) has nothing for a card-level QC to inspect, so it is exempt.
  let qcResult;
  if (!action.artifactPath) {
    qcResult = { pass: true, reason: 'no artifact declared; card-level re-QC not applicable' };
  } else if (typeof opts.rerunCardQc === 'function') {
    qcResult =
      execResult && execResult.ok && readerFresh
        ? await Promise.resolve(opts.rerunCardQc(cardId, opts))
        : { pass: false, reason: 'skipped: action did not run cleanly or artifact was not fresh' };
  } else {
    qcResult = {
      pass: false,
      reason:
        'no rerunCardQc injected for an artifact-backed action; card-level QC cannot be skipped (fail closed)',
    };
  }

  const cleared = !!(execResult && execResult.ok) && readerFresh && qcResult.pass !== false;
  const row = {
    status: cleared ? 'cleared' : 'failed',
    cardId,
    defectType,
    action,
    execResult,
    artifactSha: afterArtifact.sha,
    artifactChanged,
    readerFresh,
    qcResult,
    reason: cleared
      ? `mechanical action cleared: ${action.label}`
      : !execResult || !execResult.ok
        ? `mechanical action failed to run: ${(execResult && execResult.reason) || (execResult && execResult.stderr) || 'ExampleCo error'}`
        : !readerFresh
          ? `mechanical action exited ok but the card reader saw no change (same-reader postcondition failed): ${action.artifactPath || 'no artifact path declared'}`
          : `mechanical action ran and artifact refreshed but card-level QC still fails: ${qcResult.reason || 'qc failed'}`,
  };

  if (recordLedger) {
    ledger.recordAttempt(
      date,
      {
        defect: defectKeyStr,
        tactic: tacticLabel,
        tacticInputHash,
        fix: action.label,
        qcResult: cleared ? 'cleared' : 'failed',
        reflection: row.reason,
      },
      opts.ledgerOpts || {},
    );
  }

  return row;
}

module.exports = {
  MANIFEST_ID_TO_DOMAINS_ID,
  domainsIdForCard,
  STALE_DEFECT_TYPES,
  LOCK_DEFECT_TYPES,
  pidAlive,
  classifyLockForReclaim,
  reclaimLockDir,
  shaOf,
  readCardArtifact,
  isFreshWithin,
  resolveMechanicalAction,
  createInProcessLock,
  runCommand,
  checkPrerequisites,
  runMechanicalAction,
};
