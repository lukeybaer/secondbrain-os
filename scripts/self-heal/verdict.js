'use strict';

// scripts/self-heal/verdict.js
//
// The ONE runtime reader of the per-card QC contract declared in
// dev-plans/_domains.json. Built per feedback_qc_at_output_level.md and
// dev-plans/briefing-selfheal-consolidated-plan-2026-06-19.html (Wave C, PR1).
//
// Why this exists: the rule "a value <= floor, or empty over a non-empty source,
// is a defect" (memory/feedback_zero_activity_with_source_data_is_a_defect.md) named
// this module but it was never built, so each consumer (verify-briefing-cards-live.js,
// the orchestrator) hard-coded its own floors and they drifted. This module reads the
// declarative qc.acceptance predicate from the manifest and is the single source the
// live verifier and the heal loop both call, so there is exactly one reader of the
// contract. It reuses the same manifest parse as scripts/lib/manifest-coverage.js
// (manifestCardIds) so the CI ratchet and the runtime verdict cannot diverge.
//
// Card-level QC is the loop-again decision: a card passes only when honest AND
// self-heal is exhausted. verdict() returns:
//   pass    - the card's acceptance predicate holds (nothing to heal here)
//   defect  - the predicate fails AND the heal ladder still has an untried rung
//   blocked - the predicate fails AND self-heal is exhausted (emit the honest
//             hard-block on the honesty ladder, terminalDefect names the owner)

const fs = require('node:fs');
const path = require('node:path');
const mc = require('../lib/manifest-coverage.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DOMAINS_JSON = path.join(REPO_ROOT, 'dev-plans', '_domains.json');

// Honesty ladder (ExampleCo, 2026-06-19), most specific rung first.
//   L1 = a specific step-by-step ExampleCo action (a real wall only ExampleCo can clear)
//   L2 = broken for a known, identifiable reason self-heal could not fix
//   L3 = broken, do not know why, but know WHERE (the failing component)
//   L4 = broken, self-heal failed, do not even know what part, no logs; here is
//        exactly what we do know
const LADDER = ['L1', 'L2', 'L3', 'L4'];

function loadDomains(domainsPath = DOMAINS_JSON) {
  const d = JSON.parse(fs.readFileSync(domainsPath, 'utf8'));
  return Array.isArray(d) ? d : d.domains || [];
}

function allCards(domainsPath) {
  const out = [];
  for (const dom of loadDomains(domainsPath)) for (const c of dom.cards || []) out.push(c);
  return out;
}

function loadCardContract(cardId, opts = {}) {
  const cards = opts.cards || allCards(opts.domainsPath);
  return cards.find((c) => c.cardId === cardId) || null;
}

// Evaluate a card's qc.acceptance predicate against observed values.
// Returns { ok, reason }. A tagged union of predicate kinds (ExampleCo D15: simplest
// thing that solves it, not a general expression language).
function evalAcceptance(acceptance, observed) {
  if (!acceptance) return { ok: true, reason: 'no acceptance predicate declared' };
  const o = observed || {};
  switch (acceptance.kind) {
    case 'count-floor': {
      const field = acceptance.field || 'value';
      const v = Number(o[field] ?? o.value ?? 0);
      const ok = v >= acceptance.min;
      return {
        ok,
        reason: ok
          ? `${field}=${v} >= floor ${acceptance.min}`
          : `${field}=${v} below floor ${acceptance.min}`,
      };
    }
    case 'not-zero-when-source-nonempty':
    case 'nonempty-when-source-nonempty': {
      const rendered = Number(o.renderedCount ?? o.value ?? 0);
      const source = Number(o.sourceCount ?? 0);
      const ok = !(source > 0 && rendered <= 0);
      return {
        ok,
        reason: ok
          ? `rendered=${rendered} source=${source}`
          : `zero rendered while source has ${source} (zero-with-source defect)`,
      };
    }
    case 'within-budget': {
      const value = Number(o.value ?? 0);
      const baseline = Number(o.baseline ?? 0);
      const source = Number(o.sourceCount ?? o.resourcesRunning ?? 0);
      if (source > 0 && value <= 0) {
        return {
          ok: false,
          reason: `value 0 while ${source} resources running (zero-with-source defect)`,
        };
      }
      if (
        baseline > 0 &&
        acceptance.maxSpikeFactor &&
        value > baseline * acceptance.maxSpikeFactor
      ) {
        return {
          ok: false,
          reason: `value ${value} exceeds ${acceptance.maxSpikeFactor}x baseline ${baseline}`,
        };
      }
      return { ok: true, reason: `value=${value} baseline=${baseline}` };
    }
    case 'freshness': {
      const ageHours = Number(o.ageHours ?? Infinity);
      const ok = ageHours <= acceptance.maxAgeHours;
      return {
        ok,
        reason: ok
          ? `age ${ageHours}h <= ${acceptance.maxAgeHours}h`
          : `stale: ${ageHours}h > ${acceptance.maxAgeHours}h`,
      };
    }
    default:
      return { ok: true, reason: `ExampleCo acceptance kind '${acceptance.kind}', not enforced` };
  }
}

// The verdict for one card given observed state.
// observed may include healLadderRemaining (untried rungs) to decide defect vs blocked.
function verdict(cardId, observed = {}, opts = {}) {
  const card = opts.card || loadCardContract(cardId, opts);
  if (!card) {
    return {
      status: 'pass',
      cardId,
      reason: `no manifest contract for ${cardId}; unenforced`,
      failureMode: null,
      healLadder: null,
      owner: null,
    };
  }
  const qc = card.qc || {};
  const acc = evalAcceptance(qc.acceptance, observed);
  if (acc.ok) {
    return {
      status: 'pass',
      cardId,
      reason: acc.reason,
      failureMode: null,
      healLadder: null,
      owner: null,
    };
  }
  const fm = (card.failureModes || [])[0] || null;
  const ladder = fm && Array.isArray(fm.healLadder) ? fm.healLadder : [];
  const remaining =
    observed.healLadderRemaining != null ? Number(observed.healLadderRemaining) : ladder.length;
  const status = remaining > 0 ? 'defect' : 'blocked';
  const owner = (fm && fm.terminalDefect && fm.terminalDefect.owner) || null;
  return {
    status,
    cardId,
    reason: acc.reason,
    failureMode: fm ? fm.mode : null,
    healLadder: ladder,
    terminalDefect: fm ? fm.terminalDefect || null : null,
    owner,
  };
}

module.exports = {
  loadDomains,
  allCards,
  loadCardContract,
  evalAcceptance,
  verdict,
  manifestCardIds: mc.manifestCardIds,
  LADDER,
  DOMAINS_JSON,
};
