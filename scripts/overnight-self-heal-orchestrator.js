#!/usr/bin/env node
/**
 * overnight-self-heal-orchestrator.js
 *
 * REAL overnight self-heal: spawn one Claude Code session per briefing
 * blocker, with a structured prompt that drives investigate / write or
 * update tests / fix code / consult Codex on meaningful changes / commit /
 * push / verify the blocker is cleared. Sequential (no git race). Hard
 * deadline. Single-instance lockfile. Every session result logged to
 * data/agent/overnight-self-heal-runs.jsonl so the morning briefing can
 * show what actually happened overnight with commit-SHA proof.
 *
 * Closes the 2026-05-23 ExampleCo gap: "the clean briefing represents a clean
 * life and you have to do Claude Code sessions and fix stuff and test
 * it and commit it and repeat that process (each of those need
 * consultation with Codex as per the rule) and you're developing,
 * self-healing actively overnight."
 *
 * CLI shape: `claude --print --output-format=stream-json -p PROMPT`.
 * bypassPermissions is globally enabled in ~/.claude/settings.json.
 *
 * Locked by src/main/__tests__/overnight-self-heal-orchestrator.test.ts.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const { runWithFallback } = require('./lib/heal-executor.js');
const { runHeals, createSerializer } = require('./lib/heal-scheduler.js');
const { runIsolatedHealSession } = require('./lib/isolated-heal-session.js');
const { buildClaudeCliEnv, isCliFailureOutput } = require('./lib/cli-output-guard.js');
const { refreshIfNeeded } = require('./claude-token-refresh.js');
// Phase 4a desired-state reconciler pieces (each pure + DI-able):
const repairLedger = require('./self-heal/briefing-repair-ledger.js');
const { executorHealthRow } = require('./lib/executor-health-row.js');
const { assertModeEquivalence, loadRunGraph } = require('./lib/briefing-heal-run-graph.js');
const { createBudget, phaseExhausted, budgetExhaustedRed } = require('./lib/heal-error-budget.js');

const REPO = path.resolve(__dirname, '..');

function isGitWorkTree(dir) {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    return String(out).trim() === 'true';
  } catch {
    return false;
  }
}

function resolveCoordinatorRepoRoot(appRoot = REPO, options = {}) {
  const env = options.env || process.env;
  const isGit = options.isGitWorkTree || isGitWorkTree;
  const candidates = [
    env.SELF_HEAL_GIT_REPO,
    env.SECONDBRAIN_GIT_REPO,
    env.SECONDBRAIN_ROOT,
    appRoot,
    '/home/ec2-user/secondbrain-current',
    '/home/ec2-user/secondbrain-repo',
    '/opt/secondbrain-work',
  ]
    .filter(Boolean)
    .map((candidate) => path.resolve(String(candidate)));
  for (const candidate of [...new Set(candidates)]) {
    if (isGit(candidate)) return candidate;
  }
  throw new Error(`No valid self-heal git root found for app root ${path.resolve(appRoot)}`);
}

let cachedCoordinatorRepoRoot = null;
function getCoordinatorRepoRoot(appRoot = REPO, options = {}) {
  if (options && (options.env || options.isGitWorkTree)) {
    return resolveCoordinatorRepoRoot(appRoot, options);
  }
  if (!cachedCoordinatorRepoRoot) {
    cachedCoordinatorRepoRoot = resolveCoordinatorRepoRoot(appRoot);
  }
  return cachedCoordinatorRepoRoot;
}
const DEFAULT_CONCURRENCY = 4;
const UNBOUNDED_MAX_PASSES = Number.POSITIVE_INFINITY;
const RUNS_LOG_PATH = path.join(REPO, 'data', 'agent', 'overnight-self-heal-runs.jsonl');
const LOCK_PATH = path.join(os.tmpdir(), 'secondbrain-overnight-self-heal.lock');
const LOCK_STALE_MS = 6 * 60 * 60 * 1000; // 6h (overnight window)
// Self-heal workers need patience, not an open floor. Workers fix inline now
// (no background-task spawning), so a real repair must read, edit, run the
// affected vitest, and return the contract object in ONE bounded session. Eight
// minutes was too short for that and workers cleared 0 ("exceeded budget 480s").
// Twenty gives an inline fix room while still bounding the lane so a spinning
// repair cannot monopolize the overnight window. This stays well under the
// executor generic 30-minute fallback and is still clamped by the hard
// overnight deadline (shouldRespectDeadline + the per-worker
// Math.min(perSessionBudgetMs, deadlineMs - now) cap), so it never blows 05:15.
const DEFAULT_PER_SESSION_BUDGET_MS = 20 * 60 * 1000;
const DEFAULT_PUBLISH_REFRESH_BUDGET_MS = 10 * 60 * 1000;
const DEFAULT_NO_FRUIT_ATTEMPT_LIMIT = 10;
const DEFAULT_NO_LIVE_REDUCTION_ATTEMPT_LIMIT = 20;
const DEFAULT_DEADLINE_CT = '05:15';
const PEER_AGENT_NEED_RE =
  /\b(credential|password|api[\s-]?key|aws|2fa|mfa|approve|approval|decide|decision|choose|external|wire transfer|payment|legal|insurance|sign|signature|consent|interview|in[\s-]?person|notar)\b/i;
// Negation patterns: when the blocker explicitly declares ExampleCo is NOT in the
// loop, the bare keyword match above must not flip the blocker to skip.
// 2026-05-24 regression: "Hard blocker, not a ExampleCo decision" tripped on
// /decision/ and silenced an Amy-owned subsystem.
const NEED_NEGATION_RE =
  /\b(nothing|none\b|not a ExampleCo|not amy-owned|hard blocker, not|amy owns|amy classifies|amy must)\b/i;
const BRIEFING_FALLBACK_WINDOW_MS = 36 * 60 * 60 * 1000;

function parseDateArg(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date' && argv[i + 1]) return argv[i + 1];
    const m = String(arg || '').match(/^--date=(\d{4}-\d{2}-\d{2})$/);
    if (m) return m[1];
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(arg || ''))) return arg;
  }
  return null;
}

function parseRenderQcDefects(output) {
  const text = String(output || '');
  const defects = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*-\s+(.+?)\s*$/);
    if (m) defects.push(m[1].trim());
  }
  return defects;
}

const NEWS_RENDER_CARD_IDS = new Set([
  'ai_tech_news',
  'us_news',
  'world_news',
  'us_immigration_news',
  'mortgage_industry_news',
  'covid_news',
  'viral_news',
]);

const NEWS_FAMILY_DEFECT_TYPES = new Set([
  'NEWS-PROSE',
  'NEWS-STUB',
  'NEWS-CHROME',
  'NEWS-DUPLICATE',
  'NEWS-TITLE-JUMBLE',
  'BUILDER-COUNT',
  'VALUE-SANITY',
  'BLOCKED-CARD',
]);

function renderQcDefectType(defect) {
  return (String(defect || '').match(/^([A-Z0-9-]+):/) || [])[1] || 'RENDER-QC';
}

function renderQcCardId(defect) {
  const text = String(defect || '');
  return (
    (text.match(/^[A-Z0-9-]+:\s*([a-z0-9_]+)\s*\(/i) || [])[1] ||
    (text.match(/->\s*([a-z0-9_]+)\s*\(/i) || [])[1] ||
    (text.match(/CARD-DUPLICATE:\s*([a-z0-9_]+)/i) || [])[1] ||
    ''
  );
}

function isNewsFamilyRenderDefect(defect) {
  const type = renderQcDefectType(defect).toUpperCase();
  const cardId = renderQcCardId(defect);
  return NEWS_RENDER_CARD_IDS.has(cardId) && NEWS_FAMILY_DEFECT_TYPES.has(type);
}

function renderQcDefectGroupKey(defect) {
  const text = String(defect || '');
  const type = renderQcDefectType(text);
  const id = renderQcCardId(text) || 'dashboard';
  if (/^BLOCKERS-NAMED-CARD$/i.test(type)) {
    return `${id}:BLOCKERS-NAMED-CARD`;
  }
  if (/^BLOCKERS-(?:FLOOR|COUNT)$/i.test(type)) {
    return 'dashboard:BLOCKERS-ACCOUNTING';
  }
  if (NEWS_RENDER_CARD_IDS.has(id) && NEWS_FAMILY_DEFECT_TYPES.has(type)) {
    return 'all_news_cards:NEWS-QUALITY';
  }
  if (type === 'CARD-ORDER' || type === 'NEWS-LAST' || type.startsWith('MILESTONE-')) {
    return 'dashboard:DASHBOARD-LAYOUT';
  }
  if (
    id === 'video_approval_queue' &&
    (type === 'BLOCKED-TILE' || type === 'VIDEO-MANIFEST-DRIFT')
  ) {
    return 'video_approval_queue:VIDEO-APPROVAL-QUALITY';
  }
  if (id === 'system_health' && type === 'BLOCKED-TILE') return 'system_health:SYSTEM-HEALTH';
  if (id === 'communication_coaching' && type === 'BLOCKED-TILE') {
    return 'communication_coaching:COMM-COACHING';
  }
  if (id === 'communication_coaching' && type === 'EXEC-CRISPNESS') {
    return 'communication_coaching:COMM-COACHING';
  }
  if (type.startsWith('ACTION-ITEM-')) return 'action_items:ACTION-ITEM-QUALITY';
  if (type.startsWith('AWS-DETAIL')) return 'aws_costs:AWS-DETAIL';
  if (type.startsWith('COMM-COACHING')) return 'communication_coaching:COMM-COACHING';
  if (type.startsWith('PEOPLE-FILE-')) return 'people_files_changes:PEOPLE-FILE-QUALITY';
  if (type.startsWith('OTTER-')) return 'otter_speaker_pareto:OTTER-QUALITY';
  return `${id}:${type}`;
}

function renderQcDefectsToBlockers(defects) {
  const groups = new Map();
  for (const defect of defects || []) {
    const clean = String(defect || '').trim();
    if (!clean) continue;
    const key = renderQcDefectGroupKey(clean);
    const bucket = groups.get(key) || [];
    bucket.push(clean);
    groups.set(key, bucket);
  }
  return [...groups.entries()].map(([key, rows], i) => {
    const [cardId, defectType] = key.split(':');
    const affectedCards = [
      ...new Set(
        rows
          .map(
            (row) =>
              (String(row).match(/^[A-Z0-9-]+:\s*([a-z0-9_]+)\s*\(/i) || [])[1] ||
              (String(row).match(/->\s*([a-z0-9_]+)\s*\(/i) || [])[1] ||
              '',
          )
          .filter(Boolean),
      ),
    ];
    const affectedPrefix =
      affectedCards.length && cardId !== affectedCards[0]
        ? `Affected cards: ${affectedCards.join(', ')}. `
        : '';
    return {
      index: i + 1,
      title: `Live render QC ${defectType} on ${cardId}`,
      requirement: 'The authenticated live dashboard must pass canonical render and prose QC.',
      evidence: `${affectedPrefix}${rows.length} live defect(s): ${rows.slice(0, 6).join('; ')}${rows.length > 6 ? `; +${rows.length - 6} more` : ''}`,
      repair:
        'Fix the healer, generator, or renderer path that produced this defect, then rerun the overnight process and live dashboard QC.',
      owner: 'Amy',
      need: 'Nothing.',
      source: 'live-render-qc',
      rawDefectCount: rows.length,
      rawDefects: rows,
    };
  });
}

function defaultLiveRenderQcRunner({ date, repoRoot = REPO } = {}) {
  const script = path.join(repoRoot, 'scripts', 'verify-dashboard-cards-live.js');
  return spawnSync(process.execPath, [script, '--date', date], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function shouldCollectLiveRenderQc(opts = {}) {
  if (opts.liveRenderQc === false) return false;
  if (opts.liveRenderQc === true || opts.liveRenderQcRunner) return true;
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return false;
  return true;
}

// Same shape as shouldCollectLiveRenderQc: never spawn a real `claude` auth
// probe in unit tests. Explicit authProbe injection (or authPreflight:true)
// forces it on; authPreflight:false forces it off; under VITEST/test it defaults
// off so existing orchestrator tests with injected spawnSession are unaffected.
function shouldRunAuthPreflight(opts = {}) {
  if (opts.authPreflight === false) return false;
  if (opts.authPreflight === true || opts.authProbe) return true;
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return false;
  return true;
}

function collectLiveRenderQcBlockers(opts = {}) {
  if (!shouldCollectLiveRenderQc(opts)) return { blockers: [], defects: [], skipped: true };
  const runner = opts.liveRenderQcRunner || defaultLiveRenderQcRunner;
  const result = runner({ date: opts.date, repoRoot: opts.repoRoot || REPO });
  if (result && Array.isArray(result.defects)) {
    const defects = result.defects.map(String).filter(Boolean);
    if (result.retry && defects.length === 0) {
      const retryDefect =
        'LIVE-QC-RETRY: dashboard live render QC was inconclusive and must be retried or healed; zero defect rows is not a clean briefing';
      return {
        blockers: renderQcDefectsToBlockers([retryDefect]),
        defects: [retryDefect],
        status: result.status ?? null,
        retry: true,
      };
    }
    return { blockers: renderQcDefectsToBlockers(defects), defects, status: result.status ?? null };
  }
  const status = result && typeof result.status === 'number' ? result.status : 0;
  const output = `${(result && result.stdout) || ''}\n${(result && result.stderr) || ''}`;
  if (status === 0) return { blockers: [], defects: [], status };
  if (status === 2) {
    const retryDefect =
      'LIVE-QC-RETRY: dashboard live render QC was inconclusive and must be retried or healed; zero defect rows is not a clean briefing';
    return {
      blockers: renderQcDefectsToBlockers([retryDefect]),
      defects: [retryDefect],
      status,
      retry: true,
    };
  }
  const defects = parseRenderQcDefects(output);
  return { blockers: renderQcDefectsToBlockers(defects), defects, status };
}

// CANONICAL DEFECT SOURCE (Phase 1, item 4). The loop's card-defect list is built
// from the live render-QC verifier (verify-dashboard-cards-live.js), NOT from parsing
// the markdown BLOCKERS card. Each live defect line becomes a first-class Defect record
// keyed by { card_id, defect_type }. The markdown BLOCKERS card stays a render/display
// artifact only; it is no longer an input to this loop (Phase 1, DELETE).
function buildCanonicalDefects(defects = []) {
  const out = [];
  const seen = new Set();
  for (const raw of defects || []) {
    const row = String(raw || '').trim();
    if (!row) continue;
    const cardId = renderQcCardId(row) || 'dashboard';
    const defectType = renderQcDefectType(row);
    const key = `${cardId}:${defectType}`;
    const dedupKey = `${key}::${row}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({ card_id: cardId, defect_type: defectType, key, raw: row });
  }
  return out;
}

// PER-WORKER LIVE-QC GATE (Phase 1, item 2). For ONE worker result, decide whether the
// defect(s) it claimed cleared actually dropped from the authenticated post-repair live
// render-QC. A worker "cleared its defect" only when NONE of the defect-group keys it was
// dispatched against still appear in postRepairDefects. If any survive, the card stays red
// (the caller must NOT count it cleared and must re-plan it). Returns
// { cleared, survivedKeys } so the caller can downgrade the worker and re-plan the card.
function workerLiveQcCleared(result, postRepairDefects = []) {
  const postKeys = defectGroupKeySet(postRepairDefects);
  const rawDefects = Array.isArray(result && result.rawDefects) ? result.rawDefects : [];
  const rawKeys = [...defectGroupKeySet(rawDefects)];
  if (!rawKeys.length) {
    // No machine-known defect keys for this worker: fall back to the wave-level signal
    // (cannot prove per-worker reduction, so do not override the worker's own status).
    return { cleared: true, survivedKeys: [], ExampleCo: true };
  }
  const survivedKeys = rawKeys.filter((key) => {
    if (!postKeys.has(key)) return false;
    if (key === 'dashboard:BLOCKERS-ACCOUNTING') {
      return blockersAccountingSurvived(rawDefects, postRepairDefects);
    }
    return true;
  });
  return { cleared: survivedKeys.length === 0, survivedKeys };
}

function defectSignature(defects = []) {
  return (defects || []).map(String).filter(Boolean).sort().join('\n');
}

function defectSurfaceSignature(defects = []) {
  return [
    ...new Set(
      groupedDefectSummaries(defects)
        .map((group) => group.cardId || 'dashboard')
        .filter(Boolean),
    ),
  ]
    .sort()
    .join(',');
}

function resolveAttemptLimit(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function repairLoopJudgment({ reason, attempts, surfaceSignature, rawDefects, bestRawDefects }) {
  if (reason === 'options-exhausted-same-surface-no-fruit') {
    const surface = surfaceSignature || 'the same surface';
    return `No good fruit after ${attempts} attempts: the live page is still showing ${surface} with ${rawDefects} blocker(s). Further retries are likely repeating a bad assumption; stop and ask ExampleCo for steering.`;
  }
  if (reason === 'options-exhausted-no-live-reduction') {
    return `No actual live-page reduction after ${attempts} attempts since the last lower blocker count. Best seen is ${bestRawDefects}, current is ${rawDefects}; stop and ask ExampleCo which assumption is wrong.`;
  }
  return '';
}

function repairLoopEntryFromDefects(defects = [], pass = 0) {
  const defectRows = Array.isArray(defects) ? defects : [];
  const summaries = groupedDefectSummaries(defectRows);
  return {
    pass: Number(pass || 0),
    rawDefects: defectRows.length,
    exactSignature: defectSignature(defectRows),
    surfaceSignature: defectSurfaceSignature(defectRows),
    groups: summaries.map((group) => `${group.cardId}:${group.defectType}`),
  };
}

function novelDefectGroups(priorEntries = [], currentEntry = {}) {
  const priorGroups = new Set();
  for (const entry of priorEntries || []) {
    for (const group of Array.isArray(entry && entry.groups) ? entry.groups : []) {
      if (group) priorGroups.add(String(group));
    }
  }
  const currentGroups = [
    ...new Set(
      (Array.isArray(currentEntry && currentEntry.groups) ? currentEntry.groups : [])
        .map(String)
        .filter(Boolean),
    ),
  ];
  if (!priorGroups.size || !currentGroups.length) return [];
  return currentGroups.filter((group) => !priorGroups.has(group));
}

function defectGroupSignatureFromEntry(entry = {}) {
  const groups = Array.isArray(entry && entry.groups) ? entry.groups : [];
  return [...new Set(groups.map(String).filter(Boolean))].sort().join('\n');
}

function currentDefectShapeEpoch(entries = []) {
  if (!entries.length) return [];
  const currentSignature = defectGroupSignatureFromEntry(entries[entries.length - 1]);
  if (!currentSignature) return entries;
  let start = entries.length - 1;
  for (let i = entries.length - 2; i >= 0; i -= 1) {
    if (defectGroupSignatureFromEntry(entries[i]) !== currentSignature) break;
    start = i;
  }
  return entries.slice(start);
}

function readRecentJsonlRows(filePath, maxBytes = 2 * 1024 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    const bytes = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      fs.readSync(fd, buffer, 0, bytes, stat.size - bytes);
      const text = buffer.toString('utf8');
      const lines = text.split(/\r?\n/).filter(Boolean);
      const completeLines = stat.size > bytes ? lines.slice(1) : lines;
      return completeLines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function loadPersistentRepairLoopHistory(logPath = RUNS_LOG_PATH, opts = {}) {
  const limit = resolveAttemptLimit(opts.limit, DEFAULT_NO_LIVE_REDUCTION_ATTEMPT_LIMIT);
  const maxAgeMs = Number(opts.maxAgeMs || 36 * 60 * 60 * 1000);
  const nowMs = Number(opts.nowMs || Date.now());
  const date = opts.date ? String(opts.date) : '';
  const canonicalLiveQcStages = new Set([
    'live-render-qc',
    'pre-repair-live-render-qc',
    'post-repair-live-render-qc',
  ]);
  return readRecentJsonlRows(logPath)
    .filter((row) => row && canonicalLiveQcStages.has(row.stage))
    .filter((row) => Array.isArray(row.defects) && row.defects.length > 0)
    .filter((row) => !date || String(row.date || row.briefingDate || '') === date)
    .filter((row) => {
      const ts = Date.parse(String(row.ts || ''));
      return !Number.isFinite(maxAgeMs) || !Number.isFinite(ts) || nowMs - ts <= maxAgeMs;
    })
    .map((row) => repairLoopEntryFromDefects(row.defects, row.pass))
    .filter((entry) => entry.exactSignature && entry.surfaceSignature)
    .slice(-limit);
}

function summarizeRepairLoopExhaustion(history = [], currentEntry = {}, opts = {}) {
  const noFruitAttemptLimit = resolveAttemptLimit(
    opts.noFruitAttemptLimit ?? opts.sameSurfaceNoFruitLimit,
    DEFAULT_NO_FRUIT_ATTEMPT_LIMIT,
  );
  const noLiveReductionAttemptLimit = resolveAttemptLimit(
    opts.noLiveReductionAttemptLimit,
    DEFAULT_NO_LIVE_REDUCTION_ATTEMPT_LIMIT,
  );
  const windowSize = Math.max(
    3,
    Number(opts.windowSize || noFruitAttemptLimit) || noFruitAttemptLimit,
  );
  const rawDefects = Number(currentEntry.rawDefects || 0);
  if (rawDefects <= 0) return { exhausted: false, reason: 'clean' };
  const entries = [...(history || []), currentEntry]
    .filter((entry) => entry && entry.exactSignature && entry.surfaceSignature)
    .map((entry) => ({
      pass: Number(entry.pass || 0),
      rawDefects: Number(entry.rawDefects || 0),
      exactSignature: String(entry.exactSignature || ''),
      surfaceSignature: String(entry.surfaceSignature || ''),
      groups: Array.isArray(entry.groups) ? entry.groups : [],
    }));
  if (!entries.length) {
    return { exhausted: false, reason: 'insufficient-history', window: entries };
  }
  const currentAll = entries[entries.length - 1];
  const freshGroups = novelDefectGroups(entries.slice(0, -1), currentAll);
  if (freshGroups.length) {
    return {
      exhausted: false,
      reason: 'fresh-defect-shape',
      freshGroups,
      window: entries.slice(-windowSize),
    };
  }
  // The no-live-reduction guard is deliberately broader than the same-surface
  // guard: alternating between surfaces with the same blocker count is still
  // spin. Do not reset this counter merely because the defect shape changed.
  const liveReductionEntries = entries;
  let bestRawDefects = Number.POSITIVE_INFINITY;
  let lastBestIndex = -1;
  liveReductionEntries.forEach((entry, index) => {
    if (entry.rawDefects < bestRawDefects) {
      bestRawDefects = entry.rawDefects;
      lastBestIndex = index;
    }
  });
  const attemptsSinceBest = liveReductionEntries.length - lastBestIndex;
  if (
    noLiveReductionAttemptLimit > 0 &&
    attemptsSinceBest >= noLiveReductionAttemptLimit &&
    currentAll.rawDefects >= bestRawDefects
  ) {
    const window = liveReductionEntries.slice(
      Math.max(0, liveReductionEntries.length - noLiveReductionAttemptLimit),
    );
    const reason = 'options-exhausted-no-live-reduction';
    return {
      exhausted: true,
      reason,
      attempts: attemptsSinceBest,
      bestRawDefects,
      window,
      judgment: repairLoopJudgment({
        reason,
        attempts: attemptsSinceBest,
        surfaceSignature: currentAll.surfaceSignature,
        rawDefects: currentAll.rawDefects,
        bestRawDefects,
      }),
    };
  }
  const trailingSameSurface = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!currentAll.surfaceSignature || entry.surfaceSignature !== currentAll.surfaceSignature) {
      break;
    }
    trailingSameSurface.unshift(entry);
  }
  let bestTrailingRawDefects = Number.POSITIVE_INFINITY;
  let lastTrailingBestIndex = -1;
  trailingSameSurface.forEach((entry, index) => {
    if (entry.rawDefects < bestTrailingRawDefects) {
      bestTrailingRawDefects = entry.rawDefects;
      lastTrailingBestIndex = index;
    }
  });
  const sameSurfaceNoFruitAttempts = trailingSameSurface.length - lastTrailingBestIndex;
  if (
    noFruitAttemptLimit > 0 &&
    sameSurfaceNoFruitAttempts >= noFruitAttemptLimit &&
    currentAll.rawDefects >= bestTrailingRawDefects
  ) {
    const window = trailingSameSurface.slice(-noFruitAttemptLimit);
    const reason = 'options-exhausted-same-surface-no-fruit';
    return {
      exhausted: true,
      reason,
      attempts: sameSurfaceNoFruitAttempts,
      bestRawDefects: bestTrailingRawDefects,
      window,
      judgment: repairLoopJudgment({
        reason,
        attempts: sameSurfaceNoFruitAttempts,
        surfaceSignature: currentAll.surfaceSignature,
        rawDefects: currentAll.rawDefects,
        bestRawDefects: bestTrailingRawDefects,
      }),
    };
  }
  if (entries.length < windowSize) {
    return { exhausted: false, reason: 'insufficient-history', window: entries };
  }
  const recent = entries.slice(-windowSize);
  const current = recent[recent.length - 1];
  const sameSurface =
    !!current.surfaceSignature &&
    recent.every((entry) => entry.surfaceSignature === current.surfaceSignature);
  const priorExactSeen = recent
    .slice(0, -1)
    .some((entry) => entry.exactSignature === current.exactSignature);
  const bestPriorRawDefects = Math.min(...recent.slice(0, -1).map((entry) => entry.rawDefects));
  const noNetProgress = current.rawDefects >= bestPriorRawDefects;
  if (sameSurface && priorExactSeen && noNetProgress) {
    return {
      exhausted: true,
      reason: 'options-exhausted-oscillation',
      bestPriorRawDefects,
      window: recent,
    };
  }
  return { exhausted: false, reason: 'still-changing', window: recent };
}

function defectGroupKeySet(defects = []) {
  return new Set((defects || []).map(renderQcDefectGroupKey).filter(Boolean));
}

function groupedDefectSummaries(defects = []) {
  const groups = new Map();
  for (const defect of defects || []) {
    const row = String(defect || '').trim();
    if (!row) continue;
    const key = renderQcDefectGroupKey(row);
    if (!key) continue;
    const rows = groups.get(key) || [];
    rows.push(row);
    groups.set(key, rows);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const [cardId, defectType] = key.split(':');
    return {
      key,
      cardId,
      defectType,
      count: rows.length,
      sample: rows[0] || '',
    };
  });
}

function newDefectGroups(beforeDefects = [], afterDefects = []) {
  const beforeKeys = defectGroupKeySet(beforeDefects);
  return groupedDefectSummaries(afterDefects).filter((group) => !beforeKeys.has(group.key));
}

function defectCardIdSet(defects = []) {
  return new Set(
    groupedDefectSummaries(defects)
      .map((group) => group.cardId)
      .filter(Boolean),
  );
}

function newCardDefectGroups(beforeDefects = [], newGroups = []) {
  const beforeCards = defectCardIdSet(beforeDefects);
  return (newGroups || []).filter((group) => group.cardId && !beforeCards.has(group.cardId));
}

function survivingDefectGroupKeys(beforeDefects = [], afterDefects = []) {
  const afterKeys = defectGroupKeySet(afterDefects);
  return [...defectGroupKeySet(beforeDefects)].filter((key) => afterKeys.has(key));
}

function blockersFloorCount(defect) {
  const n = Number(
    (String(defect || '').match(/Blockers card reports\s+(\d+)\s+hard blocker/i) || [])[1],
  );
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isBlockersFloorRefinement({
  beforeDefects = [],
  afterDefects = [],
  newCardGroups = [],
} = {}) {
  if (!beforeDefects.length || !afterDefects.length) return false;
  const beforeRows = beforeDefects.map((defect) => String(defect || '').trim()).filter(Boolean);
  if (!beforeRows.length || beforeRows.some((defect) => !/^BLOCKERS-FLOOR:/i.test(defect))) {
    return false;
  }
  const reportedBlockers = Math.max(0, ...beforeDefects.map(blockersFloorCount));
  if (!reportedBlockers) return false;
  const afterNamedCards = afterDefects.filter((defect) =>
    /^BLOCKERS-NAMED-CARD:/i.test(String(defect || '').trim()),
  );
  return afterNamedCards.length > 0 && afterDefects.length <= reportedBlockers;
}

function isBlockersNamedCardMaterialized({ beforeDefects = [], afterDefects = [] } = {}) {
  if (!beforeDefects.length || !afterDefects.length) return false;
  const beforeNamedCards = new Set(
    beforeDefects
      .filter((defect) => /^BLOCKERS-NAMED-CARD:/i.test(String(defect || '').trim()))
      .map((defect) => renderQcCardId(defect))
      .filter(Boolean),
  );
  if (!beforeNamedCards.size) return false;
  const afterGroups = groupedDefectSummaries(afterDefects);
  return [...beforeNamedCards].some((cardId) => {
    const sameCardAfter = afterGroups.filter((group) => group.cardId === cardId);
    if (!sameCardAfter.length) return false;
    if (sameCardAfter.some((group) => group.defectType === 'BLOCKERS-NAMED-CARD')) return false;
    return sameCardAfter.some((group) => !/^BLOCKERS-/i.test(group.defectType));
  });
}

function isPostRepairDefectSwap({
  beforeDefects = [],
  afterDefects = [],
  newCardGroups = [],
} = {}) {
  if (!beforeDefects.length || !afterDefects.length) return false;
  if (isBlockersFloorRefinement({ beforeDefects, afterDefects, newCardGroups })) return true;
  if (isBlockersNamedCardMaterialized({ beforeDefects, afterDefects })) return true;
  if (!newCardGroups.length) return false;
  if (survivingDefectGroupKeys(beforeDefects, afterDefects).length !== 0) return false;
  if (afterDefects.length <= beforeDefects.length) return true;
  return (
    isBlockersFloorRefinement({ beforeDefects, afterDefects, newCardGroups }) ||
    isBlockersNamedCardMaterialized({ beforeDefects, afterDefects })
  );
}

function blockersAccountingNamedCards(defects = []) {
  return new Set(
    (defects || [])
      .filter((defect) => /^BLOCKERS-NAMED-CARD:/i.test(String(defect || '').trim()))
      .map((defect) => renderQcCardId(defect))
      .filter(Boolean),
  );
}

function blockersAccountingTypeSet(defects = []) {
  return new Set(
    (defects || [])
      .map((defect) => renderQcDefectType(defect))
      .filter((type) => /^BLOCKERS-(?:FLOOR|COUNT)$/i.test(type)),
  );
}

function blockersAccountingSurvived(rawDefects = [], postRepairDefects = []) {
  const rawNamed = blockersAccountingNamedCards(rawDefects);
  const postNamed = blockersAccountingNamedCards(postRepairDefects);
  if (rawNamed.size) {
    return [...rawNamed].some((cardId) => postNamed.has(cardId));
  }
  const rawTypes = blockersAccountingTypeSet(rawDefects);
  const postTypes = blockersAccountingTypeSet(postRepairDefects);
  return [...rawTypes].some((type) => postTypes.has(type));
}

function isLiveQcRetryDefect(defect) {
  return /^LIVE-QC-RETRY:/i.test(String(defect || '').trim());
}

function isOnlyLiveQcRetryDefects(defects = []) {
  return (
    Array.isArray(defects) &&
    defects.length > 0 &&
    defects.every((defect) => isLiveQcRetryDefect(defect))
  );
}

function isPostRepairRegression({
  beforeDefects = [],
  afterDefects = [],
  newCardGroups = [],
  postRepairDefectSwap = false,
} = {}) {
  if (isOnlyLiveQcRetryDefects(beforeDefects)) return false;
  return (
    newCardGroups.length > 0 && afterDefects.length >= beforeDefects.length && !postRepairDefectSwap
  );
}

function clearedWorkerSurvivedGroups(blockers = [], results = [], postRepairDefects = []) {
  const postKeys = defectGroupKeySet(postRepairDefects);
  if (!postKeys.size) return [];
  const survived = [];
  for (let idx = 0; idx < results.length; idx += 1) {
    const result = results[idx] || {};
    if (result.status !== 'cleared') continue;
    const blocker = blockers[idx] || {};
    const rawDefects = Array.isArray(result.rawDefects)
      ? result.rawDefects
      : Array.isArray(blocker.rawDefects)
        ? blocker.rawDefects
        : [];
    const rawKeys = defectGroupKeySet(rawDefects);
    const overlap = [...rawKeys].filter((key) => {
      if (!postKeys.has(key)) return false;
      if (key === 'dashboard:BLOCKERS-ACCOUNTING') {
        return blockersAccountingSurvived(rawDefects, postRepairDefects);
      }
      return true;
    });
    if (!overlap.length) continue;
    survived.push({
      blocker: result.blockerTitle || blocker.title || `worker-${idx + 1}`,
      defectKeys: overlap,
    });
  }
  return survived;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectLiveRenderQcAfterSettle(opts = {}) {
  const beforeSignature = defectSignature(opts.beforeDefects || []);
  const shouldSettle = !!opts.settle && beforeSignature;
  const maxAttempts = Math.max(1, Number(opts.liveQcSettleAttempts || (shouldSettle ? 7 : 1)));
  const delayMs =
    opts.liveQcSettleDelayMs != null
      ? Math.max(0, Number(opts.liveQcSettleDelayMs) || 0)
      : process.env.VITEST || process.env.NODE_ENV === 'test'
        ? 0
        : 15_000;
  let last = null;
  let attempts = 0;
  let changed = false;
  let cleanStreak = 0;
  const requireConfirmedClean = shouldSettle && maxAttempts > 1;
  const started = Date.now();
  for (let i = 0; i < maxAttempts; i += 1) {
    attempts = i + 1;
    last = collectLiveRenderQcBlockers(opts);
    const signature = defectSignature(last.defects || []);
    changed = !!signature && signature !== beforeSignature;
    cleanStreak = last.status === 0 && !signature ? cleanStreak + 1 : 0;
    if (
      !shouldSettle ||
      (last.status === 0 && (!requireConfirmedClean || cleanStreak >= 2)) ||
      changed ||
      last.skipped
    ) {
      break;
    }
    if (i < maxAttempts - 1 && delayMs > 0) await waitMs(delayMs);
  }
  if (requireConfirmedClean && last && last.status === 0 && cleanStreak < 2) {
    const retryDefect =
      'LIVE-QC-RETRY: dashboard live render QC was inconclusive and must be retried or healed; zero defect rows is not a clean briefing';
    last = {
      blockers: renderQcDefectsToBlockers([retryDefect]),
      defects: [retryDefect],
      status: 2,
      retry: true,
    };
  }
  return {
    ...(last || { blockers: [], defects: [], skipped: true }),
    settle: {
      attempts,
      changed,
      cleanStreak,
      waitedMs: Date.now() - started,
      beforeDefects: (opts.beforeDefects || []).length,
    },
  };
}

function mergeBlockers(blockers) {
  const out = [];
  const seen = new Set();
  for (const blocker of blockers || []) {
    const key = `${blocker.source || 'markdown'}:${blocker.title || ''}:${blocker.evidence || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...blocker, index: out.length + 1 });
  }
  return out;
}

function rawDefectCountForBlockers(blockers = []) {
  return (blockers || []).reduce((sum, blocker) => {
    const rawCount = Number(blocker && blocker.rawDefectCount);
    if (Number.isFinite(rawCount) && rawCount > 0) return sum + rawCount;
    const rows = Array.isArray(blocker && blocker.rawDefects) ? blocker.rawDefects.length : 0;
    return sum + (rows || 1);
  }, 0);
}

function newsRenderRows(blocker) {
  const rows = Array.isArray(blocker && blocker.rawDefects)
    ? blocker.rawDefects.map(String)
    : [String((blocker && blocker.evidence) || '')];
  return rows.filter(isNewsFamilyRenderDefect);
}

function cardIdsFromRenderRows(rows = []) {
  return [...new Set(rows.map((row) => renderQcCardId(row)).filter(Boolean))];
}

function bundleRelatedRepairBlockers(blockers = []) {
  const out = [];
  const newsItems = [];
  let newsInsertAt = -1;
  for (const blocker of blockers || []) {
    const newsRows = newsRenderRows(blocker);
    if (newsRows.length) {
      if (newsInsertAt < 0) newsInsertAt = out.length;
      newsItems.push({ blocker, rows: newsRows });
      continue;
    }
    out.push(blocker);
  }
  if (!newsItems.length) return out;
  const rows = newsItems.flatMap((item) => item.rows);
  const cards = cardIdsFromRenderRows(rows);
  const bundle = {
    index: newsInsertAt + 1,
    title: 'Live render QC NEWS-READINESS on news_cards',
    requirement:
      'Every rendered news card must meet its item target, carry no hard-block marker, and show either a three-ExampleCoraph article summary with a source link or the canonical headline-only note for a genuinely inaccessible story.',
    evidence: `${rows.length} live news content defect(s) across ${cards.length ? cards.join(', ') : 'news cards'}: ${rows.slice(0, 10).join('; ')}${rows.length > 10 ? `; +${rows.length - 10} more` : ''}`,
    repair:
      'Fix the shared news healer, generator, summarizer, item-count, or renderer path once for the affected news cards, then rerun publish refresh and live render QC.',
    owner: 'Amy',
    need: 'Nothing.',
    source: 'live-render-qc',
    rawDefectCount: rows.length,
    rawDefects: rows,
    bundledCards: cards,
    bundledDefectTypes: [
      ...new Set(rows.map((row) => (row.match(/^([A-Z0-9-]+):/) || [])[1]).filter(Boolean)),
    ],
  };
  out.splice(newsInsertAt, 0, bundle);
  return out.map((blocker, index) => ({ ...blocker, index: index + 1 }));
}

function publishRefreshWatchdogRepairBlocker({ phase, refresh, defectCount } = {}) {
  const watchdog = refresh && refresh.watchdog ? refresh.watchdog : {};
  const thresholdMs = Number(watchdog.thresholdMs || 0);
  const threshold = thresholdMs ? `${Math.round(thresholdMs / 1000)}s` : 'ExampleCo budget';
  const signal = refresh && refresh.signal ? ` signal ${refresh.signal}` : '';
  const count = Number.isFinite(Number(defectCount)) ? Number(defectCount) : 0;
  return {
    title: 'Self-heal publish-refresh watchdog on self_heal',
    requirement:
      'The overnight self-healer must treat a publish refresh watchdog kill as a repair target, not just a metric.',
    evidence: `PUBLISH-REFRESH-WATCHDOG: ${phase || 'publish-refresh'} exceeded ${threshold}${signal}; ${count} live defect(s) still needed a completed refresh/QC cycle.`,
    repair:
      'Fix the publish-refresh orchestration, timeout decomposition, card targeting, or child-process cleanup so the next overnight pass can complete refresh and live QC.',
    owner: 'Amy',
    need: 'Nothing.',
    source: 'self-heal-health',
    rawDefectCount: 1,
    rawDefects: [
      `PUBLISH-REFRESH-WATCHDOG: ${phase || 'publish-refresh'} exceeded ${threshold}${signal}`,
    ],
  };
}

function selfHealFalseClearRepairBlocker({
  falseClearGroups = [],
  results = [],
  postRepairDefects = [],
  repairLoopExhaustion = null,
} = {}) {
  const groups = Array.isArray(falseClearGroups) ? falseClearGroups.filter(Boolean) : [];
  const resultNotes = (results || [])
    .filter((result) => result && result.status === 'cleared')
    .map((result) => {
      const title = String(result.blockerTitle || 'worker').slice(0, 90);
      const reflection = String(result.reflection || '')
        .replace(/\s+/g, ' ')
        .slice(0, 180);
      const verification = String(result.verification || '')
        .replace(/\s+/g, ' ')
        .slice(0, 140);
      return `${title}: verification=${verification || 'missing'}; reflection=${reflection || 'missing'}`;
    })
    .slice(0, 6);
  const window = ((repairLoopExhaustion && repairLoopExhaustion.window) || [])
    .map((entry) => `pass ${entry.pass}: ${entry.rawDefects} defect(s) ${entry.surfaceSignature}`)
    .join('; ');
  return {
    title: 'Self-heal false-clear loop on self_heal',
    requirement:
      'The overnight self-healer must not keep retrying the same card lanes after workers claim cleared but authenticated live QC is unchanged.',
    evidence: [
      `SELF-HEAL-FALSE-CLEAR: ${groups.length || 'multiple'} cleared worker group(s) survived live QC: ${groups.join(', ') || 'ExampleCo groups'}.`,
      `Live QC still reports ${postRepairDefects.length} defect(s) after coordinator deploy, publish refresh, and rendered-page verification.`,
      window ? `Recent repair-loop window: ${window}.` : '',
      resultNotes.length ? `Worker proof/reflection samples: ${resultNotes.join(' | ')}` : '',
    ]
      .filter(Boolean)
      .join(' '),
    repair:
      'Fix the self-heal verifier, publish-refresh targeting, worker proof contract, or loop planning so the next pass designs against the false-clear mechanism before retrying the same card-specific fix.',
    owner: 'Amy',
    need: 'Nothing.',
    source: 'self-heal-health',
    rawDefectCount: 1,
    rawDefects: [
      'SELF-HEAL-FALSE-CLEAR: cleared workers left the same authenticated live QC defects',
    ],
  };
}

function annotateKnownFalseClearPreflightBlockers(blockers = [], knownCards = []) {
  const cardSet = new Set((knownCards || []).map(String).filter(Boolean));
  if (!cardSet.size) return blockers;
  return (blockers || []).map((blocker) => {
    const rows = Array.isArray(blocker && blocker.rawDefects) ? blocker.rawDefects : [];
    const affected = cardIdsFromRenderRows(rows);
    const matches = affected.some((card) => cardSet.has(card));
    if (!matches) return blocker;
    const evidence = String((blocker && blocker.evidence) || '').trim();
    const repair = String((blocker && blocker.repair) || '').trim();
    return {
      ...blocker,
      knownFalseClearPreflight: true,
      skipDeterministicPreflights: true,
      knownFalseClearCards: affected.filter((card) => cardSet.has(card)),
      evidence: [
        evidence,
        'Known false-clear context: a deterministic preflight already claimed this card cleared, but authenticated live render QC stayed red.',
      ]
        .filter(Boolean)
        .join(' '),
      repair: [
        repair,
        'Bypass deterministic preflights for this card and repair the generator, renderer, proof binding, or status-label logic directly.',
      ]
        .filter(Boolean)
        .join(' '),
    };
  });
}

function shouldBypassDeterministicPreflights(blocker) {
  return !!(blocker && (blocker.skipDeterministicPreflights || blocker.knownFalseClearPreflight));
}

function isFalseClearSelfHealBlocker(blocker) {
  return /SELF-HEAL-FALSE-CLEAR|false-clear loop/i.test(
    `${(blocker && blocker.title) || ''} ${(blocker && blocker.evidence) || ''}`,
  );
}

function isLandingConflictSelfHealBlocker(blocker) {
  return /SELF-HEAL-LANDING|landing conflict|merge\/landing/i.test(
    `${(blocker && blocker.title) || ''} ${(blocker && blocker.evidence) || ''}`,
  );
}

function falseClearGroupsFromBlockers(blockers = []) {
  const groups = [];
  for (const blocker of blockers || []) {
    if (!isFalseClearSelfHealBlocker(blocker)) continue;
    const evidence = String((blocker && blocker.evidence) || '');
    const survived = evidence.match(
      /survived live QC:\s*([\s\S]*?)(?:\.\s*Live QC|\.\s*Recent|\.\s*Worker|$)/i,
    );
    const text = survived ? survived[1] : evidence;
    for (const match of text.matchAll(/Live render QC [A-Z0-9-]+ on [a-z0-9_]+/gi)) {
      groups.push(match[0]);
    }
  }
  return [...new Set(groups)];
}

function selfHealWorkerContractRepairBlocker({
  selfHealHealth = {},
  results = [],
  postRepairDefects = [],
  repeatedContractMissWave = false,
} = {}) {
  const hardKills = Number(selfHealHealth.hardWatchdogKills || 0);
  const workerKills = Number(selfHealHealth.workerKills || 0);
  const contractMisses = Number(selfHealHealth.contractMisses || 0);
  const excessiveKillGroups = Array.isArray(selfHealHealth.excessiveWorkerKillGroups)
    ? selfHealHealth.excessiveWorkerKillGroups
    : [];
  const excessiveTimeGroups = Array.isArray(selfHealHealth.excessiveWorkerTimeGroups)
    ? selfHealHealth.excessiveWorkerTimeGroups
    : [];
  const samples = (results || [])
    .filter((result) => result && result.status === 'escalated')
    .map((result) => {
      const title = String(result.blockerTitle || 'worker').slice(0, 90);
      const reason = String(result.escalationReason || result.escalation_reason || '')
        .replace(/\s+/g, ' ')
        .slice(0, 180);
      const attempts = Array.isArray(result.attempts)
        ? result.attempts
            .map((attempt) => {
              const executor = String((attempt && attempt.executor) || 'executor');
              const why = String(
                (attempt && (attempt.escalationReason || attempt.escalation_reason)) ||
                  (attempt && attempt.watchdog && attempt.watchdog.kind) ||
                  '',
              )
                .replace(/\s+/g, ' ')
                .slice(0, 120);
              return `${executor}:${why || 'no reason'}`;
            })
            .slice(0, 3)
            .join(', ')
        : '';
      return `${title}: ${reason || 'no escalation reason'}${attempts ? ` (${attempts})` : ''}`;
    })
    .slice(0, 6);
  return {
    title: 'Self-heal worker watchdog and contract on self_heal',
    requirement:
      'The overnight self-healer must repair worker watchdog kills, missed result contracts, and orphaned worker cleanup before retrying the same card lanes.',
    evidence: [
      `SELF-HEAL-WORKER-CONTRACT: live QC still reports ${postRepairDefects.length} defect(s) after worker execution.`,
      `Worker health: ${hardKills} hard watchdog kill(s), ${workerKills} total watchdog kill(s), ${contractMisses} contract miss(es).`,
      repeatedContractMissWave
        ? 'All worker lanes missed the JSON contract and live QC did not change.'
        : '',
      excessiveKillGroups.length
        ? `Excessive-kill group(s): ${excessiveKillGroups.join(', ')}.`
        : '',
      excessiveTimeGroups.length
        ? `Excessive-time group(s): ${excessiveTimeGroups.join(', ')}.`
        : '',
      samples.length ? `Escalated worker samples: ${samples.join(' | ')}` : '',
    ]
      .filter(Boolean)
      .join(' '),
    repair:
      'Fix worker budgeting, protected final JSON wrap-up, executor auth handling, verified-diff salvage rules, or child-process cleanup so the next pass can land verified repairs instead of losing them to watchdog or contract failure.',
    owner: 'Amy',
    need: 'Nothing.',
    source: 'self-heal-health',
    rawDefectCount: 1,
    rawDefects: [
      'SELF-HEAL-WORKER-CONTRACT: worker watchdog or output contract failure survived live QC',
    ],
  };
}

function selfHealLandingConflictRepairBlocker({
  selfHealHealth = {},
  results = [],
  postRepairDefects = [],
} = {}) {
  const landingGroups = Array.isArray(selfHealHealth.landingFailedGroups)
    ? selfHealHealth.landingFailedGroups
    : [];
  const samples = (results || [])
    .filter((result) =>
      /landing push failed|git rebase|rebase .*failed|non-fast-forward|could not apply/i.test(
        String((result && (result.escalationReason || result.escalation_reason)) || ''),
      ),
    )
    .map((result) => {
      const title = String(result.blockerTitle || 'worker')
        .replace(/\s+/g, ' ')
        .slice(0, 90);
      const sha = String(result.commit_sha || result.commitSha || '').slice(0, 12);
      const reason = String(result.escalationReason || result.escalation_reason || '')
        .replace(/\s+/g, ' ')
        .slice(0, 220);
      return `${title}${sha ? ` @ ${sha}` : ''}: ${reason || 'landing failed'}`;
    })
    .slice(0, 6);
  return {
    title: 'Self-heal landing and merge on self_heal',
    requirement:
      'The overnight self-healer must land verified worker fixes after parallel lanes, including rebase conflicts, before retrying the same card lanes.',
    evidence: [
      `SELF-HEAL-LANDING: live QC still reports ${postRepairDefects.length} defect(s) after a worker produced a verified fix that did not land.`,
      landingGroups.length ? `Landing-failed group(s): ${landingGroups.join(', ')}.` : '',
      samples.length ? `Failed landing samples: ${samples.join(' | ')}` : '',
    ]
      .filter(Boolean)
      .join(' '),
    repair:
      'Fix the coordinator landing path: rebase conflict handling, sequential replay of preserved worktrees, patch salvage from verified workers, or branch serialization. Do that before retrying the card worker.',
    owner: 'Amy',
    need: 'Nothing.',
    source: 'self-heal-health',
    rawDefectCount: 1,
    rawDefects: ['SELF-HEAL-LANDING: verified worker fix failed to land after parallel repair'],
  };
}

// ── Pre-spawn auth preflight ────────────────────────────────────────────────
// 2026-06-28 RED root cause: the overnight fan-out spawned 12 heal workers that
// each hit "API Error: 401" before their prompt because the worker env never
// ExampleCod the Claude OAuth token. heal-executor.workerEnv now injects it, and
// THIS preflight guarantees we never spawn the fan-out into a known-dead auth
// state: one cheap authenticated probe, one refresh attempt, one re-probe, then
// a single named System Health defect plus a clean stop if auth is still dead.

// Cheap authenticated probe: spawn one minimal `claude -p` with the same env an
// attended session uses (buildClaudeCliEnv injects CLAUDE_CODE_OAUTH_TOKEN and
// strips ANTHROPIC_API_KEY). A login/quota/401 sentinel in the output means auth
// is dead; isCliFailureOutput reuses the canonical guard pattern.
function defaultClaudeAuthProbe(opts = {}) {
  // platform + spawn are injectable so the Windows cmd.exe routing is unit-testable
  // without a real CLI spawn.
  const platform = opts.platform || process.platform;
  const spawn = opts.spawnSync || spawnSync;
  const claudeBin =
    platform === 'win32'
      ? process.env.APPDATA
        ? path.join(process.env.APPDATA, 'npm', 'claude.cmd')
        : 'claude.cmd'
      : 'claude';
  const probeArgs = ['--print', '--setting-sources', '', '-p', 'ping'];
  // On win32 a .cmd shim must be routed through cmd.exe /c with shell:false, or
  // spawnSync sets res.error and a healthy run falsely reports auth-failed. Non-win
  // calls the binary directly. Mirrors scripts/lib/heal-executor.js spawnClaude.
  const spawnFile = platform === 'win32' ? 'cmd.exe' : claudeBin;
  const spawnArgs = platform === 'win32' ? ['/c', claudeBin, ...probeArgs] : probeArgs;
  try {
    const res = spawn(spawnFile, spawnArgs, {
      cwd: opts.repoRoot || REPO,
      encoding: 'utf8',
      timeout: Number(opts.timeoutMs || 60_000),
      env: buildClaudeCliEnv(process.env, opts.tokenPath),
      windowsHide: true,
      shell: false,
    });
    const out = ((res.stdout || '') + '\n' + (res.stderr || '')).trim();
    if (res.error) {
      return {
        ok: false,
        detail: 'claude probe spawn error: ' + String(res.error.message || res.error).slice(0, 200),
      };
    }
    if (res.status !== 0) {
      return { ok: false, detail: 'claude probe exited ' + res.status + ': ' + out.slice(0, 200) };
    }
    if (!out || isCliFailureOutput(out)) {
      return {
        ok: false,
        detail: 'claude probe returned an auth/quota failure: ' + out.slice(0, 200),
      };
    }
    return { ok: true, detail: 'claude auth probe ok' };
  } catch (e) {
    return {
      ok: false,
      detail: 'claude probe threw: ' + String((e && e.message) || e).slice(0, 200),
    };
  }
}

// One token refresh attempt via the canonical refresher. Best-effort: any throw
// is reported as a failed refresh so the caller still surfaces a clean defect.
async function defaultTokenRefresh() {
  try {
    const r = await refreshIfNeeded({ force: true });
    return { ok: true, refreshed: !!(r && r.refreshed), skipped: !!(r && r.skipped) };
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e).slice(0, 200) };
  }
}

// The single named auth System Health defect. Concrete runbook so morning ExampleCo
// (or the next pass) knows exactly what to run.
function selfHealAuthFailedRepairBlocker({ probeDetail = '', refreshDetail = '' } = {}) {
  return {
    title: 'Self-Heal Executor: auth failed',
    requirement:
      'The overnight self-heal executor must hold a valid Claude credential before spawning any heal workers.',
    evidence: [
      'SELF-HEAL-AUTH-FAILED: the pre-spawn Claude auth probe failed and a forced token refresh did not recover it, so the worker fan-out was not spawned (no dead 401 sessions).',
      probeDetail ? 'Probe: ' + String(probeDetail).slice(0, 240) + '.' : '',
      refreshDetail ? 'Refresh: ' + String(refreshDetail).slice(0, 240) + '.' : '',
    ]
      .filter(Boolean)
      .join(' '),
    repair:
      'Runbook: on ExampleCo laptop run `claude /login` to re-seed ~/.claude/.credentials.json, then verify data/agent/claude-token-refresh.jsonl shows a recent "refreshed" or "fresh-skipped" row and that ~/.claude-oauth-token is recent. Re-run the overnight self-heal orchestrator once auth is restored.',
    owner: 'ExampleCo',
    need: 'Run claude /login to re-seed the Claude Max credential; the refresh token itself has expired and only ExampleCo can re-authenticate.',
    source: 'self-heal-health',
    rawDefectCount: 1,
    rawDefects: [
      'SELF-HEAL-AUTH-FAILED: pre-spawn Claude auth probe and forced refresh both failed',
    ],
  };
}

// Probe, refresh-once, re-probe. Returns {ok:true} when auth is good, or
// {ok:false, blocker} with the single named defect when it stays dead.
async function preflightHealAuth(opts = {}) {
  const probe = opts.authProbe || defaultClaudeAuthProbe;
  const refresh = opts.tokenRefresh || defaultTokenRefresh;
  const first = await Promise.resolve(
    probe({ repoRoot: opts.repoRoot, tokenPath: opts.tokenPath }),
  );
  if (first && first.ok) return { ok: true, probe: 'first', detail: first.detail || '' };
  const refreshResult = await Promise.resolve(refresh());
  const second = await Promise.resolve(
    probe({ repoRoot: opts.repoRoot, tokenPath: opts.tokenPath }),
  );
  if (second && second.ok) {
    return {
      ok: true,
      probe: 'after-refresh',
      detail: second.detail || '',
      refreshed: !!(refreshResult && refreshResult.refreshed),
    };
  }
  return {
    ok: false,
    probeDetail: (second && second.detail) || (first && first.detail) || 'auth probe failed',
    refreshDetail:
      (refreshResult &&
        (refreshResult.detail ||
          (refreshResult.ok
            ? refreshResult.refreshed
              ? 'refreshed but probe still failed'
              : 'refresh skipped'
            : 'refresh failed'))) ||
      '',
    blocker: selfHealAuthFailedRepairBlocker({
      probeDetail: (second && second.detail) || (first && first.detail) || '',
      refreshDetail:
        (refreshResult &&
          (refreshResult.detail ||
            (refreshResult.ok
              ? refreshResult.refreshed
                ? 'refreshed'
                : 'refresh skipped'
              : 'refresh failed'))) ||
        '',
    }),
  };
}

// Parse the BLOCKERS section of a briefing markdown into structured tasks.
function parseBlockersFromMarkdown(md) {
  if (!md) return [];
  const startMarker = /^BLOCKERS\b[^\n]*:\s*$/m;
  const startMatch = md.match(startMarker);
  if (!startMatch) return [];
  const startIdx = startMatch.index + startMatch[0].length;
  // Block runs until the section divider or next top-level section. The
  // dashboard markdown often renders a horizontal rule immediately after a clear
  // Blockers card; if we read past it, later numbered meeting/reminder rows look
  // like repair tasks and spawn nonsense workers.
  const tail = md.slice(startIdx);
  const bodyLines = [];
  const nextSectionRe = /^[A-Z][A-Za-z0-9 &/().,'+-]+(?:\s+\([^)]*\))*:\s*$/;
  for (const raw of tail.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^---\s*$/.test(line)) break;
    if (nextSectionRe.test(raw)) break;
    bodyLines.push(raw);
  }
  const body = bodyLines.join('\n');
  // Each blocker starts with "<n>. <title>" at column 0.
  const lines = body.split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const rawLine of lines) {
    const line = rawLine;
    const itemHead = line.match(/^(\d+)\.\s+(.+?)\s*$/);
    if (itemHead) {
      if (cur) out.push(cur);
      cur = {
        index: parseInt(itemHead[1], 10),
        title: itemHead[2].trim(),
        requirement: '',
        evidence: '',
        repair: '',
        owner: '',
        need: '',
      };
      continue;
    }
    if (!cur) continue;
    // 2026-05-24 format update: blockers now use concrete labels
    // ("What's failing", "What I tried", "Next step", "What you need to
    // do") instead of meta-commentary ("Requirement", "Relentless
    // iteration verdict", "Need from ExampleCo"). Old labels still parse for
    // back-compat with archived briefings on disk.
    const kv = line.match(
      /^\s+(Requirement|Evidence|Repair now|Owner|Need from ExampleCo|What's failing|What I tried|Next step|What you need to do):\s*(.*)$/,
    );
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      if (key === 'Requirement') cur.requirement = val;
      else if (key === 'Evidence' || key === "What's failing") cur.evidence = val;
      else if (key === 'Repair now' || key === 'Next step') cur.repair = val;
      else if (key === 'Owner') cur.owner = val;
      else if (key === 'Need from ExampleCo' || key === 'What you need to do') cur.need = val;
      else if (key === 'What I tried') cur.tried = val;
      continue;
    }
    // Continuation of the prior field if it ends mid-sentence.
    const cont = line.match(/^\s+(.+)$/);
    if (cont && cur && cur.need) cur.need += ' ' + cont[1].trim();
    else if (cont && cur && cur.evidence && !cur.repair && !cur.owner)
      cur.evidence += ' ' + cont[1].trim();
  }
  if (cur) out.push(cur);
  return out.filter((b) =>
    [b.requirement, b.evidence, b.repair, b.owner, b.need, b.tried].some((v) =>
      Boolean(String(v || '').trim()),
    ),
  );
}

// Decide whether the orchestrator should auto-attempt this blocker.
// Anything that names a credential, decision, or external action stays
// out of scope.
function classifyOwnership(blocker) {
  const owner = String(blocker.owner || '')
    .trim()
    .toLowerCase();
  const need = String(blocker.need || '');
  if (owner === 'ExampleCo') return { canAutoAttempt: false, reason: 'owner=ExampleCo explicit' };
  if (NEED_NEGATION_RE.test(need)) return { canAutoAttempt: true };
  if (PEER_AGENT_NEED_RE.test(need)) {
    return {
      canAutoAttempt: false,
      reason: 'need from ExampleCo names an external action (credential/decision/approval)',
    };
  }
  return { canAutoAttempt: true };
}

// 2026-05-24 fix: when the scheduled task runs at 22:30 CT the UTC date is
// already tomorrow, so briefing-{date}.md does not exist yet. Walk the
// briefings dir and pick the newest file within a 36h window; null only when
// nothing recent is on disk (real wall, surfaces as a startup escalation).
function resolveLatestBriefingPath({ date, briefingsDir, nowMs }) {
  const exact = path.join(briefingsDir, `briefing-${date}.md`);
  try {
    if (fs.statSync(exact).isFile()) return exact;
  } catch {
    /* fall through */
  }
  let entries;
  try {
    entries = fs.readdirSync(briefingsDir);
  } catch {
    return null;
  }
  const cutoff = nowMs - BRIEFING_FALLBACK_WINDOW_MS;
  let best = null;
  for (const name of entries) {
    if (!/^briefing-\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
    const full = path.join(briefingsDir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.mtimeMs < cutoff) continue;
    if (!best || stat.mtimeMs > best.mtimeMs) best = { full, mtimeMs: stat.mtimeMs };
  }
  return best ? best.full : null;
}

