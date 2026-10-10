#!/usr/bin/env node
// claude-proxy.js
// Local proxy server that runs on your computer. Accepts OpenAI-compatible
// /chat/completions requests and routes them through `claude -p` using
// Max plan tokens (zero cost). EC2 connects via SSH reverse tunnel.
//
// Usage:
//   node claude-proxy.js
//   # Listens on port 3456 (configurable via PORT env)
//
// EC2 reaches this via reverse tunnel:
//   ssh -R 3456:localhost:3456 user@your-server
//
// Then EC2 server hits http://localhost:3456/chat/completions

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const {
  isCliFailureOutput,
  buildClaudeCliEnv,
} = require('./scripts/lib/cli-output-guard.js');
const { decideStreamOutcome } = require('./scripts/lib/proxy-stream-outcome.js');
const { reserveVoicePaidCall } = require('./scripts/lib/voice-paid-fallback.js');
const {
  candidatePaths: candidateOpenAiKeyPaths,
  resolveOpenAiVoiceKey,
} = require('./scripts/lib/openai-voice-key.js');
const {
  appendInferenceEvent,
  correlationFromOpenAiRequest,
} = require('./scripts/lib/inference-work-ledger.js');
const {
  acquireClaudeHealthCanaryClaim,
  buildClaudeHealthCanary,
  classifyClaudeHealthCanaryOutput,
  newestClaudeHealthState,
  releaseClaudeHealthCanaryClaim,
  resolveClaudeExecutableCandidates,
} = require('./scripts/lib/claude-health-canary.js');
const {
  buildVoiceDecisionPrompt,
  deterministicDtmfDecision,
  parseVoiceDecision,
  voiceDecisionDelta,
} = require('./scripts/lib/vapi-voice-decision.js');
const {
  classifyLaneFailure,
  recordLaneFailure,
  recordLaneSuccess,
  selectVoiceLane,
  describeVoiceLaneHealth,
} = require('./scripts/lib/voice-lane-router.js');
// The proxy is launched by a scheduled-task watchdog whose working directory is
// the node install dir, not the repo. Anchoring lane health to __dirname keeps
// every read and write on the same file no matter who starts the process; a
// cwd-relative default silently split the memo in two and the router kept
// reading a healthy-looking empty file while the seeded outage sat elsewhere.
const VOICE_LANE_OPTS = Object.freeze({ dataDir: path.join(__dirname, 'data') });
const {
  CodexAppServerClient,
  DISABLED_VOICE_FEATURES,
} = require('./scripts/lib/codex-app-server-client.js');
const {
  createCodexVoiceAttemptTelemetryRecorder,
} = require('./scripts/lib/codex-voice-attempt-telemetry.js');
const VOICE_DECISION_SCHEMA = require('./scripts/lib/vapi-voice-decision.schema.json');
const {
  VAPI_SUBSCRIPTION_VOICE_MODEL,
  VAPI_SUBSCRIPTION_VOICE_PREFLIGHT_MODEL,
  callAudienceFromSystemMessages,
} = require('./scripts/lib/vapi-call-correlation.js');
const {
  classifyCanaryFailureOutput,
  classifyClaudeHealth,
  defaultClaudeHealthStatePath,
  nextHealthState,
  readClaudeHealthState,
  shouldRunCanary,
  writeClaudeHealthState,
} = require('./scripts/lib/claude-max-health-state.js');
const { resolveAutomatedEffortRequest } = require('./scripts/lib/model-effort-policy.js');
const { currentVoiceSurface } = require('./scripts/lib/voice-release-proof.js');

const PORT = process.env.CLAUDE_PROXY_PORT || 3456;
// Vapi abandons a custom-LLM request at roughly 20 seconds. A voice relay must
// either produce real content well inside that budget or fail honestly so no
// orphan model process continues after the phone turn has gone away.
// ExampleCo's hard rule: no more than about three seconds of dead air on a call.
// 2026-08-16 added a hold phrase because ExampleCo sat through 13.4 seconds of
// silence on call 01a00bcf while a lookup ran. It was tuned to 1200ms, which is
// BELOW the normal decision time of 2 to 4 seconds, so it fired on every single
// turn. On the 2026-08-17 vendor call the receptionist heard "One sec." in front
// of almost every sentence, including the greeting where it came out as a bare
// "One", and hung up. The threshold now sits above normal decision time, so it
// speaks only on the genuinely slow tail this was built for. ExampleCo's rule is no
// more than about three seconds of dead air.
const HOLD_PHRASE_AFTER_MS = Number(process.env.VOICE_HOLD_PHRASE_AFTER_MS) || 3000;

// An opening turn has nothing to hold for. There is no lookup running, the
// caller has just said hello, and a hold phrase there makes Amy sound broken
// from her first word. Vapi sends the conversation so far; if Amy has not
// spoken yet, this is the opening.
function voiceTurnIsOpening(openaiBody) {
  const messages = Array.isArray(openaiBody?.messages) ? openaiBody.messages : [];
  return !messages.some(
    (message) => message?.role === 'assistant' && String(message?.content || '').trim(),
  );
}
// What Amy says when a voice turn fails, by what actually went wrong. A single
// timing-shaped apology told ExampleCo "that one is taking too long" even when the
// lookup had crashed outright, which hides the real fault and makes retrying
// look pointless. Each line names the failure and says whether a retry helps.
const VOICE_FAILURE_SPEECH = Object.freeze({
  timeout: "That lookup ran past the time I have on a call. Ask me again and I'll retry it.",
  crashed: "That lookup failed on my end, it didn't even start. Ask me again.",
  unreadable: "I got an answer back but couldn't read it. Ask me again and I'll retry.",
  empty: "I came back with nothing on that one. Ask me again and I'll retry.",
  unknown: "Sorry, I couldn't pull that just now. Ask me again and I'll retry.",
});
const VOICE_FIRST_CONTENT_TIMEOUT_MS =
  Number(process.env.VOICE_FIRST_CONTENT_TIMEOUT_MS) || 4400;
const VOICE_STREAM_TIMEOUT_MS = Number(process.env.VOICE_STREAM_TIMEOUT_MS) || 45000;
// Bind every phone-turn inference receipt to the exact proxy/call surface that
// produced it. The release harness rejects receipts from any other build.
const VOICE_SURFACE_HASH = currentVoiceSurface({ rootDir: __dirname }).hash;
const VOICE_TURN_CACHE_MS = 30_000;
const activeVoiceTurns = new Map();
const recentCompletedVoiceTurns = new Map();

function logicalVoiceTurnId(correlation) {
  const match = String(correlation?.workId || '').match(/^(voice-call:[^:]+:turn:\d+)/i);
  return match ? match[1] : '';
}

function writeSilentVoiceCompletion(res, callId) {
  if (res.writableEnded || res.destroyed) return;
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(
      'data: ' +
        JSON.stringify({
          id: callId,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        }) +
        '\n\n',
    );
  }
  res.write(
    'data: ' +
      JSON.stringify({
        id: callId,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }) +
      '\n\n',
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

function writeVoiceDecisionCompletion(res, callId, decision) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const chunks = [
    {
      id: callId,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    },
    {
      id: callId,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: voiceDecisionDelta(decision), finish_reason: null }],
    },
    {
      id: callId,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ];
  for (const chunk of chunks) res.write('data: ' + JSON.stringify(chunk) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

function rememberCompletedVoiceTurn(logicalTurnId, correlation, decision) {
  if (!logicalTurnId || !correlation?.workId || !decision) return;
  recentCompletedVoiceTurns.set(logicalTurnId, {
    completedAt: Date.now(),
    workId: correlation.workId,
    decision: { ...decision },
  });
}

function replayCompletedVoiceTurn(res, callId, logicalTurnId, correlation) {
  if (!logicalTurnId) return false;
  const cached = recentCompletedVoiceTurns.get(logicalTurnId);
  if (!cached) return false;
  if (Date.now() - Number(cached.completedAt || 0) > VOICE_TURN_CACHE_MS) {
    recentCompletedVoiceTurns.delete(logicalTurnId);
    return false;
  }
  if (!correlation?.workId || cached.workId !== correlation.workId) {
    recentCompletedVoiceTurns.delete(logicalTurnId);
    return false;
  }
  // Replaying speech makes an exact provider retry idempotently useful. Never
  // replay a completed tool action such as DTMF; a second keypad tone could
  // select the wrong IVR branch.
  if (cached.decision?.type === 'speak') {
    writeVoiceDecisionCompletion(res, callId, cached.decision);
  } else {
    writeSilentVoiceCompletion(res, callId);
  }
  return true;
}

function claudeRuntimeCwd() {
  const dir =
    process.env.CLAUDE_PROXY_RUNTIME_CWD ||
    path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'secondbrain', 'claude-proxy-runtime');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Find the Claude executable. On Windows the npm bin exposes claude.cmd, but
// shell:true drops intentionally empty values such as --tools '' and
// --setting-sources ''. Resolve the shim to its packaged native executable so
// isolation arguments reach the CLI unchanged. A missing native executable is
// a startup error because falling back to the shim would silently remove the
// isolation contract.
function resolveClaudePath() {
  if (process.platform !== 'win32') return 'claude';
  const candidates = [
    process.env.CLAUDE_PATH,
    path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    path.join(
      process.env.LOCALAPPDATA || '',
      'Packages',
      'Claude_pzs8sxrjxfjjc',
      'LocalCache',
      'Roaming',
      'npm',
      'claude.cmd',
    ),
  ];
  return resolveClaudeExecutableCandidates(candidates);
}
const CLAUDE_PATH = resolveClaudePath();

// ---------------------------------------------------------------------------
// Honest /health: only recent live proof earns green. Token validity is a
// cheap prerequisite for the canary, not proof that the subscription rung can
// answer. The result is persisted across proxy and watchdog restarts.
//
// EC2's checkLocalProxy() trusts this endpoint to decide whether to route
// live Vapi calls through the Max-plan proxy. The old handler returned 200
// {status:'ok'} unconditionally, so a dead Claude subscription (expired
// OAuth token) still received production traffic and callers heard silence
// or raw auth errors (2026-06-11 LLM fallback ladder plan, P0).
// ---------------------------------------------------------------------------
// Hard cap on the probe spawn. A real `claude -p "ping"` cold start on ExampleCo's
// PC measures ~23s idle but ~47s under load (CLI boot + first inference
// round-trip, contending with the many claude sessions ExampleCo runs), NOT
// sub-second. The old 10s cap was below that floor, so the probe ALWAYS timed
// out, the verdict was permanently { ok:false, 'probe timed out' }, /health
// served 503 degraded forever, and EC2 checkLocalProxy permanently routed Amy's
// LLM to PAID OpenAI (observed 2026-06-15: health.llm.source =
// 'openai-gpt4o (PAID)' for ~2.7 days with auth actually FINE).
//
// 90s clears a loaded cold start (~1.9x the 47s observed). A budget this large
// is safe ONLY because getClaudeHealth no longer BLOCKS /health on the probe:
// the probe runs in the background and /health serves the cached verdict
// instantly, so the long budget never collides with EC2 checkLocalProxy's 8s
// GET cap. Env-overridable so a slower box can widen it without a code deploy.
const HEALTH_PROBE_TIMEOUT_MS = Number(process.env.HEALTH_PROBE_TIMEOUT_MS) || 90000;

let lastSuccessfulStreamAt = 0; // retained as process-local observability
let healthProbeInFlight = null;
const HEALTH_STATE_PATH = defaultClaudeHealthStatePath();
let healthState = readClaudeHealthState(HEALTH_STATE_PATH);

// Supporting auth signal: the Max-plan OAuth token's expiry, read straight from
// ~/.claude/.credentials.json (same file the token-refresh task maintains). A
// present, unexpired token permits a bounded canary. It does not make /health
// green by itself because server-side revocation and invalid_grant can coexist
// with an unexpired local token.
const TOKEN_PATH = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.claude',
  '.credentials.json',
);
function readTokenAuth() {
  try {
    const oauth = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')).claudeAiOauth;
    if (!oauth || !oauth.expiresAt) {
      return {
        ok: false,
        fingerprint: 'missing-credentials',
        reason: 'no claudeAiOauth token in .credentials.json',
      };
    }
    const fingerprint = crypto
      .createHash('sha256')
      .update(String(oauth.refreshToken || oauth.accessToken || oauth.expiresAt))
      .digest('hex')
      .slice(0, 16);
    const msLeft = oauth.expiresAt - Date.now();
    if (msLeft <= 0) {
      return {
        ok: false,
        fingerprint,
        reason: 'access token expired ' + Math.round(-msLeft / 60000) + 'm ago',
      };
    }
    return {
      ok: true,
      fingerprint,
      reason: 'token valid, ' + Math.round(msLeft / 60000) + 'm left',
    };
  } catch (e) {
    return {
      ok: false,
      fingerprint: 'token-read-failed',
      reason: 'token read failed: ' + e.message,
    };
  }
}

