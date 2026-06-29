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

// --- Callable heal ladders (Phase 3, item 1) ---------------------------------
//
// A heal-ladder rung is EITHER a free-text string (legacy, the 1284 historical
// rungs) OR a resolvable reference { module, function, args, label }. The object
// form lets the loop actually CALL the named generator/healer, and lets a
// drift-lint fail CI when a refactor renames or deletes a referenced function.
// String rungs are still accepted (this lands incrementally) but they are not
// callable; a loader that needs a callable rung warns and skips them.
//
// IMPORTANT consumer seam: the attempt-ledger keys each rung by a STABLE STRING
// (optionKey). A bare object would stringify to "[object Object]" and collapse
// every object rung to one identity, breaking remainingUniqueOptions. So every
// rung MUST expose a stable label; healLadderRungLabel() is the one place that
// derives it, and the ledger routes through it.

function isCallableRung(rung) {
  return Boolean(
    rung && typeof rung === 'object' && !Array.isArray(rung) && rung.module && rung.function,
  );
}

// The stable string identity of a rung (legacy string -> itself; object ->
// explicit label, else "module#function"). Used by the attempt-ledger so an
// object rung is a distinct, repeat-detectable option.
function healLadderRungLabel(rung) {
  if (rung && typeof rung === 'object' && !Array.isArray(rung)) {
    if (rung.label) return String(rung.label);
    if (rung.module && rung.function) return `${rung.module}#${rung.function}`;
    return JSON.stringify(rung);
  }
  return String(rung == null ? '' : rung);
}

// Resolve a callable rung to its function. REPO_ROOT-relative module path.
// Returns { ok, fn, error }. Never throws (a missing module/function is a
// drift-lint failure, surfaced as ok:false, not a crash of the heal loop).
function resolveHealLadderRung(rung, opts = {}) {
  if (!isCallableRung(rung)) {
    return {
      ok: false,
      callable: false,
      error: 'not a callable rung (legacy string or malformed)',
    };
  }
  const repoRoot = opts.repoRoot || REPO_ROOT;
  const modPath = path.resolve(repoRoot, rung.module);
  let mod;
  try {
    mod = require(modPath);
  } catch (e) {
    return {
      ok: false,
      callable: true,
      error: `module not resolvable: ${rung.module} (${(e && e.message) || e})`,
    };
  }
  const fn = mod && mod[rung.function];
  if (typeof fn !== 'function') {
    return {
      ok: false,
      callable: true,
      error: `function '${rung.function}' not found or not callable in ${rung.module}`,
    };
  }
  return { ok: true, callable: true, fn };
}