// Compose the per-session prompt. Self-contained: the spawned session has
// no memory of this orchestrator beyond what this prompt provides.
function buildSessionPrompt(blocker, opts = {}) {
  const repoRoot = opts.repoRoot || REPO;
  const deadlineIso = opts.deadlineIso || new Date(Date.now() + 25 * 60 * 1000).toISOString();
  const branchSummary = opts.branchSummary || 'master';
  const blockerId = (blocker.title || 'ExampleCo')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60);
  const falseClearProofGroups = isFalseClearSelfHealBlocker(blocker)
    ? falseClearGroupsFromBlockers([blocker])
    : [];
  const falseClearCountMatch = String((blocker && blocker.evidence) || '').match(
    /Live QC still reports\s+(\d+)\s+defect/i,
  );
  const falseClearCount = falseClearCountMatch ? Number(falseClearCountMatch[1]) : null;
  const falseClearProofContract =
    falseClearProofGroups.length || Number.isFinite(falseClearCount)
      ? [
          ``,
          `SELF-HEAL FALSE-CLEAR PROOF CONTRACT:`,
          falseClearProofGroups.length
            ? `  - Your final verification or reflection must name every current survivor group exactly: ${falseClearProofGroups.join('; ')}.`
            : '',
          Number.isFinite(falseClearCount)
            ? `  - Your final verification or reflection must say authenticated live QC still reports ${falseClearCount} defect(s).`
            : '',
          falseClearProofGroups.length && Number.isFinite(falseClearCount)
            ? `  - The exact survivor labels and authenticated live QC count must appear together in the same final verification or reflection field.`
            : '',
          `  - Do not claim clear with vague wording like "all survivor groups" or "the live count"; the coordinator will reject that proof and preserve your checkout.`,
          `  - If your targeted proof cannot cover those exact survivors and count, status must be escalated.`,
        ]
          .filter(Boolean)
          .join('\n')
      : '';
  return [
    `You are Amy doing overnight self-heal development work. ONE briefing blocker to clear.`,
    ``,
    `BLOCKER:`,
    `  title:       ${blocker.title || ''}`,
    `  requirement: ${blocker.requirement || ''}`,
    `  evidence:    ${blocker.evidence || ''}`,
    `  repair plan: ${blocker.repair || ''}`,
    `  owner:       ${blocker.owner || 'Amy'}`,
    `  need:        ${blocker.need || 'Nothing'}`,
    `  blocker_id:  ${blockerId}`,
    ``,
    `REPO: ${repoRoot}`,
    `BRANCH: ${branchSummary}`,
    `HARD DEADLINE: ${deadlineIso} (UTC). If your work would push past this, escalate cleanly instead of forcing a partial commit.`,
    ``,
    `WORKFLOW (do all of these, in this order):`,
    `  1. Read the blocker evidence AND the recent attempt/run history for this blocker_id or defect type. Do not repeat a prior tactic unless you can name the material change.`,
    `  2. Investigate root cause. Read the failing test/log/manifest/file referenced by the evidence. Do NOT guess.`,
    `  3. Write or update the smallest meaningful regression test that pins the fix. Test goes first.`,
    `  4. Review the planned change before acting. Use only a foreground peer-review command if one is directly available and can finish inside the deadline; otherwise write a brief adversarial self-review and continue. Record which review path you used in reflection. If peer review or self-review flags a specific approach, choose a different approach before acting. Do NOT start nested workers, background tasks, or child sessions from this worker.`,
    `  5. Apply the fix.`,
    `  6. Run bounded verification only. Prefer the smallest targeted Node/assertion command plus node --check for changed JS. If vitest is unavailable or a command exceeds 90 seconds, stop that command, record it, and escalate or use the smaller targeted proof; do not wait indefinitely. For a BLOCKED-TILE/red-card blocker, do not claim clear by changing the card from red to yellow/green or weakening the red-card QC; fix the underlying source or escalate.`,
    opts.noPush
      ? `  7. Do NOT commit and do NOT push from this isolated worker. Leave the verified file changes in the worktree. The coordinator commits, rebases, pushes, deploys, waits, refreshes, and runs full live QC.`
      : `  7. Commit with a clear message that names the blocker_id and what was fixed. Then push to master.`,
    opts.noPush
      ? `  8. Do NOT run SSH deploy, cloud publish, dashboard refresh, or live-card refresh from this worker. The coordinator owns commit/land/deploy/wait/refresh/full live QC after your verified worktree changes.`
      : `  8. Wait for the changed artifact/deploy/publish hash when the fix affects the live dashboard, then refresh the card and rerun the targeted/live verification. Local source tests alone are not closure.`,
    `  9. Reflect on the targeted QC result you produced, the prior live defect, and the next design if the coordinator's live QC still fails.`,
    falseClearProofContract,
    ``,
    `OUTPUT CONTRACT (final assistant message MUST be exactly one minified JSON object on its own line, with no Markdown and no prose):`,
    `  {`,
    `    "status": "cleared" | "escalated",`,
    `    "blocker_id": "${blockerId}",`,
    opts.noPush
      ? `    "commit_sha": "",`
      : `    "commit_sha": "<git rev-parse HEAD after push, empty string if escalated>",`,
    `    "pushed": true | false,`,
    `    "tests": "<short summary, e.g. \\"35/35 passed\\" or \\"vitest IRS test green\\">",`,
    `    "verification": "<what command/check proved the blocker cleared>",`,
    `    "reflection": "<new QC result vs prior result; whether the fix worked; next design if not clean>",`,
    `    "escalation_reason": "<empty when cleared; one sentence when escalated>"`,
    `  }`,
    ``,
    `Escalate cleanly (status=escalated, commit_sha="", pushed=false) when:`,
    `  - the blocker actually needs ExampleCo (credential, decision, external call)`,
    `  - you cannot verify the fix without infra ExampleCo must provide`,
    `  - the deadline is approaching and a partial commit would be worse than no commit`,
    opts.noPush
      ? `For isolated workers, pushed MUST be false and commit_sha MUST be empty. You may claim status=cleared only after a passing targeted verification command and leaving the fix as file changes for the coordinator to commit.`
      : `Never claim status=cleared without a real pushed commit and a passing verification command.`,
  ].join('\n');
}

