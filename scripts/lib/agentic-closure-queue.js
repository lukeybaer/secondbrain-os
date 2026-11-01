'use strict';

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function serializedLane() {
  let tail = Promise.resolve();
  let active = 0;
  let maxActive = 0;
  return {
    enqueue(fn) {
      const run = tail.then(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return await fn();
        } finally {
          active -= 1;
        }
      });
      tail = run.catch(() => {});
      return run;
    },
    snapshot() {
      return { active, maxActive };
    },
  };
}

async function runAgenticClosureQueue({
  jobs = [],
  concurrency = Number(process.env.AGENTIC_HEALER_CONCURRENCY || 2),
  createWorkspace,
  runWorker,
  prepare = null,
  integrate,
} = {}) {
  if (typeof createWorkspace !== 'function') throw new Error('createWorkspace is required');
  if (typeof runWorker !== 'function') throw new Error('runWorker is required');
  if (typeof integrate !== 'function') throw new Error('integrate is required');
  const cap = positiveInt(concurrency, 2);
  const lane = serializedLane();
  const results = new Array(jobs.length);
  let next = 0;

  async function process(index) {
    const job = jobs[index];
    let workspace;
    try {
      workspace = await createWorkspace(job, index);
    } catch (error) {
      workspace = { ok: false, error: String((error && error.message) || error) };
    }
    if (!workspace || workspace.ok === false || !workspace.cwd) {
      results[index] = {
        job,
        outcome: 'workspace-failed',
        error: String((workspace && workspace.error) || 'isolated workspace unavailable'),
        workspace: workspace || null,
      };
      return;
    }
    let worker;
    try {
      worker = await runWorker({ job, index, workspace });
    } catch (error) {
      results[index] = {
        job,
        outcome: 'worker-failed',
        error: String((error && error.message) || error),
        workspace,
      };
      return;
    }
    // Optional parallel pre-integration phase: it runs in this worker loop,
    // NOT in the serialized publish lane, so independent jobs' private-scope
    // work (tests, worktree commits) can overlap in time. A prepare failure
    // never loses the job; integrate falls back to its whole-call path.
    let prepared = null;
    if (typeof prepare === 'function') {
      try {
        prepared = await prepare({ job, index, workspace, worker });
      } catch (error) {
        prepared = null;
      }
    }
    let integration;
    try {
      integration = await lane.enqueue(() =>
        integrate({ job, index, workspace, worker, prepared }),
      );
    } catch (error) {
      integration = { ok: false, error: String((error && error.message) || error) };
    }
    results[index] = {
      job,
      workspace,
      worker,
      integration,
      outcome: integration && integration.ok ? 'integrated' : 'integration-failed',
      error: integration && integration.ok ? '' : String((integration && integration.error) || ''),
    };
  }

  async function workerLoop() {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      await process(index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(cap, jobs.length || 1) }, () => workerLoop()));
  return {
    concurrency: cap,
    jobs: results,
    publishLane: lane.snapshot(),
  };
}

const DEFAULT_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

// Batches every verified, code-changed prepared patch into one integration
// sweep instead of one land+deploy per closure id (PACKET E1, item 1). A
// caller enqueues a job's land-ready entry with `enqueue()`; the sweep fires
// when its interval elapses OR the caller calls `drainNow()` (its "pool
// drained" signal), whichever comes first, and then, inside this single
// serialized lane:
//   1. Lands every pending entry SEQUENTIALLY (one `land(entry)` call per
//      entry; land.js cannot batch multiple worktree commits into one call,
//      so sequential per-commit land is the accepted fallback). One entry's
//      land failure never blocks another entry's land -- each is an
//      independent worktree/commit, so the loop keeps going.
//   2. Deploys EXACTLY ONCE for the whole batch, covering every entry that
//      landed (`deploy({ entries, landResults, targetSha })`, targetSha the
//      last landed SHA -- land.js fast-forwards, so it is a superset
//      ancestor of every earlier land in the same sweep).
//   3. Runs `close(entry, { land, deploy })` for EVERY entry back to back,
//      even one whose own land or the batch deploy failed -- `close` is
//      responsible for shaping an honest pending/failed result in that case
//      (never a false clear). One closure id per entry is preserved end to
//      end; the sweep itself never runs whole-board QC -- `close` is always
//      scoped to its own entry.
// Each `enqueue()` promise resolves with that one entry's own `close()`
// result once its sweep runs.
function createIntegrationSweep({
  intervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  land,
  deploy,
  close,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof land !== 'function') throw new Error('land is required');
  if (typeof deploy !== 'function') throw new Error('deploy is required');
  if (typeof close !== 'function') throw new Error('close is required');
  const pending = [];
  let timer = null;
  let running = null;

  function clearTimer() {
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function schedule() {
    if (timer || pending.length === 0) return;
    timer = setTimeoutFn(() => {
      timer = null;
      runSweep();
    }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function runSweep() {
    if (running) return running;
    clearTimer();
    if (!pending.length) return Promise.resolve(null);
    const batch = pending.splice(0, pending.length);
    running = (async () => {
      const landResults = [];
      for (const entry of batch) {
        let result;
        try {
          result = await land(entry);
        } catch (error) {
          result = { ok: false, error: String((error && error.message) || error) };
        }
        landResults.push(
          result && typeof result === 'object'
            ? result
            : { ok: false, error: 'land returned no result' },
        );
      }
      const landedIndexes = landResults
        .map((result, index) => (result && result.ok ? index : -1))
        .filter((index) => index >= 0);
      let deployResult = null;
      if (landedIndexes.length) {
        const landedEntries = landedIndexes.map((index) => batch[index]);
        const landedResultsOnly = landedIndexes.map((index) => landResults[index]);
        const targetSha = landedResultsOnly[landedResultsOnly.length - 1].landedSha || '';
        try {
          deployResult = await deploy({
            entries: landedEntries,
            landResults: landedResultsOnly,
            targetSha,
          });
        } catch (error) {
          deployResult = { ok: false, error: String((error && error.message) || error) };
        }
        if (!deployResult || typeof deployResult !== 'object') {
          deployResult = { ok: false, error: 'deploy returned no result' };
        }
      }
      const closeResults = [];
      for (let index = 0; index < batch.length; index += 1) {
        const entry = batch[index];
        const landResult = landResults[index];
        let result;
        try {
          result = await close(entry, {
            land: landResult,
            deploy: landResult && landResult.ok ? deployResult : null,
          });
        } catch (error) {
          result = { ok: false, error: String((error && error.message) || error) };
        }
        closeResults.push(result);
        entry.resolve(result);
      }
      running = null;
      // A sweep that drained mid-flight left later enqueues scheduled; pick
      // those up too instead of waiting a full interval.
      if (pending.length) schedule();
      return { landResults, deployResult, closeResults };
    })();
    return running;
  }

  return {
    enqueue(entry) {
      return new Promise((resolve) => {
        pending.push({ ...entry, resolve, queuedAtMs: now() });
        schedule();
      });
    },
    // The caller's "pool drained" signal: run the sweep right now instead of
    // waiting out the rest of the interval. Safe to call when nothing is
    // pending (no-op) or while a sweep is already running (joins it).
    drainNow() {
      return runSweep();
    },
    pendingCount() {
      return pending.length;
    },
    snapshot() {
      return { pendingCount: pending.length, sweeping: !!running };
    },
  };
}

module.exports = {
  runAgenticClosureQueue,
  positiveInt,
  createIntegrationSweep,
  DEFAULT_SWEEP_INTERVAL_MS,
};
