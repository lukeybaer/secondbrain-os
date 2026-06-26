'use strict';

// scripts/self-heal/heal-loop.js
//
// The full self-heal cycle for ONE card, the cycle ExampleCo specified: each iteration is
//   decide -> (if heal) apply the next untried option in an isolated worktree ->
//   land to master -> DEPLOY to EC2 prod -> VERIFY on the live dashboard ->
//   record the outcome in the durable attempt ledger -> re-decide.
// A fix is only "healed" when it is deployed AND verified green in prod. If it is still
// broken after deploy+verify, the option is recorded as failed and the loop moves to the
// NEXT untried unique option. It gives up (blocked, honest hard-block) ONLY at true
// exhaustion, never repeating an option, with memory ExampleCod across iterations and nights.
//
// The side-effecting steps are INJECTED (deps) so this is unit-testable with mocks and so
// the live wiring (real worktree apply, land, EC2 deploy, dashboard verify) lives at the
// edge. The loop is condition-bounded (healed | exhausted | budget), never count-bounded.
//
// deps:
//   observe(cardId)            -> observed state object for verdict (e.g. { articleCount })
//   applyFix(cardId, option)   -> { ok, commit?, reason? }   worktree -> fix -> land
//   deploy(commit)             -> { ok, deployRef?, reason? } promote to EC2 prod
//   verify(cardId)             -> { ok, observed?, reason? }  live-dashboard QC in prod

const { decideHeal, recordHealOutcome } = require('./heal-decision.js');

async function healCard(cardId, deps = {}, opts = {}) {
  const { observe, applyFix, deploy, verify } = deps;
  const now = opts.now || (() => Date.now());
  const deadline = opts.budgetMs ? now() + opts.budgetMs : Infinity;
  // Absolute cap on apply cycles, independent of ladder length. Default Infinity so
  // existing callers (loop to true exhaustion) are unchanged; the overnight
  // finalization gate passes a finite maxApplied as the 5:30am-build safety bound so
  // a never-verifying defect can never apply more than maxApplied options in one run.
  const maxApplied = Number.isFinite(opts.maxApplied) ? opts.maxApplied : Infinity;
  let appliedCount = 0;
  const trace = [];

  while (true) {
    if (now() > deadline) {
      return {
        cardId,
        status: 'timeout',
        trace,
        note: 'heal budget exhausted before pass or true exhaustion',
      };
    }
    if (appliedCount >= maxApplied) {
      return {
        cardId,
        status: 'capped',
        trace,
        note: `heal apply cap reached (${maxApplied}) before pass or true exhaustion`,
      };
    }

    const observed = await observe(cardId);
    const decision = decideHeal(cardId, observed, opts.healRecord, opts);

    if (decision.action === 'pass') return { cardId, status: 'healed', trace, decision };
    if (decision.action === 'blocked') {
      // True exhaustion: the honest hard-block (lists every option tried and why).
      return {
        cardId,
        status: 'blocked',
        honestBlock: decision.honestBlock,
        attempts: decision.attempts,
        trace,
      };
    }

    // action === 'heal': try the next untried unique option through the full cycle.
    const option = decision.option;
    const step = { option };

    appliedCount += 1;
    const applied = await applyFix(cardId, option);
    if (!applied || !applied.ok) {
      recordHealOutcome(
        cardId,
        {
          option,
          outcome: 'failed',
          failureReason: (applied && applied.reason) || 'apply failed',
          ts: opts.ts,
        },
        opts,
      );
      trace.push({ ...step, outcome: 'apply-failed' });
      continue;
    }

    const deployed = await deploy(applied.commit);
    if (!deployed || !deployed.ok) {
      recordHealOutcome(
        cardId,
        {
          option,
          outcome: 'deploy-failed',
          failureReason: (deployed && deployed.reason) || 'deploy failed',
          commit: applied.commit,
          ts: opts.ts,
        },
        opts,
      );
      trace.push({ ...step, outcome: 'deploy-failed', commit: applied.commit });
      continue;
    }

    const verified = await verify(cardId);
    if (verified && verified.ok) {
      recordHealOutcome(
        cardId,
        {
          option,
          outcome: 'deployed-verified',
          commit: applied.commit,
          deployRef: deployed.deployRef,
          ts: opts.ts,
        },
        opts,
      );
      trace.push({
        ...step,
        outcome: 'deployed-verified',
        commit: applied.commit,
        deployRef: deployed.deployRef,
      });
      return {
        cardId,
        status: 'healed',
        commit: applied.commit,
        deployRef: deployed.deployRef,
        trace,
      };
    }

    // Deployed but still broken in prod: record the failed option, advance to the next.
    recordHealOutcome(
      cardId,
      {
        option,
        outcome: 'failed',
        failureReason: (verified && verified.reason) || 'still failing after deploy',
        commit: applied.commit,
        deployRef: deployed.deployRef,
        ts: opts.ts,
      },
      opts,
    );
    trace.push({ ...step, outcome: 'verify-failed', commit: applied.commit });
  }
}

module.exports = { healCard };