// Parse the stream-json output of `claude --print` to classify the result.
function classifySessionResult(stdout, exitCode) {
  if (exitCode !== 0) {
    return {
      status: 'escalated',
      escalationReason: `claude CLI exited with code ${exitCode}`,
      commit_sha: '',
      pushed: false,
    };
  }
  if (!stdout || !stdout.trim()) {
    return {
      status: 'escalated',
      escalationReason: 'empty CLI output',
      commit_sha: '',
      pushed: false,
    };
  }
  // Walk lines, find the last `type:"result"` entry, extract its `.result`.
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  let resultText = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry && entry.type === 'result' && typeof entry.result === 'string') {
        resultText = entry.result;
        break;
      }
    } catch {
      /* keep walking */
    }
  }
  if (!resultText) {
    return {
      status: 'escalated',
      escalationReason: 'no result block found in stream-json',
      commit_sha: '',
      pushed: false,
    };
  }
  // Result body must contain a single JSON object that matches the contract.
  // Extract the LAST {...} block in the result text.
  const jsonMatch = resultText.match(/\{[\s\S]*\}\s*$/);
  if (!jsonMatch) {
    return {
      status: 'escalated',
      escalationReason: 'result block did not contain JSON',
      commit_sha: '',
      pushed: false,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    return {
      status: 'escalated',
      escalationReason: 'result JSON parse failed: ' + String(e.message || e).slice(0, 120),
      commit_sha: '',
      pushed: false,
    };
  }
  const status = String(parsed.status || '').toLowerCase();
  const commit_sha = String(parsed.commit_sha || '');
  const pushed = parsed.pushed === true;
  if (status === 'cleared' && commit_sha && pushed) {
    return {
      status: 'cleared',
      commit_sha,
      pushed,
      verification: parsed.verification,
      tests: parsed.tests,
      reflection: parsed.reflection,
    };
  }
  return {
    status: 'escalated',
    escalationReason:
      parsed.escalation_reason ||
      `session reported status=${status}, commit_sha=${commit_sha}, pushed=${pushed}`,
    commit_sha,
    pushed,
  };
}

// Deadline gate: should we skip starting a new session because remaining
// time is less than the per-session budget?
function shouldRespectDeadline(nowMs, deadlineMs, perSessionBudgetMs) {
  if (!Number.isFinite(deadlineMs)) return false;
  return deadlineMs - nowMs < perSessionBudgetMs;
}

