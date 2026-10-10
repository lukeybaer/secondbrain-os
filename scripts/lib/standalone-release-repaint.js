'use strict';

// The deploy pipeline deliberately leaves one resumable release-level target:
// `standalone-deploy-repaint:<full SHA>`.  This module is the only consumer
// for that target.  It is called by amy-night-run only after the date-scoped
// watcher lock is held, claims the exact pending receipt atomically, performs
// a new live proof, and then uses the same final closure writer as an
// integration repaint.  A deploy success or an old proof alone can never
// write `complete`.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  DEPLOYMENT_STEPS,
  receiptEntriesForSha,
} = require('../record-release-closure.js');
const {
  fetchLiveHtml,
  parseTiles,
  renderedBriefingDate,
  parseGenerationMarkers,
  systemHealthMetricProofs,
} = require('../verify-dashboard-cards-live.js');
const { readDayManifest, currentGenerationId } = require('./briefing-day-manifest.js');
const { formatDeployParityRow } = require('./deploy-parity-row.js');
const { releaseShaFromPhysicalRoot } = require('./release-identity.js');

const TARGET_PREFIX = 'standalone-deploy-repaint:';
const CLAIM_SCHEMA = 'standalone-release-repaint-claim@1';
const SHA_RE = /^[0-9a-f]{40}$/;
const OWNER_KEYS = ['date', 'pid', 'attemptId', 'startedAt', 'hostname', 'processStartTime'];
const REVERIFY_HEALTH_TIMEOUT_MS = 10_000;
const REVERIFY_PARITY_TIMEOUT_MS = 30_000;
const RELEASE_SURFACE_TIMEOUT_SECONDS = 15;

function targetIdForSha(sha) {
  const value = String(sha || '').trim().toLowerCase();
  if (!SHA_RE.test(value)) throw new Error('standalone release repaint requires a full lowercase SHA');
  return `${TARGET_PREFIX}${value}`;
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function claimPath(dataDir, sha) {
  return path.join(path.resolve(dataDir), 'agent', 'release-repaint-claims', `${sha}.json`);
}

function watcherLockPath(dataDir, date) {
  return path.join(path.resolve(dataDir), 'agent', `overnight-watcher-lock-${date}.json`);
}

function readJson(file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function ownerIdentity(owner, date) {
  if (!owner || typeof owner !== 'object') throw new Error('standalone repaint requires watcher owner identity');
  const normalized = {
    date: String(owner.date || ''),
    pid: Number(owner.pid),
    attemptId: String(owner.attemptId || ''),
    startedAt: String(owner.startedAt || ''),
    hostname: String(owner.hostname || ''),
    processStartTime: String(owner.processStartTime || ''),
  };
  if (
    normalized.date !== String(date || '') ||
    !Number.isInteger(normalized.pid) ||
    normalized.pid <= 0 ||
    !normalized.attemptId ||
    !Number.isFinite(Date.parse(normalized.startedAt)) ||
    !normalized.hostname ||
    !normalized.processStartTime
  ) {
    throw new Error('standalone repaint received malformed watcher owner identity');
  }
  return normalized;
}

function sameOwner(left, right) {
  return OWNER_KEYS.every((key) => String(left?.[key] ?? '') === String(right?.[key] ?? ''));
}

function assertCurrentOwner({ dataDir, date, owner }) {
  const expected = ownerIdentity(owner, date);
  const current = readJson(watcherLockPath(dataDir, date));
  if (current.error || !sameOwner(current.value, expected)) {
    throw new Error('standalone repaint requires the currently held exact night-owner lock');
  }
  return expected;
}

function strictReceiptEntries(file) {
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch (error) {
    throw new Error(`cannot read release-closure receipts: ${error.code || error.message}`);
  }
  for (let index = 0; index < lines.length; index += 1) {
    try {
      JSON.parse(lines[index]);
    } catch {
      throw new Error(`malformed release-closure receipt at line ${index + 1}`);
    }
  }
  return lines;
}

function pendingAnchor({ dataDir, sha }) {
  const targetId = targetIdForSha(sha);
  const file = path.join(path.resolve(dataDir), 'agent', 'release-closure-receipts.jsonl');
  strictReceiptEntries(file);
  const entries = receiptEntriesForSha(file, sha);
  const matches = entries.filter(
    (entry) =>
      entry.row.status === 'pending-exact-repaint' &&
      entry.row.stage === 'deployment-proved' &&
      entry.row.targetId === targetId,
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? `ambiguous standalone repaint anchor for ${sha}`
        : `no pending standalone repaint anchor for ${sha}`,
    );
  }
  const anchor = matches[0];
  if (
    !Number.isFinite(Date.parse(String(anchor.row.completedAt || ''))) ||
    anchor.row.steps?.exactOwningUnitRepaint !== 'pending' ||
    DEPLOYMENT_STEPS.some((step) => anchor.row.steps?.[step] !== 'passed')
  ) {
    throw new Error(`standalone repaint anchor for ${sha} lacks complete deployment proof`);
  }
  return { ...anchor, targetId, file };
}

function closureEntry({ dataDir, sha, targetId, expectedDigest = '' }) {
  const file = path.join(path.resolve(dataDir), 'agent', 'release-closure-receipts.jsonl');
  if (!fs.existsSync(file)) return null;
  strictReceiptEntries(file);
  const entries = receiptEntriesForSha(file, sha).filter(
    (entry) =>
      entry.row.status === 'complete' &&
      entry.row.stage === 'complete' &&
      entry.row.targetId === targetId &&
      entry.row.steps?.exactOwningUnitRepaint === 'passed' &&
      DEPLOYMENT_STEPS.every((step) => entry.row.steps?.[step] === 'passed'),
  );
  const result = entries.length ? entries.at(-1) : null;
  return result && (!expectedDigest || result.digest === expectedDigest) ? result : null;
}

const releaseShaFromReleaseRoot = releaseShaFromPhysicalRoot;

function readLiveRelease({ runtimeRoot, sha = '' }) {
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(runtimeRoot));
  } catch {
    return { ok: false, reason: `cannot resolve runtime root ${runtimeRoot}` };
  }
  const actualSha = releaseShaFromReleaseRoot(resolved);
  const expectedSha = String(sha || '').trim().toLowerCase();
  if (!SHA_RE.test(actualSha) || (expectedSha && actualSha !== expectedSha)) {
    return { ok: false, reason: `runtime root is ${actualSha || 'unidentified'}, not claimed ${sha}` };
  }
  return { ok: true, releaseRoot: resolved, releaseSha: actualSha };
}

