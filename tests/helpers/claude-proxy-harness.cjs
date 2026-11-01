'use strict';
// Test helper: run the real voice handlers from claude-proxy.js (the PC voice
// proxy) without starting its HTTP server. The handlers are sliced out of the
// source with loadWithAutoStubs and wired to a fake child_process.spawn, fake
// req/res objects and fresh per-harness turn caches, so a test can drive a
// phone turn end to end and assert on what the proxy writes and kills.
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { loadWithAutoStubs } = require('./extract-source-function.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const PROXY = path.join(ROOT, 'claude-proxy.js');
const voiceDecision = require(path.join(ROOT, 'scripts', 'lib', 'vapi-voice-decision.js'));
const callCorrelation = require(path.join(ROOT, 'scripts', 'lib', 'vapi-call-correlation.js'));

const HANDLERS = [
  'handleClaudeVoiceFallback',
  'handleCodexVoiceCompletionsViaExec',
  'salvageSpokenDecision',
  'logicalVoiceTurnId',
  'writeSilentVoiceCompletion',
  'writeVoiceDecisionCompletion',
  'rememberCompletedVoiceTurn',
  'replayCompletedVoiceTurn',
  'fallbackTurnAlreadyCompleted',
  'markFallbackTurnCompleted',
  'voiceTurnIsOpening',
];

function fakeChild(pid) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { written: '', write(s) { this.written += s; }, end(s) { if (s) this.written += s; } };
  proc.signals = [];
  proc.kill = (signal) => {
    proc.signals.push(signal || 'SIGTERM');
    return true;
  };
  return proc;
}

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headersSent = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.chunks = [];
  res.writeHead = (status) => {
    res.statusCode = status;
    res.headersSent = true;
  };
  res.write = (chunk) => {
    res.chunks.push(String(chunk));
    return true;
  };
  res.end = (chunk) => {
    if (chunk) res.chunks.push(String(chunk));
    res.writableEnded = true;
  };
  // The SSE frames the proxy wrote, parsed. [DONE] is kept as the string.
  res.frames = () =>
    res.chunks
      .join('')
      .split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => f.slice(6))
      .map((f) => (f === '[DONE]' ? f : JSON.parse(f)));
  // Everything the caller would hear: the concatenated content deltas.
  res.spoken = () =>
    res
      .frames()
      .filter((f) => f !== '[DONE]')
      .map((f) => f.choices?.[0]?.delta?.content || '')
      .join('');
  return res;
}

function fakeReq() {
  const req = new EventEmitter();
  req.headers = {};
  return req;
}

function createProxyHarness({ platform = 'win32' } = {}) {
  const spawned = [];
  const settles = [];
  const timers = [];
  let nextPid = 4100;
  const spawn = (command, args) => {
    const child = fakeChild(nextPid++);
    spawned.push({ command, args, child });
    return child;
  };
  const fakeProcess = { platform, env: {}, pid: process.pid };
  const fns = loadWithAutoStubs(PROXY, HANDLERS, {
    spawn,
    process: fakeProcess,
    crypto,
    path,
    __dirname: ROOT,
    console: { log() {}, error() {}, warn() {} },
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => clearTimeout(t),
    activeVoiceTurns: new Map(),
    recentCompletedVoiceTurns: new Map(),
    fallbackCompletedTurns: new Map(),
    VOICE_TURN_CACHE_MS: 30_000,
    VOICE_FIRST_CONTENT_TIMEOUT_MS: 60_000,
    VOICE_STREAM_TIMEOUT_MS: 60_000,
    HOLD_PHRASE_AFTER_MS: 60_000,
    VOICE_FAILURE_SPEECH: { timeout: 'T', crashed: 'C', unreadable: 'U', empty: 'E', unknown: 'X' },
    CODEX_PATH: 'codex',
    CLAUDE_PATH: 'claude',
    DISABLED_VOICE_FEATURES: [],
    VAPI_SUBSCRIPTION_VOICE_PREFLIGHT_MODEL: callCorrelation.VAPI_SUBSCRIPTION_VOICE_PREFLIGHT_MODEL,
    buildVoiceDecisionPrompt: voiceDecision.buildVoiceDecisionPrompt,
    deterministicDtmfDecision: voiceDecision.deterministicDtmfDecision,
    parseVoiceDecision: voiceDecision.parseVoiceDecision,
    voiceDecisionDelta: voiceDecision.voiceDecisionDelta,
    messagesToPrompt: () => 'conversation',
    holdPhraseFor: () => null,
    buildClaudeCliEnv: (env) => ({ ...env }),
    claudeRuntimeCwd: () => os.tmpdir(),
    startInferenceTelemetry: () => ({
      correlation: null,
      settle: (...args) => settles.push(args),
    }),
  });
  return {
    ...fns,
    spawned,
    settles,
    // Children that are the model process, not a taskkill helper.
    models: () => spawned.filter((s) => s.command !== 'taskkill.exe'),
    treeKills: () => spawned.filter((s) => s.command === 'taskkill.exe'),
    req: fakeReq,
    res: fakeRes,
    dispose: () => timers.forEach((t) => clearTimeout(t)),
  };
}

// One phone turn's correlation. Partial and final transcript requests for the
// same logical turn share the turn prefix but carry different work ids.
function turnCorrelation(callId, turn, request) {
  return { workId: `voice-call:${callId}:turn:${turn}:${request}`, attributed: true };
}

function speak(content) {
  return JSON.stringify({ type: 'speak', content, toolName: '', argumentsJson: '{}' });
}

module.exports = { createProxyHarness, turnCorrelation, speak };
