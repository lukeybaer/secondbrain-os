'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'amy.voice-release-proof.v1';
const DEFAULT_SURFACE_FILES = Object.freeze([
  'config/voice-runtime-policy.json',
  'ec2-server.js',
  'scripts/callback-watchdog.js',
  'scripts/outbound-call-control.js',
  'scripts/push-amy-vapi-config.js',
  'scripts/vapi-end-of-call.js',
  'scripts/vapi-self-call-status-test.js',
  'scripts/lib/outbound-call-broker.js',
  'scripts/lib/vapi-listen-opening-watcher.js',
  'scripts/lib/outbound-call-control.js',
  // Decides what a phone status question is answered with (check_spine). The
  // release proof asks that question, so this file is part of what it proves.
  'scripts/lib/dispatch-delivery.js',
  'scripts/lib/inference-work-ledger.js',
  'scripts/lib/codex-app-server-client.js',
  'scripts/lib/codex-voice-attempt-telemetry.js',
  'scripts/lib/claude-voice-subscription-client.js',
  'scripts/lib/voice-lane-router.js',
  'scripts/lib/voice-paid-fallback.js',
  'scripts/lib/voice-primary.js',
  'scripts/lib/voice-internal-self-test.js',
  'scripts/lib/voice-turn-coordinator.js',
  'scripts/lib/voice-traffic-priority.js',
  'scripts/lib/briefing-dashboard-cache.js',
  'scripts/lib/briefing-people-index-cache.js',
  'scripts/lib/cli-output-guard.js',
  'scripts/lib/vapi-call-correlation.js',
  'scripts/lib/vapi-live-assistant.js',
  'scripts/lib/vapi-static-model.js',
  'scripts/lib/vapi-tool-contract.js',
  'scripts/lib/vapi-voice-decision.js',
  'scripts/lib/vapi-voice-output.js',
  'scripts/lib/voice-cloud-inference.js',
  'scripts/lib/voice-self-test-status-seed.js',
  'scripts/lib/voice-release-proof.js',
  'src/main/amy-versions.ts',
  'src/main/calls.ts',
  'src/main/vapi-model-headers.ts',
]);

function defaultRootDir() {
  return path.resolve(__dirname, '..', '..');
}

function proofPath(opts = {}) {
  if (opts.proofPath) return opts.proofPath;
  if (!opts.dataDir) throw new Error('voice release proof requires dataDir or proofPath');
  return path.join(opts.dataDir, 'agent', 'voice-release-proof.json');
}

function currentVoiceSurface(opts = {}) {
  const rootDir = path.resolve(opts.rootDir || defaultRootDir());
  const files = [...(opts.surfaceFiles || DEFAULT_SURFACE_FILES)].map(String).sort();
  const digest = crypto.createHash('sha256');
  for (const relative of files) {
    const file = path.resolve(rootDir, relative);
    const insideRoot = file === rootDir || file.startsWith(rootDir + path.sep);
    if (!insideRoot) throw new Error(`voice surface path escapes runtime root: ${relative}`);
    digest.update(relative.replace(/\\/g, '/') + '\0');
    try {
      // Every file in the protected call surface is tracked text. Normalize
      // checkout line endings so the same release hashes identically on the
      // Windows proxy and Linux EC2 controller.
      digest.update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      digest.update('[missing]');
    }
    digest.update('\0');
  }
  return { rootDir, files, hash: digest.digest('hex') };
}

