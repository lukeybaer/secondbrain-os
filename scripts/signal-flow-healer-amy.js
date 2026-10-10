#!/usr/bin/env node
'use strict';

const { cleanupCompletedEvents, retryPending, retryUnadmittedJournal } = require('./lib/signal-ingest.js');
const { withEventLease } = require('./lib/signal-flow-cycles.js');
const { readSignalFlowHealth } = require('./lib/signal-flow-health.js');
const { runPeopleProjection } = require('./lib/signal-people-project.js');

async function runOnce(options = {}) {
  const stateRoot =
    options.stateRoot || process.env.SIGNAL_INGEST_ROOT || '/opt/secondbrain-durable/signal-ingest';
  const owned = await (options.withFlowLease || withEventLease)(
    stateRoot,
    () => runOwned({ ...options, stateRoot }),
    { staleMs: 30 * 60 * 1000 },
  );
  if (owned.acquired) return owned.value;
  const health = (options.readSignalFlowHealth || readSignalFlowHealth)({ stateRoot });
  console.log(`[signal-flow] run=deferred reason=${owned.reason} open=${health.openEventIds?.length || 0}`);
  return {
    schema: 'amy.signal.flow-healer-run.v1',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    deferred: true,
    reason: owned.reason,
    health,
    errors: [],
    ok: health.ok,
  };
}

async function runOwned(options = {}) {
  const stateRoot = options.stateRoot;
  const result = {
    schema: 'amy.signal.flow-healer-run.v1',
    startedAt: new Date().toISOString(),
    capture: null,
    people: null,
    cleanup: 0,
    errors: [],
  };
  try {
    const admission = await (options.retryUnadmittedJournal || retryUnadmittedJournal)({
      ...options,
      stateRoot,
      limit: 25,
    });
    const stages = await (options.retryPending || retryPending)({ ...options, stateRoot, limit: 25 });
    result.capture = { admission, stages };
  } catch (error) {
    result.errors.push({ stage: 'capture', message: String(error.message || error).slice(0, 1000) });
  }
  try {
    result.people = await (options.runPeopleProjection || runPeopleProjection)({
      ...options,
      stateRoot,
      limit: 100,
    });
    if (result.people?.ok === false) {
      result.errors.push({
        stage: 'people',
        message: `${result.people.errors?.length || 1} People event(s) remain pending`,
      });
    }
  } catch (error) {
    result.errors.push({ stage: 'people', message: String(error.message || error).slice(0, 1000) });
  }
  result.cleanup = (options.cleanupCompletedEvents || cleanupCompletedEvents)(stateRoot, options);
  result.health = (options.readSignalFlowHealth || readSignalFlowHealth)({ stateRoot });
  result.completedAt = new Date().toISOString();
  result.ok = result.errors.length === 0 && result.health.ok;
  for (const metric of result.health.metrics || []) {
    console.log(
      `[signal-flow] window=24h metric=${metric.id} status=${metric.status} complete=${metric.complete}/${metric.expected ?? metric.admitted} pending=${metric.pending}`,
    );
  }
  console.log(
    `[signal-flow] run=${result.ok ? 'green' : 'non-green'} errors=${result.errors.length} open=${result.health.openEventIds?.length || 0}`,
  );
  return result;
}

async function main() {
  const result = await runOnce();
  if ((result.errors?.length || 0) > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[signal-flow] fatal: ${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = { main, runOnce };
