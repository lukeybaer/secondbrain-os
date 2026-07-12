#!/usr/bin/env node
// feature-backlog.js
//
// Manages the ranked feature backlog for SecondBrain improvements.
// Stored git-tracked at data/agent/feature-backlog.json (pushed to GitHub).
//
// 2026-05-10 rewrite: stop downgrading strong well-researched ideas just
// because they did not surface as a daily pain. The original algorithm
// (flat -5/day decay, items at 0 deleted, MAX_ITEMS=10, research relevance
// capped below pain severity) produced a superficial top list biased toward
// the last 24h of rejections. ExampleCo: "the opinion is strong because it is
// real". Algorithm now:
//
//   priority_score = round(strategic_impact * 0.45 + signal_score * 0.55)
//
//   strategic_impact (0..100, permanent, never decays)
//     - Set at creation from architectural reasoning, not from recent pain
//     - Increases when independent sources confirm the gap (research breadth)
//     - Floor for any item with at least one research_confirmation
//
//   signal_score (0..100, volatile)
//     - Pain event:            +15 to +25 depending on severity
//     - Research confirmation: +8 to +25 + independent-source breadth bonus
//     - Decay: multiplicative 0.97/day after 3 quiet days, floor =
//       strategic_impact * 0.5 for items with any research confirmation,
//       else floor = 0
//
//   Removal: items never deleted. Items that fall below the visible
//   threshold are MOVED to data/agent/feature-backlog-archive.jsonl. They
//   can be restored by rePromoteIfMatched() when a new signal references them.
//
//   MAX_ITEMS = 25 (was 10). The briefing renderer groups by category and
//   shows ranked items; this just stops truncating deep research too early.

const fs = require('fs');
const path = require('path');

const REPO = process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');
const BACKLOG_PATH = path.join(REPO, 'data', 'agent', 'feature-backlog.json');
const ARCHIVE_PATH = path.join(REPO, 'data', 'agent', 'feature-backlog-archive.jsonl');
const { deriveBacklogReceipt, writeBacklogReceipt } = require('./lib/backlog-run-receipt.js');

const PAIN_SEVERITY = {
  rejection: 20,
  health_red: 20,
  gap_trigger: 25,
  bug_fix_commit: 15,
  health_yellow: 10,
  recurring_rejection: 25,
};

const RESEARCH_RELEVANCE = {
  high: 25,
  medium: 15,
  low: 8,
};

const SCORE_FLOOR = 0;
const SCORE_CEILING = 100;
const MAX_ITEMS = 25;
const QUIET_DAYS_BEFORE_DECAY = 3;
const DECAY_FACTOR_PER_DAY = 0.97;
const STRATEGIC_WEIGHT = 0.45;
const SIGNAL_WEIGHT = 0.55;

function loadBacklog() {
  try {
    const raw = fs.readFileSync(BACKLOG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.features) {
      for (const f of parsed.features) ensureNewFields(f);
    }
    return parsed;
  } catch {
    return { version: 1, last_updated: new Date().toISOString(), features: [] };
  }
}

function ensureNewFields(feature) {
  if (feature.problem_statement === undefined) feature.problem_statement = '';
  if (feature.evidence === undefined) feature.evidence = [];
  if (feature.implementation_plan === undefined) feature.implementation_plan = '';
  if (feature.signal_score === undefined) feature.signal_score = feature.priority_score || 0;
  if (feature.strategic_impact === undefined) {
    const research = (feature.research_confirmations || []).length;
    const pain = (feature.pain_events || []).length;
    const seed = Math.min(100, (feature.priority_score || 0) + research * 5 + pain * 2);
    feature.strategic_impact = Math.max(20, seed);
  }
  feature.priority_score = computePriority(feature);
}

function computePriority(feature) {
  const strategic = clampScore(feature.strategic_impact || 0);
  const signal = clampScore(feature.signal_score || 0);
  return Math.round(strategic * STRATEGIC_WEIGHT + signal * SIGNAL_WEIGHT);
}