function resolveMaxPasses(opts = {}) {
  const raw = opts.maxPasses ?? (opts.env || process.env).SELFHEAL_MAX_PASSES;
  if (raw == null || raw === '' || String(raw).toLowerCase() === 'unbounded') {
    return UNBOUNDED_MAX_PASSES;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : UNBOUNDED_MAX_PASSES;
}

function maxPassesForLog(maxPasses) {
  return Number.isFinite(maxPasses) ? maxPasses : 'unbounded';
}

function shouldContinueRepairLoop({
  anyEscalated,
  mode,
  passNumber,
  maxPasses,
  postRepairRawDefects,
  repeatedContractMissWave,
  postRepairRegressed,
  postRepairDefectSwap,
  repairLoopOptionsExhausted,
  repairLoopExhaustionReason,
  falseClearSelfHealEscalation,
  falseClearSelfHealAttempted,
  deadlineMs,
  perSessionBudgetMs,
  nowMs = Date.now(),
} = {}) {
  if (!anyEscalated || !mode || mode.observe) {
    return { continue: false, reason: 'not-actionable' };
  }
  if (!postRepairRawDefects) {
    return { continue: false, reason: 'clean' };
  }
  if (repeatedContractMissWave) {
    return { continue: false, reason: 'contract-miss-wave' };
  }
  if (postRepairRegressed) {
    return { continue: false, reason: 'post-repair-regressed' };
  }
  if (repairLoopOptionsExhausted) {
    return { continue: false, reason: repairLoopExhaustionReason || 'options-exhausted' };
  }
  if (Number.isFinite(maxPasses) && passNumber >= maxPasses) {
    return { continue: false, reason: 'max-passes-exhausted' };
  }
  if (!mode.midday && shouldRespectDeadline(nowMs, deadlineMs, perSessionBudgetMs)) {
    return { continue: false, reason: 'deadline-too-close' };
  }
  if (falseClearSelfHealAttempted) {
    return { continue: true, reason: 'false-clear-underlying-repair' };
  }
  return {
    continue: true,
    reason: falseClearSelfHealEscalation
      ? 'false-clear-self-heal'
      : postRepairDefectSwap
        ? 'swapped-live-defects'
        : 'surviving-live-defects',
  };
}

function ensureDirForFile(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    /* best effort */
  }
}

function appendRunLog(row, logPath = RUNS_LOG_PATH) {
  ensureDirForFile(logPath);
  fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}

// EXECUTOR-HEALTH CHECKPOINT (self-heal-why-report, 2026-07-02): the SELF-HEAL HEALTH
// card can only say "executor healthy" / "executor cannot run" when SOMETHING durable
// proves the executor actually ran this window. Before this fix, a clean pass with no
// blockers, an unreadable briefing, or a missing briefing all `return`ed before ever
// writing a self-heal-health row, so the card fell through to "ExampleCo: no executor
// health checkpoint recorded" -- indistinguishable from a healer that never ran at all.
// This ONE stage name (`self-heal-checkpoint`) is written at the START of every pass
// (status:'running', proves the process launched) and at every EXIT (status:'green'
// when nothing blew up, 'red' with a plain-English `crash` reason on a genuine crash),
// so self-heal-health-card.js's resolveExecutorRow can trust "no checkpoint this
// window" to mean the healer genuinely never ran, not merely "nothing to report".
const CHECKPOINT_STAGE = 'self-heal-checkpoint';

function logExecutorCheckpoint(logRun, phase, extra = {}) {
  logRun({ stage: CHECKPOINT_STAGE, phase, ...extra });
}

function clampCheckpointDetail(text, n = 200) {
  return String(text == null ? '' : text).slice(0, n);
}

function pidIsAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function acquireLock({ lockPath = LOCK_PATH, isPidAlive = pidIsAlive } = {}) {
  try {
    if (fs.existsSync(lockPath)) {
      const stat = fs.statSync(lockPath);
      const age = Date.now() - stat.mtimeMs;
      let holder = '';
      try {
        holder = fs.readFileSync(lockPath, 'utf8').trim();
      } catch {
        /* best effort */
      }
      if (age < LOCK_STALE_MS && holder && isPidAlive(holder)) {
        return {
          ok: false,
          reason: `another orchestrator instance is running (lock age ${Math.round(age / 1000)}s)`,
        };
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* best effort */
      }
    }
    fs.writeFileSync(lockPath, String(process.pid), 'utf8');
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: 'lock acquisition failed: ' + String(e.message || e).slice(0, 160),
    };
  }
}

function releaseLock() {
  try {
    const holder = fs.readFileSync(LOCK_PATH, 'utf8').trim();
    if (holder === String(process.pid)) fs.unlinkSync(LOCK_PATH);
  } catch {
    /* best effort */
  }
}

function parseDeadlineToTodayCt(spec) {
  const m = String(spec || DEFAULT_DEADLINE_CT).match(/^([0-2]?\d):([0-5]\d)$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const now = new Date();
  const dl = new Date(now);
  dl.setHours(hh, mm, 0, 0);
  if (dl.getTime() < now.getTime()) dl.setDate(dl.getDate() + 1);
  return dl.getTime();
}

function gitBranchSummary(repoRoot) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    return `${branch}, ${dirty ? `${dirty.split('\n').length} uncommitted change(s)` : 'clean working tree'}`;
  } catch {
    return 'ExampleCo';
  }
}

function safeDeployRelPath(file) {
  const rel = String(file || '')
    .replace(/\\/g, '/')
    .trim();
  if (!rel || rel.startsWith('/') || rel.includes('\0')) return '';
  const normalized = path.posix.normalize(rel);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    return '';
  }
  if (
    normalized === 'node_modules' ||
    normalized.startsWith('node_modules/') ||
    normalized === '.git' ||
    normalized.startsWith('.git/') ||
    normalized === '.agents' ||
    normalized.startsWith('.agents/') ||
    normalized === '.codex' ||
    normalized.startsWith('.codex/')
  ) {
    return '';
  }
  return normalized;
}

function deployTargetsForRelPath(rel) {
  const clean = safeDeployRelPath(rel);
  if (!clean) return [];
  const targets = [clean];
  if (clean === 'ec2-server.js') targets.push('server.js');
  return targets;
}

function deployedFilesNeedServerRestart(files = []) {
  return (files || []).some((file) => {
    const rel = String(file || '').replace(/\\/g, '/');
    return (
      rel === 'ec2-server.js' ||
      rel === 'server.js' ||
      /^scripts\/.*\.js$/i.test(rel) ||
      /^src\/.*\.js$/i.test(rel)
    );
  });
}

const RUNTIME_CORE_SYNC_RELS = [
  'AGENTS.md',
  '.codex/instructions.md',
  'memory/MEMORY.md',
  'memory/AMY.md',
  'memory/AMY_REQUIREMENTS.md',
  'memory/AMY_FOUNDATION_REFLECTION.md',
  'memory/reference_amy_state_locations.md',
  'memory/reference_operator_identity.json',
];

function safeRuntimeCoreRelPath(file) {
  const normalized = String(file || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!RUNTIME_CORE_SYNC_RELS.includes(normalized)) return '';
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) return '';
  return normalized;
}

function runtimeCoreMemoryIsUsable(root) {
  try {
    const memory = fs.readFileSync(path.join(root, 'memory', 'MEMORY.md'), 'utf8');
    return /\bAMY\.md\b/.test(memory);
  } catch {
    return false;
  }
}

function resolveRuntimeCoreSyncSourceRoot({
  fromRoot,
  toRoot,
  appRoot = REPO,
  env = process.env,
  isGitWorkTreeFn = isGitWorkTree,
} = {}) {
  const candidates = [];
  if (env.SELF_HEAL_RUNTIME_CORE_SOURCE_ROOT) {
    candidates.push(env.SELF_HEAL_RUNTIME_CORE_SOURCE_ROOT);
  }
  try {
    candidates.push(getCoordinatorRepoRoot(appRoot, { env, isGitWorkTree: isGitWorkTreeFn }));
  } catch {
    /* fall back to worker snapshot below */
  }
  candidates.push(fromRoot);

  const destRoot = path.resolve(toRoot || '');
  for (const candidate of candidates.filter(Boolean)) {
    const root = path.resolve(String(candidate));
    if (!root || root === destRoot || !fs.existsSync(root)) continue;
    if (!runtimeCoreMemoryIsUsable(root)) continue;
    return root;
  }
  return path.resolve(fromRoot || '');
}

function isPermissionCopyError(e) {
  const text = String((e && (e.code || e.message)) || e || '');
  return /\b(?:EACCES|EPERM)\b/i.test(text);
}

function shouldUseSudoInstallFallback({
  dest,
  toRoot,
  platform = process.platform,
  allowSudoInstallFallback,
} = {}) {
  if (allowSudoInstallFallback != null) return !!allowSudoInstallFallback;
  if (platform !== 'linux') return false;
  const rootText = String(toRoot || '').replace(/\\/g, '/');
  const destText = String(dest || '').replace(/\\/g, '/');
  const isLiveRoot = (p) => p === '/opt/secondbrain' || p.startsWith('/opt/secondbrain/');
  return isLiveRoot(rootText) || isLiveRoot(destText);
}

function sudoInstallFile({
  src,
  dest,
  runner = spawnSync,
  platform = process.platform,
  toRoot = '',
  allowSudoInstallFallback,
} = {}) {
  if (
    !shouldUseSudoInstallFallback({
      dest,
      toRoot,
      platform,
      allowSudoInstallFallback,
    })
  ) {
    throw new Error(`permission denied copying ${src} -> ${dest}`);
  }
  let mode = '0644';
  try {
    mode = fs.statSync(src).mode & 0o111 ? '0755' : '0644';
  } catch {
    /* default to data-file mode */
  }
  const result = runner('sudo', ['install', '-D', '-m', mode, src, dest], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `sudo install failed for ${dest}: ${String(result.stderr || result.stdout || '').slice(0, 300)}`,
    );
  }
  return { copied: true, via: 'sudo-install' };
}

function copyFileForDeploy({
  src,
  dest,
  toRoot,
  copyFile = fs.copyFileSync,
  runner = spawnSync,
  platform = process.platform,
  allowSudoInstallFallback,
} = {}) {
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyFile(src, dest);
    return { copied: true, via: 'direct' };
  } catch (e) {
    if (!isPermissionCopyError(e)) throw e;
    return sudoInstallFile({
      src,
      dest,
      toRoot,
      runner,
      platform,
      allowSudoInstallFallback,
    });
  }
}

function syncRuntimeCoreFilesFromSource({
  sourceRoot,
  toRoot,
  copyFile = fs.copyFileSync,
  runner = spawnSync,
  platform = process.platform,
  allowSudoInstallFallback,
} = {}) {
  const srcRoot = path.resolve(sourceRoot || '');
  const destRoot = path.resolve(toRoot || '');
  if (!srcRoot || !destRoot || srcRoot === destRoot) {
    return { copied: 0, files: [], skipped: true };
  }
  const files = [];
  let copied = 0;
  let sudoCopied = 0;
  for (const rel of RUNTIME_CORE_SYNC_RELS) {
    const clean = safeRuntimeCoreRelPath(rel);
    if (!clean) continue;
    const src = path.join(srcRoot, clean);
    const dest = path.join(destRoot, clean);
    if (!src.startsWith(srcRoot + path.sep) || !dest.startsWith(destRoot + path.sep)) continue;
    if (!fs.existsSync(src)) continue;
    const copyResult = copyFileForDeploy({
      src,
      dest,
      toRoot: destRoot,
      copyFile,
      runner,
      platform,
      allowSudoInstallFallback,
    });
    if (copyResult.via === 'sudo-install') sudoCopied++;
    files.push(clean);
    copied++;
  }
  return { copied, sudoCopied, files, sourceRoot: srcRoot };
}