// Validate EVERY object-form rung across the manifest. Legacy string rungs are
// counted (warnings) but never fail. Returns { ok, failures[], warnings, checked }.
// A refactor that renames/removes a referenced function fails here (and in the
// drift-lint that consumes this), per Phase 3 item 1.
function validateAllHealLadders(opts = {}) {
  const cards = opts.cards || allCards(opts.domainsPath);
  const failures = [];
  let stringRungs = 0;
  let objectRungs = 0;
  for (const card of cards) {
    for (const fm of card.failureModes || []) {
      const ladder = Array.isArray(fm.healLadder) ? fm.healLadder : [];
      for (let i = 0; i < ladder.length; i += 1) {
        const rung = ladder[i];
        if (isCallableRung(rung)) {
          objectRungs += 1;
          const r = resolveHealLadderRung(rung, opts);
          if (!r.ok) {
            failures.push({
              cardId: card.cardId,
              failureMode: fm.mode || null,
              rung: i,
              label: healLadderRungLabel(rung),
              error: r.error,
            });
          }
        } else {
          stringRungs += 1;
        }
      }
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    warnings: stringRungs,
    checked: objectRungs,
  };
}

// --- One owner per card (Phase 3, item 4) ------------------------------------
//
// The manifest declares EXACTLY ONE owning generator per card: card.owner =
// { module, function }. This is the generator/healer responsible for producing
// the card's artifact -- distinct from failureModes[].terminalDefect.owner, which
// is the HUMAN/TEAM accountable when self-heal is exhausted (Amy-engineering, Jeff).
// One declared owner is how "one owner per card" is enforced WITHOUT physically
// merging the two builder files (that collapse is deferred per the Phase 3 plan).

function cardOwner(card) {
  return card && card.owner ? card.owner : null;
}

// Validate owning generators. RATCHET semantics (mirrors manifest-coverage):
//   - A card with NO owner is a BASELINE GAP (reported in `unownedCardIds`), not a
//     hard failure -- so this lands incrementally without first researching the
//     generator for all 37 historical cards. The drift-lint ratchets the unowned
//     COUNT so it can only shrink, never grow (a new card MUST declare an owner).
//   - A DECLARED owner that is malformed, uncallable, or shares its
//     module#function with another card's owner (two cards claiming one generator
//     is still "one owner per card" only if each card's owner is distinct) is a
//     HARD FAILURE. owner.module+function must resolve to a real function, so a
//     refactor that renames/removes it fails here.
//   - A card may opt OUT explicitly with owner: { unowned: <reason> } (honest "no
//     single generator", e.g. a pure render-merge card); that is recorded, not failed.
// Returns { ok, failures[], owned, unowned, unownedCardIds, checked }.
function validateCardOwners(opts = {}) {
  const cards = opts.cards || allCards(opts.domainsPath);
  const failures = [];
  const unownedCardIds = [];
  let owned = 0;
  const ownerSeen = new Map(); // module#function -> first cardId that claimed it
  for (const card of cards) {
    const owner = cardOwner(card);
    if (!owner || owner.unowned) {
      unownedCardIds.push(card.cardId);
      continue;
    }
    if (!owner.module || !owner.function) {
      failures.push({
        cardId: card.cardId,
        error: 'owner malformed (needs { module, function } or { unowned: <reason> })',
      });
      continue;
    }
    const key = `${owner.module}#${owner.function}`;
    if (ownerSeen.has(key)) {
      failures.push({
        cardId: card.cardId,
        error: `owner ${key} is already the owner of '${ownerSeen.get(key)}' (one owner per card: each card needs a distinct owning generator)`,
      });
      continue;
    }
    const r = resolveHealLadderRung({ module: owner.module, function: owner.function }, opts);
    if (!r.ok) {
      failures.push({ cardId: card.cardId, error: `owner not callable: ${r.error}` });
      continue;
    }
    ownerSeen.set(key, card.cardId);
    owned += 1;
  }
  return {
    ok: failures.length === 0,
    failures,
    owned,
    unowned: unownedCardIds.length,
    unownedCardIds,
    checked: cards.length,
  };
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

// Runtime assertion (Phase 3, item 4): a card is FRESHLY-PUBLISHED for this build
// only if its owning generator ran this build. We do not invent a new run-receipt:
// the freshness signal IS the receipt -- the owning generator writes a dated
// artifact, and `observed.ageHours` (its age) within the card's freshness
// maxAgeHours proves it ran recently enough for THIS build. A card with no owner,
// or whose freshness acceptance fails (stale/missing artifact), is NOT freshly
// published, so the QC must not treat it as clean. Cards without a freshness
// acceptance fall back to their normal verdict (this gate is the freshness floor,
// not a replacement for count/zero-with-source predicates).
// Returns { freshlyPublished, reason }.
function cardFreshlyPublished(cardId, observed = {}, opts = {}) {
  const card = opts.card || loadCardContract(cardId, opts);
  if (!card) return { freshlyPublished: false, reason: `no manifest contract for ${cardId}` };
  const owner = cardOwner(card);
  if (!owner || owner.unowned) {
    return {
      freshlyPublished: false,
      reason: `card '${cardId}' has no owning generator, so its publish cannot be attributed to a build run`,
    };
  }
  const acc = (card.qc && card.qc.acceptance) || null;
  if (!acc || acc.kind !== 'freshness') {
    // No freshness floor declared: the freshly-published gate does not apply; the
    // ordinary verdict governs. We report attributable (owner exists) but note it.
    return {
      freshlyPublished: true,
      reason: `owner ${owner.module}#${owner.function} declared; no freshness floor to assert run-this-build`,
    };
  }
  const r = evalAcceptance(acc, observed);
  return {
    freshlyPublished: r.ok,
    reason: r.ok
      ? `owner ${owner.module}#${owner.function} ran this build (${r.reason})`
      : `owner ${owner.module}#${owner.function} did NOT run fresh: ${r.reason}`,
  };
}

module.exports = {
  loadDomains,
  allCards,
  loadCardContract,
  evalAcceptance,
  verdict,
  isCallableRung,
  healLadderRungLabel,
  resolveHealLadderRung,
  validateAllHealLadders,
  cardOwner,
  validateCardOwners,
  cardFreshlyPublished,
  manifestCardIds: mc.manifestCardIds,
  LADDER,
  DOMAINS_JSON,
};
