'use strict';

// scripts/lib/heal-error-budget.js
//
// PHASE 4a, item 6: SRE SPLIT DEADLINES + ERROR BUDGET.
//
// The overnight run had ONE deadline and would retry past it; SRE practice splits the
// run clock into named phases with their OWN sub-deadlines and a HARD error budget.
// When the budget for a phase (or the whole run) is exhausted, the run does NOT retry
// past the deadline. Instead it publishes a NAMED, EVIDENCED RED: the defect, the
// tactics already tried (read from the per-defect repair ledger), and the ONE action
// needed.
//
// Phases (default split of the total budget):
//   audit   - observe + live render-QC + canonical defects
//   repair  - the heal worker wave
//   decide  - post-repair QC + self-heal-health + loop decision
//   read    - publish refresh + settle reads
//
// Pure + injectable clock so tests never sleep. No spawn, no network.

const DEFAULT_PHASES = ['audit', 'repair', 'decide', 'read'];

// Default fractions of the total budget per phase (must sum to 1). Repair gets the
// lion's share; audit/decide/read are bounded so a spinning lane cannot eat the run.
const DEFAULT_PHASE_FRACTIONS = {
  audit: 0.15,
  repair: 0.55,
  decide: 0.15,
  read: 0.15,
};

function normalizeFractions(fractions = DEFAULT_PHASE_FRACTIONS, phases = DEFAULT_PHASES) {
  const out = {};
  let sum = 0;
  for (const phase of phases) {
    const f = Number(fractions[phase]);
    out[phase] = Number.isFinite(f) && f > 0 ? f : 0;
    sum += out[phase];
  }
  if (sum <= 0) {
    const even = 1 / phases.length;
    for (const phase of phases) out[phase] = even;
    return out;
  }
  for (const phase of phases) out[phase] /= sum; // renormalize to sum 1
  return out;
}

// Build the phase deadline schedule from a total budget. Each phase gets an absolute
// deadline (cumulative). startMs defaults to now (injectable for tests).
function createBudget(opts = {}) {
  const phases = Array.isArray(opts.phases) && opts.phases.length ? opts.phases : DEFAULT_PHASES;
  const totalMs = Number(opts.totalBudgetMs);
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    throw new Error('createBudget requires a positive totalBudgetMs');
  }
  const startMs = Number.isFinite(Number(opts.startMs)) ? Number(opts.startMs) : Date.now();
  const fractions = normalizeFractions(opts.phaseFractions, phases);
  const phaseBudgetMs = {};
  const phaseDeadlineMs = {};
  let cumulative = startMs;
  for (const phase of phases) {
    const ms = Math.round(totalMs * fractions[phase]);
    phaseBudgetMs[phase] = ms;
    cumulative += ms;
    phaseDeadlineMs[phase] = cumulative;
  }
  return {
    phases,
    startMs,
    totalMs,
    hardDeadlineMs: startMs + totalMs,
    phaseBudgetMs,
    phaseDeadlineMs,
  };
}

// HARD error-budget check for a phase. Returns { exhausted, remainingMs, phase }.
// exhausted=true means the phase's own deadline AND the total hard deadline are past
// (either trips it). The caller must NOT retry once exhausted; it must publish the RED.
function phaseExhausted(budget, phase, nowMs = Date.now()) {
  if (!budget) return { exhausted: false, remainingMs: Infinity, phase };
  const phaseDeadline = budget.phaseDeadlineMs[phase];
  const hard = budget.hardDeadlineMs;
  const overHard = nowMs >= hard;
  const overPhase = Number.isFinite(phaseDeadline) && nowMs >= phaseDeadline;
  const remainingMs = Math.min(
    Number.isFinite(phaseDeadline) ? phaseDeadline - nowMs : Infinity,
    hard - nowMs,
  );
  return { exhausted: overHard || overPhase, overHard, overPhase, remainingMs, phase };
}

// Build the NAMED, EVIDENCED RED published when the budget is exhausted. It ExampleCos:
//   - the defect(s) still open (from openDefects, the per-defect repair ledger),
//   - the tactics already tried per defect (so we never claim "untried" wrongly),
//   - the ONE action needed.
// Returns a System-Health-shaped row PLUS a blocker so both the System Health card and
// the Blockers card show the same evidenced RED. Pure: openDefects is passed in.
function budgetExhaustedRed({ phase, budget, nowMs = Date.now(), openDefects = [] } = {}) {
  const open = Array.isArray(openDefects) ? openDefects : [];
  const elapsedMs = budget ? nowMs - budget.startMs : 0;
  const overBy = budget ? Math.max(0, nowMs - budget.hardDeadlineMs) : 0;
  const defectLines = open.slice(0, 8).map((d) => {
    const tried = Array.isArray(d.triedTactics) ? d.triedTactics : [];
    return `${d.defect} (${d.attempts || tried.length} attempt(s); tried: ${
      tried.slice(0, 5).join('; ') || 'none recorded'
    }; latest QC ${d.lastQcResult || 'failed'})`;
  });
  const evidence = [
    `HEAL-ERROR-BUDGET-EXHAUSTED: the ${phase || 'run'} phase exhausted its error budget after ${Math.round(
      elapsedMs / 1000,
    )}s${overBy > 0 ? ` (${Math.round(overBy / 1000)}s past the hard deadline)` : ''}; retrying past the deadline is forbidden.`,
    open.length
      ? `${open.length} defect(s) still open: ${defectLines.join(' | ')}.`
      : 'No per-defect ledger rows were recorded before the budget ran out.',
  ].join(' ');
  const action = open.length
    ? 'Pick a NOT-yet-tried tactic for each open defect on the next run (the no-repeat guard rejects re-running a failed tactic with the same input); if every tactic is exhausted, this is a ExampleCo decision on the underlying card.'
    : 'Investigate why the heal phases consumed the full budget without recording a single repair attempt (executor health, publish-refresh hang, or a stuck audit probe), then re-run with a fixed phase split.';
  return {
    row: {
      label: 'Self-Heal Error Budget',
      status: 'red',
      detail: evidence,
      runbook: action,
    },
    blocker: {
      title: `Self-heal error budget exhausted in ${phase || 'run'} phase`,
      requirement:
        'The overnight self-healer must finish within its split phase deadlines or publish a named, evidenced RED, never retry past the deadline.',
      evidence,
      repair: action,
      owner: open.length && open.every((d) => (d.triedTactics || []).length) ? 'ExampleCo' : 'Amy',
      need: 'Nothing.',
      source: 'self-heal-health',
      rawDefectCount: Math.max(1, open.length),
      rawDefects: [
        `HEAL-ERROR-BUDGET-EXHAUSTED: ${phase || 'run'} phase deadline reached with ${open.length} defect(s) still open`,
      ],
    },
  };
}

module.exports = {
  DEFAULT_PHASES,
  DEFAULT_PHASE_FRACTIONS,
  normalizeFractions,
  createBudget,
  phaseExhausted,
  budgetExhaustedRed,
};