function recordHealthEvent(event) {
  const tokenAuth = readTokenAuth();
  healthState = newestClaudeHealthState(
    healthState,
    readClaudeHealthState(HEALTH_STATE_PATH),
  );
  healthState = nextHealthState(
    healthState,
    {
      ...event,
      credentialFingerprint: event.credentialFingerprint || tokenAuth.fingerprint,
    },
  );
  try {
    writeClaudeHealthState(HEALTH_STATE_PATH, healthState);
  } catch (error) {
    console.error('[proxy] could not persist Claude health state: ' + error.message);
  }
  return healthState;
}

// Background end-to-end confirmation. Spawns a tiny `claude -p "ping"` to catch
// a token that is unexpired but server-side revoked. It resolves with a
// classification, NOT a raw boolean: only a DEFINITIVE auth failure (a CLI
// auth/login sentinel in the output) downgrades the verdict to degraded. A
// timeout, spawn error, nonzero exit with no auth sentinel, or empty output is
// INCONCLUSIVE under load and must NEVER flip a valid-token proxy to PAID. A
// clean answer marks a successful liveness signal. Resolves (never rejects).
function runClaudeAuthProbe() {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    // verdict: 'fail' (definitive auth failure -> degraded), 'ok' (live), or
    // 'inconclusive' (load/transient -> leave the token verdict standing).
    const finish = (verdict, reason) => {
      if (settled) return;
      settled = true;
      if (verdict === 'fail') {
        const failure = classifyCanaryFailureOutput(reason);
        recordHealthEvent({
          verdict: 'owner_action_required',
          code: failure.code,
          detail: reason,
          source: 'live-canary',
        });
        console.error('[proxy] auth probe DEFINITIVE FAIL: ' + reason);
      } else if (verdict === 'ok') {
        lastSuccessfulStreamAt = Date.now();
        recordHealthEvent({ verdict: 'ok', detail: reason, source: 'live-canary' });
      } else {
        recordHealthEvent({
          verdict: 'inconclusive',
          code: /timed out/i.test(reason) ? 'timeout' : 'transport_failure',
          detail: reason,
          source: 'live-canary',
        });
        console.error('[proxy] auth probe inconclusive: ' + reason);
      }
      resolve({ verdict, reason });
    };

    const isWindowsCmd =
      process.platform === 'win32' && /\.(cmd|bat)$/i.test(CLAUDE_PATH);
    const childEnv = buildClaudeCliEnv(process.env);
    const nonce = `amy-health-${crypto.randomUUID()}`;
    const canary = buildClaudeHealthCanary({ nonce });
    let proc;
    try {
      proc = spawn(CLAUDE_PATH, canary.args, {
        env: childEnv,
        cwd: claudeRuntimeCwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: isWindowsCmd,
        windowsHide: true,
      });
    } catch (e) {
      finish('inconclusive', 'spawn threw: ' + e.message);
      return;
    }

    const killer = setTimeout(() => {
      // Timeout is INCONCLUSIVE, not an auth failure: a loaded box just couldn't
      // boot the CLI in time. Treating it as degraded is what pinned EC2 to PAID.
      finish('inconclusive', 'probe timed out after ' + HEALTH_PROBE_TIMEOUT_MS + 'ms');
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, HEALTH_PROBE_TIMEOUT_MS);

    proc.stdout.on('data', (c) => (stdout += c.toString()));
    proc.stderr.on('data', (c) => (stderr += c.toString()));
    proc.on('error', (err) => {
      clearTimeout(killer);
      // ENOENT / transient spawn error is an environment problem, not auth.
      finish('inconclusive', 'spawn error: ' + err.message);
    });
    proc.on('close', (code) => {
      clearTimeout(killer);
      // A definitive auth/login sentinel is the ONLY thing that downgrades.
      // The CLI prints "Not logged in · Please run /login" to stdout and exits
      // 0, so classify the output regardless of exit code (shared guard).
      if (isCliFailureOutput(stdout) || isCliFailureOutput(stderr)) {
        const output = (stdout || stderr).trim().slice(0, 200);
        const failure = classifyCanaryFailureOutput(output);
        finish(
          failure.verdict === 'owner_action_required' ? 'fail' : 'inconclusive',
          'CLI failure output: ' + output,
        );
        return;
      }
      if (code !== 0) {
        // Nonzero without an auth sentinel is more likely a transient/load kill
        // than a credential problem -> inconclusive, keep the token verdict.
        finish('inconclusive', 'claude -p exited ' + code + ': ' + (stderr || stdout).trim().slice(0, 200));
        return;
      }
      if (!classifyClaudeHealthCanaryOutput(stdout, nonce)) {
        finish('inconclusive', 'claude health canary returned unexpected output');
        return;
      }
      finish('ok', 'probe ok');
    });

    proc.stdin.write(canary.prompt);
    proc.stdin.end();
  });
}

// Health verdict used by the /health route. NEVER blocks: the current persisted
// verdict is returned immediately while a due canary runs single-flight in the
// background. A valid token without recent live proof remains unknown/503.
function getClaudeHealth() {
  const now = Date.now();
  // Multiple proxy processes share this receipt. Reload before admission so a
  // canary completed by one process prevents every sibling from spawning the
  // same one-bit subscription check.
  healthState = newestClaudeHealthState(
    healthState,
    readClaudeHealthState(HEALTH_STATE_PATH),
  );
  const tok = readTokenAuth();
  if (!tok.ok) {
    const sameOwnerWall =
      healthState?.state === 'owner_action_required' &&
      healthState.credentialFingerprint === tok.fingerprint;
    if (!sameOwnerWall) {
      recordHealthEvent({
        verdict: 'owner_action_required',
        code: 'token_unavailable',
        detail: tok.reason,
        source: 'token-check',
        credentialFingerprint: tok.fingerprint,
      });
    }
  }
  const verdict = classifyClaudeHealth({ state: healthState, tokenAuth: tok, nowMs: now });
  if (!healthProbeInFlight && shouldRunCanary({ state: healthState, tokenAuth: tok, nowMs: now })) {
    const claim = acquireClaudeHealthCanaryClaim({ statePath: HEALTH_STATE_PATH, nowMs: now });
    if (claim.acquired) {
      healthProbeInFlight = runClaudeAuthProbe().finally(() => {
        releaseClaudeHealthCanaryClaim(claim);
        healthProbeInFlight = null;
      });
    }
  }
  return Promise.resolve(verdict);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Build a prompt from OpenAI chat messages
function messagesToPrompt(messages, tools) {
  const parts = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      parts.push(msg.content);
    } else if (msg.role === 'user') {
      parts.push('\n[User]: ' + msg.content);
    } else if (msg.role === 'assistant') {
      let text = msg.content || '';
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          text += '\n[Tool call]: ' + tc.function.name + '(' + tc.function.arguments + ')';
        }
      }
      if (text) parts.push('\n[Assistant]: ' + text);
    } else if (msg.role === 'tool') {
      parts.push('\n[Tool result]: ' + msg.content);
    }
  }

  // Add tool definitions if present
  if (tools && tools.length) {
    const toolSection =
      '\n\n[Available tools - call by responding with ONLY a JSON block like {"tool_call":{"name":"...","arguments":{...}}}]:\n' +
      tools
        .filter((t) => t.type === 'function')
        .map((t) => '- ' + t.function.name + ': ' + (t.function.description || '').slice(0, 300))
        .join('\n');
    // Insert after system prompt
    parts.splice(1, 0, toolSection);
  }

  return parts.join('\n');
}

function resolveCodexPath() {
  if (process.env.CODEX_PATH) return process.env.CODEX_PATH;
  if (process.platform !== 'win32') return 'codex';
  const candidates = [
    path.join(
      process.env.APPDATA || '',
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe',
    ),
    path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep searching */
    }
  }
  return 'codex';
}

