'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
// Dependency-free on purpose: this module ships beside claude-proxy.js in the
// public mirror, where the news reader is stripped.
const { isFastNewsCommand, newsFastEndpointEnabled } = require('./voice-news-fast-command.js');

const SCHEMA = 'amy.voice-release-proof.v1';
// The second proof release admission requires: a passing `--scenario news`
// self-call on the same surface hash (Codex review, 2026-10-17). Every command
// the owner call of that day lost must have been server-served on a real call.
const NEWS_SCHEMA = 'amy.voice-news-scenario-proof.v1';
// The directive canary call (--scenario directive). Its proof settles that one
// internal test and nothing else: release admission never reads it.
const DIRECTIVE_SCHEMA = 'amy.voice-directive-canary-proof.v1';
// The live news script, in order, with the server action that must have
// answered each line on the receiving leg. Action names alone could pass a call
// where "Go back" skipped forward (Codex review, 2026-10-18). A resume line
// ("Ending", "No, don't stop") may land as the cut article or the next one.
const NEWS_SCENARIO_REQUIRED_TURNS = Object.freeze([
  { utterance: 'skip', actions: ['not_started'] },
  { utterance: 'read the news', actions: ['start'] },
  { utterance: 'skip', actions: ['next_article'] },
  { utterance: 'skip', actions: ['next_article'] },
  { utterance: 'i said skip', actions: ['next_article'] },
  { utterance: 'ending', actions: ['current', 'next_article'] },
  { utterance: 'no dont stop', actions: ['current', 'next_article'] },
  { utterance: 'skip section', actions: ['next_section'] },
  { utterance: 'save this article', actions: ['save_current'] },
  { utterance: 'go back', actions: ['previous'] },
  { utterance: 'stop', actions: ['stop'] },
].map((turn) => Object.freeze({ ...turn, actions: Object.freeze([...turn.actions]) })));
const NEWS_SCENARIO_REQUIRED_ACTIONS = Object.freeze([
  ...new Set(NEWS_SCENARIO_REQUIRED_TURNS.filter((turn) => turn.actions.length === 1).map((turn) => turn.actions[0])),
]);
// Every scripted command the scorer times, in order and with repeats (the
// opening "read the news" is not a command). The proof needs one latency per
// occurrence: three skips, not one (Codex review, 2026-10-18).
const NEWS_SCENARIO_TIMED_SEQUENCE = Object.freeze(
  NEWS_SCENARIO_REQUIRED_TURNS.map((turn) => turn.utterance).filter((text) => text !== 'read the news'),
);
const NEWS_SCENARIO_TIMED_COMMANDS = Object.freeze([...new Set(NEWS_SCENARIO_TIMED_SEQUENCE)]);
// The canonical latency ceilings: the end of an exact skip-family command to
// Amy speaking (the endpoint rule), and every other command (smart
// endpointing). A proof may carry stricter ceilings, never looser: a run
// scored against 60 seconds used to open release admission (Codex review
// c7c8ed3ea566). The fast bar is the measured live floor with margin; the 0.5s
// goal stays open in voice-call-stack.LESSONS.md.
const NEWS_MAX_COMMAND_MS = 2000;
const NEWS_MAX_OTHER_COMMAND_MS = 3500;
// The pre-start skip opens the call: Amy's not-started line is the call's first
// meaningful response, so it keeps that three-second release limit, never the
// 2 s bar for a skip over the news (one news self-call).
const NEWS_MAX_PRE_START_MS = 3000;
// Amy's audio cut on a barge-in: the caller's speech start to Amy's speech stop
// from the same events. Live self-calls measured 1.2 to 1.5s on 2026-10-18
// (voice detection, two phone-network hops and the stop itself, none on EC2);
// the transcript-based 500ms figure counted from the transcript's word time,
// after the cut had already happened (one news self-call).
const NEWS_MAX_AUDIO_STOP_MS = 2000;
// The one measurement the proof accepts: the caller's speech stop to Amy's
// speech start from voice provider speech-update events stamped on EC2. Voice provider's
// transcript merges cut audio into the next reply and cannot time a command.
const NEWS_LATENCY_MEASURE = 'speech';