function validateEvidence(evidence = {}, opts = {}) {
  const callIds = [...new Set((evidence.callIds || []).map(String).filter(Boolean))];
  if (callIds.length !== 2) throw new Error('voice release proof requires exactly two unique call legs');
  if (evidence.exactLegCorrelation !== true) {
    throw new Error('voice release proof requires exact two-leg correlation');
  }
  if (evidence.substantiveReply !== true) {
    throw new Error('voice release proof requires a heard, substantive Amy reply');
  }
  if (!Number.isFinite(Number(evidence.substantiveReplyChars)) || Number(evidence.substantiveReplyChars) < 40) {
    throw new Error('voice release proof requires at least 40 characters of heard Amy reply evidence');
  }
  // The release test must exercise the third-party opening: Amy listens, says
  // Hello? once into dead air, then opens after the answer (2026-10-05).
  if (evidence.listenOpening !== true) {
    throw new Error('voice release proof requires a passing listen-first opening');
  }
  if (evidence.naturalClose !== true) {
    throw new Error('voice release proof requires a natural completed close');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(evidence.transcriptSha256 || ''))) {
    throw new Error('voice release proof requires a transcript SHA-256');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(evidence.proxySurfaceHash || ''))) {
    throw new Error('voice release proof requires the running proxy surface SHA-256');
  }
  if (opts.expectedSurfaceHash && evidence.proxySurfaceHash !== opts.expectedSurfaceHash) {
    throw new Error('voice release proof came from a different running proxy surface');
  }
  const maxFirstMeaningfulMs = Number(evidence.maxFirstMeaningfulMs);
  const maxAllowedFirstMeaningfulMs = Number(evidence.maxAllowedFirstMeaningfulMs);
  if (!Number.isFinite(maxFirstMeaningfulMs) || maxFirstMeaningfulMs <= 0) {
    throw new Error('voice release proof requires measured first meaningful response latency');
  }
  if (!Number.isFinite(maxAllowedFirstMeaningfulMs) || maxAllowedFirstMeaningfulMs <= 0) {
    throw new Error('voice release proof requires a first meaningful response ceiling');
  }
  if (maxFirstMeaningfulMs > maxAllowedFirstMeaningfulMs) {
    throw new Error(`voice release proof first meaningful response ${maxFirstMeaningfulMs}ms exceeds ${maxAllowedFirstMeaningfulMs}ms`);
  }
  const maxInferenceDurationMs = Number(evidence.maxInferenceDurationMs);
  const maxAllowedInferenceDurationMs = Number(evidence.maxAllowedInferenceDurationMs);
  if (!Number.isFinite(maxInferenceDurationMs) || maxInferenceDurationMs <= 0) {
    throw new Error('voice release proof requires measured bounded completion duration');
  }
  if (!Number.isFinite(maxAllowedInferenceDurationMs) || maxAllowedInferenceDurationMs <= 0) {
    throw new Error('voice release proof requires a completion-duration ceiling');
  }
  if (maxInferenceDurationMs > maxAllowedInferenceDurationMs) {
    throw new Error(`voice release proof completion ${maxInferenceDurationMs}ms exceeds ${maxAllowedInferenceDurationMs}ms`);
  }
  return {
    ...evidence,
    callIds,
    maxFirstMeaningfulMs,
    maxAllowedFirstMeaningfulMs,
    maxInferenceDurationMs,
    maxAllowedInferenceDurationMs,
  };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  return value;
}

function writeVoiceReleaseProof(opts = {}) {
  const surface = currentVoiceSurface(opts);
  const evidence = validateEvidence(opts.evidence, { expectedSurfaceHash: surface.hash });
  return writeJsonAtomic(proofPath(opts), {
    schema: SCHEMA,
    passed: true,
    provedAt: typeof opts.nowIso === 'function' ? opts.nowIso() : new Date().toISOString(),
    surfaceHash: surface.hash,
    surfaceFiles: surface.files,
    evidence,
  });
}

function readVoiceReleaseAdmission(opts = {}) {
  const file = proofPath(opts);
  const surface = currentVoiceSurface(opts);
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return {
      schema: SCHEMA,
      mode: 'paused',
      source: 'voice-release-proof',
      reason:
        error?.code === 'ENOENT'
          ? 'The current call surface has no passing Amy-to-Amy talkback proof.'
          : `The Amy-to-Amy talkback proof could not be read: ${error.message}`,
      path: file,
      surfaceHash: surface.hash,
    };
  }
  if (proof?.schema !== SCHEMA || proof?.passed !== true) {
    return {
      schema: SCHEMA,
      mode: 'paused',
      source: 'voice-release-proof',
      reason: 'The stored Amy-to-Amy talkback proof is invalid.',
      path: file,
      surfaceHash: surface.hash,
    };
  }
  if (proof.surfaceHash !== surface.hash) {
    return {
      schema: SCHEMA,
      mode: 'paused',
      source: 'voice-release-proof',
      reason: 'The live call surface changed after its last Amy-to-Amy talkback proof.',
      path: file,
      surfaceHash: surface.hash,
      provedSurfaceHash: proof.surfaceHash || null,
    };
  }
  try {
    validateEvidence(proof.evidence, { expectedSurfaceHash: surface.hash });
  } catch (error) {
    return {
      schema: SCHEMA,
      mode: 'paused',
      source: 'voice-release-proof',
      reason: `The stored Amy-to-Amy talkback proof is incomplete: ${error.message}`,
      path: file,
      surfaceHash: surface.hash,
    };
  }
  return {
    schema: SCHEMA,
    mode: 'enabled',
    source: 'voice-release-proof',
    reason: 'The current call surface passed a real two-leg Amy-to-Amy talkback test.',
    path: file,
    surfaceHash: surface.hash,
    proof,
  };
}

module.exports = {
  DEFAULT_SURFACE_FILES,
  SCHEMA,
  currentVoiceSurface,
  proofPath,
  readVoiceReleaseAdmission,
  validateEvidence,
  writeVoiceReleaseProof,
};
