#!/usr/bin/env node
'use strict';

const http = require('node:http');
const { readSignalFlowHealth } = require('./lib/signal-flow-health.js');

function getJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Accept: 'application/json' } }, (response) => {
      let raw = '';
      response.on('data', (chunk) => (raw += chunk));
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw || '{}'));
        } catch {
          resolve({ raw });
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

async function health(options = {}) {
  const stateRoot = options.stateRoot || process.env.SIGNAL_INGEST_ROOT || '/opt/secondbrain-durable/signal-ingest';
  let daemon;
  try {
    daemon = { ok: true, response: await (options.getJson || getJson)('http://127.0.0.1:7584/api/v1/check') };
  } catch (error) {
    daemon = { ok: false, error: error.message };
  }
  const flow = (options.readSignalFlowHealth || readSignalFlowHealth)({
    stateRoot,
    now: options.now || new Date(),
  });
  const ok = daemon.ok && flow.ok;
  return {
    ...flow,
    schema: 'amy.signal.ingest-health.v2',
    checkedAt: new Date().toISOString(),
    daemon,
    ok,
  };
}

function activationReady(result) {
  const completeness = (result.metrics || []).find(
    (metric) => metric.id === 'signal-flow-message-completeness',
  );
  const downstream = (result.metrics || []).filter(
    (metric) => metric.id !== 'signal-flow-message-completeness',
  );
  const expectedWarmupProblems = (completeness?.problems || []).every(
    (problem) =>
      /receiver-journal coverage/i.test(problem) ||
      /admitted event\(s\) lack a receiver-journal source record/i.test(problem),
  );
  return Boolean(
    result.daemon?.ok &&
      result.listener?.ok &&
      result.listener?.receiveMode === 'manual' &&
      result.listener?.subscriptionActive &&
      completeness &&
      Number(completeness.duplicateJournalRecords || 0) === 0 &&
      expectedWarmupProblems &&
      downstream.length === 5 &&
      downstream.every((metric) => metric.status === 'green'),
  );
}

async function main() {
  const result = await health();
  const allowCoverageBuilding = process.argv.includes('--allow-coverage-building');
  const output = allowCoverageBuilding
    ? { ...result, activationReady: activationReady(result) }
    : result;
  console.log(JSON.stringify(output, null, 2));
  if (!result.ok && !(allowCoverageBuilding && output.activationReady)) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = { activationReady, getJson, health };