function saveBacklog(backlog) {
  backlog.version = (backlog.version || 0) + 1;
  backlog.last_updated = new Date().toISOString();
  for (const f of backlog.features) {
    f.priority_score = computePriority(f);
  }
  fs.mkdirSync(path.dirname(BACKLOG_PATH), { recursive: true });
  fs.writeFileSync(BACKLOG_PATH, JSON.stringify(backlog, null, 2) + '\n');
  // Output contract (ExampleCo wave 3a, 2026-07-12, D8): every backlog save also
  // writes the research receipt next to it -- scored asks OR an explicit
  // no-proposals marker. The FEATURE BACKLOG card and its QC read this receipt
  // so "loop produced nothing" is always distinguishable from "nothing to
  // propose". Never allowed to fail the save itself.
  try {
    writeBacklogReceipt(path.dirname(BACKLOG_PATH), deriveBacklogReceipt(backlog));
  } catch (e) {
    console.warn(`[feature-backlog] receipt write failed: ${(e && e.message) || e}`);
  }
}

function clampScore(score) {
  return Math.max(SCORE_FLOOR, Math.min(SCORE_CEILING, score));
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const then = new Date(dateStr + 'T00:00:00Z').getTime();
  const now = Date.now();
  return Math.max(0, Math.floor((now - then) / (24 * 3600 * 1000)));
}

function addPainEvent(backlog, featureId, { source, detail, severity }) {
  const feature = backlog.features.find((f) => f.id === featureId);
  if (!feature) return false;
  const delta = PAIN_SEVERITY[severity] || PAIN_SEVERITY.bug_fix_commit;
  const today = todayStamp();
  feature.pain_events = feature.pain_events || [];
  feature.pain_events.push({ date: today, source, detail });
  feature.score_history = feature.score_history || [];
  feature.score_history.push({ date: today, delta, reason: `pain: ${detail}`, dim: 'signal' });
  feature.signal_score = clampScore((feature.signal_score || 0) + delta);
  feature.last_signal_date = today;
  feature.priority_score = computePriority(feature);
  return true;
}

function addResearchConfirmation(backlog, featureId, { repo, finding, relevance }) {
  const feature = backlog.features.find((f) => f.id === featureId);
  if (!feature) return false;
  const baseDelta = RESEARCH_RELEVANCE[relevance] || RESEARCH_RELEVANCE.medium;
  const today = todayStamp();
  feature.research_confirmations = feature.research_confirmations || [];

  const priorRepos = new Set(
    feature.research_confirmations.map((r) => (r.repo || '').toLowerCase()),
  );
  const isNewSource = repo && !priorRepos.has(repo.toLowerCase());
  const breadthBonus = isNewSource ? Math.round(baseDelta * 0.5) : 0;

  feature.research_confirmations.push({
    date: today,
    repo,
    finding,
    relevance: relevance || 'medium',
  });

  feature.score_history = feature.score_history || [];
  feature.score_history.push({
    date: today,
    delta: baseDelta,
    reason: `research: ${repo} -- ${(finding || '').slice(0, 140)}`,
    dim: 'signal',
  });
  feature.signal_score = clampScore((feature.signal_score || 0) + baseDelta);

  if (breadthBonus > 0) {
    feature.strategic_impact = clampScore((feature.strategic_impact || 0) + breadthBonus);
    feature.score_history.push({
      date: today,
      delta: breadthBonus,
      reason: `breadth: new independent source (${repo}) raises strategic impact`,
      dim: 'strategic',
    });
  }

  feature.last_signal_date = today;
  feature.priority_score = computePriority(feature);
  return true;
}

function applyDailyDecay(backlog) {
  const today = todayStamp();
  for (const feature of backlog.features) {
    const quietDays = daysSince(feature.last_signal_date);
    if (quietDays < QUIET_DAYS_BEFORE_DECAY) continue;

    const hasResearch = (feature.research_confirmations || []).length > 0;
    const researchFloor = hasResearch ? Math.floor((feature.strategic_impact || 0) * 0.5) : 0;
    const pinFloor = feature.pinned ? Math.max(1, researchFloor) : researchFloor;

    const proposedSignal = Math.floor((feature.signal_score || 0) * DECAY_FACTOR_PER_DAY);
    const newSignal = Math.max(pinFloor, proposedSignal);
    const actualDelta = newSignal - (feature.signal_score || 0);

    if (actualDelta !== 0) {
      feature.signal_score = newSignal;
      feature.score_history = feature.score_history || [];
      feature.score_history.push({
        date: today,
        delta: actualDelta,
        reason: hasResearch
          ? `decay: quiet ${quietDays}d, floor=${pinFloor} (research-backed)`
          : `decay: quiet ${quietDays}d`,
        dim: 'signal',
      });
      feature.priority_score = computePriority(feature);
    }
  }
}

