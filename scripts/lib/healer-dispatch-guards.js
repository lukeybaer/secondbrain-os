'use strict';

// Two guards on an unattended healer model session: a live board re-check
// immediately before dispatch, and a wall-clock cap on each session.
//
// ExampleCo, 2026-09-24: "goal is to get to 30 mins total runtime". Healer
// sessions took 7 of the last 12 minutes of the Sep 24 night and kept Sep 18
// to 23 running for hours; with Codex demoted the ladder has one rung, so
// the fair split handed one session half of a 60-minute card budget.
//
// 1. Live re-check: planning, Jev admission and context assembly take time,
//    and the controller or another run may publish a green row meanwhile.
//    Immediately before the spend circuit and the spawn, the driver re-reads
//    the live board; a target it positively shows clean gets no model. A
//    missing, partial or stale board is unknown, never clean.
// 2. Session cap: each model session gets at most
//    AMY_HEALER_SESSION_CAP_MINUTES (default 15). The watchdog kills at the
//    capped budget and the prompt states it.
//
// Scope: unattended runs only (the night owner and daytime controller
// launches). Attended runs (supervised, heal-the-healer, or a human-action
// token such as a verified button) bypass both, the same attended set the
// evidence fingerprint gate exempts: they exist to retry what an unattended
// run could not close, and the attended practice refresh has its own
// 90-minute budget.
// Kill switches, both default ON: AMY_HEALER_LIVE_RECHECK=off and
// AMY_HEALER_SESSION_CAP_MINUTES=0.

const DEFAULT_SESSION_CAP_MINUTES = 15;
const MIN_SESSION_CAP_MS = 5 * 60 * 1000;

function norm(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase();
}

// Whether the guards apply to this run, and why.
function dispatchGuardScope({
  supervised = false,
  healTheHealer = false,
  humanActionToken = '',
} = {}) {
  if (supervised === true) return { active: false, reason: 'attended-supervised' };
  if (healTheHealer === true) return { active: false, reason: 'attended-heal-the-healer' };
  if (String(humanActionToken || '').trim()) {
    return { active: false, reason: 'attended-human-action' };
  }
  return { active: true, reason: 'unattended' };
}

function liveRecheckEnabled(env = process.env) {
  return norm(env && env.AMY_HEALER_LIVE_RECHECK) !== 'off';
}

// True only when the current live board positively shows this exact target
// clean. A missing card, a missing metric row or a stale board is unknown,
// never clean.
function liveTargetClean(artifact, card) {
  if (!artifact || !Array.isArray(artifact.cards) || !card) return false;
  const parent = artifact.cards.find((row) => row && norm(row.id) === norm(card.id));
  if (!parent) return false;
  if (norm(parent.status) === 'clean') return true;
  const unitId = norm(card.workUnitId);
  if (!unitId) return false;
  const row = (
    Array.isArray(artifact.systemHealthMeasurements) ? artifact.systemHealthMeasurements : []
  ).find((measurement) => measurement && norm(measurement.id) === unitId);
  return !!row && ['green', 'clean'].includes(norm(row.status));
}

// Per-session wall clock cap in ms, or 0 when the kill switch turns it off.
function healerSessionCapMs(env = process.env) {
  const raw = env && env.AMY_HEALER_SESSION_CAP_MINUTES;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_SESSION_CAP_MINUTES * 60 * 1000;
  }
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_SESSION_CAP_MINUTES * 60 * 1000;
  if (minutes === 0) return 0;
  return Math.max(MIN_SESSION_CAP_MS, Math.round(minutes * 60 * 1000));
}

function capSessionBudgetMs(budgetMs, capMs) {
  const budget = Number(budgetMs);
  if (!capMs || !Number.isFinite(budget)) return budget;
  return Math.min(budget, capMs);
}

module.exports = {
  DEFAULT_SESSION_CAP_MINUTES,
  dispatchGuardScope,
  liveRecheckEnabled,
  liveTargetClean,
  healerSessionCapMs,
  capSessionBudgetMs,
};
