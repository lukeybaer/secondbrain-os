// scripts/lib/llm-ladder-anomaly.js
//
// Window-over-window cost-anomaly detection for the LLM ladder.
//
// summarizeLadder() (scripts/lib/llm-ladder-observability.js) answers "is the
// ladder healthy right now". It cannot answer "is reliance on the paid floor
// RISING" -- a slow drift where each night looks individually acceptable but the
// trend is a cost/health regression. This module compares the current summary
// against a saved baseline summary and flags a regression when paid-floor
// reliance climbs, the top rung's answer rate falls, or paid-floor dollar spend
// rises beyond a threshold. Pure over two summary objects; persistence of the
// rolling baseline lives in the observability CLI, not here.

'use strict';

// compareWindows(current, baseline, opts) -> { regression, flags, deltas }. Pure.
//   opts.paidFloorJumpPct  reliance-rate rise (absolute, 0..1) that flags       (default 0.15)
//   opts.firstRungDropPct  top-rung answer-rate fall (absolute, 0..1) that flags (default 0.15)
//   opts.spendJumpUsd      paid-floor $ rise over baseline that flags            (default 0.50)
function compareWindows(current, baseline, opts = {}) {
  const paidFloorJumpPct = Number.isFinite(opts.paidFloorJumpPct) ? opts.paidFloorJumpPct : 0.15;
  const firstRungDropPct = Number.isFinite(opts.firstRungDropPct) ? opts.firstRungDropPct : 0.15;
  const spendJumpUsd = Number.isFinite(opts.spendJumpUsd) ? opts.spendJumpUsd : 0.5;

  const flags = [];
  if (!baseline || !current) {
    return { regression: false, flags: ['no baseline to compare against'], deltas: {} };
  }

  const curPaid = current.paidFloorRelianceRate || 0;
  const basePaid = baseline.paidFloorRelianceRate || 0;
  const paidDelta = curPaid - basePaid;

  // A null firstRungAnswerRate means "no answers in the window" -- treat as a
  // perfect top rung (1) so a quiet window never looks like a regression.
  const curFirst = current.firstRungAnswerRate == null ? 1 : current.firstRungAnswerRate;
  const baseFirst = baseline.firstRungAnswerRate == null ? 1 : baseline.firstRungAnswerRate;
  const firstDelta = curFirst - baseFirst; // negative = top rung fell

  const spendDelta = (current.paidFloorSpendUsd || 0) - (baseline.paidFloorSpendUsd || 0);

  if (paidDelta >= paidFloorJumpPct) {
    flags.push(
      `paid-floor reliance rose ${Math.round(basePaid * 100)}% -> ${Math.round(curPaid * 100)}%`,
    );
  }
  if (firstDelta <= -firstRungDropPct) {
    flags.push(
      `top-rung answer rate fell ${Math.round(baseFirst * 100)}% -> ${Math.round(curFirst * 100)}%`,
    );
  }
  if (spendDelta >= spendJumpUsd) {
    flags.push(
      `paid-floor spend rose $${(baseline.paidFloorSpendUsd || 0).toFixed(4)} -> $${(current.paidFloorSpendUsd || 0).toFixed(4)}`,
    );
  }

  return {
    regression: flags.length > 0,
    flags,
    deltas: {
      paidFloorRelianceRate: Math.round(paidDelta * 1000) / 1000,
      firstRungAnswerRate: Math.round(firstDelta * 1000) / 1000,
      paidFloorSpendUsd: Math.round(spendDelta * 10000) / 10000,
    },
  };
}

module.exports = { compareWindows };