// The scorer, the proof and the receipts compare spoken commands this way:
// letters and spaces only, so "No, don't stop." and "no dont stop" are one.
// An apostrophe is dropped, not spaced: the transcriber wrote "dont" on
// release one self-call (2026-10-28), which failed on that alone.
function normalizeNewsUtterance(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/['\u2018\u2019]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const DEFAULT_SURFACE_FILES = Object.freeze([
  'config/voice-runtime-policy.json',
  'ec2-server.js',
  // What decides which part of ec2-server.js is hashed; a change to either
  // changes the fingerprint method itself (Codex review, 2026-10-24).
  'scripts/lib/voice-server-slice.js',
  // Which process serves calls and how it shares state with main.
  'scripts/lib/server-role.js',
  'scripts/lib/phone-process-release.js',
  'scripts/vendor/acorn-8.16.0.js',
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
  // How a session is named, offered and read on the phone (check_spine and
  // read_session).
  'scripts/lib/voice-session-cloud-records.js',
  'scripts/lib/voice-session-reader.js',
  // The server-served news reader: command classification, the owner fast
  // endpoint rule, the reader cursor and model playback dedupe. The talkback
  // proof call does not drive news commands; the separate `--scenario news`
  // self-call does, and release admission requires its proof on this same
  // digest, so any change in how a news command is answered pauses ordinary
  // outbound until a real news call passes again (Codex review, 2026-10-17).
  'scripts/lib/voice-news-server-turn.js',
  'scripts/lib/voice-news-fast-command.js',
  // The marker that makes the route answer the news proof's synthetic caller
  // with silence; a change to it changes what the proof proves.
  'scripts/lib/voice-synthetic-caller.js',
  'scripts/lib/briefing-news-reader.js',
  'scripts/lib/news-reader-model-playback.js',
  'scripts/lib/inference-work-ledger.js',
  'scripts/lib/codex-app-server-client.js',
  'scripts/lib/codex-voice-attempt-telemetry.js',
  'scripts/lib/claude-voice-subscription-client.js',
  'scripts/lib/voice-lane-router.js',
  'scripts/lib/voice-paid-fallback.js',
  'scripts/lib/voice-primary.js',
  'scripts/lib/voice-prompt-warmup.js',
  'scripts/lib/voice-internal-self-test.js',
  // What a self-test ask_amy runs and the lease that admits it.
  'scripts/lib/voice-directive-canary.js',
  'scripts/lib/voice-selftest-dispatch-lease.js',
  // What any caller hears while a slow turn is worked on (D-12).
  'scripts/lib/voice-hold-phrase.js',
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

function newsProofPath(opts = {}) {
  if (opts.newsProofPath) return opts.newsProofPath;
  return path.join(path.dirname(proofPath(opts)), 'voice-news-scenario-proof.json');
}

// The server file also runs the briefing, videos and chat, so only its
// phone slice counts (owner decision). Required lazily: the public mirror
// has no ec2-server.js, so this module stays dependency-free there. A slice
// that cannot be cut falls back to the whole file, which fails safe.
const SERVER_FILE = 'ec2-server.js';
let lastServerSlice = { text: null, slice: null };

function surfaceText(relative, text) {
  const normalized = text.replace(/\r\n/g, '\n');
  if (relative.replace(/\\/g, '/') !== SERVER_FILE) return normalized;
  if (lastServerSlice.text === normalized) return lastServerSlice.slice;
  let slice;
  try {
    slice = 'phone-slice\0' + require('./voice-server-slice.js').phoneServerSlice(normalized);
  } catch {
    slice = 'whole-file\0' + normalized;
  }
  lastServerSlice = { text: normalized, slice };
  return slice;
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
      digest.update(surfaceText(relative, fs.readFileSync(file, 'utf8')));
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

function validateNewsEvidence(evidence = {}, opts = {}) {
  const callIds = [...new Set((evidence.callIds || []).map(String).filter(Boolean))];
  if (callIds.length !== 2) throw new Error('news-scenario proof requires exactly two unique call legs');
  if (evidence.ok !== true || (Array.isArray(evidence.issues) && evidence.issues.length)) {
    throw new Error('news-scenario proof requires a passing scored news call');
  }
  if (typeof evidence.fastEndpoint !== 'boolean') {
    throw new Error('news-scenario proof requires the fast news endpoint setting');
  }
  const servedTurns = (Array.isArray(evidence.servedTurns) ? evidence.servedTurns : []).map((row) => ({
    callId: String(row?.callId || ''),
    utterance: String(row?.utterance || ''),
    action: String(row?.action || ''),
  }));
  if (!servedTurns.length) throw new Error('news-scenario proof requires the server-served turns of the receiving leg');
  // The receipts are one receiving leg's stream. A sequence split across the
  // two legs, or taken from the caller leg, proves nothing about Amy's leg
  // (Codex review, 2026-10-18).
  const legs = [...new Set(servedTurns.map((row) => row.callId))];
  const inboundCallId = String(evidence.inboundCallId || '');
  if (legs.length !== 1 || !callIds.includes(legs[0]) || (inboundCallId && legs[0] !== inboundCallId)) {
    throw new Error('news-scenario proof served turns must all come from the receiving leg of the proof call legs');
  }
  let cursor = 0;
  for (const required of NEWS_SCENARIO_REQUIRED_TURNS) {
    const index = servedTurns.findIndex((row, i) => i >= cursor && normalizeNewsUtterance(row.utterance) === required.utterance);
    if (index < 0) {
      throw new Error(`news-scenario proof is missing the server-served "${required.utterance}" turn (${required.actions[0]})`);
    }
    if (!required.actions.includes(servedTurns[index].action)) {
      throw new Error(`news-scenario proof: "${required.utterance}" was served as ${servedTurns[index].action}, not ${required.actions.join(' or ')}`);
    }
    cursor = index + 1;
  }
  const servedActions = [...new Set(servedTurns.map((row) => row.action))];
  const latencies = Array.isArray(evidence.latencies) ? evidence.latencies : [];
  const maxCommandMs = Number(evidence.maxCommandMs);
  const maxOtherCommandMs = Number(evidence.maxOtherCommandMs);
  if (!Number.isFinite(maxCommandMs) || maxCommandMs <= 0 || !Number.isFinite(maxOtherCommandMs) || maxOtherCommandMs <= 0) {
    throw new Error('news-scenario proof requires fast and ordinary command latency ceilings');
  }
  if (maxCommandMs > NEWS_MAX_COMMAND_MS || maxOtherCommandMs > NEWS_MAX_OTHER_COMMAND_MS) {
    throw new Error(`news-scenario proof ceilings ${maxCommandMs}ms/${maxOtherCommandMs}ms exceed the canonical ${NEWS_MAX_COMMAND_MS}ms/${NEWS_MAX_OTHER_COMMAND_MS}ms`);
  }
  const maxAudioStopMs = Number(evidence.maxAudioStopMs);
  if (!Number.isFinite(maxAudioStopMs) || maxAudioStopMs <= 0) throw new Error('news-scenario proof requires an audio-stop ceiling');
  if (maxAudioStopMs > NEWS_MAX_AUDIO_STOP_MS) {
    throw new Error(`news-scenario proof audio-stop ceiling ${maxAudioStopMs}ms exceeds the canonical ${NEWS_MAX_AUDIO_STOP_MS}ms`);
  }
  let timedCursor = 0;
  let preStartIndex = -1;
  const seen = new Map();
  for (const command of NEWS_SCENARIO_TIMED_SEQUENCE) {
    const occurrence = (seen.get(command) || 0) + 1;
    seen.set(command, occurrence);
    const index = latencies.findIndex((row, i) => i >= timedCursor && normalizeNewsUtterance(row?.command) === command);
    if (index < 0) {
      throw new Error(`news-scenario proof has no latency for "${command}" (occurrence ${occurrence} of ${NEWS_SCENARIO_TIMED_SEQUENCE.filter((c) => c === command).length})`);
    }
    if (timedCursor === 0) preStartIndex = index;
    timedCursor = index + 1;
  }
  for (const [i, row] of latencies.entries()) {
    // The scorer writes ms: null for a command Amy never answered; Number(null)
    // is 0, so the raw value must already be a number (Codex closure, 2026-10-18).
    const ms = row?.ms;
    // The fast bar is for a skip over the news. The pre-start skip, the first
    // timed row and served as not_started, opens the call and carries its first
    // phone-network trip (2156 ms sender-side, 1253 ms voice provider turn latency, news
    // one self-call), so it alone keeps the first-response limit.
    // Only the very first row qualifies; a row after any other timed row is
    // never the call's first response (Codex review 111faa8b8010).
    const preStart = i === 0 && preStartIndex === 0 && row?.action === 'not_started' && normalizeNewsUtterance(row?.command) === 'skip';
    const ceiling = preStart ? NEWS_MAX_PRE_START_MS : isFastNewsCommand(row?.command) ? maxCommandMs : maxOtherCommandMs;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      throw new Error(`news-scenario proof: "${row?.command}" has an invalid latency ${row?.ms}ms`);
    }
    if (row?.measure !== NEWS_LATENCY_MEASURE) {
      throw new Error(`news-scenario proof: "${row?.command}" latency was not measured from speech events (measure ${row?.measure})`);
    }
    if (ms > ceiling) {
      throw new Error(`news-scenario proof: "${row?.command}" took ${row?.ms}ms, over ${ceiling}ms`);
    }
  }
  // The barge-in itself: at least one skip the server served as next_article
  // (so spoken over an article, not over the not-started line) with Amy's cut
  // measured from speech events, every measured cut inside the ceiling.
  const audioStops = Array.isArray(evidence.audioStops) ? evidence.audioStops : [];
  if (!audioStops.some((row) => normalizeNewsUtterance(row?.command) === 'skip' && row?.action === 'next_article')) {
    throw new Error('news-scenario proof has no measured audio stop for a skip spoken over an article');
  }
  for (const row of audioStops) {
    if (typeof row?.ms !== 'number' || !Number.isFinite(row.ms) || row.ms < 0) {
      throw new Error(`news-scenario proof: "${row?.command}" has an invalid audio stop ${row?.ms}ms`);
    }
    if (row?.measure !== NEWS_LATENCY_MEASURE) {
      throw new Error(`news-scenario proof: "${row?.command}" audio stop was not measured from speech events (measure ${row?.measure})`);
    }
    if (row.ms > maxAudioStopMs) {
      throw new Error(`news-scenario proof: audio took ${row.ms}ms to stop after "${row.command}", over ${maxAudioStopMs}ms`);
    }
  }
  if (!String(evidence.recordingUrl || '').trim()) throw new Error('news-scenario proof requires the call recording link');
  if (!/^[a-f0-9]{64}$/i.test(String(evidence.transcriptSha256 || ''))) {
    throw new Error('news-scenario proof requires a transcript SHA-256');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(evidence.proxySurfaceHash || ''))) {
    throw new Error('news-scenario proof requires the running proxy surface SHA-256');
  }
  if (opts.expectedSurfaceHash && evidence.proxySurfaceHash !== opts.expectedSurfaceHash) {
    throw new Error('news-scenario proof came from a different running proxy surface');
  }
  return { ...evidence, callIds, servedTurns, servedActions, maxCommandMs, maxOtherCommandMs, maxAudioStopMs, issues: [] };
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

function directiveProofPath(opts = {}) {
  if (opts.directiveProofPath) return opts.directiveProofPath;
  return path.join(path.dirname(proofPath(opts)), 'voice-directive-canary-proof.json');
}

function validateDirectiveEvidence(evidence = {}, opts = {}) {
  const callIds = [...new Set((evidence.callIds || []).map(String).filter(Boolean))];
  if (callIds.length !== 2) throw new Error('directive canary proof requires exactly two unique call legs');
  if (evidence.ok !== true || (Array.isArray(evidence.issues) && evidence.issues.length)) {
    throw new Error('directive canary proof requires a passing canary call');
  }
  const inboundCallId = String(evidence.inboundCallId || '');
  if (!callIds.includes(inboundCallId)) throw new Error('directive canary proof names no receiving leg of its call');
  const taskId = String(evidence.taskId || '');
  if (!taskId.startsWith('spine-voice-canary-') || evidence.taskStatus !== 'done') {
    throw new Error('directive canary proof requires its closed canary spine Task');
  }
  const surfaceHash = String(evidence.proxySurfaceHash || '');
  if (opts.expectedSurfaceHash && surfaceHash !== opts.expectedSurfaceHash) {
    throw new Error('directive canary proof was measured on a different voice surface');
  }
  return { callIds, inboundCallId, taskId, taskStatus: 'done', proxySurfaceHash: surfaceHash, ok: true, issues: [] };
}

function writeVoiceDirectiveCanaryProof(opts = {}) {
  const surface = currentVoiceSurface(opts);
  const evidence = validateDirectiveEvidence(opts.evidence, { expectedSurfaceHash: surface.hash });
  return writeJsonAtomic(directiveProofPath(opts), {
    schema: DIRECTIVE_SCHEMA,
    passed: true,
    provedAt: typeof opts.nowIso === 'function' ? opts.nowIso() : new Date().toISOString(),
    surfaceHash: surface.hash,
    surfaceFiles: surface.files,
    evidence,
  });
}

function writeVoiceNewsScenarioProof(opts = {}) {
  const surface = currentVoiceSurface(opts);
  const evidence = validateNewsEvidence(opts.evidence, { expectedSurfaceHash: surface.hash });
  return writeJsonAtomic(newsProofPath(opts), {
    schema: NEWS_SCHEMA,
    passed: true,
    provedAt: typeof opts.nowIso === 'function' ? opts.nowIso() : new Date().toISOString(),
    surfaceHash: surface.hash,
    surfaceFiles: surface.files,
    evidence,
  });
}

function readNewsScenarioAdmission(opts, surface) {
  const file = newsProofPath(opts);
  const paused = (reason, extra = {}) => ({
    schema: NEWS_SCHEMA,
    mode: 'paused',
    source: 'voice-news-scenario-proof',
    reason,
    path: file,
    surfaceHash: surface.hash,
    ...extra,
  });
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return paused(
      error?.code === 'ENOENT'
        ? 'The current call surface has no passing news-scenario proof.'
        : `The news-scenario proof could not be read: ${error.message}`,
    );
  }
  if (proof?.schema !== NEWS_SCHEMA || proof?.passed !== true) return paused('The stored news-scenario proof is invalid.');
  if (proof.surfaceHash !== surface.hash) {
    return paused('The live call surface changed after its last news-scenario proof.', { provedSurfaceHash: proof.surfaceHash || null });
  }
  try {
    validateNewsEvidence(proof.evidence, { expectedSurfaceHash: surface.hash });
  } catch (error) {
    return paused(`The stored news-scenario proof is incomplete: ${error.message}`);
  }
  // The env switch changes live turn-taking without touching the surface hash,
  // so a flip (either way) is unproved until a news call passes under it.
  const fastEndpoint = newsFastEndpointEnabled(opts.env);
  if (proof.evidence.fastEndpoint !== fastEndpoint) {
    return paused('The fast news endpoint setting changed after its news-scenario proof.', {
      provedFastEndpoint: proof.evidence.fastEndpoint,
      fastEndpoint,
    });
  }
  return { mode: 'enabled', path: file, proof };
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
  const news = readNewsScenarioAdmission(opts, surface);
  if (news.mode !== 'enabled') return news;
  return {
    schema: SCHEMA,
    mode: 'enabled',
    source: 'voice-release-proof',
    reason: 'The current call surface passed a real two-leg Amy-to-Amy talkback test and a real news-scenario call.',
    path: file,
    surfaceHash: surface.hash,
    proof,
    newsProofPath: news.path,
    newsProof: news.proof,
  };
}

module.exports = {
  surfaceText,
  DEFAULT_SURFACE_FILES,
  NEWS_LATENCY_MEASURE,
  NEWS_MAX_AUDIO_STOP_MS,
  NEWS_MAX_COMMAND_MS,
  NEWS_MAX_OTHER_COMMAND_MS,
  NEWS_MAX_PRE_START_MS,
  NEWS_SCENARIO_REQUIRED_ACTIONS,
  NEWS_SCENARIO_REQUIRED_TURNS,
  NEWS_SCENARIO_TIMED_COMMANDS,
  NEWS_SCENARIO_TIMED_SEQUENCE,
  NEWS_SCHEMA,
  DIRECTIVE_SCHEMA,
  SCHEMA,
  currentVoiceSurface,
  newsProofPath,
  normalizeNewsUtterance,
  proofPath,
  readVoiceReleaseAdmission,
  validateEvidence,
  validateNewsEvidence,
  validateDirectiveEvidence,
  directiveProofPath,
  writeVoiceDirectiveCanaryProof,
  writeVoiceNewsScenarioProof,
  writeVoiceReleaseProof,
};
