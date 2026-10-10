#!/usr/bin/env node
'use strict';

const {
  cleanupCompletedEvents,
  connectJsonRpcReceiver,
  recordListenerHeartbeat,
  retryPending,
  retryUnadmittedJournal,
} = require('./lib/signal-ingest.js');

async function main() {
  await retryUnadmittedJournal();
  await retryPending();
  cleanupCompletedEvents();
  const stateRoot = process.env.SIGNAL_INGEST_ROOT;
  const stop = connectJsonRpcReceiver({ stateRoot });
  const heartbeatTimer = setInterval(
    () => recordListenerHeartbeat(stateRoot, { ...stop.getState(), detail: 'listener-heartbeat' }),
    60_000,
  );
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      clearInterval(heartbeatTimer);
      stop();
      process.exit(0);
    });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[signal-ingest] fatal: ${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = { main };