const CODEX_PATH = resolveCodexPath();
const voiceAppServer = new CodexAppServerClient({ codexPath: CODEX_PATH, model: 'gpt-5.6-terra' });

function startInferenceTelemetry({
  openaiBody,
  headers,
  prompt,
  correlation: suppliedCorrelation,
  processName,
  trigger,
  model,
  effort,
  returnCondition,
}) {
  try {
    const correlation = suppliedCorrelation || correlationFromOpenAiRequest(openaiBody, headers);
    const inferenceId = crypto.randomUUID();
    const startedAt = Date.now();
    const contextBytes = Buffer.byteLength(prompt);
    let settled = false;
    const record = (event) => {
      try {
        appendInferenceEvent({
          inferenceId,
          rootWorkId: correlation.rootWorkId,
          parentWorkId: correlation.parentWorkId || correlation.rootWorkId,
          workId: correlation.workId,
          process: processName,
          trigger,
          stateFingerprint: correlation.stateFingerprint,
          model,
          effort,
          returnCondition,
          contextBytes,
          voiceSurfaceHash: VOICE_SURFACE_HASH,
          ...event,
        });
      } catch (error) {
        console.error('[proxy] inference ledger write failed: ' + error.message);
      }
    };
    record({ event: 'started' });
    return {
      correlation,
      settle(outcome, outputBytes = 0, usage = {}) {
        if (settled) return;
        settled = true;
        record({
          event: 'settled',
          outcome,
          outputBytes,
          durationMs: Date.now() - startedAt,
          ...usage,
        });
      },
    };
  } catch (error) {
    // Telemetry is never allowed to take down a live call.
    console.error('[proxy] inference telemetry unavailable: ' + error.message);
    return { correlation: suppliedCorrelation || null, settle() {} };
  }
}

function handleCodexVoiceCompletionsViaExec(openaiBody, req, res, suppliedCorrelation = null) {
  const isPreflight = openaiBody.model === VAPI_SUBSCRIPTION_VOICE_PREFLIGHT_MODEL;
  const tools = Array.isArray(openaiBody.tools) ? openaiBody.tools : [];
  const callId = 'chatcmpl-codex-voice-' + Date.now();
  const logicalTurnId = logicalVoiceTurnId(suppliedCorrelation);
  if (replayCompletedVoiceTurn(res, callId, logicalTurnId, suppliedCorrelation)) return;
  const prompt = buildVoiceDecisionPrompt({
    conversation: messagesToPrompt(openaiBody.messages || [], []),
    tools,
  });
  const telemetry = startInferenceTelemetry({
    openaiBody,
    headers: req.headers,
    prompt,
    correlation: suppliedCorrelation,
    processName: isPreflight ? 'vapi-voice-preflight' : 'vapi-voice',
    trigger: isPreflight ? 'voice-route-preflight' : 'caller-or-tool-turn',
    model: 'gpt-5.6-terra',
    effort: 'low',
    returnCondition: 'one interruption-aware spoken response or one explicit tool handoff',
  });
  const deterministicDtmf = deterministicDtmfDecision({
    messages: openaiBody.messages || [],
    tools,
  });
  if (deterministicDtmf) {
    // Vapi can send a partial-transcript request and then a final-transcript
    // request for the same logical turn. A deterministic final DTMF decision
    // must supersede the older model-backed request before returning. Leaving
    // the older request alive lets its later timeout/failure race the valid
    // tool call and causes Vapi to end the whole call as `llm-failed`.
    if (logicalTurnId) {
      activeVoiceTurns.get(logicalTurnId)?.supersede();
      activeVoiceTurns.delete(logicalTurnId);
    }
    const outputBytes = deterministicDtmf.toolName.length + deterministicDtmf.argumentsJson.length;
    rememberCompletedVoiceTurn(logicalTurnId, suppliedCorrelation, deterministicDtmf);
    telemetry.settle('completed-deterministic-dtmf', outputBytes);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(
      'data: ' +
        JSON.stringify({
          id: callId,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        }) +
        '\n\n',
    );
    res.write(
      'data: ' +
        JSON.stringify({
          id: callId,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: voiceDecisionDelta(
                deterministicDtmf,
                'call_' + crypto.randomUUID().replace(/-/g, ''),
              ),
              finish_reason: null,
            },
          ],
        }) +
        '\n\n',
    );
    res.write(
      'data: ' +
        JSON.stringify({
          id: callId,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        }) +
        '\n\n',
    );
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  const args = [
    ...DISABLED_VOICE_FEATURES.flatMap((feature) => ['--disable', feature]),
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--model',
    'gpt-5.6-terra',
    '--output-schema',
    path.join(__dirname, 'scripts', 'lib', 'vapi-voice-decision.schema.json'),
    '-c',
    'model_reasoning_effort="low"',
    '-c',
    'project_doc_max_bytes=0',
    '-',
  ];
  const isWindowsCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(CODEX_PATH);
  const proc = spawn(CODEX_PATH, args, {
    cwd: claudeRuntimeCwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: isWindowsCmd,
    windowsHide: true,
  });
  let childSettled = false;
  let terminatedReason = '';
  let firstContentSeen = false;
  let firstContentTimer = null;
  let streamTimer = null;
  let buffer = '';
  let decisionText = '';
  let contentBytes = 0;
  let codexUsage = {};
  let stderrHead = '';
  let sseStarted = false;

  const startSSE = () => {
    if (sseStarted || res.writableEnded) return;
    sseStarted = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(
      'data: ' +
        JSON.stringify({
          id: callId,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        }) +
        '\n\n',
    );
  };
  const sseWrite = (payload) => {
    if (res.writableEnded || res.destroyed || terminatedReason) return;
    startSSE();
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
  };
  const activeRequestToken = crypto.randomUUID();
  const cleanupActiveVoiceTurn = () => {
    if (logicalTurnId && activeVoiceTurns.get(logicalTurnId)?.token === activeRequestToken) {
      activeVoiceTurns.delete(logicalTurnId);
    }
  };
  const supersede = () => {
    terminateProcess('superseded by newer request state');
    writeSilentVoiceCompletion(res, callId);
  };
  if (logicalTurnId) {
    activeVoiceTurns.get(logicalTurnId)?.supersede();
    activeVoiceTurns.set(logicalTurnId, { token: activeRequestToken, supersede });
  }
  const killProcessTree = () => {
    if (process.platform === 'win32' && proc.pid) {
      try {
        const treeKiller = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        treeKiller.on('error', () => {
          try { proc.kill('SIGTERM'); } catch { /* already dead */ }
        });
        treeKiller.on('close', (code) => {
          if (code === 0 || childSettled) return;
          try { proc.kill('SIGTERM'); } catch { /* already dead */ }
        });
        return;
      } catch {
        /* direct child kill below remains the fallback */
      }
    }
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
  };
  const terminateProcess = (reason) => {
    if (childSettled || terminatedReason) return;
    terminatedReason = reason;
    telemetry.settle(reason, Math.max(contentBytes, decisionText.length), codexUsage);
    console.error('[proxy] terminating Codex voice stream: ' + reason);
    killProcessTree();
  };
  const finishVoiceDecision = (decision) => {
    if (childSettled || terminatedReason) return;
    if (decision.type === 'speak') contentBytes = decision.content.length;
    if (decision.type === 'tool_call') {
      contentBytes = decision.toolName.length + decision.argumentsJson.length;
    }
    rememberCompletedVoiceTurn(logicalTurnId, suppliedCorrelation, decision);
    telemetry.settle('completed', contentBytes, codexUsage);
    sseWrite({
      id: callId,
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: voiceDecisionDelta(
            decision,
            decision.type === 'tool_call'
              ? 'call_' + crypto.randomUUID().replace(/-/g, '')
              : '',
          ),
          finish_reason: null,
        },
      ],
    });
    sseWrite({
      id: callId,
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: decision.type === 'tool_call' ? 'tool_calls' : 'stop',
        },
      ],
    });
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
    // item.completed contains the full schema-constrained decision. Waiting
    // for the CLI's trailing bookkeeping after this point adds hundreds of
    // milliseconds to the phone turn without changing the answer.
    terminatedReason = 'decision delivered';
    cleanupActiveVoiceTurn();
    clearTimeout(firstContentTimer);
    clearTimeout(streamTimer);
    killProcessTree();
  };
  const noteFirstContent = () => {
    if (firstContentSeen) return;
    firstContentSeen = true;
    if (firstContentTimer) clearTimeout(firstContentTimer);
  };
  const clientDisconnected = (source) => {
    if (!res.writableEnded) terminateProcess('client disconnected via ' + source);
  };
  req.on('aborted', () => clientDisconnected('request aborted'));
  res.on('close', () => clientDisconnected('response close'));
  firstContentTimer = setTimeout(() => {
    if (firstContentSeen || childSettled) return;
    terminateProcess('first content deadline exceeded');
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'voice_first_content_timeout',
            message: `No model content within ${VOICE_FIRST_CONTENT_TIMEOUT_MS}ms.`,
          },
        }),
      );
    } else if (!res.writableEnded) {
      res.write(
        'data: ' +
          JSON.stringify({ error: { code: 'voice_first_content_timeout', message: 'Voice model missed its first-content deadline.' } }) +
          '\n\n',
      );
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }, VOICE_FIRST_CONTENT_TIMEOUT_MS);
  streamTimer = setTimeout(() => {
    if (childSettled) return;
    terminateProcess('voice stream deadline exceeded');
    if (!res.writableEnded) res.end();
  }, VOICE_STREAM_TIMEOUT_MS);

  // Commit the streaming transport immediately so Vapi keeps one request open
  // while the structured decision is produced. This empty role delta is not
  // model content and does not satisfy the first-content deadline above.
  startSSE();
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const rawUsage = event?.usage || event?.turn?.usage || event?.result?.usage;
        if (rawUsage && typeof rawUsage === 'object') {
          const inputTokens = Math.max(0, Number(rawUsage.input_tokens) || 0);
          const cachedInputTokens = Math.max(0, Number(rawUsage.cached_input_tokens) || 0);
          const outputTokens = Math.max(0, Number(rawUsage.output_tokens) || 0);
          codexUsage = {
            inputTokens,
            cachedInputTokens,
            outputTokens,
            processedTokens:
              Math.max(0, Number(rawUsage.total_tokens) || 0) || inputTokens + outputTokens,
          };
        }
        const text =
          event?.type === 'item.completed' && event?.item?.type === 'agent_message'
            ? String(event.item.text || '').trim()
            : '';
        if (!text || decisionText) continue;
        noteFirstContent();
        decisionText = text;
        try {
          finishVoiceDecision(parseVoiceDecision(decisionText, tools));
        } catch (error) {
          stderrHead = 'invalid voice decision: ' + error.message;
        }
      } catch {
        /* ignore non-JSON diagnostic output */
      }
    }
  });
  proc.stderr.on('data', (chunk) => {
    if (stderrHead.length < 500) stderrHead = (stderrHead + chunk.toString()).slice(0, 500);
  });
  proc.on('error', (error) => {
    childSettled = true;
    cleanupActiveVoiceTurn();
    clearTimeout(firstContentTimer);
    clearTimeout(streamTimer);
    if (terminatedReason) return;
    telemetry.settle('spawn-error', contentBytes, codexUsage);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'codex_voice_unavailable', message: error.message } }));
    } else if (!res.writableEnded) {
      res.end();
    }
  });
  proc.on('close', (code) => {
    childSettled = true;
    cleanupActiveVoiceTurn();
    clearTimeout(firstContentTimer);
    clearTimeout(streamTimer);
    if (terminatedReason) return;
    let decision = null;
    if (decisionText) {
      try {
        decision = parseVoiceDecision(decisionText, tools);
      } catch (error) {
        stderrHead = `invalid voice decision: ${error.message}`;
      }
    }
    if (decision?.type === 'speak') contentBytes = decision.content.length;
    if (decision?.type === 'tool_call') {
      contentBytes = decision.toolName.length + decision.argumentsJson.length;
    }
    if (decision) rememberCompletedVoiceTurn(logicalTurnId, suppliedCorrelation, decision);
    telemetry.settle(decision ? 'completed' : `empty-or-invalid-exit-${code}`, contentBytes, codexUsage);
    if (!decision) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'codex_voice_unavailable',
              message: `Codex voice exited ${code} without content${stderrHead ? ': ' + stderrHead : ''}`.slice(0, 500),
            },
          }),
        );
      } else if (!res.writableEnded) {
        res.end();
      }
      return;
    }
    sseWrite({
      id: callId,
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: voiceDecisionDelta(
            decision,
            decision.type === 'tool_call'
              ? `call_${crypto.randomUUID().replace(/-/g, '')}`
              : '',
          ),
          finish_reason: null,
        },
      ],
    });
    sseWrite({
      id: callId,
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: decision.type === 'tool_call' ? 'tool_calls' : 'stop',
        },
      ],
    });
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });
  proc.stdin.end(prompt);
}