function refreshCardsFromHealResults(results = []) {
  const cards = new Set();
  const broadNewsTargets = new Set(['news_cards', 'all_news_cards', 'news_content']);
  for (const result of results || []) {
    const title = String((result && (result.blockerTitle || result.title)) || '');
    const rawRows = Array.isArray(result && result.rawDefects) ? result.rawDefects.map(String) : [];
    const evidence = String((result && result.evidence) || '');
    const escalation = [
      result && result.escalationReason,
      result && result.escalation_reason,
      result && result.verification,
      result && result.reflection,
      result && result.requirement,
      result && result.repair,
      result && result.repair_plan,
      result && result.need,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    const clueRows = [...rawRows, ...(evidence ? [evidence] : []), ...escalation];
    const rawCards = cardIdsFromRenderRows(rawRows);
    for (const card of systemHealthProofCardsFromRows(clueRows)) cards.add(card);
    for (const card of systemHealthActionCardsFromRows(clueRows)) cards.add(card);
    for (const card of rawCards) cards.add(card);
    const explicit = String((result && (result.blockerId || result.blocker_id)) || '');
    if (
      /^[a-z][a-z0-9_]*$/.test(explicit) &&
      !(rawCards.length && broadNewsTargets.has(explicit))
    ) {
      cards.add(explicit);
    }
    for (const card of contentReadinessCardsFromSystemHealthRows(clueRows)) cards.add(card);
    const titleCard = (title.match(/\bon\s+([a-z0-9_]+)\b/i) || [])[1] || '';
    if (titleCard && !(rawCards.length && broadNewsTargets.has(titleCard))) cards.add(titleCard);
    if (
      /NEWS-(?:CONTENT|READINESS|STUB|PROSE)|news_cards|all_news_cards/i.test(title) &&
      !rawCards.length
    ) {
      cards.add('news_cards');
    }
  }
  return [...cards].filter(Boolean);
}

function refreshResultsFromBlockers(blockers = []) {
  return (blockers || []).map((blocker) => ({
    blockerTitle: (blocker && blocker.title) || '',
    blockerId: (blocker && (blocker.blocker_id || blocker.blockerId)) || '',
    rawDefects: Array.isArray(blocker && blocker.rawDefects) ? blocker.rawDefects : [],
    pushed: true,
  }));
}

function allSessionFailuresAreContractMisses(results = []) {
  const nonCleared = (results || []).filter((result) => result && result.status !== 'cleared');
  if (!nonCleared.length) return false;
  return nonCleared.every((result) => {
    const attempts = Array.isArray(result.attempts) ? result.attempts : [];
    return attempts.some((attempt) =>
      /no JSON status block|contract-miss/i.test(
        String((attempt && attempt.escalationReason) || (result && result.escalationReason) || ''),
      ),
    );
  });
}

function contentReadinessCardsFromSystemHealthRows(rows = []) {
  const out = new Set();
  const labelMap = [
    [/AI\s*&?\s*tech news/i, 'ai_tech_news'],
    [/\bUS news\b/i, 'us_news'],
    [/\bWorld news\b/i, 'world_news'],
    [/\bUS immigration news\b/i, 'us_immigration_news'],
    [/\bMortgage industry news\b/i, 'mortgage_industry_news'],
    [/\bCOVID(?:-19)?(?: treatments)?(?: & news)?\b/i, 'covid_news'],
    [/\bViral (?:tech )?clip proposals\b|\bviral news\b/i, 'viral_news'],
  ];
  for (const row of rows || []) {
    const text = String(row || '');
    if (!/\bBLOCKED-TILE:\s*system_health\b/i.test(text)) continue;
    const hasContentReadiness = /\bContent readiness\b/i.test(text);
    let matchedNamedContentCard = false;
    if (hasContentReadiness && /\+\d+\s+more\b/i.test(text)) out.add('news_cards');
    for (const [re, id] of labelMap) {
      if (re.test(text)) {
        matchedNamedContentCard = true;
        out.add(id);
      }
    }
    if (hasContentReadiness && !matchedNamedContentCard) out.add('news_cards');
  }
  return [...out];
}

function systemHealthProofCardsFromRows(rows = []) {
  const out = new Set();
  for (const row of rows || []) {
    const text = String(row || '');
    if (!/\bBLOCKED-TILE:\s*system_health\b/i.test(text)) continue;
    if (/\bGraphiti\b/i.test(text)) out.add('graphiti_coverage');
    if (/\bOtter speaker enrichment\b/i.test(text)) out.add('otter_speaker_pareto');
  }
  return [...out];
}

function systemHealthActionCardsFromRows(rows = []) {
  const out = new Set();
  for (const row of rows || []) {
    const text = String(row || '');
    if (!/\bBLOCKED-TILE:\s*system_health\b/i.test(text)) continue;
    if (/\bGmail action scan\b|\baction items?\b/i.test(text)) out.add('action_items');
  }
  return [...out];
}

function restartSecondbrainBackend({
  appRoot = REPO,
  env = process.env,
  platform = process.platform,
  runner = spawnSync,
} = {}) {
  if (env.SELF_HEAL_PM2_RESTART === '0') return { skipped: true, reason: 'disabled' };
  const resolved =
    platform === 'linux' && String(appRoot || '').startsWith('/')
      ? String(appRoot)
      : path.resolve(appRoot || '');
  if (env.SELF_HEAL_PM2_RESTART !== '1') {
    if (platform !== 'linux' || !resolved.startsWith('/opt/secondbrain')) {
      return { skipped: true, reason: 'not-ec2-app-root' };
    }
  }
  const result = runner('pm2', ['restart', 'secondbrain-backend'], {
    cwd: resolved,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').slice(-500),
    stderr: String(result.stderr || '').slice(-500),
  };
}

function deployChangedFilesFromWorktree({
  worktree,
  commitSha,
  appRoot = REPO,
  env = process.env,
  runtimeCoreSourceRoot = '',
  isGitWorkTreeFn = isGitWorkTree,
  copyFile = fs.copyFileSync,
  runner = spawnSync,
  platform = process.platform,
  allowSudoInstallFallback,
  git = (args, cwd = worktree, opts = {}) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs || 120_000,
      maxBuffer: 16 * 1024 * 1024,
    }),
} = {}) {
  if (!worktree || !commitSha) return { skipped: true, reason: 'missing worktree or commit' };
  const fromRoot = path.resolve(worktree);
  const toRoot = path.resolve(appRoot);
  if (fromRoot === toRoot) return { skipped: true, reason: 'app root is worker root' };
  const status = String(
    git(['diff-tree', '--no-commit-id', '--name-status', '-r', commitSha]) || '',
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let copied = 0;
  let removed = 0;
  let sudoCopied = 0;
  const files = [];
  for (const line of status) {
    const parts = line.split(/\t+/);
    const state = parts[0] || '';
    const rel = safeDeployRelPath(parts[parts.length - 1]);
    const targets = deployTargetsForRelPath(rel);
    if (!targets.length) continue;
    files.push(...targets);
    for (const targetRel of targets) {
      const dest = path.join(toRoot, targetRel);
      if (!dest.startsWith(toRoot + path.sep) && dest !== toRoot) continue;
      if (state.startsWith('D')) {
        if (targetRel !== rel) continue;
        try {
          fs.rmSync(dest, { force: true });
          removed++;
        } catch {
          /* best effort */
        }
        continue;
      }
      const src = path.join(fromRoot, rel);
      if (!src.startsWith(fromRoot + path.sep) || !fs.existsSync(src)) continue;
      const copyResult = copyFileForDeploy({
        src,
        dest,
        toRoot,
        copyFile,
        runner,
        platform,
        allowSudoInstallFallback,
      });
      if (copyResult.via === 'sudo-install') sudoCopied++;
      copied++;
    }
  }
  const runtimeCoreSyncSourceRoot = resolveRuntimeCoreSyncSourceRoot({
    fromRoot,
    toRoot,
    appRoot,
    env: runtimeCoreSourceRoot
      ? { ...env, SELF_HEAL_RUNTIME_CORE_SOURCE_ROOT: runtimeCoreSourceRoot }
      : env,
    isGitWorkTreeFn,
  });
  const runtimeCoreSync = syncRuntimeCoreFilesFromSource({
    sourceRoot: runtimeCoreSyncSourceRoot,
    toRoot,
    copyFile,
    runner,
    platform,
    allowSudoInstallFallback,
  });
  sudoCopied += Number(runtimeCoreSync.sudoCopied || 0);
  const uniqueFiles = [...new Set(files)].slice(0, 50);
  const restart =
    deployedFilesNeedServerRestart(uniqueFiles) && copied > 0
      ? restartSecondbrainBackend({ appRoot, env, platform, runner })
      : { skipped: true, reason: 'no-live-js-change' };
  const ok = restart && restart.ok === false ? false : true;
  const error = ok
    ? ''
    : `backend restart failed: ${String(restart.stderr || restart.stdout || '').slice(0, 200)}`;
  return { ok, error, copied, removed, sudoCopied, files: uniqueFiles, runtimeCoreSync, restart };
}

function refreshPublishedBriefingAfterHeal({
  date,
  appRoot = REPO,
  env = process.env,
  platform = process.platform,
  runner = spawnSync,
  results = [],
  budgetMs = DEFAULT_PUBLISH_REFRESH_BUDGET_MS,
} = {}) {
  if (env.SELF_HEAL_PUBLISH_REFRESH === '0') return { skipped: true, reason: 'disabled' };
  const resolved =
    platform === 'linux' && String(appRoot || '').startsWith('/')
      ? String(appRoot)
      : path.resolve(appRoot || '');
  if (env.SELF_HEAL_PUBLISH_REFRESH !== '1') {
    if (platform !== 'linux' || !resolved.startsWith('/opt/secondbrain')) {
      return { skipped: true, reason: 'not-ec2-app-root' };
    }
  }
  const result = runner(
    process.execPath,
    [
      'scripts/cloud-morning-briefing.js',
      '--date',
      date,
      '--data-dir',
      path.join(resolved, 'data'),
      '--publish',
      '--self-heal-refresh',
    ],
    {
      cwd: resolved,
      encoding: 'utf8',
      timeout: budgetMs,
      env: {
        ...env,
        AMY_BRIEFING_ALLOW_CLOUD_HEAL: '1',
        AMY_BRIEFING_SELF_HEAL_REFRESH: '1',
        SELF_HEAL_REFRESH_CARDS: refreshCardsFromHealResults(results).join(','),
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const timedOut =
    result &&
    (result.signal === 'SIGTERM' ||
      /timed\s*out|ETIMEDOUT/i.test(String((result.error && result.error.code) || '')) ||
      /timed\s*out|ETIMEDOUT/i.test(String((result.error && result.error.message) || '')));
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || null,
    watchdog: timedOut
      ? { kind: 'publish-refresh-budget', killed: true, thresholdMs: budgetMs }
      : null,
    stdout: String(result.stdout || '').slice(-1500),
    stderr: String(result.stderr || result.error?.message || '').slice(-1500),
  };
}

// Run one self-heal session per blocker, with automatic claude->codex
// fallback. Delegates to scripts/lib/heal-executor.js (runWithFallback),
// which owns BOTH the per-executor CLI shape AND its matching result parser.
//
// This replaces the prior hand-rolled spawn, which spawned codex while
// parsing claude stream-json (a structural bug: the parser never matched
// codex's stderr run-log shape, so every codex session classified as
// "no result block" even when it cleared). Binding the parser to the
// executor inside heal-executor prevents that class of error, and the
// fallback means a hang or transient fault in claude does not stall the
// blocker, codex picks it up. A genuine-wall escalation (needs ExampleCo) does
// NOT fall back, because the other model hits the same wall.
//
// Injectable for tests via opts.runFallback.
function runHealSessionCore(blocker, opts = {}) {
  const cwd = opts.cwd || opts.repoRoot || REPO;
  const prompt = buildSessionPrompt(blocker, opts);
  const budgetMs = opts.budgetMs || DEFAULT_PER_SESSION_BUDGET_MS;
  const fallback = opts.runFallback || runWithFallback;
  // Stream the session's live output to a tailable per-session log so a watcher can
  // play-by-play it in real time and catch a break early, instead of only seeing the
  // result at completion. data/agent/heal-sessions/<slug>-<uniq>.log
  let onStream = opts.onStream;
  let sessionLogPath = '';
  if (!onStream) {
    try {
      const slug =
        String((blocker && blocker.title) || 'heal')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 40) +
        '-' +
        String(opts.uniq != null ? opts.uniq : '0');
      const dir = path.join(REPO, 'data', 'agent', 'heal-sessions');
      fs.mkdirSync(dir, { recursive: true });
      const logPath = path.join(dir, slug + '.log');
      sessionLogPath = logPath;
      fs.writeFileSync(
        logPath,
        `# heal: ${(blocker && blocker.title) || ''}\n# started ${new Date().toISOString()}\n`,
      );
      onStream = (chunk) => {
        try {
          fs.appendFileSync(logPath, chunk);
        } catch (e) {
          /* best effort */
        }
      };
    } catch (e) {
      /* logging is best-effort */
    }
  }
  return Promise.resolve(
    fallback(prompt, {
      primary: 'claude',
      secondary: 'codex',
      budgetMs,
      cwd,
      onStream,
    }),
  )
    .then((r) => ({
      status: r.status,
      commit_sha: r.commit_sha || '',
      pushed: !!r.pushed,
      verification: r.summary || r.verification || '',
      tests: r.tests || '',
      reflection: r.reflection || '',
      escalationReason: r.escalationReason || '',
      attempts: r.attempts || [],
      sessionLogPath,
      stdoutTail: String(r.stdout || '').slice(-2000),
      stderrTail: String(r.stderr || '').slice(-2000),
    }))
    .catch((e) => ({
      status: 'escalated',
      commit_sha: '',
      pushed: false,
      escalationReason:
        'runWithFallback threw: ' + String(e && e.message ? e.message : e).slice(0, 200),
      attempts: [],
      sessionLogPath,
      stdoutTail: '',
      stderrTail: '',
    }));
}

// The heal runner the orchestrator calls per survivor. In PARALLEL mode (opts.parallel
// with a serializer) the session runs in its own git worktree and its commit lands
// serially, so concurrent heals never collide on the shared checkout or race the push.
// In SEQUENTIAL mode it runs directly in the shared repo (legacy overnight behavior).
function spawnSession(blocker, opts = {}) {
  if (opts.parallel && typeof opts.serialize === 'function') {
    return runIsolatedHealSession(blocker, {
      repoRoot: opts.repoRoot || getCoordinatorRepoRoot(REPO),
      dependencyRoot: opts.dependencyRoot || REPO,
      afterPush:
        opts.afterPush || ((info) => deployChangedFilesFromWorktree({ ...info, appRoot: REPO })),
      runSession: runHealSessionCore,
      serialize: opts.serialize,
      uniq: opts.uniq,
      budgetMs: opts.budgetMs,
      deadlineIso: opts.deadlineIso,
      branchSummary: opts.branchSummary,
      sessionOpts: { runFallback: opts.runFallback, uniq: opts.uniq },
    });
  }
  return runHealSessionCore(blocker, opts);
}

function summarizeSelfHealHealth(blockers = [], results = [], opts = {}) {
  const refreshOnlyResults = (
    Array.isArray(opts.refreshOnlyResults) ? opts.refreshOnlyResults : []
  ).map((result) => ({
    ...result,
    status: result && result.status ? result.status : 'cleared',
  }));
  const refreshOnlyRawDefects = refreshOnlyResults.reduce((sum, result) => {
    const rawCount = Number(result && result.rawDefectCount);
    if (Number.isFinite(rawCount) && rawCount > 0) return sum + rawCount;
    const rows = Array.isArray(result && result.rawDefects) ? result.rawDefects.length : 0;
    return sum + (rows || 1);
  }, 0);
  const rawDefects =
    refreshOnlyRawDefects +
    blockers.reduce((sum, b) => sum + Number(b && b.rawDefectCount ? b.rawDefectCount : 1), 0);
  const postRepairDefects = opts.postRepairDefects || opts.postRepairLiveDefects || [];
  const preRepairDefects = Array.isArray(opts.preRepairDefects) ? opts.preRepairDefects : [];
  const newPostRepairDefectGroupDetails = preRepairDefects.length
    ? newDefectGroups(preRepairDefects, postRepairDefects)
    : [];
  const newPostRepairDefectGroups = newPostRepairDefectGroupDetails.map(
    (group) => `${group.cardId}:${group.defectType} (${group.count})`,
  );
  const newPostRepairCardGroupDetails = newCardDefectGroups(
    preRepairDefects,
    newPostRepairDefectGroupDetails,
  );
  const newPostRepairCardGroups = newPostRepairCardGroupDetails.map(
    (group) => `${group.cardId}:${group.defectType} (${group.count})`,
  );
  const postRepairDefectSwap = isPostRepairDefectSwap({
    beforeDefects: preRepairDefects,
    afterDefects: postRepairDefects,
    newCardGroups: newPostRepairCardGroupDetails,
  });
  const postRepairRegressed = isPostRepairRegression({
    beforeDefects: preRepairDefects,
    afterDefects: postRepairDefects,
    newCardGroups: newPostRepairCardGroupDetails,
    postRepairDefectSwap,
  });
  const groups = results.map((result, idx) => {
    const attempts = Array.isArray(result && result.attempts) ? result.attempts : [];
    const workerMs = attempts.reduce((sum, a) => sum + Number((a && a.durationMs) || 0), 0);
    const watchdogKills = attempts.filter((a) => a && a.watchdog && a.watchdog.killed).length;
    const hardWatchdogKills = attempts.filter((a) => {
      const kind = String((a && a.watchdog && a.watchdog.kind) || '');
      return (
        a &&
        a.watchdog &&
        a.watchdog.killed &&
        /budget|first-byte-hang|nested-background-task/i.test(kind)
      );
    }).length;
    const contractMisses = attempts.filter((a) =>
      /no JSON status block|contract-miss/i.test(
        String((a && (a.escalationReason || a.watchdog?.kind)) || ''),
      ),
    ).length;
    const blocker = blockers[idx] || {};
    const escalationReason = String(
      (result && (result.escalationReason || result.escalation_reason)) || '',
    );
    return {
      blocker: (result && result.blockerTitle) || blocker.title || `worker-${idx + 1}`,
      status: result && result.status,
      workerMs,
      watchdogKills,
      hardWatchdogKills,
      contractMisses,
      reflectionPresent: !!(result && result.reflection),
      verificationPresent: !!(result && result.verification),
      testsPresent: !!(result && result.tests),
      evidencePresent: !!(
        result &&
        (result.sessionLogPath || result.stdoutTail || result.stderrTail)
      ),
      pushed: !!(result && result.pushed),
      committed: !!(result && result.committed),
      deployFailed: !!(result && result.deploy && result.deploy.ok === false),
      escalationReason,
      landingFailed:
        /landing push failed|git rebase|rebase .*failed|non-fast-forward|could not apply/i.test(
          escalationReason,
        ),
    };
  });
  const workerKills = groups.reduce((sum, g) => sum + g.watchdogKills, 0);
  const hardWatchdogKills = groups.reduce((sum, g) => sum + g.hardWatchdogKills, 0);
  const contractMisses = groups.reduce((sum, g) => sum + g.contractMisses, 0);
  const excessiveWorkerKillGroups = groups
    .filter((g) => g.watchdogKills >= 3)
    .map((g) => g.blocker);
  const excessiveWorkerTimeGroups = groups
    .filter((g) => g.workerMs > 60 * 60 * 1000)
    .map((g) => g.blocker);
  const missingReflectionGroups = groups
    .filter((g) => g.status === 'cleared' && !g.reflectionPresent)
    .map((g) => g.blocker);
  const missingVerificationGroups = groups
    .filter((g) => g.status === 'cleared' && !g.verificationPresent)
    .map((g) => g.blocker);
  const missingTestsGroups = groups
    .filter((g) => g.status === 'cleared' && !g.testsPresent)
    .map((g) => g.blocker);
  const missingEvidenceGroups = groups
    .filter((g) => g.status !== 'cleared' && !g.evidencePresent)
    .map((g) => g.blocker);
  const landingFailedGroups = groups.filter((g) => g.landingFailed).map((g) => g.blocker);
  const deployFailedGroups = groups.filter((g) => g.deployFailed).map((g) => g.blocker);
  const falseClearGroups = [
    ...new Set(
      [
        ...clearedWorkerSurvivedGroups(blockers, results, postRepairDefects),
        ...clearedWorkerSurvivedGroups([], refreshOnlyResults, postRepairDefects),
      ].map((g) => g.blocker),
    ),
  ];
  const defects = [];
  if (hardWatchdogKills > 0) defects.push(`${hardWatchdogKills} hard watchdog kill(s)`);
  if (contractMisses > 0) defects.push(`${contractMisses} contract miss(es)`);
  if (excessiveWorkerKillGroups.length)
    defects.push(`${excessiveWorkerKillGroups.length} excessive-kill group(s)`);
  if (excessiveWorkerTimeGroups.length)
    defects.push(`${excessiveWorkerTimeGroups.length} >1h worker group(s)`);
  if (missingReflectionGroups.length)
    defects.push(`${missingReflectionGroups.length} cleared group(s) missing reflection`);
  if (missingVerificationGroups.length)
    defects.push(`${missingVerificationGroups.length} cleared group(s) missing verification`);
  if (missingTestsGroups.length)
    defects.push(`${missingTestsGroups.length} cleared group(s) missing tests`);
  if (missingEvidenceGroups.length)
    defects.push(`${missingEvidenceGroups.length} red group(s) missing worker evidence`);
  if (landingFailedGroups.length) defects.push(`${landingFailedGroups.length} landing conflict(s)`);
  if (deployFailedGroups.length) defects.push(`${deployFailedGroups.length} deploy failure(s)`);
  if (falseClearGroups.length) defects.push(`${falseClearGroups.length} false-clear group(s)`);
  if (newPostRepairDefectGroups.length) {
    defects.push(`${newPostRepairDefectGroups.length} new post-repair defect group(s)`);
  }
  return {
    status: defects.length ? 'red' : 'green',
    rawDefects,
    repairGroups: blockers.length,
    preRepairRawDefects: preRepairDefects.length,
    postRepairRawDefects: postRepairDefects.length,
    postRepairRegressed,
    postRepairDefectSwap,
    workerKills,
    hardWatchdogKills,
    contractMisses,
    excessiveWorkerKillGroups,
    excessiveWorkerTimeGroups,
    missingReflectionGroups,
    missingVerificationGroups,
    missingTestsGroups,
    missingEvidenceGroups,
    landingFailedGroups,
    deployFailedGroups,
    falseClearGroups,
    newPostRepairDefectGroups,
    newPostRepairCardGroups,
    checkpointCoverage: {
      liveDefect: rawDefects,
      repairResult: results.length + refreshOnlyResults.length,
      reflection: results.filter((r) => r && r.reflection).length,
      verification: results.filter((r) => r && r.verification).length,
      postRepairLiveDefect: postRepairDefects.length,
    },
    detail: defects.length
      ? defects.join('; ')
      : `clean: ${results.length}/${blockers.length} worker group(s) completed without watchdog defects`,
  };
}

// Mechanical pre-flight: when the briefing blocker maps to a tests-blocked
// signature, the heal-tests-repair module can fix some categories without
// any LLM call. Returns { repaired, cleared, actions } or null if nothing
// to do. cleared=true only when after-repair vitest re-run reports zero
// failures on the originally-failing files; we approximate by running the
// repair pass and then re-reading the heal-tests output to check whether
// the count dropped. Safe to call repeatedly.
function tryMechanicalRepair(blocker, opts = {}) {
  const title = String(blocker.title || '').toLowerCase();
  if (!title.includes('tests') && !title.includes('system health')) {
    return null;
  }
  const blockedPath = opts.blockedPath || path.join(REPO, 'data', 'agent', 'tests-blocked.json');
  let blocked;
  try {
    blocked = JSON.parse(fs.readFileSync(blockedPath, 'utf8'));
  } catch {
    return null;
  }
  if (!blocked || !Array.isArray(blocked.items) || blocked.items.length === 0) return null;
  let repair;
  try {
    repair = opts.repair || require('./heal-tests-repair.js');
  } catch {
    return null;
  }
  try {
    const rep = repair.runRepairPass(blocked, { dryRun: false, ...(opts.repairOptions || {}) });
    return {
      repaired: rep.repaired,
      cleared: rep.repaired >= blocked.items.length,
      actions: rep.actions || [],
    };
  } catch (e) {
    return {
      repaired: 0,
      cleared: false,
      actions: [{ error: String(e.message || e).slice(0, 240) }],
    };
  }
}

// Video blocker preflight: re-probe the manifest to check if "Stuck videos"
// blockers are still live. The briefing snapshot can be hours old; if a prior
// session cleaned the manifest the blocker is stale and burning an LLM session
// on it is pure waste (observed live 2026-06-16: all 3 blockers escalated
// repeatedly while the manifest was already clean).
// NOTE: "Video approval queue" blockers are handled separately by
// tryVideoApprovalQueueRepair, which dead-letters exhausted build-queue entries.
function tryVideoBlockerPreflight(blocker) {
  const title = String((blocker && blocker.title) || '').toLowerCase();
  if (!/stuck video|rejectedstuck/i.test(title)) return null;
  const manifestPath = path.join(REPO, 'content-review', 'pending', 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    // No manifest = nothing stuck (probe returns green when manifest is absent).
    return { cleared: true, repaired: 0, actions: [{ action: 'manifest absent, nothing stuck' }] };
  }
  const videos = Array.isArray(manifest && manifest.videos) ? manifest.videos : [];
  const stuck = videos.filter(
    (v) =>
      v &&
      !(v.regen_status === 'dead-letter' && !v.video_file) &&
      (v.video_needs_regen === true ||
        v.thumbnail_needs_regen === true ||
        /rejected/i.test(String(v.status || '')) ||
        ['failed', 'rubric_failed', 'dead-letter', 'hard_blocked'].includes(
          String(v.regen_status || ''),
        ) ||
        v.regen_hard_blocked === true ||
        v.regen_hard_block_reason),
  );
  if (stuck.length === 0) {
    return {
      cleared: true,
      repaired: 0,
      actions: [{ action: `manifest has ${videos.length} video(s), 0 stuck -- blocker is stale` }],
    };
  }
  return null; // still stuck, let the LLM session handle it
}

function videoApprovalBlockerText(blocker) {
  return [
    blocker && blocker.title,
    blocker && blocker.evidence,
    ...(Array.isArray(blocker && blocker.rawDefects) ? blocker.rawDefects : []),
  ]
    .filter(Boolean)
    .join(' ');
}

function candidateVideoManifestPaths(repoRoot, opts = {}) {
  return [
    opts.manifestPath,
    path.join(repoRoot, 'content-review', 'pending', 'manifest.json'),
    '/opt/secondbrain/content-review/pending/manifest.json',
  ]
    .filter(Boolean)
    .map((file) => path.resolve(String(file)));
}

function readJsonIfPresent(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function resolveVideoManifestForRepair(repoRoot, opts = {}) {
  const candidates = [...new Set(candidateVideoManifestPaths(repoRoot, opts))];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const manifest = readJsonIfPresent(file, null);
        if (manifest && Array.isArray(manifest.videos)) return { manifest, manifestPath: file };
      }
    } catch {
      /* try next */
    }
  }
  const first = candidates[0] || path.join(repoRoot, 'content-review', 'pending', 'manifest.json');
  return { manifest: { videos: [] }, manifestPath: first };
}

function pendingReviewDirForManifest(manifestPath) {
  return path.dirname(manifestPath);
}

function titleFromVideoArtifact(id, metadata = {}) {
  const direct =
    metadata.title ||
    metadata.video_title ||
    metadata.headline ||
    metadata.name ||
    metadata.topic ||
    metadata.short_title;
  if (direct) return String(direct).trim();
  return String(id || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

function findPendingVideoThumbnail(pendingDir, id) {
  const candidates = [
    `${id}_thumb.jpg`,
    `${id}_thumb.jpeg`,
    `${id}_thumb.png`,
    `${id}.jpg`,
    `${id}.jpeg`,
    `${id}.png`,
    `${id}_thumbnail.jpg`,
    `${id}_thumbnail.png`,
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(path.join(pendingDir, file))) return file;
    } catch {
      /* try next */
    }
  }
  return '';
}

function metadataForPendingVideo(pendingDir, id) {
  const candidates = [`${id}.json`, `${id}_metadata.json`, `${id}.metadata.json`];
  for (const file of candidates) {
    const json = readJsonIfPresent(path.join(pendingDir, file), null);
    if (json && typeof json === 'object') return json;
  }
  return {};
}

function rebuildVideoManifestFromPendingArtifacts(repoRoot, opts = {}) {
  const { manifest, manifestPath } = resolveVideoManifestForRepair(repoRoot, opts);
  const pendingDir = opts.pendingDir
    ? path.resolve(String(opts.pendingDir))
    : pendingReviewDirForManifest(manifestPath);
  let files = [];
  try {
    files = fs.readdirSync(pendingDir);
  } catch {
    return null;
  }
  const existingVideos = Array.isArray(manifest.videos) ? manifest.videos : [];
  const referenced = new Set();
  for (const video of existingVideos) {
    const id = String((video && video.id) || '').trim();
    const file = String((video && video.video_file) || '').trim();
    if (id) referenced.add(`${id}.mp4`.toLowerCase());
    if (file) referenced.add(path.basename(file).toLowerCase());
  }
  const recoveredAt = new Date().toISOString();
  const additions = [];
  for (const file of files.sort()) {
    if (!/\.(?:mp4|mov|webm|m4v)$/i.test(file)) continue;
    if (referenced.has(file.toLowerCase())) continue;
    const full = path.join(pendingDir, file);
    let stat = null;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const id = path.basename(file, path.extname(file));
    const metadata = metadataForPendingVideo(pendingDir, id);
    const generatedAt =
      metadata.generated_at ||
      metadata.created_at ||
      metadata.generatedDate ||
      new Date(stat.mtimeMs).toISOString();
    additions.push({
      id,
      title: titleFromVideoArtifact(id, metadata),
      status: 'pending_approval',
      video_file: file,
      thumbnail_file: findPendingVideoThumbnail(pendingDir, id) || undefined,
      channel: metadata.channel || metadata.target_channel || metadata.platform || undefined,
      generated_at: generatedAt,
      generated_date: String(generatedAt).slice(0, 10),
      recovered_from_pending_artifact: true,
      recovered_from_pending_artifact_at: recoveredAt,
      telegram_notified_at: recoveredAt,
      notification_suppressed_reason: 'manifest-recovered-from-existing-artifact',
    });
    referenced.add(file.toLowerCase());
  }
  if (!additions.length) return null;
  const nextManifest = {
    ...manifest,
    videos: [...existingVideos, ...additions],
    recovered_from_pending_artifacts_at: recoveredAt,
    recovered_from_pending_artifacts_count:
      Number(manifest.recovered_from_pending_artifacts_count || 0) + additions.length,
  };
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 2) + '\n', 'utf8');
  } catch (e) {
    return {
      repaired: 0,
      cleared: false,
      actions: [{ error: 'failed to write rebuilt manifest: ' + String(e.message).slice(0, 200) }],
    };
  }
  return {
    repaired: additions.length,
    cleared: true,
    actions: additions.map((video) => ({
      action: 'recovered pending video artifact into approval manifest',
      videoId: video.id,
      file: video.video_file,
    })),
    manifestPath,
  };
}

// Video approval queue repair: dead-letter build-queue entries whose retries are
// exhausted. The Video Approval card goes red when ec2-build-queue.json has
// videos with rejection_note whose prior-attempt context shows max attempts
// reached. These sit in the queue forever because no rebuild can succeed, and
// the orchestrator burns LLM sessions trying to "fix" them. Mechanical fix:
// move exhausted entries out of the active videos array and log them.
function tryVideoApprovalQueueRepair(blocker, opts = {}) {
  const text = videoApprovalBlockerText(blocker).toLowerCase();
  if (
    !/video[_\s-]?approval|video[_\s-]?manifest[_\s-]?drift|pending video files|content-review manifest/i.test(
      text,
    )
  )
    return null;

  const repoRoot = opts.repoRoot || REPO;
  const manifestRepair = rebuildVideoManifestFromPendingArtifacts(repoRoot, opts);
  if (manifestRepair) return manifestRepair;

  const queuePath = opts.queuePath || path.join(repoRoot, 'scripts', 'ec2-build-queue.json');
  let queue;
  try {
    queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  } catch {
    return null; // no queue file, nothing to repair
  }
  const videos = Array.isArray(queue.videos) ? queue.videos : [];
  if (videos.length === 0) return null;

  // Identify exhausted entries: rejection_note present AND either
  // (a) note contains "attempt 3/3" or higher max-attempt marker, or
  // (b) rejection is older than 14 days with no script (unregenerable).
  const EXHAUSTED_RE = /attempt\s+(\d+)\/(\d+)\s+at\s+/gi;
  const deadLettered = [];
  const surviving = [];
  for (const v of videos) {
    if (!v.rejection_note) {
      surviving.push(v);
      continue;
    }
    let maxed = false;
    const note = String(v.rejection_note);
    let m;
    EXHAUSTED_RE.lastIndex = 0;
    while ((m = EXHAUSTED_RE.exec(note))) {
      if (parseInt(m[1], 10) >= parseInt(m[2], 10)) {
        maxed = true;
        break;
      }
    }
    // Also dead-letter if script is empty (nothing to rebuild from)
    if (!maxed && !v.script) maxed = true;
    if (maxed) {
      deadLettered.push(v);
    } else {
      surviving.push(v);
    }
  }

  if (deadLettered.length === 0) return null;

  // Write dead-letter records to regen-failures.jsonl
  const failLogPath = path.join(repoRoot, 'data', 'agent', 'regen-failures.jsonl');
  try {
    for (const v of deadLettered) {
      fs.appendFileSync(
        failLogPath,
        JSON.stringify({
          ts: new Date().toISOString(),
          videoId: v.id,
          reason: 'exhausted-retries-dead-letter',
          rejection_note: String(v.rejection_note || '').slice(0, 500),
          source: 'video-approval-queue-preflight',
        }) + '\n',
      );
    }
  } catch {
    /* best effort */
  }

  // Update the queue
  queue.videos = surviving;
  try {
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + '\n', 'utf8');
  } catch (e) {
    return {
      repaired: 0,
      cleared: false,
      actions: [{ error: 'failed to write updated queue: ' + String(e.message).slice(0, 200) }],
    };
  }

  return {
    repaired: deadLettered.length,
    cleared: true,
    actions: deadLettered.map((v) => ({
      action: 'dead-lettered exhausted video from build queue',
      videoId: v.id,
    })),
  };
}

function actionArtifactRepairProof(artifact) {
  const review = (artifact && artifact.reviewWindow) || {};
  const verifier = review.replyVerifier || {};
  const stamps = [artifact && artifact.lastFullReviewAt, artifact && artifact.generatedAt]
    .map((ts) => (ts && ts !== 'never' ? new Date(ts).getTime() : NaN))
    .filter(Number.isFinite);
  const newest = stamps.length ? Math.max(...stamps) : NaN;
  const ageH = Number.isFinite(newest) ? (Date.now() - newest) / 3600000 : Infinity;
  const fresh = Number.isFinite(ageH) && ageH <= 24;
  const verifiedMs = Date.parse((artifact && artifact.lastReplyVerificationAt) || '');
  const replyVerified =
    verifier &&
    verifier.ok === true &&
    verifier.skipped !== true &&
    Number.isFinite(newest) &&
    Number.isFinite(verifiedMs) &&
    verifiedMs + 5 * 60000 >= newest;
  let integrityIssue = '';
  if (!fresh) integrityIssue = 'action-item artifact is not fresh';
  else if (!replyVerified) {
    integrityIssue =
      'action-item rebuild has no sent-mail reply-verification proof at or after the latest Gmail review';
  } else if (review.source === 'local-archive') {
    integrityIssue = 'action-item rebuild used local archive fallback instead of live Gmail proof';
  } else if (verifier.skipped) {
    integrityIssue = 'action-item rebuild skipped sent-mail reply verification';
  }
  return { fresh, replyVerified, integrityIssue };
}

