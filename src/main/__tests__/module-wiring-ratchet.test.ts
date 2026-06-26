import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  buildWiringDigest,
  checkWiringRatchet,
  renderWiringHeadline,
  WIRING_BASELINE,
} from '../module-wiring-audit';

// Live ratchet against the real src/main tree (not synthetic fixtures - those
// live in module-wiring-audit.test.ts). This is the hard gate: it scans the
// actual codebase on every run and FAILS if the count of orphaned
// (built-but-unwired) modules, or their total dead-weight lines, rose above the
// committed WIRING_BASELINE. run-tests-before-pr.sh runs vitest before every
// push, so a nightly run that ships a tested-but-unwired module turns this red
// and is blocked until the module is wired into a runtime importer (or the
// baseline is lowered in the SAME commit after a genuine reduction).
//
// This is the enforcement half of feedback_nightly_runs_must_wire_not_orphan;
// the observability half (the boot-time self-health warning) was already wired
// but soft. A category gate, not a single-trigger pin: it catches ANY future
// orphan regression, not one named module.

const SRC_MAIN = path.resolve(__dirname, '..');

describe('module wiring ratchet (live src/main)', () => {
  it('does not regress orphan count or dead-weight lines past WIRING_BASELINE', () => {
    const audit = buildWiringDigest(SRC_MAIN);
    const verdict = checkWiringRatchet(audit);

    // Surface the full picture on failure so the diff is self-explanatory.
    if (!verdict.ok) {
      console.error(renderWiringHeadline(audit));

      console.error(verdict.message);
    }

    expect(verdict.ok, verdict.message).toBe(true);
  });

  it('pins the run-119 baseline (lowered after wiring 3 orphans into self-health)', () => {
    // Run 119 wired token-budget-governor, memory-archival-recommender, and
    // ingest-queue into self-health-digest, dropping the live count
    // 63->61 / 16731->15717. This pin documents the locked reduction; the live
    // gate above enforces it.
    expect(WIRING_BASELINE.orphanModules).toBe(61);
    expect(WIRING_BASELINE.deadWeightLines).toBe(15717);
  });

  it('keeps the committed baseline honest (a sanity bound, not the gate)', () => {
    // If someone wires enough orphans that the live count drops well under the
    // baseline, this nudges them to lower it - a stale-high baseline silently
    // re-opens the door. Generous slack so normal churn does not trip it; the
    // real gate is the regression test above.
    const audit = buildWiringDigest(SRC_MAIN);
    expect(
      audit.orphanModules,
      `Live orphans (${audit.orphanModules}) are far under baseline ` +
        `(${WIRING_BASELINE.orphanModules}). Lower WIRING_BASELINE in ` +
        `module-wiring-audit.ts to lock in the reduction.`,
    ).toBeGreaterThan(WIRING_BASELINE.orphanModules - 15);
  });
});