// Quality gate (2026-05-17). The dashboard "Amy / EA agent" feature-backlog
// card was surfacing vague fluff proposals because the only thing that ever
// called createFeature was a one-time seed script -- there was no ongoing
// generator and no structural bar. validateProposal makes every proposal
// carry a concrete problem statement, real evidence, and an implementation
// plan with file paths, and is wired as a HARD gate inside createFeature so
// the backlog can never store an unvalidated item.

// Banned-phrase set: reuses the obvious-fluff idea from hasUsefulFeatureText
// in manual-briefing-v3.js. A title/description that leans on any of these is
// a placeholder, not a proposal.
const BANNED_FLUFF_PHRASES = [
  'no detail captured',
  'nightly research',
  'pain signals + research',
  'see pain signals',
  'potential improvement',
  'specific reason captured',
  'data/agent/pain-events',
  'tbd',
  'to be determined',
  'misc improvement',
  'general enhancement',
  'various improvements',
];

const MIN_PROBLEM_STATEMENT_CHARS = 60;
const FILE_PATH_REGEX = /[\w./-]+\.(js|ts|py|json|md)/;

// validateProposal(feature) -> { ok, failures[] }
// Fails when:
//  - problem_statement missing or under MIN_PROBLEM_STATEMENT_CHARS chars
//  - evidence is empty (not an array, or zero entries)
//  - implementation_plan missing, or contains no concrete file path
//  - title or description hits the obvious-fluff banned-phrase check
function validateProposal(feature) {
  const failures = [];
  const f = feature || {};

  const problem = String(f.problem_statement || '').trim();
  if (!problem) {
    failures.push('problem_statement is missing');
  } else if (problem.length < MIN_PROBLEM_STATEMENT_CHARS) {
    failures.push(
      `problem_statement too short (${problem.length} chars, need >=${MIN_PROBLEM_STATEMENT_CHARS})`,
    );
  }

  const evidence = Array.isArray(f.evidence) ? f.evidence : [];
  if (evidence.length === 0) {
    failures.push('evidence is empty (need at least one {source, detail} entry)');
  }

  const plan = String(f.implementation_plan || '').trim();
  if (!plan) {
    failures.push('implementation_plan is missing');
  } else if (!FILE_PATH_REGEX.test(plan)) {
    failures.push(
      'implementation_plan names no concrete file path (expect a *.js/*.ts/*.py/*.json/*.md path)',
    );
  }

  const fluffText = `${f.title || ''} ${f.description || ''}`.toLowerCase();
  const hitFluff = BANNED_FLUFF_PHRASES.find((p) => fluffText.includes(p));
  if (hitFluff) {
    failures.push(`title/description contains banned fluff phrase: "${hitFluff}"`);
  }

  return { ok: failures.length === 0, failures };
}

// Quality gate (2026-05-17 ExampleCo dispatch: "Feature backlog proposals are
// vague. Add quality gate requiring concrete problem, evidence, implementation
// plan."). A proposal is only shown as a READY backlog item when it clears all
// three bars; anything short is a weak suggestion, still tracked and scored but
// surfaced only as a count until it is sharpened.
//
//   1. Concrete problem    -- problem_statement (or description fallback)
//                             names a specific observable gap, >= 60 chars.
//   2. Evidence            -- at least one pain event, research confirmation,
//                             or evidence entry backs the proposal.
//   3. Implementation plan -- a concrete plan: >= 80 chars OR names a file path.
const QUALITY_MIN_PROBLEM_CHARS = 60;
const QUALITY_MIN_PLAN_CHARS = 80;

