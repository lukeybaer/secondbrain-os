'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCHEMA = 'neo4j.resource_cap.v1';
const DEFAULT_CONTAINER = 'secondbrain-neo4j';
const DEFAULT_CPUS = 1.5;
const DEFAULT_TIMEOUT_MS = 10000;
const RECEIPT_REL = path.join('agent', 'neo4j-resource-cap-latest.json');

function defaultDataDir() {
  return (
    process.env.SECONDBRAIN_DATA_DIR ||
    (process.platform === 'linux'
      ? '/opt/secondbrain/data'
      : path.join(
          process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
          'secondbrain',
          'data',
        ))
  );
}

function receiptPath(dataDir = defaultDataDir()) {
  return path.join(dataDir, RECEIPT_REL);
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function executeDockerDefault(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error ? result.error.message : '',
  };
}

function commandFailure(result, action) {
  if (result && result.status === 0) return '';
  return [
    action,
    result && result.error,
    result && result.stderr,
    result && result.stdout,
  ]
    .filter(Boolean)
    .join(': ')
    .trim();
}

function inspectCpus(executeDocker, container, timeoutMs) {
  const result = executeDocker(
    ['inspect', '--format', '{{.HostConfig.NanoCpus}}', container],
    { timeoutMs },
  );
  const failure = commandFailure(result, 'docker inspect failed');
  if (failure) throw new Error(failure);
  const nanoCpus = Number(String(result.stdout || '').trim());
  if (!Number.isFinite(nanoCpus) || nanoCpus < 0) {
    throw new Error(`docker inspect returned invalid NanoCpus: ${String(result.stdout || '').trim()}`);
  }
  return nanoCpus / 1e9;
}

function sameCap(actual, expected) {
  return Math.abs(Number(actual) - Number(expected)) < 0.000001;
}

function ensureNeo4jCpuCap({
  dataDir = defaultDataDir(),
  container = DEFAULT_CONTAINER,
  cpus = DEFAULT_CPUS,
  apply = false,
  now = new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  executeDocker = executeDockerDefault,
} = {}) {
  const expectedCpus = Number(cpus);
  let receipt;
  try {
    const beforeCpus = inspectCpus(executeDocker, container, timeoutMs);
    if (sameCap(beforeCpus, expectedCpus)) {
      receipt = {
        schema: SCHEMA,
        generatedAt: now.toISOString(),
        status: 'clean',
        container,
        expectedCpus,
        observedCpus: beforeCpus,
        applied: false,
        detail: `${container} is capped at ${expectedCpus} CPUs.`,
      };
    } else if (!apply) {
      receipt = {
        schema: SCHEMA,
        generatedAt: now.toISOString(),
        status: 'defect',
        container,
        expectedCpus,
        observedCpus: beforeCpus,
        applied: false,
        detail: `${container} CPU cap is ${beforeCpus}; expected ${expectedCpus}.`,
      };
    } else {
      const update = executeDocker(
        ['update', `--cpus=${expectedCpus}`, container],
        { timeoutMs },
      );
      const updateFailure = commandFailure(update, 'docker update failed');
      if (updateFailure) throw new Error(updateFailure);
      const afterCpus = inspectCpus(executeDocker, container, timeoutMs);
      receipt = {
        schema: SCHEMA,
        generatedAt: now.toISOString(),
        status: sameCap(afterCpus, expectedCpus) ? 'clean' : 'defect',
        container,
        expectedCpus,
        observedCpus: afterCpus,
        previousCpus: beforeCpus,
        applied: true,
        detail: sameCap(afterCpus, expectedCpus)
          ? `${container} was capped and reverified at ${expectedCpus} CPUs.`
          : `${container} remained at ${afterCpus} CPUs after update; expected ${expectedCpus}.`,
      };
    }
  } catch (error) {
    receipt = {
      schema: SCHEMA,
      generatedAt: now.toISOString(),
      status: 'blocked',
      container,
      expectedCpus,
      observedCpus: null,
      applied: false,
      detail: String((error && error.message) || error),
    };
  }
  writeJsonAtomic(receiptPath(dataDir), receipt);
  return receipt;
}

function readNeo4jCpuCapReceipt(dataDir = defaultDataDir()) {
  try {
    return JSON.parse(fs.readFileSync(receiptPath(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

function classifyNeo4jCpuCapReceipt(receipt, {
  now = new Date(),
  required = true,
  maxAgeHours = 36,
} = {}) {
  if (!receipt) {
    return required
      ? { status: 'red', detail: 'Neo4j CPU cap proof is missing.', canAutoHeal: true }
      : { status: 'green', detail: 'Neo4j CPU cap is enforced only on the EC2 host.' };
  }
  const ageHours = (now.getTime() - Date.parse(receipt.generatedAt || 0)) / 3600000;
  if (
    receipt.status !== 'clean' ||
    !sameCap(receipt.observedCpus, receipt.expectedCpus || DEFAULT_CPUS)
  ) {
    return {
      status: 'red',
      detail: receipt.detail || 'Neo4j CPU cap proof is not clean.',
      generatedAt: receipt.generatedAt,
      canAutoHeal: true,
    };
  }
  if (!Number.isFinite(ageHours) || ageHours > maxAgeHours) {
    return {
      status: 'yellow',
      detail: `Neo4j CPU cap proof is stale (${Math.round(ageHours)}h old).`,
      generatedAt: receipt.generatedAt,
      canAutoHeal: true,
    };
  }
  return {
    status: 'green',
    detail: `${receipt.container || DEFAULT_CONTAINER} capped at ${receipt.observedCpus} CPUs; proof ${Math.round(ageHours * 60)}m old.`,
    generatedAt: receipt.generatedAt,
  };
}

function probeNeo4jCpuCap({ dataDir = defaultDataDir(), now = new Date(), required = true } = {}) {
  return classifyNeo4jCpuCapReceipt(readNeo4jCpuCapReceipt(dataDir), { now, required });
}

function healNeo4jCpuCap({ dataDir = defaultDataDir(), now = new Date() } = {}) {
  const result = ensureNeo4jCpuCap({ dataDir, now, apply: true });
  return {
    target: 'neo4jCpuCap',
    healed: result.status === 'clean',
    action: 'enforced docker CPU cap and reverified HostConfig.NanoCpus',
    detail: result.detail,
  };
}

module.exports = {
  SCHEMA,
  DEFAULT_CONTAINER,
  DEFAULT_CPUS,
  RECEIPT_REL,
  defaultDataDir,
  receiptPath,
  ensureNeo4jCpuCap,
  readNeo4jCpuCapReceipt,
  classifyNeo4jCpuCapReceipt,
  probeNeo4jCpuCap,
  healNeo4jCpuCap,
};