async function handleCodexVoiceCompletionsViaAppServer(
  openaiBody,
  req,
  res,
  suppliedCorrelation = null,
) {
  const isPreflight = openaiBody.model === VAPI_SUBSCRIPTION_VOICE_PREFLIGHT_MODEL;
  const tools = Array.isArray(openaiBody.tools) ? openaiBody.tools : [];
  const callId = 'chatcmpl-codex-voice-' + Date.now();
  const logicalTurnId = logicalVoiceTurnId(suppliedCorrelation);
  if (replayCompletedVoiceTurn(res, callId, logicalTurnId, suppliedCorrelation)) return;
  const prompt = buildVoiceDecisionPrompt({
    conversation: messagesToPrompt(openaiBody.messages || [], []),
    tools,
  });
  const telemetry = startInferenceTelemetry({
    openaiBody,
    headers: req.headers,
    prompt,
    correlation: suppliedCorrelation,
    processName: isPreflight ? 'vapi-voice-preflight' : 'vapi-voice',
    trigger: isPreflight ? 'voice-route-preflight' : 'caller-or-tool-turn',
    model: 'gpt-5.6-terra',
    effort: 'low',
    returnCondition: 'one interruption-aware spoken response or one explicit tool handoff',
  });
  const recordPhysicalAttempt = createCodexVoiceAttemptTelemetryRecorder({
    startTelemetry: startInferenceTelemetry,
    openaiBody,
    headers: req.headers,
    prompt,
    correlation: telemetry.correlation || suppliedCorrelation,
  });
  const abortController = new AbortController();
  const activeRequestToken = crypto.randomUUID();
  let terminatedReason = '';
  let firstContentSeen = false;
  let firstContentTimer = null;
  let streamTimer = null;
  let sseStarted = false;

  const startSSE = () => {
    if (sseStarted || res.writableEnded || res.destroyed || terminatedReason) return;
    sseStarted = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(
      'data: ' +
        JSON.stringify({
          id: callId,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        }) +
        '\n\n',
    );
  };
  const sseWrite = (payload) => {
    if (res.writableEnded || res.destroyed || terminatedReason) return;
    startSSE();
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
  };
  const cleanupActiveVoiceTurn = () => {
    if (logicalTurnId && activeVoiceTurns.get(logicalTurnId)?.token === activeRequestToken) {
      activeVoiceTurns.delete(logicalTurnId);
    }
  };
  const terminate = (reason) => {
    if (terminatedReason) return;
    terminatedReason = reason;
    abortController.abort();
    clearTimeout(firstContentTimer);
    clearTimeout(streamTimer);
    cleanupActiveVoiceTurn();
    telemetry.settle(reason);
  };
  const supersede = () => {
    terminate('superseded by newer request state');
    writeSilentVoiceCompletion(res, callId);
  };
  if (logicalTurnId) {
    activeVoiceTurns.get(logicalTurnId)?.supersede();
    activeVoiceTurns.set(logicalTurnId, { token: activeRequestToken, supersede });
  }
  const noteFirstContent = () => {
    if (firstContentSeen || terminatedReason) return;
    firstContentSeen = true;
    clearTimeout(firstContentTimer);
    startSSE();
  };
  const finishVoiceDecision = (decision) => {
    if (terminatedReason) return;
    const outputBytes =
      decision.type === 'speak'
        ? decision.content.length
        : decision.toolName.length + decision.argumentsJson.length;
    rememberCompletedVoiceTurn(logicalTurnId, suppliedCorrelation, decision);
    telemetry.settle('completed-app-server', outputBytes);
    sseWrite({
      id: callId,
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: voiceDecisionDelta(
            decision,
            decision.type === 'tool_call'
              ? 'call_' + crypto.randomUUID().replace(/-/g, '')
              : '',
          ),
          finish_reason: null,
        },
      ],
    });
    sseWrite({
      id: callId,
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: decision.type === 'tool_call' ? 'tool_calls' : 'stop',
        },
      ],
    });
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
    terminatedReason = 'decision delivered';
    clearTimeout(firstContentTimer);
    clearTimeout(streamTimer);
    cleanupActiveVoiceTurn();
  };
  const clientDisconnected = (source) => {
    if (!res.writableEnded && !terminatedReason) terminate('client disconnected via ' + source);
  };
  req.on('aborted', () => clientDisconnected('request aborted'));
  res.on('close', () => clientDisconnected('response close'));
  firstContentTimer = setTimeout(() => {
    if (firstContentSeen || terminatedReason) return;
    terminate('first content deadline exceeded');
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'voice_first_content_timeout',
            message: `No model content within ${VOICE_FIRST_CONTENT_TIMEOUT_MS}ms.`,
          },
        }),
      );
    }
  }, VOICE_FIRST_CONTENT_TIMEOUT_MS);
  streamTimer = setTimeout(() => {
    if (terminatedReason) return;
    terminate('voice stream deadline exceeded');
    if (!res.writableEnded) res.end();
  }, VOICE_STREAM_TIMEOUT_MS);

  try {
    const result = await voiceAppServer.runVoiceDecision({
      prompt,
      outputSchema: VOICE_DECISION_SCHEMA,
      validate: (text) => parseVoiceDecision(text, tools),
      onAttemptEvent: recordPhysicalAttempt,
      signal: abortController.signal,
      timeoutMs: VOICE_STREAM_TIMEOUT_MS,
    });
    if (!terminatedReason) {
      // Do not commit the HTTP stream on an unvalidated primary delta. That
      // preserves the compatibility fallback when a hedge is the first valid
      // schema-constrained decision.
      noteFirstContent();
      finishVoiceDecision(result.decision);
    }
  } catch (error) {
    if (terminatedReason) return;
    clearTimeout(firstContentTimer);
    clearTimeout(streamTimer);
    cleanupActiveVoiceTurn();
    telemetry.settle('app-server-error');
    if (!res.headersSent && !res.writableEnded && !res.destroyed) throw error;
    terminate('app-server-error-after-stream-start');
    if (!res.writableEnded) res.end();
  }
}

function handleCodexVoiceCompletions(openaiBody, req, res, suppliedCorrelation = null) {
  const tools = Array.isArray(openaiBody.tools) ? openaiBody.tools : [];
  const deterministicDtmf = deterministicDtmfDecision({
    messages: openaiBody.messages || [],
    tools,
  });
  if (deterministicDtmf) {
    handleCodexVoiceCompletionsViaExec(openaiBody, req, res, suppliedCorrelation);
    return;
  }
  handleCodexVoiceCompletionsViaAppServer(openaiBody, req, res, suppliedCorrelation)
    .then(() => {
      recordLaneSuccess('codex-app-server', VOICE_LANE_OPTS);
    })
    .catch((error) => {
      console.error('[proxy] Codex app-server voice path unavailable: ' + error.message);
      // Teach the router what just happened so the NEXT call skips this
      // provider instead of paying the same discovery cost again.
      const failure = classifyLaneFailure(error);
      recordLaneFailure('codex-app-server', failure, VOICE_LANE_OPTS);
      if (res.headersSent || res.writableEnded || res.destroyed) {
        if (!res.writableEnded) res.end();
        return;
      }
      // A quota or auth outage takes out every Codex lane at once. Retrying the
      // Codex exec path here is what turned one outage into silence on the
      // call, so hand this turn to the Claude lane immediately.
      if (failure.kind === 'quota' || failure.kind === 'auth') {
        console.error(
          `[proxy] voice lane router: Codex ${failure.kind} outage, handing this turn to the Claude lane`,
        );
        handleClaudeVoiceFallback(openaiBody, req, res, suppliedCorrelation);
        return;
      }
      handleCodexVoiceCompletionsViaExec(openaiBody, req, res, suppliedCorrelation);
    });
}