// Action-items blocker preflight: when the blocker is "Fresh Gmail action items
// were not rebuilt", run regenerate-action-items.js mechanically instead of
// burning an LLM session. The script must produce a fresh artifact AND current
// sent-mail reply-verification proof. A fresh timestamp alone is not a clear:
// that exact false-clear leaves the live action_items tile red.
function tryActionItemsRepair(blocker, opts = {}) {
  const text = [
    blocker && blocker.title,
    blocker && blocker.evidence,
    ...(Array.isArray(blocker && blocker.rawDefects) ? blocker.rawDefects : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!/action[_\s-]?items?|action.item|gmail.action/i.test(text)) return null;

  const repoRoot = opts.repoRoot || REPO;
  const date = opts.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const scriptPath = path.join(repoRoot, 'scripts', 'regenerate-action-items.js');
  if (!fs.existsSync(scriptPath)) {
    return {
      repaired: 0,
      cleared: false,
      actions: [{ error: 'regenerate-action-items.js not found' }],
    };
  }

  const args = [scriptPath, '--date', date, '--limit', '300'];
  let result;
  try {
    const runner = opts.runner || require('child_process').execFileSync;
    const out = runner(process.execPath, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 240000,
      maxBuffer: 16 * 1024 * 1024,
    });
    result = JSON.parse(out);
  } catch (e) {
    return {
      repaired: 0,
      cleared: false,
      actions: [
        { error: 'regenerate-action-items.js failed: ' + String(e.message || e).slice(0, 200) },
      ],
    };
  }

  if (!result || !result.ok) {
    return {
      repaired: 0,
      cleared: false,
      actions: [{ action: 'regenerator returned not-ok', detail: result }],
    };
  }

  // Write heartbeat so the freshness gate sees a recent scan
  const heartbeatPath = path.join(repoRoot, 'data', 'agent', 'gmail-scan-heartbeat.jsonl');
  try {
    fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
    fs.appendFileSync(
      heartbeatPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        scanned: result.fetchedMessages || 0,
        amyEnqueued: 0,
        pplCandidates: 0,
        spineQueued: 0,
        source: 'action-items-preflight',
      }) + '\n',
    );
  } catch {
    /* best effort */
  }

  // Verify the same proof the renderer needs before the action_items tile can
  // stop being held. Fresh-but-unverified artifacts are still blockers.
  let proof = { fresh: false, replyVerified: false, integrityIssue: 'action artifact unreadable' };
  try {
    const artifact = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'data', 'briefing-action-items.json'), 'utf8'),
    );
    proof = actionArtifactRepairProof(artifact);
  } catch {
    /* verification failed */
  }
  const cleared = proof.fresh && proof.replyVerified && !proof.integrityIssue;

  return {
    repaired: cleared ? 1 : 0,
    cleared,
    actions: [
      {
        action: 'ran regenerate-action-items.js',
        source: result.source || 'ExampleCo',
        fetched: result.fetchedMessages,
        written: result.writtenItems,
        fresh: proof.fresh,
        replyVerified: proof.replyVerified,
        integrityIssue: proof.integrityIssue || undefined,
      },
    ],
  };
}

// Scheduled-task blockers already have a deterministic catch-up path in
// health-self-heal. Use it before spending a whole LLM session on "run the
// same cloud catch-up script and re-check the receipt ledger".
function tryScheduledTaskRepair(blocker, opts = {}) {
  const rawText = [
    blocker && blocker.title,
    blocker && blocker.evidence,
    blocker && blocker.repair,
    blocker && blocker.need,
  ]
    .filter(Boolean)
    .join(' ');
  const text = rawText.toLowerCase();
  if (!/\bscheduled tasks?\b/.test(text) && !/\bscheduled skill/.test(text)) {
    return null;
  }

  let health;
  try {
    health = opts.health || require('./health-self-heal.js');
  } catch (e) {
    return {
      repaired: 0,
      cleared: false,
      before: null,
      after: null,
      actions: [{ error: 'health-self-heal unavailable: ' + String(e.message || e).slice(0, 180) }],
    };
  }
  const probe = opts.probeScheduledSkillOutcomes || health.probeScheduledSkillOutcomes;
  const heal = opts.healScheduledSkills || health.healScheduledSkills;
  if (typeof probe !== 'function' || typeof heal !== 'function') {
    return {
      repaired: 0,
      cleared: false,
      before: null,
      after: null,
      actions: [{ error: 'scheduled task probe/heal functions unavailable' }],
    };
  }

  const probeOpts = { ...(opts.probeOptions || {}) };
  if (!probeOpts.date) {
    const dateMatch = rawText.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (dateMatch) probeOpts.date = dateMatch[1];
  }
  const before = probe(probeOpts);
  if (before && before.status === 'green') {
    return {
      repaired: 0,
      cleared: true,
      before,
      after: before,
      actions: [{ action: 'scheduled task receipts already green' }],
    };
  }
  const healResult = heal(before || {});
  const after = probe(probeOpts);
  const cleared = !!(after && after.status === 'green');
  const missingBefore =
    before && Array.isArray(before.missingSkills) ? before.missingSkills.length : 0;
  const failedBefore =
    before && Array.isArray(before.failedSkills) ? before.failedSkills.length : 0;
  const missingAfter = after && Array.isArray(after.missingSkills) ? after.missingSkills.length : 0;
  const failedAfter = after && Array.isArray(after.failedSkills) ? after.failedSkills.length : 0;
  return {
    repaired: Math.max(0, missingBefore + failedBefore - missingAfter - failedAfter),
    cleared,
    before,
    after,
    actions: [
      {
        action: healResult && healResult.action ? healResult.action : 'ran scheduled task catch-up',
        healed: !!(healResult && healResult.healed),
        durSec: healResult && healResult.durSec,
        exitCode: healResult && healResult.exitCode,
        blocker: healResult && healResult.blocker,
        after: after && after.detail,
      },
    ],
  };
}

// Run-mode flags. observe = report the heal plan, act on nothing. parallel = fan
// out heal sessions concurrently (safe now that session isolation landed; the git
// landing serializes). midday = no fixed deadline, run to completion (the attended
// mid-day heal, vs the deadline-bounded overnight run). Defaults preserve the legacy
// behavior (sequential, overnight deadline, acting) so an unflagged run is unchanged.
function parseRunMode(opts = {}) {
  const argv = Array.isArray(opts.argv) ? opts.argv : process.argv.slice(2);
  const env = opts.env || process.env;
  const has = (f) => argv.includes(f);
  const observe =
    !!opts.observe || has('--observe') || has('--dry-run') || env.SELFHEAL_OBSERVE === '1';
  const parallel = !!opts.parallel || has('--parallel') || env.SELFHEAL_PARALLEL === '1';
  const midday = !!opts.midday || has('--midday') || env.SELFHEAL_MIDDAY === '1';
  let concurrency = Number(opts.concurrency || env.SELFHEAL_CONCURRENCY || DEFAULT_CONCURRENCY);
  if (!Number.isFinite(concurrency) || concurrency < 1) concurrency = DEFAULT_CONCURRENCY;
  return { observe, parallel, midday, concurrency };
}

function modeLabel(mode) {
  return [
    mode.parallel ? `parallel(x${mode.concurrency})` : 'sequential',
    mode.midday ? 'midday(no-deadline)' : 'overnight(deadline)',
    mode.observe ? 'OBSERVE(no-act)' : 'ACT',
  ].join(' / ');
}

// The fix-the-fix guard (2026-06-15): the orchestrator announces its ACTUAL mode at
// startup, read from the flags, so a run can never be silently mislabeled. If
// someone calls a run "the new parallel architecture," the log row and stdout state
// whether it actually is parallel or still sequential.
function announceMode(mode, logRun, blockerCount) {
  const label = modeLabel(mode);
  logRun({
    stage: 'mode',
    mode: label,
    parallel: mode.parallel,
    midday: mode.midday,
    observe: mode.observe,
    concurrency: mode.concurrency,
    blockers: blockerCount,
  });
  try {
    console.log(`[orchestrator] MODE: ${label} | blockers=${blockerCount}`);
  } catch (e) {
    /* stdout optional */
  }
}