function passesQualityGate(feature) {
  const reasons = [];
  const f = feature || {};
  const problem = String(f.problem_statement || f.description || '').trim();
  if (problem.length < QUALITY_MIN_PROBLEM_CHARS) {
    reasons.push(
      `problem statement too thin (need >= ${QUALITY_MIN_PROBLEM_CHARS} chars naming a concrete, observable gap)`,
    );
  }
  const evidenceCount =
    (Array.isArray(f.pain_events) ? f.pain_events.length : 0) +
    (Array.isArray(f.research_confirmations) ? f.research_confirmations.length : 0) +
    (Array.isArray(f.evidence) ? f.evidence.length : 0);
  if (evidenceCount < 1) {
    reasons.push('no evidence (need >= 1 pain event, research confirmation, or evidence entry)');
  }
  const plan = String(f.implementation_plan || '').trim();
  if (!plan || (plan.length < QUALITY_MIN_PLAN_CHARS && !FILE_PATH_REGEX.test(plan))) {
    reasons.push('no implementation plan (need concrete steps with a file path or >= 80 chars)');
  }
  return { ok: reasons.length === 0, reasons };
}

function createFeature(
  backlog,
  {
    id,
    title,
    description,
    category,
    initialScore,
    strategicImpact,
    summaryOneSentence,
    detailTwoExampleCoraph,
    problemStatement,
    evidence,
    implementationPlan,
  },
) {
  const today = todayStamp();
  const signalSeed = clampScore(initialScore != null ? initialScore : 10);
  const strategic = clampScore(
    strategicImpact != null ? strategicImpact : Math.max(20, signalSeed + 10),
  );
  const feature = {
    id,
    title,
    description,
    category,
    proposed_date: today,
    strategic_impact: strategic,
    signal_score: signalSeed,
    priority_score: 0,
    problem_statement: problemStatement || '',
    evidence: Array.isArray(evidence) ? evidence : [],
    implementation_plan: implementationPlan || '',
    score_history: [
      {
        date: today,
        delta: strategic,
        reason: 'initial: strategic impact set from architectural reasoning',
        dim: 'strategic',
      },
      { date: today, delta: signalSeed, reason: 'initial: seed signal', dim: 'signal' },
    ],
    pain_events: [],
    research_confirmations: [],
    last_signal_date: today,
    status: 'proposed',
  };
  if (summaryOneSentence) feature.summary_one_sentence = summaryOneSentence;
  if (detailTwoExampleCoraph) feature.detail_two_ExampleCoraph = detailTwoExampleCoraph;

  // The quality gate is enforced at SURFACE time (getBacklogForBriefing splits
  // ready vs weak), not at creation time: a weak proposal is still tracked and
  // scored so it can be sharpened, it is just hidden behind a count until it
  // clears the bar. createFeature records the gate verdict for visibility.
  feature.quality_gate = passesQualityGate(feature);

  feature.priority_score = computePriority(feature);
  backlog.features.push(feature);
  return feature;
}

function archiveItem(feature, reason) {
  try {
    fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
    const entry = {
      archived_at: new Date().toISOString(),
      reason,
      feature,
    };
    fs.appendFileSync(ARCHIVE_PATH, JSON.stringify(entry) + '\n');
  } catch {
    // archive write failures must not block the run; the in-memory backlog is still authoritative
  }
}