// Answer a voice turn on the Claude lane. Reuses the long-standing Claude
// streaming path, which already emits OpenAI-shaped SSE and translates Claude
// tool_use events into Vapi tool_calls. Measured first spoken content at ~2.9s
// from the isolated proxy runtime cwd, inside the phone first-content budget.
// Answer a voice turn on Claude using the SAME decision protocol as the Codex
// lane, so every Vapi function tool stays reachable.
//
// The first cut routed voice through the general Claude chat path with
// `--tools ''`. That is fast and safe but it left Amy with no way to call
// check_spine or any other Vapi-side tool, and on a live call she said so out
// loud: "the bridge tool isn't available in this context, and I don't have
// check spine access here either... I'm running as the cloud code agent, not
// the full Vapi Amy stack." Losing her tools and breaking character is a worse
// failure than the outage this lane exists to cover.
//
// Vapi function tools are executed by the EC2 webhook, not by the model host,
// so the model only has to NAME one. buildVoiceDecisionPrompt asks for exactly
// that as JSON and parseVoiceDecision reads it back. Built-ins stay off, so the
// phone still cannot reach Bash, and every Vapi tool works again.
// Recover a spoken answer when the model replied in prose instead of the
// decision JSON. Deliberately conservative: anything that still looks like
// machinery is refused, because speaking JSON or a stack trace down the phone
// is worse than admitting the turn failed.
function salvageSpokenDecision(raw) {
  let text = String(raw || '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  if (!text) return null;
  // Structured output that failed strict parsing is malformed, not speech.
  if (/^[[{]/.test(text) || /"type"\s*:/.test(text)) return null;
  // Machine noise must never reach the caller's ear. Stack frames take several
  // shapes: "at Object.<anonymous> (foo.js:1:1)" has no \w+.\w+ pair, so match
  // the frame form and the file:line:col form directly.
  if (/\b(Error|Traceback|undefined)\b|\bat\s+\S+\s*\(|\w+:\d+:\d+|\{"/.test(text)) return null;
  // A phone answer is a sentence or three, not a document.
  if (text.length > 700) return null;
  if (!/[a-z]/i.test(text)) return null;
  return { type: 'speak', content: text };
}

// auth-voice-paid-fallback, approved by ExampleCo 2026-08-16 at $15 and 500 calls
// per rolling 24 hours. Armed only when Codex is exhausted. The Claude CLI lane
// costs about 4.2 seconds per decision because it spawns a process per turn,
// which is past the dead-air threshold, so Amy prefixes every reply with a hold
// phrase and cannot be put in front of a venue. A hosted API call has no spawn
// cost. Every refusal here falls through to the Claude lane, never to silence.
// The proxy is started by a scheduled-task watchdog, so its environment is not
// an interactive shell's. Measured 2026-08-16: the first cut read only
// %APPDATA%, found nothing, and the lane failed in 17ms with "that lookup
// failed on my end" while the gate happily reported a full budget. Try every
// place the key actually lives, and treat a blank string as absent.

function requestOpenAiVoiceDecision(prompt, tools, budgetMs) {
  return new Promise((resolve) => {
    const { key, model, source, attempts } = resolveOpenAiVoiceKey();
    if (!key) {
      // Never log the key. Logging only whether one was found, and from where,
      // is what separates "no credential" from "the API rejected us", which
      // sounded identical on a live call and cost an evening to tell apart.
      // List where it looked. The previous two fixes each guessed at the cause
      // and each looked identical from the outside, which cost several deploy
      // cycles. Paths are not secrets; the key is never logged.
      console.error(
        '[proxy] paid voice lane: no OpenAI key found, degrading. ' +
          (Array.isArray(attempts) && attempts.length
            ? attempts.join(' | ')
            : 'no candidate paths were produced'),
      );
      resolve({ decision: null, failureReason: 'crashed' });
      return;
    }
    console.error(`[proxy] paid voice lane: key loaded from ${source || 'unknown'}, model ${model}`);
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0,
    });
    const request = https.request(
      {
        host: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${key}`,
        },
        timeout: budgetMs,
      },
      (response) => {
        let raw = '';
        response.on('data', (chunk) => (raw += chunk));
        response.on('end', () => {
          if (response.statusCode !== 200) {
            console.error('[proxy] paid voice lane HTTP ' + response.statusCode);
            resolve({ decision: null, failureReason: 'crashed' });
            return;
          }
          try {
            const text = JSON.parse(raw)?.choices?.[0]?.message?.content || '';
            if (!text.trim()) {
              resolve({ decision: null, failureReason: 'empty' });
              return;
            }
            resolve({ decision: parseVoiceDecision(text, tools), failureReason: null });
          } catch (error) {
            console.error('[proxy] OpenAI voice decision parse failed: ' + error.message);
            resolve({ decision: null, failureReason: 'unreadable' });
          }
        });
      },
    );
    request.on('timeout', () => {
      request.destroy();
      resolve({ decision: null, failureReason: 'timeout' });
    });
    request.on('error', (error) => {
      console.error('[proxy] paid voice lane request failed: ' + error.message);
      resolve({ decision: null, failureReason: 'crashed' });
    });
    request.write(body);
    request.end();
  });
}


// A logical turn may be answered by a partial-transcript request and then a
// final-transcript request. Those carry different work ids, so the shared
// replay cache, which matches on work id, cannot recognise the second one and
// both settle. The release proof then rejects the run for duplicate logical
// turn completions. This records the turns the fallback lanes have already
// completed, keyed only by logical turn, and serves the later request without
// recording a second completion.
const fallbackCompletedTurns = new Map();

function fallbackTurnAlreadyCompleted(logicalTurnId) {
  if (!logicalTurnId) return null;
  const cached = fallbackCompletedTurns.get(logicalTurnId);
  if (!cached) return null;
  if (Date.now() - cached.at > VOICE_TURN_CACHE_MS) {
    fallbackCompletedTurns.delete(logicalTurnId);
    return null;
  }
  return cached.decision;
}

function markFallbackTurnCompleted(logicalTurnId, decision) {
  if (!logicalTurnId || !decision) return;
  fallbackCompletedTurns.set(logicalTurnId, { at: Date.now(), decision: { ...decision } });
}

function handleOpenAiVoiceFallback(openaiBody, req, res, callId, suppliedCorrelation = null) {
  const tools = Array.isArray(openaiBody.tools) ? openaiBody.tools : [];
  // Vapi sends a partial-transcript and then a final-transcript request for the
  // same logical turn. Without this the lane settles twice and the release
  // proof rejects the run for duplicate logical turn completions. The Codex
  // lane has always deduped here; the fallbacks did not.
  const logicalTurnId = logicalVoiceTurnId(suppliedCorrelation);
  if (replayCompletedVoiceTurn(res, callId, logicalTurnId, suppliedCorrelation)) return;
  // Same turn, different work id. Answer with the decision already made and
  // record nothing, so the turn completes exactly once in the ledger.
  const alreadyDecided = fallbackTurnAlreadyCompleted(logicalTurnId);
  if (alreadyDecided) {
    writeVoiceDecisionCompletion(res, callId, alreadyDecided);
    return;
  }

  // Replaying only works when the work ids match, and they do not across the
  // partial and final requests for one turn, so the older request must be
  // superseded instead. Without this both settle and the release proof rejects
  // the run for duplicate logical turn completions.
  const activeRequestToken = crypto.randomUUID();
  const cleanupActiveVoiceTurn = () => {
    if (logicalTurnId && activeVoiceTurns.get(logicalTurnId)?.token === activeRequestToken) {
      activeVoiceTurns.delete(logicalTurnId);
    }
  };

  const prompt = buildVoiceDecisionPrompt({
    conversation: messagesToPrompt(openaiBody.messages || [], []),
    tools,
  });
  const telemetry = startInferenceTelemetry({
    openaiBody,
    headers: req.headers,
    prompt,
    // Without this the receipt binds to no call leg, and the release proof
    // reports "leg emitted no settled isolated inference" even though the lane
    // recorded plenty of them. Measured is not the same as attributed.
    correlation: suppliedCorrelation,
    processName: 'vapi-voice',
    trigger: 'caller-or-tool-turn',
    model: 'openai-paid-voice-fallback',
    effort: 'low',
    returnCondition: 'one interruption-aware spoken response or one explicit tool handoff',
  });

  let settled = false;
  let started = false;
  let holdSpoken = false;
  const write = (payload) => {
    if (res.writableEnded || res.destroyed) return;
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
  };
  const startSSE = () => {
    if (started || res.writableEnded || res.destroyed) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    write({
      id: callId,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });
  };
  // This lane exists to beat the dead-air threshold, so the hold phrase should
  // almost never fire here. It stays wired because a slow network hop is still
  // dead air, and silence on a live call is the failure we are removing.
  const openingTurn = voiceTurnIsOpening(openaiBody);
  const holdPhraseAllowed =
    !openingTurn && callAudienceFromSystemMessages(openaiBody) === 'principal';
  const holdTimer = setTimeout(() => {
    if (settled) return;
    // Never narrate waiting to an outside-world caller, an unmarked call, or
    // the opening turn. Only an exact system-authored principal marker may use
    // the owner-facing dead-air cover.
    if (!holdPhraseAllowed) return;
    startSSE();
    holdSpoken = true;
    write({
      id: callId,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'One sec. ' }, finish_reason: null }],
    });
  }, HOLD_PHRASE_AFTER_MS);

  // Superseding marks the turn settled so the in-flight response can never
  // record a second completion, then closes the socket silently.
  const supersede = () => {
    if (settled) return;
    settled = true;
    clearTimeout(holdTimer);
    // Settle the receipt, do not abandon it. The proof requires exactly one
    // start and one settlement per inference, and a superseded request that
    // never settles leaves a dangling start. 'superseded' is deliberately not
    // one of the completion outcomes, so this pairs the receipt without
    // counting as a second completion for the turn.
    telemetry.settle('superseded', 0);
    cleanupActiveVoiceTurn();
    writeSilentVoiceCompletion(res, callId);
  };
  if (logicalTurnId) {
    activeVoiceTurns.get(logicalTurnId)?.supersede();
    activeVoiceTurns.set(logicalTurnId, { token: activeRequestToken, supersede });
  }

  const finish = (decision, failureReason) => {
    if (settled) return;
    settled = true;
    clearTimeout(holdTimer);
    // 'completed' is the contract value. The proof only counts a settlement
    // whose outcome is empty, 'completed' or 'completed-app-server', so the
    // invented 'ok' made fifteen correctly attributed receipts invisible and
    // the gate reported the legs as having emitted nothing at all.
    telemetry.settle(
      decision ? 'completed' : failureReason || 'unknown',
      decision ? Buffer.byteLength(JSON.stringify(decision)) : 0,
    );
    if (decision) rememberCompletedVoiceTurn(logicalTurnId, suppliedCorrelation, decision);
    if (decision) markFallbackTurnCompleted(logicalTurnId, decision);
    cleanupActiveVoiceTurn();
    if (res.writableEnded || res.destroyed) return;
    startSSE();
    if (!decision) {
      write({
        id: callId,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: { content: VOICE_FAILURE_SPEECH[failureReason] || VOICE_FAILURE_SPEECH.unknown },
            finish_reason: null,
          },
        ],
      });
      write({
        id: callId,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    write({
      id: callId,
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: voiceDecisionDelta(
            decision,
            decision.type === 'tool_call' ? `call_${crypto.randomUUID().replace(/-/g, '')}` : '',
          ),
          finish_reason: null,
        },
      ],
    });
    write({
      id: callId,
      object: 'chat.completion.chunk',
      choices: [
        { index: 0, delta: {}, finish_reason: decision.type === 'tool_call' ? 'tool_calls' : 'stop' },
      ],
    });
    res.write('data: [DONE]\n\n');
    res.end();
  };

  const budgetMs = Number(process.env.VOICE_OPENAI_DECISION_TIMEOUT_MS) || 12000;
  requestOpenAiVoiceDecision(prompt, tools, budgetMs)
    .then(({ decision, failureReason }) => finish(decision, failureReason))
    .catch(() => finish(null, 'crashed'));
  void holdSpoken;
}

function handleClaudeVoiceFallback(openaiBody, req, res, suppliedCorrelation = null) {
  const tools = Array.isArray(openaiBody.tools) ? openaiBody.tools : [];
  const callId = 'chatcmpl-claude-voice-' + Date.now();
  // Vapi sends a partial-transcript and then a final-transcript request for the
  // same logical turn. Without this the lane settles twice and the release
  // proof rejects the run for duplicate logical turn completions. The Codex
  // lane has always deduped here; the fallbacks did not.
  const logicalTurnId = logicalVoiceTurnId(suppliedCorrelation);
  if (replayCompletedVoiceTurn(res, callId, logicalTurnId, suppliedCorrelation)) return;
  // Same turn, different work id. Answer with the decision already made and
  // record nothing, so the turn completes exactly once in the ledger.
  const alreadyDecided = fallbackTurnAlreadyCompleted(logicalTurnId);
  if (alreadyDecided) {
    writeVoiceDecisionCompletion(res, callId, alreadyDecided);
    return;
  }

  // Replaying only works when the work ids match, and they do not across the
  // partial and final requests for one turn, so the older request must be
  // superseded instead. Without this both settle and the release proof rejects
  // the run for duplicate logical turn completions.
  const activeRequestToken = crypto.randomUUID();
  const cleanupActiveVoiceTurn = () => {
    if (logicalTurnId && activeVoiceTurns.get(logicalTurnId)?.token === activeRequestToken) {
      activeVoiceTurns.delete(logicalTurnId);
    }
  };

  const prompt = buildVoiceDecisionPrompt({
    conversation: messagesToPrompt(openaiBody.messages || [], []),
    tools,
  });
  // 2026-08-16: this lane answered real calls while writing nothing to the
  // inference ledger, so every Amy-to-Amy release proof failed with "no
  // vapi-voice events were written" even when Amy answered correctly and hung
  // up cleanly. EC2 already refuses an unmeasured fallback; an unmeasured lane
  // that still serves live turns is the worse half of that rule. Telemetry is
  // constructed defensively and its settle() is a no-op when unavailable, so
  // this cannot take down a call.
  const telemetry = startInferenceTelemetry({
    openaiBody,
    headers: req.headers,
    prompt,
    correlation: suppliedCorrelation,
    processName: 'vapi-voice',
    trigger: 'caller-or-tool-turn',
    model: 'claude-sonnet-4-6',
    effort: 'low',
    returnCondition: 'one interruption-aware spoken response or one explicit tool handoff',
  });

  const args = [
    '-p',
    '--model',
    'claude-sonnet-4-6',
    '--input-format',
    'text',
    // Skip settings, hooks and project CLAUDE.md: 6323ms to first text with
    // them, 2879ms without, against a phone budget measured in seconds.
    '--setting-sources',
    '',
    // No built-in tools. A phone turn must never reach Bash, Edit or Write.
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
  ];

  // The decision prompt carries the full Amy voice system prompt plus every
  // tool schema, so this lane is slower than a bare completion: measured 8547ms
  // end to end for a real check_spine decision. 9000ms left no headroom at all.
  // Vapi abandons a custom-LLM request at roughly 20s, so 15000ms keeps margin
  // on both sides. Slow and correct beats fast and mute.
  // Sized from measurement, not a guess. Across ExampleCo's real calls, the wait
  // from him finishing a sentence to Amy acting ran 5.2s min, 8.0s median,
  // 9.9s p90, 13.4s max. The first budget was 15000ms set from ONE 8.5s sample,
  // and turn 2 duly overran it and told him "that one is taking too long".
  // 13.4s observed max plus real buffer, held under the ~20s at which Vapi
  // abandons the request, because a turn that cannot finish inside that is
  // unwinnable and should fail while he is still on the line to hear why.
  const budgetMs = Number(process.env.VOICE_CLAUDE_DECISION_TIMEOUT_MS) || 18000;
  const proc = spawn(CLAUDE_PATH, args, {
    cwd: claudeRuntimeCwd(),
    env: buildClaudeCliEnv(process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(CLAUDE_PATH),
    windowsHide: true,
  });

  let out = '';
  let settled = false;
  let started = false;

  const write = (payload) => {
    if (res.writableEnded || res.destroyed) return;
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
  };
  const startSSE = () => {
    if (started || res.writableEnded || res.destroyed) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    write({
      id: callId,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });
  };

  // Dead air is its own failure. On call 01a00bcf the decision took 13.4s and
  // ExampleCo sat in silence the whole time; his rule is nothing over about three
  // seconds. This lane cannot be made fast enough while Codex is out, so it
  // speaks a short hold first and delivers the real answer behind it. The
  // phrase must be context-neutral: an early version said 'Let me check.' and
  // then answered 'how are you?' with it, which is nonsense. 'One sec.' is
  // true before any turn, lookup or not, so it never misdescribes the work.
  const openingTurn = voiceTurnIsOpening(openaiBody);
  const holdPhraseAllowed =
    !openingTurn && callAudienceFromSystemMessages(openaiBody) === 'principal';
  const holdTimer = setTimeout(() => {
    if (settled) return;
    // Only a verified principal may hear owner-facing dead-air cover, and
    // never as the first thing Amy says on a call.
    if (!holdPhraseAllowed) return;
    startSSE();
    write({
      id: callId,
      object: 'chat.completion.chunk',
      // Trailing space is load-bearing. Vapi concatenates content deltas into
      // one utterance, so 'One sec.' immediately followed by the answer became
      // '1 sexession dialogue updated just now' on a real call. The space is
      // what keeps the hold and the answer as two spoken sentences.
      choices: [{ index: 0, delta: { content: 'One sec. ' }, finish_reason: null }],
    });
  }, HOLD_PHRASE_AFTER_MS);

  const finish = (decision, failureReason) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(holdTimer);
    // Settle before the early return below. A turn whose socket already closed
    // still consumed a real inference and must appear in the ledger, otherwise
    // the release proof sees a lane that served traffic and recorded nothing.
    // 'completed' is the contract value. The proof only counts a settlement
    // whose outcome is empty, 'completed' or 'completed-app-server', so the
    // invented 'ok' made fifteen correctly attributed receipts invisible and
    // the gate reported the legs as having emitted nothing at all.
    telemetry.settle(
      decision ? 'completed' : failureReason || 'unknown',
      decision ? Buffer.byteLength(JSON.stringify(decision)) : 0,
    );
    if (decision) rememberCompletedVoiceTurn(logicalTurnId, suppliedCorrelation, decision);
    if (decision) markFallbackTurnCompleted(logicalTurnId, decision);
    cleanupActiveVoiceTurn();
    if (res.writableEnded || res.destroyed) return;
    if (!decision) {
      // Never hand Vapi an error mid-call. On 01a00bcf the follow-up turn
      // failed, Vapi saw custom-llm-llm-failed, and it ENDED THE CALL on ExampleCo.
      // A spoken apology keeps the line up and lets him ask again.
      startSSE();
      write({
        id: callId,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            // Name the actual failure. A single timing-shaped apology told
            // ExampleCo 'taking too long' even when the lookup had crashed, which
            // hides the real problem and makes retrying look pointless.
            delta: { content: VOICE_FAILURE_SPEECH[failureReason] || VOICE_FAILURE_SPEECH.unknown },
            finish_reason: null,
          },
        ],
      });
      write({
        id: callId,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    startSSE();
    write({
      id: callId,
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: voiceDecisionDelta(
            decision,
            decision.type === 'tool_call' ? `call_${crypto.randomUUID().replace(/-/g, '')}` : '',
          ),
          finish_reason: null,
        },
      ],
    });
    write({
      id: callId,
      object: 'chat.completion.chunk',
      choices: [
        { index: 0, delta: {}, finish_reason: decision.type === 'tool_call' ? 'tool_calls' : 'stop' },
      ],
    });
    res.write('data: [DONE]\n\n');
    res.end();
  };

  const timer = setTimeout(() => {
    console.error('[proxy] Claude voice lane missed its decision deadline');
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    finish(null, 'timeout');
  }, budgetMs);

  proc.stdout.on('data', (chunk) => {
    out += chunk.toString();
  });
  proc.on('error', (error) => {
    console.error('[proxy] Claude voice lane spawn failed: ' + error.message);
    finish(null, 'crashed');
  });
  proc.on('close', () => {
    let decision = null;
    try {
      decision = parseVoiceDecision(out, tools);
    } catch (error) {
      console.error('[proxy] Claude voice decision parse failed: ' + error.message);
      // The Codex lane pins the reply shape with --output-schema. Claude has no
      // equivalent here, so the decision JSON is prompt-dependent and sometimes
      // comes back as plain prose instead. On a narration turn that prose IS
      // the answer, and throwing it away made Amy say "I got an answer back but
      // couldn't read it" while holding a perfectly good sentence.
      decision = salvageSpokenDecision(out);
      if (decision) console.error('[proxy] Claude voice lane salvaged a spoken answer from prose');
    }
    finish(decision, decision ? undefined : out.trim() ? 'unreadable' : 'empty');
  });

  proc.stdin.write(prompt);
  proc.stdin.end();
}

// Stream claude -p output as OpenAI SSE format
function handleChatCompletions(openaiBody, req, res) {
  let correlation = null;
  try {
    correlation = correlationFromOpenAiRequest(openaiBody, req.headers);
  } catch (error) {
    console.error('[proxy] request correlation unavailable: ' + error.message);
  }
  const requestedModel = String(openaiBody.model || '');
  const dedicatedVoiceModel = new Set([
    VAPI_SUBSCRIPTION_VOICE_MODEL,
    VAPI_SUBSCRIPTION_VOICE_PREFLIGHT_MODEL,
  ]).has(requestedModel);
  const correlatedLegacyVoiceModel =
    Boolean(correlation?.attributed) &&
    new Set(['claude-max-subscription', 'gpt-4o']).has(requestedModel);
  if (dedicatedVoiceModel || correlatedLegacyVoiceModel) {
    if (!dedicatedVoiceModel) {
      console.error(
        `[proxy] forcing stale or correlated phone model ${String(openaiBody.model || 'missing')} onto isolated voice lane`,
      );
    }
    // Which model answers the phone is a runtime decision, not a constant.
    // 2026-08-16: Codex hit its usage limit mid-afternoon and every voice turn
    // afterwards failed Codex, fell through to a second Codex path, failed
    // again, and the caller heard silence while a healthy Claude lane sat
    // unused. The router remembers a quota or auth outage so the next call
    // skips the dead provider instead of rediscovering it and burning the
    // first-content budget. Falling through here reaches the Claude lane below,
    // which already streams OpenAI-shaped SSE with tool_calls for Vapi.
    if (String(selectVoiceLane(VOICE_LANE_OPTS) || '').startsWith('codex')) {
      handleCodexVoiceCompletions(openaiBody, req, res, correlation);
      return;
    }
    // auth-voice-paid-fallback: Codex being out is the ONLY thing that arms
    // paid spend, and reaching this line is that proof. The gate still decides,
    // and any refusal falls through to the Claude lane rather than to silence.
    const paidCallId = 'chatcmpl-openai-voice-' + Date.now();
    const paid = reserveVoicePaidCall({ codexExhausted: true, callId: paidCallId });
    if (paid.allowed) {
      console.error(
        `[proxy] voice lane router: Codex unavailable, answering on the paid OpenAI lane (${paid.remainingCalls} calls, $${paid.remainingUsd} left today)`,
      );
      handleOpenAiVoiceFallback(openaiBody, req, res, paidCallId, correlation);
      return;
    }
    console.error(
      `[proxy] voice lane router: Codex unavailable, paid lane refused (${paid.reason}), answering on the Claude lane`,
    );
    // Use the voice decision lane, not the general chat path. The general path
    // cannot name a Vapi function tool, which cost Amy check_spine on a live
    // call.
    handleClaudeVoiceFallback(openaiBody, req, res, correlation);
    return;
  }
  const prompt = messagesToPrompt(openaiBody.messages || [], openaiBody.tools);
  let requestedEffort = '';
  try {
    requestedEffort = resolveAutomatedEffortRequest(openaiBody);
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message, type: 'invalid_effort_contract' } }));
    return;
  }
  const callId = 'chatcmpl-max-' + Date.now();
  const telemetry = startInferenceTelemetry({
    openaiBody,
    headers: req.headers,
    prompt,
    correlation,
    processName: 'openai-compatible-claude-proxy',
    trigger: 'compatibility-completion',
    model: 'claude-sonnet-4-6',
    effort: requestedEffort || 'not-exposed',
    returnCondition: 'one OpenAI-compatible completion',
  });

  console.log(
    '[proxy] Request: ' +
      (openaiBody.messages || []).length +
      ' messages, ' +
      (openaiBody.tools || []).length +
      ' tools, prompt ' +
      prompt.length +
      ' chars',
  );

  // Note: --bare was removed from claude CLI in 2.1.72. Use
  // --dangerously-skip-permissions so permission gates do not interfere
  // with Vapi-injected prompts. Feed prompt via stdin so shell:true
  // (required for Windows .cmd) does not word-split multi-word args.
  //
  // --mcp-config loads the Vapi MCP server (bridge_in_owner,
  // request_approval, flag_reputation_risk, send_message). Claude sees
  // these as native tools and emits tool_use events when calling them.
  // The stdout handler translates those to OpenAI tool_calls for Vapi.
  const toolLessCompatibility = openaiBody.tool_less === true;
  // Set by handleClaudeVoiceFallback when Codex is unavailable and Claude is
  // answering the phone. This turn is on the voice first-content budget.
  const voiceFallbackTurn = openaiBody.voice_fallback === true;
  // 4400ms was tuned for the WARMED Codex app-server lane. The Claude lane
  // spawns a CLI per turn: measured 3296/3367/4235ms to first text on ExampleCo's PC
  // under normal load, so the Codex budget clips it right at the edge and the
  // caller hears silence from a lane that was about to answer. Vapi abandons a
  // custom-LLM request at roughly 20s, so a wider budget here is still safely
  // inside the phone contract. A slightly later answer beats no answer.
  const claudeFirstContentBudgetMs = voiceFallbackTurn
    ? Number(process.env.VOICE_CLAUDE_FIRST_CONTENT_TIMEOUT_MS) || 9000
    : VOICE_FIRST_CONTENT_TIMEOUT_MS;
  const args = [
    '-p',
    '--model',
    'claude-sonnet-4-6',
    ...(requestedEffort ? ['--effort', requestedEffort] : []),
    '--input-format',
    'text',
    ...(toolLessCompatibility
      ? [
          '--setting-sources',
          '',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          '--tools',
          '',
          '--permission-mode',
          'dontAsk',
          '--no-session-persistence',
        ]
      : [
          // A voice turn cannot afford to load settings, hooks, and project
          // CLAUDE.md before it speaks. Measured on ExampleCo's PC with an identical
          // trivial prompt: 6323ms to first text with settings loaded, 2879ms
          // with `--setting-sources ''` and the Vapi MCP tools still attached.
          // The first-content budget is 4400ms, so the default flags miss it
          // and the caller hears silence while the lane is otherwise healthy.
          // Tools still work: --setting-sources only skips settings discovery,
          // --mcp-config below still supplies the Vapi tool server.
          // `--tools ''` disables Claude's BUILT-IN tools. A phone turn must
          // never be able to reach Bash, Edit, or Write: observed on the first
          // live test of this lane, Amy answered "How many sessions today?" by
          // emitting a Bash tool_call to list a directory. The Codex lane could
          // not do that because it is constrained to a decision schema, so this
          // risk arrives with the fallback and has to be closed with it. The
          // Vapi MCP server added below still supplies the real voice tools.
          ...(voiceFallbackTurn ? ['--setting-sources', '', '--tools', ''] : []),
          '--dangerously-skip-permissions',
        ]),
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  const hasFunctionTools = (openaiBody.tools || []).some((tool) => tool?.type === 'function');
  if (hasFunctionTools && !toolLessCompatibility) {
    args.push(
      '--mcp-config',
      process.env.CLAUDE_PROXY_MCP_CONFIG || path.join(__dirname, 'scripts', 'vapi-mcp', 'config.json'),
      '--strict-mcp-config',
    );
  }

  // On Windows, claude is shipped as a .cmd shim. Node's spawn can't run
  // .cmd files directly without shell:true (EINVAL since Node 20). Use the
  // shell flag and quote the path in case it contains spaces (Roaming/npm).
  const isWindowsCmd =
    process.platform === 'win32' && /\.(cmd|bat)$/i.test(CLAUDE_PATH);
  // Strip CLAUDECODE so the spawned `claude -p` doesn't think it's nested
  // inside another Claude Code session and bail with "Claude Code cannot be
  // launched inside another Claude Code session." The proxy may be started
  // from a Claude Code shell during local dev. Keep CLAUDE_CODE_GIT_BASH_PATH
  // — Claude needs it on Windows to find git-bash for tool execution.
  const childEnv = buildClaudeCliEnv(process.env);
  if (correlation?.attributed) {
    childEnv.AMY_SURFACE = 'vapi';
    childEnv.VAPI_CALL_ID = correlation.callId;
  }
  const proc = spawn(CLAUDE_PATH, args, {
    env: childEnv,
    // Voice requests are fully self-contained. Starting Claude from the owner
    // home loads unrelated project instructions and hooks before speech,
    // which can consume the entire phone first-content budget.
    cwd: claudeRuntimeCwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: isWindowsCmd,
    windowsHide: true,
  });

  let childSettled = false;
  let terminatedReason = '';
  let firstContentSeen = false;
  let firstContentTimer = null;
  let streamTimer = null;
  const terminateProcess = (reason) => {
    if (childSettled || terminatedReason) return;
    terminatedReason = reason;
    telemetry.settle(reason, contentBytes);
    console.error('[proxy] terminating Claude stream: ' + reason);
    if (process.platform === 'win32' && proc.pid) {
      try {
        const treeKiller = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        // Do not kill the .cmd root immediately after starting taskkill. That
        // race lets claude.exe become an orphan before taskkill enumerates the
        // tree. Fall back to the root-only signal only if taskkill itself fails.
        treeKiller.on('error', () => {
          try { proc.kill('SIGTERM'); } catch { /* already dead */ }
        });
        treeKiller.on('close', (code) => {
          if (code === 0 || childSettled) return;
          try { proc.kill('SIGTERM'); } catch { /* already dead */ }
        });
        return;
      } catch {
        /* direct child kill below remains the fallback */
      }
    }
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already dead */
    }
  };
  const noteFirstContent = () => {
    if (firstContentSeen) return;
    firstContentSeen = true;
    if (firstContentTimer) clearTimeout(firstContentTimer);
  };
  const clientDisconnected = (source) => {
    if (!res.writableEnded) terminateProcess('client disconnected via ' + source);
  };
  req.on('aborted', () => clientDisconnected('request aborted'));
  res.on('close', () => clientDisconnected('response close'));
  firstContentTimer = setTimeout(() => {
    if (firstContentSeen || childSettled) return;
    terminateProcess('first content deadline exceeded');
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'voice_first_content_timeout',
            message: `No model content within ${claudeFirstContentBudgetMs}ms.`,
          },
        }),
      );
    }
  }, claudeFirstContentBudgetMs);
  streamTimer = setTimeout(() => {
    if (childSettled) return;
    terminateProcess('voice stream deadline exceeded');
    if (!res.writableEnded) res.end();
  }, VOICE_STREAM_TIMEOUT_MS);

  // Defer the SSE 200 until claude actually produces streamable output. If
  // the spawned CLI dies without streaming anything (expired auth), headers
  // are not yet committed and the close handler can return an honest 502
  // instead of a clean empty 200 (the "empty-200 bug").
  let sseStarted = false;
  const startSSE = () => {
    if (sseStarted || res.writableEnded) return;
    sseStarted = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Send initial role delta
    res.write(
      'data: ' +
        JSON.stringify({
          id: callId,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        }) +
        '\n\n',
    );
  };
  const sseWrite = (payload) => {
    if (res.writableEnded || res.destroyed || terminatedReason) return;
    startSSE();
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
  };

  let buffer = '';
  let fullText = '';
  // Content actually delivered to the client (text chars + tool-call
  // name/argument chars). Zero at close time means the stream failed even if
  // the exit code says 0.
  let contentBytes = 0;
  // First chars of raw child output (stdout + stderr) for sentinel
  // classification at close time. Auth failures print to either stream,
  // sometimes with exit 0 ("Not logged in · Please run /login").
  let childOutputHead = '';
  const captureHead = (s) => {
    if (childOutputHead.length < 1000) {
      childOutputHead = (childOutputHead + s).slice(0, 1000);
    }
  };
  // Track tool_use content blocks so we can translate Claude's anthropic
  // tool-use format to OpenAI's tool_calls streaming format. Vapi speaks
  // OpenAI, so without this translation, tool calls are dropped and Vapi
  // silently hangs the call.
  const toolUses = {}; // index -> { id, name, inputJson }
  let stopReason = null;

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    captureHead(text);
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        // stream-json content_block_start: track tool_use blocks starting
        if (event.type === 'stream_event' && event.event && event.event.type === 'content_block_start') {
          const cb = event.event.content_block;
          const idx = event.event.index;
          if (cb && cb.type === 'tool_use') {
            noteFirstContent();
            toolUses[idx] = { id: cb.id, name: cb.name, inputJson: '' };
            contentBytes += (cb.name || '').length;
            // Emit OpenAI-style tool_calls delta with id and name
            sseWrite({
              id: callId,
              object: 'chat.completion.chunk',
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: idx,
                    id: cb.id,
                    type: 'function',
                    function: { name: cb.name, arguments: '' },
                  }],
                },
                finish_reason: null,
              }],
            });
          }
        }

        // stream-json deltas: text or tool_use input JSON
        if (event.type === 'stream_event' && event.event && event.event.delta) {
          const delta = event.event.delta;
          const idx = event.event.index;

          if (delta.type === 'text_delta' && delta.text) {
            noteFirstContent();
            fullText += delta.text;
            contentBytes += delta.text.length;
            sseWrite({
              id: callId,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
            });
          } else if (delta.type === 'input_json_delta' && toolUses[idx]) {
            noteFirstContent();
            // Stream the tool-call argument JSON chunks to OpenAI format
            toolUses[idx].inputJson += delta.partial_json || '';
            contentBytes += (delta.partial_json || '').length;
            sseWrite({
              id: callId,
              object: 'chat.completion.chunk',
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: idx,
                    function: { arguments: delta.partial_json || '' },
                  }],
                },
                finish_reason: null,
              }],
            });
          }
        }

        // Capture the stop_reason so we can emit the right OpenAI finish_reason
        if (event.type === 'stream_event' && event.event && event.event.type === 'message_delta') {
          if (event.event.delta && event.event.delta.stop_reason) {
            stopReason = event.event.delta.stop_reason;
          }
        }

        // result event (final) — fallback if no deltas streamed
        if (event.type === 'result' && event.result) {
          if (!fullText && !Object.keys(toolUses).length && event.result) {
            noteFirstContent();
            contentBytes += String(event.result).length;
            sseWrite({
              id: callId,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content: event.result }, finish_reason: null }],
            });
          }
        }
      } catch {
        // Non-JSON output — might be raw text in some modes
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg && !msg.includes('Update available')) {
      captureHead(msg);
      console.error('[proxy] stderr:', msg.slice(0, 200));
    }
  });

  proc.on('close', (code) => {
    childSettled = true;
    if (firstContentTimer) clearTimeout(firstContentTimer);
    if (streamTimer) clearTimeout(streamTimer);
    if (terminatedReason) return;
    const toolCount = Object.keys(toolUses).length;
    console.log(
      '[proxy] claude -p exited (' + code + '), streamed ' + contentBytes +
      ' content chars' + (toolCount ? ', ' + toolCount + ' tool calls' : ''),
    );
    const verdict = decideStreamOutcome({
      exitCode: code,
      bytesStreamed: contentBytes,
      outputHead: childOutputHead,
    });
    if (verdict.outcome === 'error') {
      telemetry.settle(`failed:${verdict.reason}`, contentBytes);
      // Fail loud (the old "empty-200 bug" closed this as a clean stream).
      console.error('[proxy] stream FAILED: ' + verdict.reason);
      const failure = classifyCanaryFailureOutput(childOutputHead);
      const authFailure =
        isCliFailureOutput(childOutputHead) && failure.verdict === 'owner_action_required';
      recordHealthEvent(
        authFailure
          ? {
              verdict: 'owner_action_required',
              code: failure.code,
              detail: verdict.reason,
              source: 'real-stream',
            }
          : {
              verdict: 'inconclusive',
              code: 'stream_failure',
              detail: verdict.reason,
              source: 'real-stream',
            },
      );
      if (!res.headersSent) {
        // Nothing committed yet: an honest 502 lets EC2 fall through to the
        // next ladder rung instead of treating silence as an answer.
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { code: 'claude_unavailable', message: verdict.reason },
          }),
        );
        return;
      }
      // SSE already started: emit an explicit error chunk so the client
      // never mistakes a dead stream for a clean completion.
      sseWrite({
        id: callId,
        object: 'chat.completion.chunk',
        error: { code: 'claude_unavailable', message: verdict.reason },
        choices: [
          { index: 0, delta: { content: '[claude unavailable]' }, finish_reason: null },
        ],
      });
      sseWrite({
        id: callId,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      res.write('data: [DONE]\n\n');
      if (!res.writableEnded) res.end();
      return;
    }
    // Real content delivered: count it as a passing auth probe for /health.
    telemetry.settle('completed', contentBytes);
    lastSuccessfulStreamAt = Date.now();
    recordHealthEvent({ verdict: 'ok', detail: 'real stream delivered content', source: 'real-stream' });
    // Translate Claude's stop_reason to OpenAI's finish_reason so Vapi
    // knows whether to dispatch tool calls or treat the response as final.
    const finishReason =
      stopReason === 'tool_use' || toolCount > 0 ? 'tool_calls'
      : stopReason === 'max_tokens' ? 'length'
      : 'stop';
    sseWrite({
      id: callId,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    });
    res.write('data: [DONE]\n\n');
    if (!res.writableEnded) res.end();
  });

  proc.on('error', (err) => {
    childSettled = true;
    if (firstContentTimer) clearTimeout(firstContentTimer);
    if (streamTimer) clearTimeout(streamTimer);
    if (terminatedReason) return;
    telemetry.settle('spawn-error', contentBytes);
    console.error('[proxy] spawn error:', err.message);
    recordHealthEvent({
      verdict: 'inconclusive',
      code: 'spawn_error',
      detail: err.message,
      source: 'real-stream',
    });
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'claude not available: ' + err.message } }));
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  // Send the prompt via stdin and close it so claude reads, runs, exits
  proc.stdin.write(prompt);
  proc.stdin.end();

}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // Health check: honest verdict backed by a cached real auth probe. EC2's
  // checkLocalProxy routes live Vapi traffic on this answer, so 200 only
  // when Claude auth demonstrably works; 503 degraded otherwise.
  if (url === '/health' && req.method === 'GET') {
    const verdict = await getClaudeHealth();
    if (verdict.ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          state: verdict.state,
          proofAt: verdict.proofAt,
          proofSource: verdict.proofSource,
          service: 'claude-max-proxy',
          uptime: process.uptime(),
        }),
      );
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'degraded',
          state: verdict.state,
          reason:
            verdict.state === 'owner_action_required'
              ? 'claude auth failing'
              : 'claude live proof unavailable',
          code: verdict.code,
          detail: verdict.reason,
          ownerAction: verdict.ownerAction,
          proofAt: verdict.proofAt,
          proofSource: verdict.proofSource,
          service: 'claude-max-proxy',
          uptime: process.uptime(),
        }),
      );
    }
    return;
  }

  // OpenAI-compatible chat completions
  if ((url === '/chat/completions' || url === '/v1/chat/completions') && req.method === 'POST') {
    try {
      const body = await readBody(req);
      handleChatCompletions(body, req, res);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON: ' + e.message } }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

function closeProxy() {
  voiceAppServer.close();
  server.close(() => process.exit(0));
  const forceExit = setTimeout(() => process.exit(0), 1500);
  forceExit.unref?.();
}

process.once('SIGINT', closeProxy);
process.once('SIGTERM', closeProxy);

server.listen(PORT, '127.0.0.1', () => {
  voiceAppServer
    .warm()
    .then(() => console.log('[claude-max-proxy] Codex app-server voice lane warmed'))
    .catch((error) => console.error('[claude-max-proxy] Codex app-server warmup failed: ' + error.message));
  console.log('[claude-max-proxy] Listening on 127.0.0.1:' + PORT);
  console.log('[claude-max-proxy] Using: ' + CLAUDE_PATH);
  console.log(
    '[claude-max-proxy] Connect EC2 via: ssh -R ' +
      PORT +
      ':localhost:' +
      PORT +
      ' user@your-server',
  );
  console.log('[claude-max-proxy] Max plan tokens — zero API cost');
});
