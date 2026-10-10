#!/usr/bin/env node
/**
 * verify-heal-ladder-refs.js
 *
 * DRIFT-LINT for "the manifest is a runtime spec" (Staying Green, Phase 3, items
 * 1 + 4). dev-plans/_domains.json declares, per card, a heal ladder and an owning
 * generator. This lint FAILS (exit 1) if either declaration drifts from the code:
 *
 *   1. CALLABLE HEAL LADDERS. Every OBJECT-form heal-ladder rung
 *      ({ module, function, args }) must resolve to a real, callable function. A
 *      refactor that renames or deletes a referenced function fails here. Legacy
 *      free-text string rungs are accepted (counted as warnings) so the migration
 *      lands incrementally -- they are simply not callable yet.
 *
 *   2. ONE OWNER PER CARD (ratchet). A card's declared owner (card.owner =
 *      { module, function }) must resolve to a real callable function, and no two
 *      cards may share one owning generator (one owner per card means a DISTINCT
 *      owner per card). Cards that have not yet declared an owner are a BASELINE
 *      GAP: the lint ratchets the unowned COUNT against MAX_UNOWNED so it can only
 *      shrink -- a NEW card must declare an owner, and you may only lower the
 *      baseline, never raise it.
 *
 * USAGE:
 *   node scripts/verify-heal-ladder-refs.js
 *   npm run verify:heal-ladder-refs
 *
 * EXIT CODES: 0 no drift; 1 drift detected (each violation printed).
 *
 * The check is exported pure (it takes an opts.cards array) so the regression test
 * can run it against the real manifest (passes) and against synthetic fixtures with
 * an unresolvable rung / a missing owner / a duplicate owner (fails). No network.
 */
'use strict';

const v = require('./self-heal/verdict.js');

// The current count of cards in dev-plans/_domains.json that have NOT yet declared
// an owning generator. This is a RATCHET: lower it as cards gain owners; the lint
// fails if the real count EXCEEDS it (a new unowned card slipped in). Never raise it.
const MAX_UNOWNED = 37;

function runDrift(opts = {}) {
  const failures = [];

  // 1. Callable heal ladders: every object-form rung resolves.
  const ladders = v.validateAllHealLadders(opts);
  for (const f of ladders.failures) {
    failures.push(
      `heal-ladder rung unresolvable: card '${f.cardId}' failureMode '${f.failureMode || '?'}' rung #${f.rung} (${f.label}) -> ${f.error}`,
    );
  }

  // 2. One owner per card: declared owners callable + distinct; unowned ratcheted.
  const owners = v.validateCardOwners(opts);
  for (const f of owners.failures) {
    failures.push(`card owner invalid: '${f.cardId}' -> ${f.error}`);
  }
  if (owners.unowned > MAX_UNOWNED) {
    failures.push(
      `${owners.unowned} cards lack an owning generator but the ratchet allows at most ${MAX_UNOWNED}. A new card must declare card.owner = { module, function } (or { unowned: <reason> }). Unowned: ${owners.unownedCardIds.join(', ')}.`,
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    callableRungs: ladders.checked,
    legacyStringRungs: ladders.warnings,
    ownedCards: owners.owned,
    unownedCards: owners.unowned,
    maxUnowned: MAX_UNOWNED,
  };
}

function main() {
  const result = runDrift();
  if (result.ok) {
    console.log(
      `heal-ladder + owner drift-lint PASS: ${result.callableRungs} callable rung(s) all resolvable (${result.legacyStringRungs} legacy string rung(s) pending migration), ${result.ownedCards} card(s) owned, ${result.unownedCards}/${result.maxUnowned} unowned within ratchet.`,
    );
    process.exit(0);
  }
  console.error(`heal-ladder + owner drift-lint FAILED: ${result.failures.length} drift issue(s):`);
  for (const f of result.failures) console.error('  - ' + f);
  process.exit(1);
}

module.exports = { runDrift, MAX_UNOWNED };

if (require.main === module) main();
