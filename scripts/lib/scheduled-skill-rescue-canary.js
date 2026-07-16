'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RECEIPT_DIR = path.join('agent', 'post-release-canaries');
const LATEST_FILE = 'scheduled-skill-rescue-latest.json';

function normalized(value) {
  return path.resolve(String(value || ''));
}

function samePath(a, b) {
  if (!a || !b) return false;
  return normalized(a).toLowerCase() === normalized(b).toLowerCase();
}

function safeSha(value) {
  return String(value || 'ExampleCo')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .slice(0, 80) || 'ExampleCo';
}

function rescueCanaryLatestPath(dataDir) {
  return path.join(dataDir, RECEIPT_DIR, LATEST_FILE);
}

function rescueCanaryReleasePath(dataDir, releaseSha) {
  return path.join(
    dataDir,
    RECEIPT_DIR,
    `${safeSha(releaseSha)}-scheduled-skill-rescue.json`,
  );
}

function buildRescueCanaryReceipt(input = {}) {
  const worktreeProof = input.worktreeProof || {};
  const observedOutput = String(input.observedOutput || '').trim();
  const expectedSentinel = String(input.expectedSentinel || '').trim();
  const probes = {
    releaseRootWasNonGit: input.releaseRootState === 'not-worktree',
    sourceRootWasGit: input.sourceRootState === 'worktree',
    worktreeWasIsolated: worktreeProof.proven === true,
    worktreeDistinctFromRelease:
      !!input.worktreeRoot && !samePath(input.worktreeRoot, input.releaseRoot),
    worktreeDistinctFromSource:
      !!input.worktreeRoot && !samePath(input.worktreeRoot, input.sourceRoot),
    runtimeDataDirPreserved:
      !!input.runtimeDataDir && samePath(input.runtimeDataDir, input.expectedDataDir),
    claudeFailureForced: input.forcedClaudeFailure === true,
    codexSentinelExact:
      input.rung === 'codex' && !!expectedSentinel && observedOutput === expectedSentinel,
  };
  const failures = Object.entries(probes)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  if (input.failureReason) failures.push(String(input.failureReason));
  return {
    schemaVersion: 1,
    ts: (input.now || new Date()).toISOString(),
    kind: 'post-release-scheduled-skill-rescue',
    releaseSha: String(input.releaseSha || ''),
    releaseRoot: String(input.releaseRoot || ''),
    sourceRoot: String(input.sourceRoot || ''),
    worktreeRoot: String(input.worktreeRoot || ''),
    runtimeDataDir: String(input.runtimeDataDir || ''),
    rung: String(input.rung || 'none'),
    forcedClaudeFailure: input.forcedClaudeFailure === true,
    expectedSentinel,
    observedOutput,
    worktreeProof: {
      proven: worktreeProof.proven === true,
      state: String(worktreeProof.state || 'unproven'),
      reason: String(worktreeProof.reason || ''),
    },
    probes,
    ok: failures.length === 0,
    failures,
    observational: true,
    rollbackEligible: false,
  };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function writeRescueCanaryReceipt(dataDir, receipt) {
  const releasePath = rescueCanaryReleasePath(dataDir, receipt && receipt.releaseSha);
  const latestPath = rescueCanaryLatestPath(dataDir);
  writeJsonAtomic(releasePath, receipt);
  writeJsonAtomic(latestPath, receipt);
  return { receipt, releasePath, latestPath };
}

function readRescueCanaryReceipt(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(rescueCanaryLatestPath(dataDir), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function classifyRescueCanaryReceipt(receipt, options = {}) {
  const expectedReleaseSha = String(options.expectedReleaseSha || '');
  if (!receipt) {
    return {
      status: 'yellow',
      state: 'missing',
      detail: expectedReleaseSha
        ? `Post-release scheduled-skill rescue canary has no proof for current release ${expectedReleaseSha.slice(0, 12)}.`
        : 'Post-release scheduled-skill rescue canary has no receipt yet.',
    };
  }
  if (expectedReleaseSha && String(receipt.releaseSha || '') !== expectedReleaseSha) {
    return {
      status: 'yellow',
      state: 'historical',
      detail:
        `Post-release scheduled-skill rescue canary is historical: prior release ` +
        `${String(receipt.releaseSha || 'ExampleCo').slice(0, 12)} ${receipt.ok ? 'passed' : 'failed'}; ` +
        `current release ${expectedReleaseSha.slice(0, 12)} awaits its own proof.`,
      receipt,
    };
  }
  const requiredProbes = [
    'releaseRootWasNonGit',
    'sourceRootWasGit',
    'worktreeWasIsolated',
    'worktreeDistinctFromRelease',
    'worktreeDistinctFromSource',
    'runtimeDataDirPreserved',
    'claudeFailureForced',
    'codexSentinelExact',
  ];
  const proofFailures = requiredProbes.filter((name) => receipt.probes?.[name] !== true);
  if (receipt.observational !== true) proofFailures.push('observational');
  if (receipt.rollbackEligible !== false) proofFailures.push('rollbackEligible');
  if (receipt.rung !== 'codex') proofFailures.push('rung');
  if (receipt.forcedClaudeFailure !== true) proofFailures.push('forcedClaudeFailure');
  if (receipt.worktreeProof?.proven !== true) proofFailures.push('worktreeProof');
  if (!receipt.worktreeRoot || samePath(receipt.worktreeRoot, receipt.releaseRoot)) {
    proofFailures.push('worktreeDistinctFromReleasePath');
  }
  if (!receipt.worktreeRoot || samePath(receipt.worktreeRoot, receipt.sourceRoot)) {
    proofFailures.push('worktreeDistinctFromSourcePath');
  }
  if (
    !receipt.expectedSentinel ||
    String(receipt.observedOutput || '').trim() !== String(receipt.expectedSentinel).trim()
  ) {
    proofFailures.push('exactSentinel');
  }
  if (!receipt.ok || proofFailures.length) {
    const named = [
      ...(Array.isArray(receipt.failures) ? receipt.failures : []),
      ...proofFailures,
    ];
    return {
      status: 'red',
      state: 'current-failure',
      detail:
        `Current release rescue canary ${receipt.ok ? 'proof incomplete' : 'failed'}: ${
          [...new Set(named)].join(', ') || 'proof incomplete'
        }.`,
      receipt,
    };
  }
  return {
    status: 'green',
    state: 'current-clean',
    detail:
      `Post-release rescue canary passed for ${String(receipt.releaseSha || 'ExampleCo').slice(0, 12)}: ` +
      'forced Claude failure reached Codex in a proven isolated source worktree with runtime data preserved.',
    receipt,
  };
}

module.exports = {
  buildRescueCanaryReceipt,
  classifyRescueCanaryReceipt,
  readRescueCanaryReceipt,
  rescueCanaryLatestPath,
  rescueCanaryReleasePath,
  writeRescueCanaryReceipt,
};