function loadArchive() {
  try {
    if (!fs.existsSync(ARCHIVE_PATH)) return [];
    return fs
      .readFileSync(ARCHIVE_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function rePromoteIfMatched(backlog, featureId) {
  if (backlog.features.find((f) => f.id === featureId)) return null;
  const archive = loadArchive();
  for (let i = archive.length - 1; i >= 0; i--) {
    const e = archive[i];
    if (e && e.feature && e.feature.id === featureId) {
      const restored = { ...e.feature };
      restored.last_signal_date = todayStamp();
      restored.score_history = restored.score_history || [];
      restored.score_history.push({
        date: todayStamp(),
        delta: 0,
        reason: 'restored from archive on new matching signal',
        dim: 'meta',
      });
      backlog.features.push(restored);
      return restored;
    }
  }
  return null;
}

function rankAndTrim(backlog) {
  const today = todayStamp();
  for (const f of backlog.features) f.priority_score = computePriority(f);

  const removed = [];
  backlog.features = backlog.features.filter((f) => {
    const hasMerit =
      f.pinned ||
      f.strategic_impact > 0 ||
      (f.research_confirmations || []).length > 0 ||
      (f.pain_events || []).length > 0;
    if (!hasMerit && f.priority_score <= 0) {
      removed.push({ feature: f, reason: 'no merit, no signal' });
      return false;
    }
    return true;
  });

  backlog.features.sort((a, b) => b.priority_score - a.priority_score);

  if (backlog.features.length > MAX_ITEMS) {
    const top = backlog.features.slice(0, MAX_ITEMS);
    const overflow = backlog.features.slice(MAX_ITEMS);
    const pinnedOverflow = overflow.filter((f) => f.pinned);
    for (const f of overflow.filter((f) => !f.pinned)) {
      removed.push({ feature: f, reason: `below MAX_ITEMS=${MAX_ITEMS} rank cutoff` });
    }
    backlog.features = [...top, ...pinnedOverflow];
  }

  for (const r of removed) archiveItem(r.feature, r.reason + ` (rank-trim ${today})`);
}

function getBacklogForBriefing(backlog) {
  if (!backlog.features.length) {
    return {
      items: [],
      weakItems: [],
      weakCount: 0,
      count: 0,
      summary: 'Feature backlog is empty.',
    };
  }
  const toRow = (f, i) => {
    const latest =
      f.score_history && f.score_history.length
        ? f.score_history[f.score_history.length - 1]
        : null;
    return {
      rank: i + 1,
      score: f.priority_score,
      strategic_impact: f.strategic_impact,
      signal_score: f.signal_score,
      title: f.title,
      latestSignal: latest
        ? `${latest.delta > 0 ? '+' : ''}${latest.delta} ${latest.reason}`
        : 'none',
      category: f.category,
    };
  };

  // Quality gate: a proposal is only a "ready" backlog item when it has a
  // concrete problem, evidence, and an implementation plan. Weak ones stay
  // tracked and scored but are surfaced only as a count so the briefing card
  // is not padded with vague suggestions.
  const ready = [];
  const weak = [];
  for (const f of backlog.features) {
    const gate = passesQualityGate(f);
    if (gate.ok) ready.push(f);
    else weak.push({ feature: f, reasons: gate.reasons });
  }

  const items = ready.map(toRow);
  const weakItems = weak.map(({ feature, reasons }, i) => ({
    ...toRow(feature, i),
    weakReasons: reasons,
  }));

  let summary;
  if (items.length) {
    summary = `${items.length} ready item(s), top: ${items[0].title} (${items[0].score})`;
    if (weakItems.length)
      summary += `; ${weakItems.length} weak suggestion(s) hidden until they have a concrete problem, evidence, and an implementation plan`;
  } else {
    summary = weakItems.length
      ? `0 ready items; ${weakItems.length} weak suggestion(s) need a concrete problem, evidence, and an implementation plan before they surface`
      : 'Feature backlog is empty.';
  }

  return {
    items,
    weakItems,
    weakCount: weakItems.length,
    count: items.length,
    lastUpdated: backlog.last_updated,
    summary,
  };
}

function findFeatureByKeywords(backlog, keywords) {
  const kw = keywords.map((k) => k.toLowerCase());
  return backlog.features.find((f) => {
    const text = `${f.id} ${f.title} ${f.description} ${f.category}`.toLowerCase();
    return kw.some((k) => text.includes(k));
  });
}

module.exports = {
  BACKLOG_PATH,
  ARCHIVE_PATH,
  PAIN_SEVERITY,
  RESEARCH_RELEVANCE,
  SCORE_FLOOR,
  SCORE_CEILING,
  MAX_ITEMS,
  QUIET_DAYS_BEFORE_DECAY,
  DECAY_FACTOR_PER_DAY,
  STRATEGIC_WEIGHT,
  SIGNAL_WEIGHT,
  BANNED_FLUFF_PHRASES,
  MIN_PROBLEM_STATEMENT_CHARS,
  validateProposal,
  passesQualityGate,
  loadBacklog,
  saveBacklog,
  loadArchive,
  archiveItem,
  clampScore,
  computePriority,
  addPainEvent,
  addResearchConfirmation,
  applyDailyDecay,
  createFeature,
  rankAndTrim,
  rePromoteIfMatched,
  getBacklogForBriefing,
  findFeatureByKeywords,
  ensureNewFields,
};