async function runOrchestrator(opts = {}) {
  const runLogPath = opts.runLogPath || RUNS_LOG_PATH;
  const argv = Array.isArray(opts.argv) ? opts.argv : process.argv.slice(2);
  const date = opts.date || parseDateArg(argv) || new Date().toISOString().slice(0, 10);
  const logRun = (row) => appendRunLog({ date, ...row }, runLogPath);
  const passNumber = Number(opts.passNumber || 1);
  const mode = opts.mode || parseRunMode(opts);
  // Checkpoint the START of this pass BEFORE any early return can skip it, so "no
  // checkpoint recorded" can only mean the process itself never launched (crashed
  // before this line, or was never invoked), never "it ran but had nothing to report".
  logExecutorCheckpoint(logRun, 'started', { pass: passNumber });
  const repairLoopHistoryLimit = Math.max(
    DEFAULT_NO_LIVE_REDUCTION_ATTEMPT_LIMIT,
    DEFAULT_NO_FRUIT_ATTEMPT_LIMIT,
    Number(opts.repairLoopNoFruitAttemptLimit || 0) || 0,
    Number(opts.repairLoopNoLiveReductionAttemptLimit || 0) || 0,
  );
  const repairLoopHistory = Array.isArray(opts.repairLoopHistory)
    ? opts.repairLoopHistory
    : loadPersistentRepairLoopHistory(runLogPath, {
        limit: repairLoopHistoryLimit,
        date,
        nowMs: opts.nowMs,
      });
  const briefingsDir = opts.briefingsDir || path.join(REPO, 'data', 'briefings');
  const inheritedRepairBlockers = Array.isArray(opts.extraBlockers) ? opts.extraBlockers : [];
  const inheritedFalseClearSelfHeal = inheritedRepairBlockers.some(isFalseClearSelfHealBlocker);
  const inheritedLandingConflictSelfHeal = inheritedRepairBlockers.some(
    isLandingConflictSelfHealBlocker,
  );
  const preRepairWatchdogBlockers = [];
  let briefingPath = opts.briefingPath;
  if (!briefingPath) {
    briefingPath = resolveLatestBriefingPath({ date, briefingsDir, nowMs: Date.now() });
  }
  let liveRenderQc = collectLiveRenderQcBlockers({ ...opts, date, repoRoot: REPO });
  logRun({
    stage: 'live-render-qc',
    status: liveRenderQc.status,
    retry: !!liveRenderQc.retry,
    skipped: !!liveRenderQc.skipped,
    rawDefects: (liveRenderQc.defects || []).length,
    blockerGroups: (liveRenderQc.blockers || []).length,
  });
  const preRepairRefreshEnabled =
    opts.preRepairPublishRefresh === true ||
    (opts.preRepairPublishRefresh == null && !mode.observe);
  if (preRepairRefreshEnabled && (liveRenderQc.defects || []).length) {
    const refreshPublished = opts.publishRefresh || refreshPublishedBriefingAfterHeal;
    const preRepairRefresh = await Promise.resolve(
      refreshPublished({
        date,
        appRoot: REPO,
        results: refreshResultsFromBlockers(liveRenderQc.blockers || []),
      }),
    );
    logRun({
      stage: 'pre-repair-publish-refresh',
      pass: passNumber,
      rawDefects: (liveRenderQc.defects || []).length,
      ok: !!(preRepairRefresh && preRepairRefresh.ok),
      skipped: !!(preRepairRefresh && preRepairRefresh.skipped),
      status: preRepairRefresh && preRepairRefresh.status,
      signal: preRepairRefresh && preRepairRefresh.signal,
      watchdog: preRepairRefresh && preRepairRefresh.watchdog,
      stderr_tail: String((preRepairRefresh && preRepairRefresh.stderr) || '').slice(-800),
    });
    if (preRepairRefresh && preRepairRefresh.watchdog && preRepairRefresh.watchdog.killed) {
      preRepairWatchdogBlockers.push(
        publishRefreshWatchdogRepairBlocker({
          phase: 'pre-repair publish refresh',
          refresh: preRepairRefresh,
          defectCount: (liveRenderQc.defects || []).length,
        }),
      );
    }
    liveRenderQc = await collectLiveRenderQcAfterSettle({
      ...opts,
      date,
      repoRoot: REPO,
      settle: !!(preRepairRefresh && preRepairRefresh.ok),
      beforeDefects: liveRenderQc.defects || [],
    });
    logRun({
      stage: 'pre-repair-live-render-qc',
      status: liveRenderQc.status,
      retry: !!liveRenderQc.retry,
      skipped: !!liveRenderQc.skipped,
      rawDefects: (liveRenderQc.defects || []).length,
      blockerGroups: (liveRenderQc.blockers || []).length,
      settle: liveRenderQc.settle || null,
      defects: (liveRenderQc.defects || []).slice(0, 25),
    });
  }
  if (!briefingPath && !(liveRenderQc.blockers || []).length) {
    logRun({
      stage: 'startup',
      error: 'no briefing found within 36h of ' + date + ' in ' + briefingsDir,
    });
    logExecutorCheckpoint(logRun, 'completed', {
      pass: passNumber,
      status: 'red',
      crash: 'no briefing file was found to read, so the pass stopped before it could run',
    });
    return { ok: false, cleared: 0, escalated: 0, error: 'briefing-not-found' };
  }
  let md = '';
  if (briefingPath) {
    try {
      md = fs.readFileSync(briefingPath, 'utf8');
    } catch (e) {
      if (!(liveRenderQc.blockers || []).length) {
        logRun({ stage: 'startup', error: 'briefing not readable at ' + briefingPath });
        logExecutorCheckpoint(logRun, 'completed', {
          pass: passNumber,
          status: 'red',
          crash:
            'the briefing file on disk could not be read, so the pass stopped before it could run',
        });
        return { ok: false, cleared: 0, escalated: 0, error: 'briefing-not-readable' };
      }
      logRun({
        stage: 'startup',
        warning: 'briefing not readable, using live render QC blockers',
        briefingPath,
      });
    }
  }
  logRun({ stage: 'startup', briefingPath });
  const parsedBlockerCandidates = parseBlockersFromMarkdown(md);
  const suppressParsedFalseClearSelfHeal = !!opts.suppressParsedFalseClearSelfHeal;
  const parsedFalseClearSelfHeal =
    !suppressParsedFalseClearSelfHeal && parsedBlockerCandidates.some(isFalseClearSelfHealBlocker);
  const activeFalseClearSelfHeal = inheritedFalseClearSelfHeal || parsedFalseClearSelfHeal;
  const parsedLandingConflictSelfHeal = parsedBlockerCandidates.some(
    isLandingConflictSelfHealBlocker,
  );
  const activeLandingConflictSelfHeal =
    inheritedLandingConflictSelfHeal ||
    (!activeFalseClearSelfHeal && parsedLandingConflictSelfHeal);
  const activeSelfHealMechanism = activeFalseClearSelfHeal || activeLandingConflictSelfHeal;
  // Phase 1 DELETE: the markdown BLOCKERS card is no longer a DEFECT SOURCE for this
  // loop. parseBlockersFromMarkdown is still parsed, but only its self-heal-MECHANISM
  // control rows (SELF-HEAL-FALSE-CLEAR / SELF-HEAL-LANDING that a prior pass wrote)
  // are honored here; generic card-defect rows from the markdown are dropped. Card
  // defects come exclusively from the live render-QC canonical source below.
  const parsedBlockers = activeSelfHealMechanism
    ? suppressParsedFalseClearSelfHeal
      ? []
      : parsedBlockerCandidates.filter((blocker) =>
          activeFalseClearSelfHeal
            ? isFalseClearSelfHealBlocker(blocker)
            : isLandingConflictSelfHealBlocker(blocker),
        )
    : parsedBlockerCandidates.filter(
        (blocker) =>
          !suppressParsedFalseClearSelfHeal &&
          (isFalseClearSelfHealBlocker(blocker) || isLandingConflictSelfHealBlocker(blocker)),
      );
  const liveRenderBlockers = activeSelfHealMechanism
    ? []
    : annotateKnownFalseClearPreflightBlockers(
        (liveRenderQc && liveRenderQc.blockers) || [],
        opts.knownFalseClearPreflightCards || [],
      );
  // CANONICAL DEFECT SOURCE (Phase 1, item 4): first-class Defect records keyed by
  // { card_id, defect_type } from the live render-QC verifier. This is the loop's
  // source of truth for card defects; the repair groups above are derived from the
  // same live defects, so the canonical list and the repair plan cannot diverge.
  const canonicalDefects = buildCanonicalDefects(liveRenderQc.defects || []);
  logRun({
    stage: 'canonical-defects',
    pass: passNumber,
    source: 'live-render-qc',
    count: canonicalDefects.length,
    defects: canonicalDefects.slice(0, 25).map((d) => d.key),
  });
  const rawBlockers = mergeBlockers([
    ...parsedBlockers,
    ...liveRenderBlockers,
    ...inheritedRepairBlockers,
    ...preRepairWatchdogBlockers,
  ]);
  const rawBlockerCount = rawDefectCountForBlockers(rawBlockers);
  const blockers = bundleRelatedRepairBlockers(rawBlockers);
  if (rawBlockers.length === 0) {
    logRun({ stage: 'startup', note: 'no blockers in briefing, nothing to heal' });
    // The healer DID run this pass, it just found nothing to fix. That is a healthy,
    // clean checkpoint, not "ExampleCo" -- a genuinely idle pass proves the executor works.
    logExecutorCheckpoint(logRun, 'completed', {
      pass: passNumber,
      status: 'green',
      attempted: 0,
      cleared: 0,
      escalated: 0,
    });
    return { ok: true, cleared: 0, escalated: 0 };
  }
  const maxPasses = resolveMaxPasses(opts);
  const preRepairLoopEntry = repairLoopEntryFromDefects(liveRenderQc.defects || [], passNumber);
  const preRepairLoopExhaustion = summarizeRepairLoopExhaustion(
    repairLoopHistory,
    preRepairLoopEntry,
    {
      windowSize: opts.repairLoopExhaustionWindow,
      noFruitAttemptLimit: opts.repairLoopNoFruitAttemptLimit,
      noLiveReductionAttemptLimit: opts.repairLoopNoLiveReductionAttemptLimit,
    },
  );
  if (preRepairLoopExhaustion.exhausted && !mode.observe) {
    const repairLoopExhaustionWindow = (preRepairLoopExhaustion.window || []).map((entry) => ({
      pass: entry.pass,
      rawDefects: entry.rawDefects,
      surfaceSignature: entry.surfaceSignature,
      groups: entry.groups,
    }));
    logRun({
      stage: 'self-heal-health',
      status: 'red',
      rawDefects: rawBlockerCount,
      repairGroups: blockers.length,
      preRepairRawDefects: rawBlockerCount,
      postRepairRawDefects: rawBlockerCount,
      repairLoopOptionsExhausted: true,
      repairLoopExhaustionReason: preRepairLoopExhaustion.reason,
      repairLoopExhaustionAttempts: preRepairLoopExhaustion.attempts || 0,
      repairLoopJudgment: preRepairLoopExhaustion.judgment || '',
      repairLoopExhaustionWindow,
      checkpointCoverage: {
        liveDefect: rawBlockerCount,
        repairResult: 0,
        postRepairLiveDefect: rawBlockerCount,
      },
      detail: 'repair loop options exhausted before worker wave',
    });
    logRun({
      stage: 'orchestrator-complete',
      pass: passNumber,
      cleared: 0,
      escalated: blockers.length,
      escalatedUnresolved: true,
      postRepairRawDefects: rawBlockerCount,
      totalBlockers: rawBlockerCount,
      repairGroups: blockers.length,
      repairLoopOptionsExhausted: true,
      repairLoopExhaustionReason: preRepairLoopExhaustion.reason,
      repairLoopExhaustionAttempts: preRepairLoopExhaustion.attempts || 0,
      repairLoopJudgment: preRepairLoopExhaustion.judgment || '',
      repairLoopExhaustionWindow,
    });
    if (mode.midday) {
      logRun({
        stage: 'midday-rerun-suppressed',
        pass: passNumber,
        reason: preRepairLoopExhaustion.reason,
        judgment: preRepairLoopExhaustion.judgment || '',
        survivingRawDefects: rawBlockerCount,
        repairLoopExhaustionWindow,
      });
    }
    logRun({
      stage: 'repair-loop-stopped',
      pass: passNumber,
      reason: preRepairLoopExhaustion.reason,
      maxPasses: maxPassesForLog(maxPasses),
      survivingRawDefects: rawBlockerCount,
      judgment: preRepairLoopExhaustion.judgment || '',
      mode: modeLabel(mode),
    });
    return {
      ok: false,
      escalated: true,
      pass: passNumber,
      maxPasses: maxPassesForLog(maxPasses),
      clearedCount: 0,
      escalatedCount: blockers.length,
      postRepairRawDefects: rawBlockerCount,
      postRepairDefects: (liveRenderQc.defects || []).slice(0, 25),
      cleared: 0,
      totalBlockers: rawBlockerCount,
      repairGroups: blockers.length,
      repairLoopOptionsExhausted: true,
      repairLoopExhaustionReason: preRepairLoopExhaustion.reason,
      repairLoopJudgment: preRepairLoopExhaustion.judgment || '',
    };
  }
  if (blockers.length !== rawBlockers.length || rawBlockerCount !== blockers.length) {
    logRun({
      stage: 'repair-bundle-plan',
      rawDefects: rawBlockerCount,
      rawGroups: rawBlockers.length,
      repairGroups: blockers.length,
      bundles: blockers
        .filter((b) => Array.isArray(b.bundledCards) && b.bundledCards.length)
        .map((b) => ({
          title: b.title,
          rawDefectCount: b.rawDefectCount || 0,
          cards: b.bundledCards,
          defectTypes: b.bundledDefectTypes || [],
        })),
    });
  }
  announceMode(mode, logRun, rawBlockerCount);
  // MODE-EQUIVALENCE PREFLIGHT (Phase 4a, item 5): before any spawn, assert the
  // overnight path and the attended/babysitter path read the SAME heal run-graph
  // (scripts/lib/briefing-heal-run-graph.json). A divergence means one path heals
  // differently than the other (split-brain), so we stop BEFORE spawning anything and
  // surface the divergence. Default-on: both paths resolve to the same authority graph,
  // so this passes silently; opts.modeEquivalence:false disables it, and the tests inject
  // divergent overnightStages/attendedStages to prove the guard fires.
  if (opts.modeEquivalence !== false) {
    const equivalence = (opts.assertModeEquivalence || assertModeEquivalence)({
      overnightStages: opts.overnightStages,
      attendedStages: opts.attendedStages,
    });
    if (!equivalence.ok) {
      logRun({
        stage: 'mode-equivalence-preflight',
        pass: passNumber,
        ok: false,
        divergence: equivalence.divergence,
        detail: 'overnight and attended heal paths read divergent run-graphs; no worker spawned',
      });
      logRun({
        stage: 'repair-loop-stopped',
        pass: passNumber,
        reason: 'mode-equivalence-divergence',
        mode: modeLabel(mode),
      });
      // This preflight runs before the cleared/escalated counters are declared (nothing
      // has run yet), so the counts are 0 + the unattempted blockers.
      return {
        ok: false,
        escalated: true,
        modeEquivalenceFailed: true,
        divergence: equivalence.divergence,
        pass: passNumber,
        cleared: 0,
        clearedCount: 0,
        escalatedCount: blockers.length,
        totalBlockers: rawBlockerCount,
        repairGroups: blockers.length,
      };
    }
    logRun({
      stage: 'mode-equivalence-preflight',
      pass: passNumber,
      ok: true,
      stages: equivalence.stages.length,
    });
  }
  // midday mode has no fixed deadline (run to completion); overnight keeps it.
  const deadlineMs = mode.midday
    ? null
    : parseDeadlineToTodayCt(
        opts.deadline || process.env.HEAL_TESTS_DEADLINE_CT || DEFAULT_DEADLINE_CT,
      );
  const perSessionBudgetMs = opts.budgetMs || DEFAULT_PER_SESSION_BUDGET_MS;
  const scheduledRepair = opts.scheduledRepair || tryScheduledTaskRepair;
  const mechanicalRepair = opts.mechanicalRepair || tryMechanicalRepair;
  const videoBlockerPreflight = opts.videoBlockerPreflight || tryVideoBlockerPreflight;
  const actionItemsRepair = opts.actionItemsRepair || tryActionItemsRepair;
  const videoApprovalRepair = opts.videoApprovalRepair || tryVideoApprovalQueueRepair;
  const runSession = opts.spawnSession || spawnSession;
  // SRE SPLIT DEADLINES + ERROR BUDGET (Phase 4a, item 6): overnight runs split the
  // total wall-clock into audit/repair/decide/read phases with a HARD budget. When a
  // phase budget is exhausted we publish a NAMED, EVIDENCED RED (from the per-defect
  // repair ledger) and NEVER retry past the deadline. midday/observe have no fixed clock
  // (run to completion), so the budget is overnight-only; opts.errorBudget overrides it.
  const errorBudget =
    opts.errorBudget ||
    (!mode.midday && !mode.observe && deadlineMs
      ? createBudget({
          totalBudgetMs: Math.max(60000, deadlineMs - Date.now()),
          startMs: opts.nowMs || Date.now(),
        })
      : null);
  // PER-DEFECT REPAIR LEDGER (Phase 4a, items 1-3): one row per defect attempt this
  // briefing day. ledgerOpts.dataDir is injectable so tests never touch the real store.
  // Mirrors shouldCollectLiveRenderQc/shouldRunAuthPreflight: under VITEST/test the
  // ledger is OFF by default (a real append to the shared default store would cross-
  // contaminate other tests) unless the caller explicitly enables it or injects a
  // dataDir; the new ledger tests drive the module directly and the orchestrator wiring
  // test opts in with an injected dataDir.
  const ledgerOpts = opts.repairLedgerOpts || {};
  const recordRepairLedger =
    opts.recordRepairLedger === true || (ledgerOpts && ledgerOpts.dataDir)
      ? true
      : opts.recordRepairLedger === false
        ? false
        : !(process.env.VITEST || process.env.NODE_ENV === 'test');
  let branchSummary = null;
  let cleared = 0;
  let escalated = 0;
  const refreshOnlyResults = [];

  // Phase 1 (sequential, fast, deterministic): classify ownership, run the
  // scheduled-task and mechanical pre-flights. These are quick and some mutate the
  // shared tree, so they stay sequential. Blockers that survive (still need an LLM
  // heal session) are collected for the phase-2 fan-out.
  const survivors = [];
  for (const blocker of blockers) {
    const ownership = classifyOwnership(blocker);
    if (!ownership.canAutoAttempt) {
      logRun({ stage: 'skip', blocker: blocker.title, reason: ownership.reason });
      escalated++;
      continue;
    }
    const isSelfHealHealthBlocker = blocker && blocker.source === 'self-heal-health';
    const isSelfHealMechanismBlocker =
      isSelfHealHealthBlocker ||
      isFalseClearSelfHealBlocker(blocker) ||
      isLandingConflictSelfHealBlocker(blocker);
    const bypassDeterministicPreflights = shouldBypassDeterministicPreflights(blocker);
    if (bypassDeterministicPreflights) {
      logRun({
        stage: 'deterministic-preflight-bypass',
        pass: passNumber,
        blocker: blocker.title,
        reason: 'known-false-clear-preflight',
        cards: blocker.knownFalseClearCards || [],
      });
    }
    // Video blocker preflight is read-only: re-probe the manifest to detect stale
    // blockers whose underlying issue was already resolved by a prior session or
    // manual fix. It is safe even in observe mode and prevents dry-run plans from
    // repeatedly scheduling useless video sessions against already-clean state.
    if (!isSelfHealMechanismBlocker && !bypassDeterministicPreflights) {
      const videoPreflight = videoBlockerPreflight(blocker);
      if (videoPreflight && videoPreflight.cleared) {
        logRun({
          stage: 'video-preflight',
          blocker: blocker.title,
          actions: videoPreflight.actions || [],
          status: 'cleared',
        });
        cleared++;
        continue;
      }
    }
    // Action-items preflight: rebuild the Gmail action-item artifact mechanically
    // instead of burning an LLM session. Acts (runs the regenerator), so it goes
    // after observe-safe checks but before the observe gate for non-observe runs.
    // In observe mode the regenerator must NOT run (it writes files).
    if (!mode.observe && !isSelfHealMechanismBlocker && !bypassDeterministicPreflights) {
      const actionPreflight = actionItemsRepair(blocker, { repoRoot: REPO });
      if (actionPreflight && actionPreflight.cleared) {
        const actionPreflightRawDefects = Array.isArray(blocker.rawDefects)
          ? blocker.rawDefects
          : [];
        const actionPreflightEvidence = blocker.evidence || '';
        const actionPreflightClue = [...actionPreflightRawDefects, actionPreflightEvidence].join(
          ' ',
        );
        const actionPreflightBlockerId = /\bBLOCKED-TILE:\s*system_health\b/i.test(
          actionPreflightClue,
        )
          ? 'system_health'
          : blocker.blocker_id || blocker.blockerId || 'action_items';
        logRun({
          stage: 'action-items-preflight',
          blocker: blocker.title,
          actions: actionPreflight.actions || [],
          status: 'cleared',
        });
        refreshOnlyResults.push({
          status: 'cleared',
          blockerTitle: blocker.title,
          blockerId: actionPreflightBlockerId,
          rawDefectCount: Number(blocker.rawDefectCount || 0),
          rawDefects: actionPreflightRawDefects,
          evidence: actionPreflightEvidence,
          pushed: false,
          refreshOnly: true,
          source: 'action-items-preflight',
        });
        cleared++;
        continue;
      }
      if (actionPreflight && !actionPreflight.cleared && actionPreflight.actions) {
        logRun({
          stage: 'action-items-preflight',
          blocker: blocker.title,
          actions: actionPreflight.actions,
          status: 'partial',
        });
      }
    }
    // Video approval queue repair: dead-letter exhausted-retry videos from the
    // build queue. Acts (writes ec2-build-queue.json), so non-observe only.
    if (!mode.observe && !isSelfHealMechanismBlocker && !bypassDeterministicPreflights) {
      const videoApproval = videoApprovalRepair(blocker, { repoRoot: REPO });
      if (videoApproval && videoApproval.cleared) {
        logRun({
          stage: 'video-approval-queue-repair',
          blocker: blocker.title,
          repaired: videoApproval.repaired,
          actions: (videoApproval.actions || []).slice(0, 10),
          status: 'cleared',
        });
        refreshOnlyResults.push({
          status: 'cleared',
          blockerTitle: blocker.title,
          blockerId: 'video_approval_queue',
          rawDefectCount: Number(blocker.rawDefectCount || 0),
          rawDefects: Array.isArray(blocker.rawDefects) ? blocker.rawDefects : [],
          evidence: blocker.evidence || '',
          pushed: false,
          refreshOnly: true,
          source: 'video-approval-queue-preflight',
        });
        cleared++;
        continue;
      }
      if (videoApproval && !videoApproval.cleared && videoApproval.actions) {
        logRun({
          stage: 'video-approval-queue-repair',
          blocker: blocker.title,
          actions: videoApproval.actions,
          status: 'partial',
        });
      }
    }
    // Observe mode is otherwise strictly zero-side-effect: classify ownership and
    // run only the read-only video stale check above, never the acting pre-flights
    // (scheduled-task catch-up, mechanical file edits). Every remaining
    // auto-attemptable blocker is reported as a planned heal.
    if (mode.observe) {
      survivors.push(blocker);
      continue;
    }
    if (!isSelfHealMechanismBlocker && !bypassDeterministicPreflights) {
      const scheduledPreflight = scheduledRepair(blocker, opts.scheduledRepairOptions || {});
      if (scheduledPreflight && scheduledPreflight.cleared) {
        const actions = Array.isArray(scheduledPreflight.actions) ? scheduledPreflight.actions : [];
        logRun({
          stage: 'scheduled-task-repair',
          blocker: blocker.title,
          repaired: scheduledPreflight.repaired,
          actions: actions.slice(0, 5),
          status: 'cleared',
        });
        cleared++;
        continue;
      }
      if (scheduledPreflight && !scheduledPreflight.cleared) {
        const actions = Array.isArray(scheduledPreflight.actions) ? scheduledPreflight.actions : [];
        logRun({
          stage: 'scheduled-task-repair',
          blocker: blocker.title,
          repaired: scheduledPreflight.repaired,
          actions: actions.slice(0, 5),
          status: 'partial',
        });
      }
      const preflight = mechanicalRepair(blocker, opts.mechanicalRepairOptions || {});
      if (preflight && preflight.cleared) {
        logRun({
          stage: 'mechanical-repair',
          blocker: blocker.title,
          repaired: preflight.repaired,
          actions: preflight.actions.slice(0, 5),
          status: 'cleared',
        });
        cleared++;
        continue;
      }
      if (preflight && preflight.repaired > 0) {
        logRun({
          stage: 'mechanical-repair',
          blocker: blocker.title,
          repaired: preflight.repaired,
          actions: preflight.actions.slice(0, 5),
          status: 'partial',
        });
      }
    }
    survivors.push(blocker);
  }

  // Observe mode: report the heal PLAN (which survivors would get an LLM session and
  // whether they run in parallel) and act on nothing. Zero side effects; safe to run
  // any time to see exactly what the heal would do.
  if (mode.observe) {
    logRun({
      stage: 'observe-plan',
      mode: modeLabel(mode),
      clearedByPreflight: cleared,
      escalated,
      sessionsPlanned: survivors.length,
      sessions: survivors.map((b) => b.title),
      concurrency: mode.parallel ? mode.concurrency : 1,
    });
    return {
      ok: true,
      observe: true,
      cleared,
      escalated,
      sessionsPlanned: survivors.length,
      mode: modeLabel(mode),
      totalBlockers: rawBlockerCount,
      repairGroups: blockers.length,
    };
  }

  // Pre-spawn auth preflight: never fan out heal workers into a known-dead auth
  // state. One cheap authenticated probe, one forced token refresh, one re-probe.
  // If auth is still dead, surface exactly one named System Health defect and stop
  // cleanly instead of spawning N sessions that each hit "API Error: 401".
  if (survivors.length > 0 && shouldRunAuthPreflight(opts)) {
    const authPreflight = await preflightHealAuth({
      authProbe: opts.authProbe,
      tokenRefresh: opts.tokenRefresh,
      repoRoot: opts.repoRoot,
      tokenPath: opts.authProbeTokenPath,
    });
    if (!authPreflight.ok) {
      // EXECUTOR-HEALTH -> SYSTEM HEALTH (Phase 4a, item 4): convert THIS single
      // preflight result into ONE named System Health row (executor health), not N card
      // defects or a 12-session cascade. quota/latency, when cheaply observed by the
      // probe, collapse into the same one row.
      const executorRow = executorHealthRow(authPreflight, opts.executorHealthSignals || {});
      logRun({
        stage: 'system-health-row',
        pass: passNumber,
        source: 'executor-health',
        label: executorRow.label,
        status: executorRow.status,
        detail: executorRow.detail,
        runbook: executorRow.runbook,
      });
      logRun({
        stage: 'self-heal-health',
        status: 'red',
        pass: passNumber,
        authFailed: true,
        probeDetail: authPreflight.probeDetail || '',
        refreshDetail: authPreflight.refreshDetail || '',
        plannedSessions: survivors.length,
        executorHealthRow: executorRow,
        detail: 'pre-spawn Claude auth probe failed; worker fan-out suppressed',
      });
      // Persist the single named auth-failed DEFECT to the same run-log JSONL the
      // briefing reads, so it survives this session and surfaces on the dashboard as a
      // named System Health defect, not just an in-memory return value.
      logRun({
        stage: 'self-heal-defect',
        status: 'red',
        pass: passNumber,
        source: 'self-heal-health',
        defectType: 'SELF-HEAL-AUTH-FAILED',
        title:
          (authPreflight.blocker && authPreflight.blocker.title) ||
          'Self-Heal Executor: auth failed',
        owner: (authPreflight.blocker && authPreflight.blocker.owner) || 'ExampleCo',
        evidence: (authPreflight.blocker && authPreflight.blocker.evidence) || '',
        repair: (authPreflight.blocker && authPreflight.blocker.repair) || '',
        need: (authPreflight.blocker && authPreflight.blocker.need) || '',
        rawDefects: (authPreflight.blocker && authPreflight.blocker.rawDefects) || [
          'SELF-HEAL-AUTH-FAILED: pre-spawn Claude auth probe and forced refresh both failed',
        ],
      });
      logRun({
        stage: 'repair-loop-stopped',
        pass: passNumber,
        reason: 'self-heal-executor-auth-failed',
        plannedSessions: survivors.length,
        mode: modeLabel(mode),
      });
      logExecutorCheckpoint(logRun, 'completed', {
        pass: passNumber,
        status: 'red',
        crash: `the executor's own pre-spawn auth check failed (${clampCheckpointDetail(
          authPreflight.probeDetail || 'auth probe failed',
        )}), so no repair workers were started`,
        attempted: 0,
        cleared,
        escalated: escalated + survivors.length,
      });
      logRun({
        stage: 'orchestrator-complete',
        pass: passNumber,
        cleared,
        escalated: escalated + survivors.length,
        escalatedUnresolved: true,
        authFailed: true,
        plannedSessions: survivors.length,
        repairGroups: blockers.length,
      });
      return {
        ok: false,
        escalated: true,
        authFailed: true,
        pass: passNumber,
        cleared,
        clearedCount: cleared,
        escalatedCount: escalated + survivors.length,
        plannedSessions: survivors.length,
        authBlocker: authPreflight.blocker,
        executorHealthRow: executorHealthRow(authPreflight, opts.executorHealthSignals || {}),
        totalBlockers: rawBlockerCount,
        repairGroups: blockers.length,
      };
    }
    logRun({
      stage: 'self-heal-auth-preflight',
      pass: passNumber,
      ok: true,
      probe: authPreflight.probe,
      refreshed: !!authPreflight.refreshed,
    });
  }

  // Phase 2: one LLM heal session per survivor. The git landing inside each session
  // serializes through this one serializer so two heals never push at once, even
  // when their WORK runs concurrently.
  const serialize = createSerializer();
  let gitRepo = null;
  const runOneSession = async (blocker, uniq) => {
    if (!gitRepo) gitRepo = opts.repoRoot || getCoordinatorRepoRoot(REPO);
    if (!branchSummary) branchSummary = gitBranchSummary(gitRepo);
    const sessionUniq = `p${passNumber}-${uniq}`;
    const deadlineIso = new Date(
      Math.min(deadlineMs || Date.now() + perSessionBudgetMs, Date.now() + perSessionBudgetMs),
    ).toISOString();
    const result = await runSession(blocker, {
      repoRoot: gitRepo,
      dependencyRoot: REPO,
      afterPush:
        opts.afterPush || ((info) => deployChangedFilesFromWorktree({ ...info, appRoot: REPO })),
      deadlineIso,
      branchSummary,
      budgetMs: deadlineMs
        ? Math.min(perSessionBudgetMs, deadlineMs - Date.now())
        : perSessionBudgetMs,
      serialize,
      parallel: mode.parallel,
      uniq: sessionUniq,
    });
    logRun({
      stage: 'session-complete',
      blocker: blocker.title,
      status: result.status,
      commit_sha: result.commit_sha || '',
      pushed: !!result.pushed,
      verification: result.verification || '',
      tests: result.tests || '',
      reflection: result.reflection || '',
      deploy: result.deploy || null,
      escalation_reason: result.escalationReason || '',
      attempts: result.attempts || [],
      session_log: result.sessionLogPath || '',
      worker_ms: Array.isArray(result.attempts)
        ? result.attempts.reduce((sum, a) => sum + Number((a && a.durationMs) || 0), 0)
        : 0,
      watchdog_kills: Array.isArray(result.attempts)
        ? result.attempts.filter((a) => a && a.watchdog && a.watchdog.killed).length
        : 0,
      // 2026-05-28 #gap: capture stderr tail on escalation so the morning
      // investigator can see what actually happened in the session env.
      stdout_tail: result.status === 'escalated' ? (result.stdoutTail || '').slice(-1500) : '',
      stderr_tail: result.status === 'escalated' ? (result.stderrTail || '').slice(-1500) : '',
    });
    return {
      ...result,
      blockerTitle: blocker.title,
      blockerId: blocker.blocker_id || blocker.blockerId || '',
      rawDefects: Array.isArray(blocker.rawDefects) ? blocker.rawDefects : [],
      // Carry the heal-tactic identity onto the result so the per-defect repair ledger
      // (Phase 4a item 1) records the exact { defect, tactic, tacticInputHash }.
      healDefectKey: blocker.__healDefectKey || '',
      healTactic: blocker.__healTactic || blocker.repair || blocker.title || '',
      healTacticInputHash: blocker.__healTacticInputHash || '',
    };
  };

  // SRE ERROR-BUDGET REPAIR-PHASE GATE (Phase 4a, item 6): if the repair phase is
  // already exhausted before we spawn, do NOT spawn; publish the named, evidenced RED
  // from the per-defect repair ledger and stop. Never retry past the deadline.
  if (errorBudget) {
    const repairGate = phaseExhausted(errorBudget, 'repair', opts.nowMs || Date.now());
    if (repairGate.exhausted) {
      const red = budgetExhaustedRed({
        phase: 'repair',
        budget: errorBudget,
        nowMs: opts.nowMs || Date.now(),
        // Hermeticity (Phase 4a Codex HOLD #4): read the per-defect ledger only when
        // recording is active (prod, or a test that injected a temp dataDir). Under
        // test-mode-without-dataDir recordRepairLedger is false, so default to [] here
        // too; the RED still publishes (the "no per-defect ledger rows" branch) without
        // touching the shared default store.
        openDefects: recordRepairLedger ? repairLedger.openDefects(date, ledgerOpts) : [],
      });
      logRun({
        stage: 'system-health-row',
        pass: passNumber,
        source: 'error-budget',
        label: red.row.label,
        status: red.row.status,
        detail: red.row.detail,
        runbook: red.row.runbook,
      });
      logRun({
        stage: 'self-heal-health',
        status: 'red',
        pass: passNumber,
        errorBudgetExhausted: true,
        phase: 'repair',
        detail: red.row.detail,
      });
      logRun({
        stage: 'repair-loop-stopped',
        pass: passNumber,
        reason: 'error-budget-exhausted',
        phase: 'repair',
        mode: modeLabel(mode),
      });
      return {
        ok: false,
        escalated: true,
        errorBudgetExhausted: true,
        budgetExhaustedPhase: 'repair',
        budgetRed: red,
        pass: passNumber,
        cleared,
        clearedCount: cleared,
        escalatedCount: escalated + survivors.length,
        totalBlockers: rawBlockerCount,
        repairGroups: blockers.length,
      };
    }
  }

  // NO-REPEAT TACTIC (Phase 4a, item 2): before dispatching a survivor, read the
  // per-defect repair ledger. If the SAME tactic (the blocker repair plan) + SAME input
  // hash already FAILED on the prior attempt for this defect, do NOT re-run that identical
  // move; escalate it as "tactic exhausted" and drop it from the wave. A different tactic,
  // a different input, or a prior clear lets it through.
  const dispatchSurvivors = [];
  for (const blocker of survivors) {
    const defect = blocker.defectKey || blocker.blocker_id || blocker.blockerId || blocker.title;
    const tactic = blocker.repair || blocker.title;
    const inputHash = repairLedger.hashTacticInput({
      evidence: blocker.evidence || '',
      rawDefects: Array.isArray(blocker.rawDefects) ? blocker.rawDefects : [],
    });
    blocker.__healDefectKey = repairLedger.defectKey(defect);
    blocker.__healTactic = tactic;
    blocker.__healTacticInputHash = inputHash;
    if (
      recordRepairLedger &&
      repairLedger.tacticAlreadyFailed(date, defect, tactic, inputHash, ledgerOpts)
    ) {
      logRun({
        stage: 'no-repeat-tactic',
        pass: passNumber,
        blocker: blocker.title,
        defect: blocker.__healDefectKey,
        reason: repairLedger.tacticExhaustedReason(defect, tactic),
        status: 'escalated',
      });
      escalated++;
      continue;
    }
    dispatchSurvivors.push(blocker);
  }

  let results = [];
  if (mode.parallel) {
    // Fan out: independent heal sessions run concurrently (bounded); each session's
    // git landing serializes via the shared serializer. No per-blocker deadline gate
    // in parallel mode (the mid-day heal has no fixed timer).
    results = await runHeals(dispatchSurvivors, runOneSession, { concurrency: mode.concurrency });
  } else {
    // Sequential legacy (overnight): one session at a time, deadline-gated.
    for (let i = 0; i < dispatchSurvivors.length; i++) {
      const blocker = dispatchSurvivors[i];
      if (deadlineMs && shouldRespectDeadline(Date.now(), deadlineMs, perSessionBudgetMs)) {
        logRun({ stage: 'deadline', blocker: blocker.title, remainingMs: deadlineMs - Date.now() });
        escalated++;
        continue;
      }
      results.push(await runOneSession(blocker, i));
    }
  }
  for (const r of results) {
    if (r && r.status === 'cleared') cleared++;
    else escalated++;
  }
  const pushedResults = results.filter((r) => r && r.pushed);
  const refreshResults = [...pushedResults, ...refreshOnlyResults];
  let publishRefresh = null;
  if (refreshResults.length > 0) {
    const refreshPublished = opts.publishRefresh || refreshPublishedBriefingAfterHeal;
    publishRefresh = refreshPublished({ date, appRoot: REPO, results: refreshResults });
    logRun({
      stage: 'post-repair-publish-refresh',
      pass: passNumber,
      pushedCommits: pushedResults.length,
      refreshOnlyRepairs: refreshOnlyResults.length,
      ok: !!(publishRefresh && publishRefresh.ok),
      skipped: !!(publishRefresh && publishRefresh.skipped),
      status: publishRefresh && publishRefresh.status,
      signal: publishRefresh && publishRefresh.signal,
      watchdog: publishRefresh && publishRefresh.watchdog,
      reason: publishRefresh && publishRefresh.reason,
      stderr_tail: String((publishRefresh && publishRefresh.stderr) || '').slice(-800),
    });
  }
  const postRepairLiveRenderQc = await collectLiveRenderQcAfterSettle({
    ...opts,
    date,
    repoRoot: REPO,
    settle: refreshResults.length > 0 && publishRefresh && publishRefresh.ok,
    beforeDefects: liveRenderQc.defects || [],
  });
  const postRepairRawDefects = (postRepairLiveRenderQc.defects || []).length;
  const preWorkerLiveDefects = liveRenderQc.defects || [];
  // PER-WORKER LIVE-QC GATE (Phase 1, item 2): a worker that self-reported cleared but
  // whose defect group(s) still appear in the authenticated post-repair live QC did NOT
  // clear its defect. Make the reported COUNT honest (it is not counted cleared) and RECORD
  // the survivor; r.status is deliberately LEFT so the wave-level false-clear machinery
  // (summarizeSelfHealHealth -> falseClearGroups) still fires and re-plans the card. No
  // reduction => the card stays red, never reported cleared.
  // The cleared/escalated tally above ran before post-repair live QC existed, so adjust
  // the counts for every worker this gate finds still-red (cleared-- / escalated++).
  for (const r of results) {
    if (!r || r.status !== 'cleared') continue;
    const gate = workerLiveQcCleared(r, postRepairLiveRenderQc.defects || []);
    if (!gate.cleared) {
      r.liveQcGateSurvived = true;
      r.liveQcGateSurvivedKeys = gate.survivedKeys;
      cleared = Math.max(0, cleared - 1);
      escalated += 1;
      logRun({
        stage: 'per-worker-live-qc-gate',
        pass: passNumber,
        blocker: r.blockerTitle || '',
        survivedKeys: gate.survivedKeys,
        status: 'survived',
      });
    }
  }
  // PER-DEFECT REPAIR LEDGER (Phase 4a, item 1): write one row per worker result for
  // THIS defect, now that the authenticated post-repair live QC has decided cleared vs
  // survived. qcResult drives the no-repeat guard (item 2) and openDefects/Blockers
  // (item 3) on the next pass. Best-effort: a ledger write must never wedge the loop.
  if (recordRepairLedger) {
    for (const r of results) {
      if (!r || !r.healDefectKey) continue;
      const qcResult =
        r.status === 'cleared' && !r.liveQcGateSurvived
          ? 'cleared'
          : r.status === 'cleared'
            ? 'survived'
            : r.status === 'escalated'
              ? 'escalated'
              : 'failed';
      try {
        repairLedger.recordAttempt(
          date,
          {
            defect: r.healDefectKey,
            tactic: r.healTactic,
            tacticInputHash: r.healTacticInputHash,
            fix: r.verification || r.tests || '',
            qcResult,
            reflection: r.reflection || r.escalationReason || '',
            deployedHash: r.commit_sha || '',
          },
          ledgerOpts,
        );
      } catch (e) {
        logRun({
          stage: 'repair-ledger-write-failed',
          pass: passNumber,
          defect: r.healDefectKey,
          error: String((e && e.message) || e).slice(0, 200),
        });
      }
    }
  }
  const repairLoopEntry = repairLoopEntryFromDefects(
    postRepairLiveRenderQc.defects || [],
    passNumber,
  );
  const repairLoopExhaustion = summarizeRepairLoopExhaustion(repairLoopHistory, repairLoopEntry, {
    windowSize: opts.repairLoopExhaustionWindow,
    noFruitAttemptLimit: opts.repairLoopNoFruitAttemptLimit,
    noLiveReductionAttemptLimit: opts.repairLoopNoLiveReductionAttemptLimit,
  });
  const postRepairNewDefectGroups = newDefectGroups(
    preWorkerLiveDefects,
    postRepairLiveRenderQc.defects || [],
  );
  const postRepairNewCardGroups = newCardDefectGroups(
    preWorkerLiveDefects,
    postRepairNewDefectGroups,
  );
  const postRepairDefectSwap = isPostRepairDefectSwap({
    beforeDefects: preWorkerLiveDefects,
    afterDefects: postRepairLiveRenderQc.defects || [],
    newCardGroups: postRepairNewCardGroups,
  });
  const postRepairRegressed = isPostRepairRegression({
    beforeDefects: preWorkerLiveDefects,
    afterDefects: postRepairLiveRenderQc.defects || [],
    newCardGroups: postRepairNewCardGroups,
    postRepairDefectSwap,
  });
  logRun({
    stage: 'post-repair-live-render-qc',
    status: postRepairLiveRenderQc.status,
    retry: !!postRepairLiveRenderQc.retry,
    skipped: !!postRepairLiveRenderQc.skipped,
    rawDefects: postRepairRawDefects,
    blockerGroups: (postRepairLiveRenderQc.blockers || []).length,
    settle: postRepairLiveRenderQc.settle || null,
    defects: (postRepairLiveRenderQc.defects || []).slice(0, 25),
  });
  const selfHealHealth = summarizeSelfHealHealth(survivors, results, {
    preRepairDefects: preWorkerLiveDefects,
    postRepairDefects: postRepairLiveRenderQc.defects || [],
    refreshOnlyResults,
  });
  if (publishRefresh && publishRefresh.watchdog && publishRefresh.watchdog.killed) {
    selfHealHealth.status = 'red';
    selfHealHealth.publishRefreshWatchdogKills =
      (selfHealHealth.publishRefreshWatchdogKills || 0) + 1;
    selfHealHealth.detail = selfHealHealth.detail
      ? `${selfHealHealth.detail}; 1 publish-refresh watchdog kill`
      : '1 publish-refresh watchdog kill';
  }
  if (repairLoopExhaustion.exhausted) {
    selfHealHealth.status = 'red';
    selfHealHealth.repairLoopOptionsExhausted = true;
    selfHealHealth.repairLoopExhaustionReason = repairLoopExhaustion.reason;
    selfHealHealth.repairLoopExhaustionAttempts = repairLoopExhaustion.attempts || 0;
    selfHealHealth.repairLoopJudgment = repairLoopExhaustion.judgment || '';
    selfHealHealth.repairLoopExhaustionWindow = (repairLoopExhaustion.window || []).map(
      (entry) => ({
        pass: entry.pass,
        rawDefects: entry.rawDefects,
        surfaceSignature: entry.surfaceSignature,
        groups: entry.groups,
      }),
    );
    selfHealHealth.detail = selfHealHealth.detail
      ? `${selfHealHealth.detail}; repair loop options exhausted`
      : 'repair loop options exhausted';
  }
  const publishRefreshWatchdogKilled = !!(
    publishRefresh &&
    publishRefresh.watchdog &&
    publishRefresh.watchdog.killed
  );
  const shouldEscalateFalseClearToSelfHeal =
    !mode.observe &&
    !publishRefreshWatchdogKilled &&
    postRepairRawDefects > 0 &&
    Array.isArray(selfHealHealth.falseClearGroups) &&
    selfHealHealth.falseClearGroups.length > 0 &&
    !activeFalseClearSelfHeal;
  if (shouldEscalateFalseClearToSelfHeal) {
    logRun({
      stage: 'false-clear-self-heal-escalation',
      pass: passNumber,
      falseClearGroups: selfHealHealth.falseClearGroups,
      survivingRawDefects: postRepairRawDefects,
      reason: repairLoopExhaustion.reason,
    });
  }
  // False-clear gets one verifier/self-heal pass. If authenticated live QC is
  // still red after that, retry the underlying rendered card lanes with
  // preflight bypassed instead of camping on proof-contract repairs.
  const falseClearSelfHealAttempted =
    activeFalseClearSelfHeal && postRepairRawDefects > 0 && !shouldEscalateFalseClearToSelfHeal;
  // liveRenderQc is reassigned after a pre-repair refresh, so this compares the
  // post-worker page to the defects the workers actually received.
  const unchangedAfterWorkerWave =
    defectSignature(postRepairLiveRenderQc.defects || []) ===
    defectSignature(liveRenderQc.defects || []);
  const repeatedContractMissWave =
    pushedResults.length === 0 &&
    results.length > 0 &&
    allSessionFailuresAreContractMisses(results) &&
    unchangedAfterWorkerWave;
  const inheritedWorkerContractSelfHeal = inheritedRepairBlockers.some((blocker) =>
    /SELF-HEAL-WORKER-CONTRACT|worker watchdog and contract/i.test(
      `${(blocker && blocker.title) || ''} ${(blocker && blocker.evidence) || ''}`,
    ),
  );
  const shouldEscalateLandingConflictToSelfHeal =
    !mode.observe &&
    postRepairRawDefects > 0 &&
    !inheritedLandingConflictSelfHeal &&
    Array.isArray(selfHealHealth.landingFailedGroups) &&
    selfHealHealth.landingFailedGroups.length > 0;
  if (shouldEscalateLandingConflictToSelfHeal) {
    selfHealHealth.status = 'red';
    selfHealHealth.landingConflictSelfHealEscalation = true;
    selfHealHealth.detail = selfHealHealth.detail
      ? `${selfHealHealth.detail}; landing conflict self-heal required`
      : 'landing conflict self-heal required';
    logRun({
      stage: 'landing-conflict-self-heal-escalation',
      pass: passNumber,
      landingFailedGroups: selfHealHealth.landingFailedGroups,
      survivingRawDefects: postRepairRawDefects,
    });
  }
  const shouldEscalateWorkerContractToSelfHeal =
    mode.midday &&
    !mode.observe &&
    postRepairRawDefects > 0 &&
    !inheritedWorkerContractSelfHeal &&
    (repeatedContractMissWave ||
      Number(selfHealHealth.hardWatchdogKills || 0) > 0 ||
      (Array.isArray(selfHealHealth.excessiveWorkerKillGroups) &&
        selfHealHealth.excessiveWorkerKillGroups.length > 0) ||
      (Array.isArray(selfHealHealth.excessiveWorkerTimeGroups) &&
        selfHealHealth.excessiveWorkerTimeGroups.length > 0));
  if (shouldEscalateWorkerContractToSelfHeal) {
    selfHealHealth.status = 'red';
    selfHealHealth.workerContractSelfHealEscalation = true;
    selfHealHealth.detail = selfHealHealth.detail
      ? `${selfHealHealth.detail}; worker contract self-heal required`
      : 'worker contract self-heal required';
    logRun({
      stage: 'worker-contract-self-heal-escalation',
      pass: passNumber,
      hardWatchdogKills: selfHealHealth.hardWatchdogKills || 0,
      workerKills: selfHealHealth.workerKills || 0,
      contractMisses: selfHealHealth.contractMisses || 0,
      repeatedContractMissWave,
      survivingRawDefects: postRepairRawDefects,
    });
  }
  logRun({ stage: 'self-heal-health', ...selfHealHealth });
  // Codex P2#5: a caller must never mistake escalations for success. If ANY
  // blocker escalated unresolved (deadline, ownership skip, or session
  // escalation), ok is false and escalated flags the open count. ok:true only
  // when every blocker cleared.
  const anyEscalated = escalated > 0 || postRepairRawDefects > 0;
  // The pass reached the end of its normal repair loop, so the executor DID run this
  // window regardless of how many defects it cleared. status:'red' here means the run
  // itself hit an internal defect (worker kills, contract misses, landing conflicts),
  // never "we don't know if it ran" -- the checkpoint proves it ran either way.
  logExecutorCheckpoint(logRun, 'completed', {
    pass: passNumber,
    status: selfHealHealth.status === 'red' ? 'red' : 'green',
    crash: selfHealHealth.status === 'red' ? clampCheckpointDetail(selfHealHealth.detail) : '',
    attempted: blockers.length,
    cleared,
    escalated,
  });
  logRun({
    stage: 'orchestrator-complete',
    pass: passNumber,
    cleared,
    escalated,
    escalatedUnresolved: anyEscalated,
    postRepairRawDefects,
    totalBlockers: rawBlockerCount,
    repairGroups: blockers.length,
    publishRefreshWatchdogKilled,
    repeatedContractMissWave,
    workerContractSelfHealEscalation: shouldEscalateWorkerContractToSelfHeal,
    postRepairRegressed,
    postRepairDefectSwap,
    repairLoopOptionsExhausted: !!repairLoopExhaustion.exhausted,
    repairLoopExhaustionReason: repairLoopExhaustion.reason,
    repairLoopExhaustionAttempts: repairLoopExhaustion.attempts || 0,
    repairLoopJudgment: repairLoopExhaustion.judgment || '',
    falseClearSelfHealEscalation: shouldEscalateFalseClearToSelfHeal,
    repairLoopExhaustionWindow: (repairLoopExhaustion.window || []).map((entry) => ({
      pass: entry.pass,
      rawDefects: entry.rawDefects,
      surfaceSignature: entry.surfaceSignature,
      groups: entry.groups,
    })),
    newPostRepairDefectGroups: postRepairNewDefectGroups.map(
      (group) => `${group.cardId}:${group.defectType} (${group.count})`,
    ),
    newPostRepairCardGroups: postRepairNewCardGroups.map(
      (group) => `${group.cardId}:${group.defectType} (${group.count})`,
    ),
  });
  if (
    repeatedContractMissWave &&
    mode.midday &&
    !mode.observe &&
    !shouldEscalateWorkerContractToSelfHeal
  ) {
    logRun({
      stage: 'midday-rerun-suppressed',
      pass: passNumber,
      reason: 'all worker lanes missed the JSON contract and live defects did not change',
      survivingRawDefects: postRepairRawDefects,
    });
  }
  if (postRepairRegressed && mode.midday && !mode.observe) {
    logRun({
      stage: 'midday-rerun-suppressed',
      pass: passNumber,
      reason:
        'post-repair live QC introduced new defect groups without reducing the raw blocker count',
      preRepairRawDefects: preWorkerLiveDefects.length,
      postRepairRawDefects,
      newPostRepairDefectGroups: postRepairNewDefectGroups.map(
        (group) => `${group.cardId}:${group.defectType} (${group.count})`,
      ),
      newPostRepairCardGroups: postRepairNewCardGroups.map(
        (group) => `${group.cardId}:${group.defectType} (${group.count})`,
      ),
    });
  }
  if (
    repairLoopExhaustion.exhausted &&
    mode.midday &&
    !mode.observe &&
    !shouldEscalateFalseClearToSelfHeal
  ) {
    logRun({
      stage: 'midday-rerun-suppressed',
      pass: passNumber,
      reason: repairLoopExhaustion.reason,
      judgment: repairLoopExhaustion.judgment || '',
      survivingRawDefects: postRepairRawDefects,
      repairLoopExhaustionWindow: (repairLoopExhaustion.window || []).map((entry) => ({
        pass: entry.pass,
        rawDefects: entry.rawDefects,
        surfaceSignature: entry.surfaceSignature,
        groups: entry.groups,
      })),
    });
  }
  const repairLoopDecision = shouldContinueRepairLoop({
    anyEscalated,
    mode,
    passNumber,
    maxPasses,
    postRepairRawDefects,
    repeatedContractMissWave: repeatedContractMissWave && !shouldEscalateWorkerContractToSelfHeal,
    postRepairRegressed,
    postRepairDefectSwap,
    repairLoopOptionsExhausted:
      !!repairLoopExhaustion.exhausted &&
      !shouldEscalateFalseClearToSelfHeal &&
      !shouldEscalateLandingConflictToSelfHeal &&
      !shouldEscalateWorkerContractToSelfHeal,
    repairLoopExhaustionReason: repairLoopExhaustion.reason,
    falseClearSelfHealEscalation: shouldEscalateFalseClearToSelfHeal,
    falseClearSelfHealAttempted,
    deadlineMs,
    perSessionBudgetMs,
  });
  if (anyEscalated && !mode.observe && postRepairRawDefects > 0 && !repairLoopDecision.continue) {
    logRun({
      stage: 'repair-loop-stopped',
      pass: passNumber,
      reason: repairLoopDecision.reason,
      maxPasses: maxPassesForLog(maxPasses),
      survivingRawDefects: postRepairRawDefects,
      judgment: repairLoopExhaustion.judgment || '',
      mode: modeLabel(mode),
    });
  }
  if (repairLoopDecision.continue) {
    const nextExtraBlockers = [];
    const falseClearPreflightCards = falseClearSelfHealAttempted
      ? cardIdsFromRenderRows(postRepairLiveRenderQc.defects || [])
      : [];
    if (publishRefreshWatchdogKilled) {
      nextExtraBlockers.push(
        publishRefreshWatchdogRepairBlocker({
          phase: 'post-repair publish refresh',
          refresh: publishRefresh,
          defectCount: postRepairRawDefects,
        }),
      );
    }
    if (shouldEscalateFalseClearToSelfHeal) {
      const falseClearGroups = selfHealHealth.falseClearGroups;
      nextExtraBlockers.push(
        selfHealFalseClearRepairBlocker({
          falseClearGroups,
          results,
          postRepairDefects: postRepairLiveRenderQc.defects || [],
          repairLoopExhaustion,
        }),
      );
    }
    if (shouldEscalateWorkerContractToSelfHeal) {
      nextExtraBlockers.push(
        selfHealWorkerContractRepairBlocker({
          selfHealHealth,
          results,
          postRepairDefects: postRepairLiveRenderQc.defects || [],
          repeatedContractMissWave,
        }),
      );
    }
    if (shouldEscalateLandingConflictToSelfHeal) {
      nextExtraBlockers.push(
        selfHealLandingConflictRepairBlocker({
          selfHealHealth,
          results,
          postRepairDefects: postRepairLiveRenderQc.defects || [],
        }),
      );
    }
    logRun({
      stage: 'midday-rerun-from-live-qc',
      pass: passNumber,
      nextPass: passNumber + 1,
      maxPasses: maxPassesForLog(maxPasses),
      survivingRawDefects: postRepairRawDefects,
      publishRefreshWatchdogKilled,
      extraRepairBlockers: nextExtraBlockers.length,
      knownFalseClearPreflightCards: falseClearPreflightCards,
      reason: shouldEscalateWorkerContractToSelfHeal
        ? 'worker-contract-self-heal'
        : shouldEscalateLandingConflictToSelfHeal
          ? 'landing-conflict-self-heal'
          : repairLoopDecision.reason,
    });
    return runOrchestrator({
      ...opts,
      mode,
      passNumber: passNumber + 1,
      maxPasses,
      extraBlockers: nextExtraBlockers,
      suppressParsedFalseClearSelfHeal:
        opts.suppressParsedFalseClearSelfHeal || falseClearSelfHealAttempted,
      knownFalseClearPreflightCards: [
        ...new Set([
          ...(opts.knownFalseClearPreflightCards || []).map(String).filter(Boolean),
          ...falseClearPreflightCards,
        ]),
      ],
      repairLoopHistory: [...repairLoopHistory, repairLoopEntry].slice(-repairLoopHistoryLimit),
    });
  }
  return {
    ok: !anyEscalated,
    escalated: anyEscalated,
    pass: passNumber,
    maxPasses: maxPassesForLog(maxPasses),
    clearedCount: cleared,
    escalatedCount: escalated,
    postRepairRawDefects,
    postRepairDefects: (postRepairLiveRenderQc.defects || []).slice(0, 25),
    cleared,
    totalBlockers: rawBlockerCount,
    repairGroups: blockers.length,
    // BLOCKERS FROM LEDGER (Phase 4a, item 3): the Blockers card content is generated
    // from OPEN per-defect repair-ledger rows, so it always matches reality and shrinks
    // when a defect's latest attempt clears.
    ledgerBlockers: recordRepairLedger ? repairLedger.blockersFromLedger(date, ledgerOpts) : [],
  };
}