function parseJsonOutput(output) {
  try {
    return JSON.parse(String(output || '').trim());
  } catch {
    return null;
  }
}

// A standalone deployment has no card target to refresh.  Its narrow repaint
// equivalent is a fresh authenticated read of the release's own visible
// System Health surface.  Do not call the broad dashboard verifier here: it
// may create unrelated card work.  The durable proof records only digests and
// stable facts, never dashboard content, credentials, or its tokenized URL.
function defaultReleaseSurfaceProof({
  date,
  runtimeRoot,
  sha,
  dataDir,
  healthPort = '3001',
  now = Date.now,
  fetchLiveHtmlFn = fetchLiveHtml,
  parseTilesFn = parseTiles,
  renderedBriefingDateFn = renderedBriefingDate,
  formatDeployParityRowFn = formatDeployParityRow,
} = {}) {
  const before = readLiveRelease({ runtimeRoot, sha });
  if (!before.ok) return before;
  let fetched;
  try {
    fetched = fetchLiveHtmlFn({
      date,
      host: `http://127.0.0.1:${String(healthPort)}`,
      timeoutSeconds: RELEASE_SURFACE_TIMEOUT_SECONDS,
    });
  } catch {
    return { ok: false, reason: 'release surface reverify could not fetch the local dashboard' };
  }
  if (fetched?.unreachable || typeof fetched?.html !== 'string' || !fetched.html) {
    return { ok: false, reason: 'release surface reverify could not read the local dashboard' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    return { ok: false, reason: 'release surface reverify requires a canonical briefing date' };
  }
  // The local route must render the requested dated briefing rather than a
  // cache, redirect, or stale page that merely happens to contain the labels.
  if (renderedBriefingDateFn(fetched.html) !== String(date)) {
    return { ok: false, reason: 'release surface reverify did not render the requested briefing date' };
  }
  let tiles;
  try {
    tiles = parseTilesFn(fetched.html);
  } catch {
    return { ok: false, reason: 'release surface reverify could not parse the local dashboard' };
  }
  const systemHealth = Array.isArray(tiles)
    ? tiles.filter((tile) => String(tile?.name || '').trim().toUpperCase() === 'SYSTEM HEALTH')
    : [];
  if (systemHealth.length !== 1) {
    return { ok: false, reason: 'release surface reverify requires exactly one visible System Health tile' };
  }
  const tile = systemHealth[0];
  const visible = `${String(tile.face || '')} ${String(tile.body || '')}`.replace(/\s+/g, ' ').trim();
  let expectedDeployParity;
  try {
    expectedDeployParity = formatDeployParityRowFn({ dataDir, now: now() });
  } catch {
    return { ok: false, reason: 'release surface reverify could not read current deploy-parity evidence' };
  }
  // The current dashboard renders a named chip and itemized proof, rather
  // than the old contiguous summary row. Reuse the unit's real live-QC
  // contract and require its current generation and final green chip.
  let structuredParityVisible = false;
  try {
    const candidate = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', 'briefing-cards', date, 'system_health.json'), 'utf8'));
    const unit = candidate.workUnits?.find(row => row.id === 'system_health:deploy-parity');
    const generationId = currentGenerationId(readDayManifest({ dataDir, date }), 'system_health');
    const chips = [...String(tile.inner || '').matchAll(/<span class="health-chip health-(green|yellow|red|neutral)[^"]*"[^>]*data-subsystem="([^"]*)"[^>]*>/gi)]
      .filter(match => match[2] === unit?.name);
    const expectedDetail = String(expectedDeployParity || '').replace(/^✓ Deploy parity:\s*/, '').trim();
    if (unit?.status === 'green' && String(unit.detail || '').trim() === expectedDetail &&
        generationId && parseGenerationMarkers(fetched.html).get('system_health') === generationId &&
        chips.length === 1 && chips[0][1] === 'green') {
      const proofs = systemHealthMetricProofs(tile, { ...candidate, workUnits: [unit] }, { date, generationId });
      structuredParityVisible = proofs.length === 1 && proofs[0].status === 'clean' &&
        currentGenerationId(readDayManifest({ dataDir, date }), 'system_health') === generationId;
    }
  } catch { /* Missing current unit evidence cannot prove the structured surface. */ }
  const legacyParityVisible = !String(tile.inner || '').includes('health-chip') &&
    visible.includes(String(expectedDeployParity || '').replace(/\s+/g, ' ').trim());
  // Dev Ops is release bookkeeping, so a non-green row renders as a yellow chip
  // whose entity glyph strip() removes (ExampleCo, 2026-09-14). The row is visible
  // as a legacy glyph line or as the Dev Ops chip in the tile markup.
  const devOpsVisible = /[✓✗?◇⚠]\s*dev\s+ops\b/i.test(visible) ||
    /<span class="health-chip health-(?:green|yellow|red|neutral)[^"]*"[^>]*data-subsystem="Dev Ops"/i.test(String(tile.inner || ''));
  if (
    visible.length < 24 ||
    !devOpsVisible ||
    !String(expectedDeployParity || '').startsWith('✓ Deploy parity:') ||
    (!structuredParityVisible && !legacyParityVisible)
  ) {
    return { ok: false, reason: 'release surface lacks visible Dev Ops or current green Deploy parity output' };
  }
  const after = readLiveRelease({ runtimeRoot, sha });
  if (!after.ok) return after;
  return {
    ok: true,
    checkedAt: new Date(now()).toISOString(),
    surface: {
      date: String(date || ''),
      sourceSha: sha,
      htmlSha256: digest(fetched.html),
      htmlBytes: Buffer.byteLength(fetched.html, 'utf8'),
      tileName: 'SYSTEM HEALTH',
      tileStatus: String(tile.status || ''),
      tileFaceSha256: digest(tile.face || ''),
      tileBodySha256: digest(tile.body || ''),
      devOpsVisible: true,
      deployParityVisible: true,
    },
  };
}

function defaultScopedReverify({
  dataDir,
  date,
  sha,
  targetId,
  runtimeRoot,
  now = Date.now,
  spawnSyncFn = spawnSync,
  env = process.env,
  releaseSurfaceProof = defaultReleaseSurfaceProof,
} = {}) {
  const firstLive = readLiveRelease({ runtimeRoot, sha });
  if (!firstLive.ok) return firstLive;
  const healthPort = String(env.SB_HEALTH_PORT || '3001');
  const health = spawnSyncFn(
    'curl',
    ['-fsS', '--max-time', '8', '-w', '\n%{http_code}', `http://127.0.0.1:${healthPort}/health`],
    {
      cwd: firstLive.releaseRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: REVERIFY_HEALTH_TIMEOUT_MS,
    },
  );
  const healthRaw = String(health.stdout || '').trimEnd();
  const healthBoundary = healthRaw.lastIndexOf('\n');
  const healthStatus = healthBoundary >= 0 ? healthRaw.slice(healthBoundary + 1).trim() : '';
  const healthBody = healthBoundary >= 0 ? healthRaw.slice(0, healthBoundary).trim() : '';
  const healthReport = parseJsonOutput(healthBody);
  if (health.error) return { ok: false, reason: `live health transport failed: ${health.error.message || health.error}` };
  if (health.status !== 0) return { ok: false, reason: `live health probe exited ${health.status}` };
  if (healthStatus !== '200') return { ok: false, reason: `live health returned HTTP ${healthStatus || 'missing'}` };
  if (healthReport?.releaseSha !== sha) {
    const observed = SHA_RE.test(String(healthReport?.releaseSha || '').toLowerCase())
      ? String(healthReport.releaseSha).toLowerCase()
      : 'missing-or-invalid';
    return { ok: false, reason: `live health release SHA mismatch: expected ${sha}, observed ${observed}` };
  }
  const parity = spawnSyncFn(
    process.execPath,
    [path.join(firstLive.releaseRoot, 'scripts', 'verify-deploy-parity.js'), '--json'],
    {
      cwd: firstLive.releaseRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: REVERIFY_PARITY_TIMEOUT_MS,
      env: {
        ...env,
        SECONDBRAIN_DATA_DIR: path.resolve(dataDir),
        SECONDBRAIN_LIVE_ROOT: path.resolve(runtimeRoot),
      },
    },
  );
  const parityReport = parseJsonOutput(parity.stdout);
  if (
    parity.error ||
    parity.status !== 0 ||
    !parityReport ||
    parityReport.ok !== true ||
    parityReport.suppressed === true ||
    !Number.isFinite(Date.parse(String(parityReport.checkedAt || '')))
  ) {
    return { ok: false, reason: 'live deploy-parity reverify failed or was suppressed' };
  }
  const secondLive = readLiveRelease({ runtimeRoot, sha });
  if (!secondLive.ok) return secondLive;
  const surface = releaseSurfaceProof({ dataDir, date, runtimeRoot, sha, healthPort, now });
  if (!surface?.ok) {
    return { ok: false, reason: surface?.reason || 'visible release-surface reverify failed' };
  }
  const finalLive = readLiveRelease({ runtimeRoot, sha });
  if (!finalLive.ok) return finalLive;
  return {
    ok: true,
    releaseSha: sha,
    targetId,
    releaseRoot: finalLive.releaseRoot,
    checkedAt: new Date(now()).toISOString(),
    health: { status: 200, releaseSha: healthReport.releaseSha },
    parity: {
      checkedAt: parityReport.checkedAt,
      buildPathRoot: parityReport.buildPathRoot || '',
      liveRoot: parityReport.liveRoot || '',
    },
    surface: surface.surface,
  };
}

function validProof(proof, { sha, targetId, claimedAt, date }) {
  if (!proof || proof.ok !== true || proof.releaseSha !== sha || proof.targetId !== targetId) {
    return false;
  }
  const checkedAt = Date.parse(String(proof.checkedAt || ''));
  return (
    Number.isFinite(checkedAt) &&
    checkedAt >= Date.parse(claimedAt) &&
    proof.health?.status === 200 &&
    proof.health?.releaseSha === sha &&
    Number.isFinite(Date.parse(String(proof.parity?.checkedAt || ''))) &&
    proof.surface?.date === String(date || '') &&
    proof.surface?.sourceSha === sha &&
    proof.surface?.tileName === 'SYSTEM HEALTH' &&
    Number.isInteger(proof.surface?.htmlBytes) &&
    proof.surface.htmlBytes > 0 &&
    /^[0-9a-f]{64}$/.test(String(proof.surface?.htmlSha256 || '')) &&
    /^[0-9a-f]{64}$/.test(String(proof.surface?.tileFaceSha256 || '')) &&
    /^[0-9a-f]{64}$/.test(String(proof.surface?.tileBodySha256 || '')) &&
    proof.surface?.devOpsVisible === true &&
    proof.surface?.deployParityVisible === true
  );
}

function createClaim({ anchor, owner, now }) {
  return {
    schema: CLAIM_SCHEMA,
    status: 'claimed',
    targetId: anchor.targetId,
    releaseSha: anchor.row.releaseSha,
    anchorDigest: anchor.digest,
    anchorLine: anchor.lineNumber,
    owner,
    claimId: crypto.randomUUID(),
    claimedAt: new Date(now()).toISOString(),
  };
}

function readClaim(file) {
  if (!fs.existsSync(file)) return null;
  const parsed = readJson(file);
  if (parsed.error || !parsed.value || parsed.value.schema !== CLAIM_SCHEMA) {
    throw new Error('malformed standalone repaint claim');
  }
  return parsed.value;
}

function claimMatches(claim, { anchor, owner }) {
  return (
    ['claimed', 'proved', 'complete'].includes(claim.status) &&
    claim.targetId === anchor.targetId &&
    claim.releaseSha === anchor.row.releaseSha &&
    claim.anchorDigest === anchor.digest &&
    typeof claim.claimId === 'string' &&
    claim.claimId &&
    Number.isFinite(Date.parse(String(claim.claimedAt || ''))) &&
    sameOwner(claim.owner, owner)
  );
}

// Completion belongs to the exact receipt anchor, not to the PID that wrote
// it. A recovered sole owner may therefore observe a fully persisted prior
// completion without re-proving or writing a second closure row. It still
// validates that claimant identity structurally; malformed or mismatched
// claims remain fail-closed.
function completeClaimMatchesAnchor(claim, { anchor, date }) {
  if (claim?.status !== 'complete') return false;
  try {
    const claimant = ownerIdentity(claim.owner, date);
    return claimMatches(claim, { anchor, owner: claimant });
  } catch {
    return false;
  }
}

// One call is enough for a whole target.  If the process dies after its
// atomic claim, a recovered *new* watcher owner writes a fresh claim and a
// fresh proof; it never treats the old proof as current.
function consumeStandaloneReleaseRepaint({
  dataDir,
  date,
  owner,
  runtimeRoot,
  now = Date.now,
  reverify = defaultScopedReverify,
  finalizeClosure,
  log = () => {},
} = {}) {
  const at = now;
  try {
    if (typeof finalizeClosure !== 'function') {
      throw new Error('standalone repaint has no release-closure finalizer');
    }
    const currentOwner = assertCurrentOwner({ dataDir, date, owner });
    const live = readLiveRelease({ runtimeRoot });
    if (!live.ok) return { ok: false, state: 'pending', reason: live.reason };
    const sha = live.releaseSha;
    let anchor;
    try {
      anchor = pendingAnchor({ dataDir, sha });
    } catch (error) {
      if (String(error.message || '').startsWith('no pending standalone repaint anchor')) {
        return { ok: true, state: 'no-current-target' };
      }
      throw error;
    }
    const file = claimPath(dataDir, sha);
    let claim = readClaim(file);
    if (claim?.status === 'complete') {
      if (!completeClaimMatchesAnchor(claim, { anchor, date })) {
        throw new Error('complete standalone repaint claim does not match current target anchor');
      }
      if (!/^[0-9a-f]{64}$/.test(String(claim.closureDigest || ''))) {
        throw new Error('complete standalone repaint claim lacks its bound closure digest');
      }
      const closure = closureEntry({
        dataDir,
        sha,
        targetId: anchor.targetId,
        expectedDigest: claim.closureDigest,
      });
      if (!closure) throw new Error('complete standalone repaint claim has no matching closure receipt');
      return { ok: true, state: 'already-complete', claimId: claim.claimId, closure: closure.row };
    }
    if (claim && !claimMatches(claim, { anchor, owner: currentOwner })) {
      // The old claim cannot be replayed by this owner.  The date lock proves
      // it is already gone; preserve only its digest as audit linkage and
      // require a newly executed proof below.
      const supersededDigest = digest(JSON.stringify(claim));
      claim = createClaim({ anchor, owner: currentOwner, now: at });
      claim.supersedes = supersededDigest;
      writeJsonAtomic(file, claim);
    } else if (!claim) {
      claim = createClaim({ anchor, owner: currentOwner, now: at });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        fs.writeFileSync(file, `${JSON.stringify(claim, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readClaim(file);
        if (!claimMatches(existing, { anchor, owner: currentOwner })) {
          throw new Error('standalone repaint claim was concurrently replaced');
        }
        claim = existing;
      }
    }
    assertCurrentOwner({ dataDir, date, owner: currentOwner });
    const proof = reverify({
      dataDir,
      date,
      owner: currentOwner,
      runtimeRoot,
      sha,
      targetId: anchor.targetId,
      claim,
      now: at,
    });
    if (!validProof(proof, { sha, targetId: anchor.targetId, claimedAt: claim.claimedAt, date })) {
      return { ok: false, state: 'pending', claimId: claim.claimId, reason: proof?.reason || 'scoped live reverify failed' };
    }
    assertCurrentOwner({ dataDir, date, owner: currentOwner });
    const freshAnchor = pendingAnchor({ dataDir, sha });
    if (freshAnchor.digest !== claim.anchorDigest) {
      throw new Error('standalone repaint anchor changed after claim');
    }
    const currentClaim = readClaim(file);
    if (!claimMatches(currentClaim, { anchor: freshAnchor, owner: currentOwner }) || currentClaim.claimId !== claim.claimId) {
      throw new Error('standalone repaint claim changed during live reverify');
    }
    const finalLive = readLiveRelease({ runtimeRoot, sha });
    if (!finalLive.ok) return { ok: false, state: 'pending', claimId: claim.claimId, reason: finalLive.reason };
    const provedClaim = {
      ...claim,
      status: 'proved',
      proof,
      proofDigest: digest(JSON.stringify(proof)),
    };
    writeJsonAtomic(file, provedClaim);
    const closureRow = finalizeClosure({
      dataDirPath: path.resolve(dataDir),
      sha,
      targetId: anchor.targetId,
      atMs: Date.parse(proof.checkedAt),
      expectedAnchorDigest: anchor.digest,
    });
    if (
      !closureRow ||
      closureRow.releaseSha !== sha ||
      closureRow.targetId !== anchor.targetId ||
      closureRow.status !== 'complete' ||
      closureRow.steps?.exactOwningUnitRepaint !== 'passed'
    ) {
      throw new Error('release-closure finalizer returned an unbound repaint receipt');
    }
    const closure = closureEntry({ dataDir, sha, targetId: anchor.targetId });
    if (!closure) throw new Error('release-closure finalizer did not persist the exact repaint receipt');
    writeJsonAtomic(file, {
      ...provedClaim,
      status: 'complete',
      completedAt: new Date(at()).toISOString(),
      closureDigest: closure.digest,
    });
    return { ok: true, state: 'complete', claimId: claim.claimId, closure: closure.row, proof };
  } catch (error) {
    const reason = String((error && error.message) || error);
    log(`standalone release repaint left pending: ${reason}`);
    return { ok: false, state: 'pending', reason };
  }
}

module.exports = {
  CLAIM_SCHEMA,
  TARGET_PREFIX,
  targetIdForSha,
  claimPath,
  watcherLockPath,
  pendingAnchor,
  readLiveRelease,
  releaseShaFromReleaseRoot,
  REVERIFY_HEALTH_TIMEOUT_MS,
  REVERIFY_PARITY_TIMEOUT_MS,
  RELEASE_SURFACE_TIMEOUT_SECONDS,
  defaultReleaseSurfaceProof,
  defaultScopedReverify,
  consumeStandaloneReleaseRepaint,
};
