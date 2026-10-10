'use strict';

// Parallel heal scheduler (step-3 of managing-complex-scope-2026-06-14.html).
//
// The overnight/mid-day self-heal was sequential ("no git race", one blocker at a
// time). Now that session isolation landed (per-session worktrees), independent
// heals can run concurrently; only the steps that touch a shared resource (the git
// landing) must serialize. This is the design the self-heal one-pager and ExampleCo both
// call for: parallel fan-out, serialize git, no fixed mid-day timer.
//
// Pure and injectable: the caller passes runOne(item, index) -> Promise<result>.
// Concurrency is bounded. A serializer mutex is provided for the git-landing
// section so two heals never push at once even while their WORK runs in parallel.
// Fully unit-testable with stub runOne; no git or filesystem here.

// Run items concurrently, bounded by `concurrency`. One item throwing does not
// abort the others; its slot gets {status:'error', error, index}. Returns results
// in input order.
async function runHeals(items, runOne, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Math.min(opts.concurrency || 4, list.length || 1));
  const results = new Array(list.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      try {
        results[i] = await runOne(list[i], i);
      } catch (e) {
        results[i] = { status: 'error', error: String((e && e.message) || e), index: i };
      }
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(concurrency, list.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// A serialized critical section. serialize(fn) runs fns one at a time in call order,
// even when invoked from many concurrent workers. Use it to wrap the git landing so
// pushes never race. An error in one section does not break the chain for the rest.
function createSerializer() {
  let chain = Promise.resolve();
  return function serialize(fn) {
    const run = chain.then(() => fn());
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

// Partition blockers into the ones a heal session can run in parallel vs the ones
// that must be serialized because they touch a shared resource. A blocker is
// git-serialized if its heal is expected to commit/push to the shared remote without
// worktree isolation; with worktree isolation (isolated:true) even those parallelize
// and only the landing serializes. Pure classifier.
function classifyConcurrency(blocker, { isolated = false } = {}) {
  // With per-session worktree isolation, the WORK is always parallel-safe; only the
  // landing serializes (handled by the serializer). Without isolation, anything that
  // writes the shared tree must run serially.
  if (isolated) return { parallel: true, serializeLanding: true };
  return { parallel: false, serializeLanding: true };
}

module.exports = { runHeals, createSerializer, classifyConcurrency };