module.exports = {
  CHECKPOINT_STAGE,
  logExecutorCheckpoint,
  parseBlockersFromMarkdown,
  rawDefectCountForBlockers,
  bundleRelatedRepairBlockers,
  refreshCardsFromHealResults,
  classifyOwnership,
  buildSessionPrompt,
  classifySessionResult,
  shouldRespectDeadline,
  shouldContinueRepairLoop,
  resolveMaxPasses,
  maxPassesForLog,
  defectSurfaceSignature,
  loadPersistentRepairLoopHistory,
  summarizeRepairLoopExhaustion,
  isPostRepairDefectSwap,
  isPostRepairRegression,
  parseDeadlineToTodayCt,
  spawnSession,
  summarizeSelfHealHealth,
  runOrchestrator,
  resolveLatestBriefingPath,
  tryMechanicalRepair,
  tryScheduledTaskRepair,
  tryVideoBlockerPreflight,
  tryActionItemsRepair,
  tryVideoApprovalQueueRepair,
  parseRunMode,
  parseDateArg,
  isGitWorkTree,
  resolveCoordinatorRepoRoot,
  getCoordinatorRepoRoot,
  safeDeployRelPath,
  deployTargetsForRelPath,
  deployedFilesNeedServerRestart,
  restartSecondbrainBackend,
  deployChangedFilesFromWorktree,
  refreshPublishedBriefingAfterHeal,
  selfHealFalseClearRepairBlocker,
  selfHealAuthFailedRepairBlocker,
  preflightHealAuth,
  defaultClaudeAuthProbe,
  defaultTokenRefresh,
  shouldRunAuthPreflight,
  acquireLock,
  pidIsAlive,
  parseRenderQcDefects,
  renderQcDefectsToBlockers,
  buildCanonicalDefects,
  workerLiveQcCleared,
  collectLiveRenderQcBlockers,
  mergeBlockers,
  modeLabel,
  announceMode,
  // Phase 4a desired-state reconciler seams (re-exported so callers/tests reach the
  // same implementations the orchestrator wires in).
  repairLedger,
  executorHealthRow,
  assertModeEquivalence,
  loadRunGraph,
  createBudget,
  phaseExhausted,
  budgetExhaustedRed,
  RUNS_LOG_PATH,
  DEFAULT_PER_SESSION_BUDGET_MS,
};

if (require.main === module) {
  const lock = acquireLock();
  if (!lock.ok) {
    console.error('[orchestrator] skipping run:', lock.reason);
    process.exit(0);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => {
    releaseLock();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    releaseLock();
    process.exit(143);
  });
  runOrchestrator()
    .then((result) => {
      console.log('[orchestrator] done:', JSON.stringify(result));
      process.exit(0);
    })
    .catch((e) => {
      console.error('[orchestrator] threw:', e && e.message ? e.message : e);
      const detail = String(e && e.message ? e.message : e).slice(0, 400);
      appendRunLog({ stage: 'fatal', error: detail });
      // The orchestrator process itself crashed before completing a normal pass. This is
      // the genuine "the healer broke" case: a plain-English crash reason, not "ExampleCo".
      appendRunLog({
        stage: CHECKPOINT_STAGE,
        phase: 'completed',
        status: 'red',
        crash: `the self-heal process crashed unexpectedly: ${clampCheckpointDetail(detail)}`,
      });
      process.exit(1);
    });
}
