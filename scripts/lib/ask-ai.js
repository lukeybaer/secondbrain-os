// scripts/lib/ask-ai.js
//
// THE universal LLM ladder for all Amy text processing (ExampleCo's 2026-06-11
// policy, plan: dev-plans/llm-fallback-ladder-2026-06-11.html, Codex-reviewed;
// paid-model API policy updated per ExampleCo's 2026-08-05 direct instruction).
//
// Rung order (defaultRungOrder, host-aware since W5 stage 3 2026-07-12; led by
// the durable brain switch since 2026-09-03, scripts/lib/brain-switch.js):
//   Claude leading (source default):  desktop claude-cli, codex
//                                     EC2     claude-cli, codex
//   Codex leading (owner flip, or Claude reported out of tokens):
//                                     desktop codex, claude-cli
//                                     EC2     codex, claude-cli
//     (cloud work never calls the laptop SSH-tunnel proxy)
//   briefing/news/#learn/healer: Codex subscription only, pinned to GPT-5.6
//   Sol/medium or lower. The former Bedrock switch is dormant and cannot
//   authorize a paid or alternate-provider rung in this scope.
//
// Hard requirement: no surface dead when the Claude subscription is down.
// Therefore: every rung failure (null, throw, or sentinel auth-error output)
// DESCENDS to the next rung; BrainUnreachable throws only when ALL rungs fail.
// Paid-model API policy (ExampleCo's 2026-08-05 direct instruction): every metered
// model-token rung and canary is blocked before execution. Per-call approval,
// historical caps, and stale rung-order overrides cannot reopen it. Historical
// spend helpers remain for attribution and migration compatibility only.
//
// Runs on EC2 and the PC (pure Node builtins). Surfaces inject per-call
// options; tests inject rung fns directly.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const https = require('node:https');
const {
  isCliFailureOutput,
  buildClaudeCliEnv,
  buildCodexCliEnv,
} = require('./cli-output-guard.js');
const { withTransientRetry, isTransientError } = require('./transient-error.js');
const { withCodexAmyPrelude } = require('./codex-amy-prelude.js');
const { resolveCodexDecision, resolveModelEffort } = require('./model-effort-policy.js');
const {
  assertModelEnabled,
  claudeCeilingPins,
  claudeCliPins,
  CLAUDE_MODELS_UNDER_CEILING,
  OVERNIGHT_CEILING,
  overnightProfileActive,
  ownerReportLockApplies,
  resolveOwnerReportLock,
} = require('./model-router.js');
const { resolveDirectCodex } = require('./codex-executable.js');
const {
  brainOrder,
  brainOfRung,
  readState: readBrainSwitchState,
  recordBrainFailure,
  recordBrainSuccess,
} = require('./brain-switch.js');
const {
  DEFAULT_STABLE_CONTEXT,
  buildBriefingModelContext,
  persistBriefingModelContextReceipt,
  markBriefingModelContextOutcome,
  readPriorContextReceipt,
} = require('./briefing-model-context.js');
const {
  admitBriefingModelLaunch,
  settleBriefingModelLaunch,
} = require('./briefing-night-circuit.js');
const {
  authorizeBriefingApiFallback,
  recordSettlement: recordBriefingApiSettlement,
} = require('./briefing-api-fallback-switch.js');

const { parseClaudeJsonUsage, parseCodexJsonlUsage } = require('./subscription-cli-usage.js');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
// ASK_AI_RUNGS_FILE redirects the append-only rung attempt ledger (tests);
// resolved at require time, the same style REPO uses SECONDBRAIN_ROOT.
const ATTEMPT_LOG =
  process.env.ASK_AI_RUNGS_FILE || path.join(REPO, 'data', 'agent', 'ask-ai-rungs.jsonl');
const SPEND_FILE = path.join(REPO, 'data', 'agent', 'openai-api-spend.json');
const OPENAI_MONTHLY_CAP_USD = Number(process.env.OPENAI_API_MONTHLY_CAP_USD || 30);
const OPENAI_NIGHTLY_CAP_USD = Number(process.env.OPENAI_API_NIGHTLY_CAP_USD || 10);
const OPENAI_WARN_USD = Number(process.env.OPENAI_API_WARN_USD || 15);
// Conservative per-call estimate recorded when the API response has no usage
// block: overcounting toward the caps beats silently recording zero and
// letting an untelemetered loop burn past them.
const DEFAULT_OPENAI_CALL_EST_USD = 0.02;
const CHARGED_API_RUNGS = new Set(['openai-api', 'anthropic-api', 'bedrock']);
// The Claude CLI rung's own timer when the caller names no rungTimeoutMs.
const CLAUDE_CLI_RUNG_TIMEOUT_MS = 120000;

class RungTimeoutError extends Error {
  constructor(rungName, timeoutMs) {
    super(`rung-timeout:${rungName}:${timeoutMs}ms`);
    this.name = 'RungTimeoutError';
    this.code = 'ERUNG_TIMEOUT';
    this.rungTimeout = true;
    this.rungName = rungName;
    this.timeoutMs = timeoutMs;
  }
}

class BrainUnreachable extends Error {
  constructor(attempts) {
    super('All LLM rungs failed: ' + attempts.map((a) => `${a.rung}=${a.outcome}`).join(', '));
    this.name = 'BrainUnreachable';
    this.attempts = attempts;
  }
}

// Test runs never write the live rung ledger: under vitest only an explicit
// ASK_AI_RUNGS_FILE redirect (or an injected non-default path) is written.
function isLiveLedgerUnderTest(file) {
  return (
    Boolean(process.env.VITEST) &&
    !process.env.ASK_AI_RUNGS_FILE &&
    path.resolve(file) === path.resolve(path.join(REPO, 'data', 'agent', 'ask-ai-rungs.jsonl'))
  );
}

function appendJsonl(file, obj) {
  if (isLiveLedgerUnderTest(file)) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch {
    /* logging must never break the ladder */
  }
}

function resolveRungTimeoutMs(opts = {}, fallbackMs = 45000) {
  const raw =
    opts.rungTimeoutMs !== undefined
      ? opts.rungTimeoutMs
      : process.env.ASK_AI_FAIL_FAST_MS !== undefined
        ? process.env.ASK_AI_FAIL_FAST_MS
        : fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}

function withRungTimeout(fn, timeoutMs, rungName) {
  const ms = resolveRungTimeoutMs({ rungTimeoutMs: timeoutMs }, timeoutMs);
  let timer = null;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new RungTimeoutError(rungName, ms)), ms);
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  });
}

// ---- hard-capped spend ledger for the OpenAI API floor ---------------------
//
// State file shape: { month, spentUsd, calls, night, nightSpentUsd,
// nightCalls, nightHistory, updatedAt }. Both buckets key off the America/Chicago clock,
// not UTC: month is the yyyy-mm of the CT date; night is the night-of date
// of the 6:00 PM to 6:00 AM CT window (D5, ExampleCo 2026-07-11). Legacy pre-D5
// files carried { day, daySpentUsd, dayCalls } (CT calendar-day bucket);
// those are read once as the night bucket and roll off on the next write.

// CT calendar-day string (yyyy-mm-dd) for the given instant. The single place
// the CT boundary is computed, exported so tests can pin the boundary.
function ctDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d);
}

// Coerce a date-like value (Date, ISO string, epoch ms, undefined) to a Date.
// Unparseable input degrades to "now": the ledger must keep counting even if
// a caller hands it garbage (fail-safe); strict validation belongs at the
// HTTP settle endpoint, not here.
function toDate(dateLike) {
  if (dateLike instanceof Date && !Number.isNaN(dateLike.getTime())) return dateLike;
  if (dateLike === undefined || dateLike === null) return new Date();
  const d = new Date(dateLike);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

// CT hour of day (0-23) for the given instant.
function ctHour(d = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(d),
  );
}

// The yyyy-mm-dd string one calendar day before the given yyyy-mm-dd string.
function previousDateString(day) {
  const [y, m, d] = String(day)
    .split('-')
    .map((n) => Number(n));
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

function isoDateMinusDays(day, count) {
  const [y, m, d] = String(day)
    .split('-')
    .map((n) => Number(n));
  return new Date(Date.UTC(y, m - 1, d - Math.max(0, Number(count) || 0)))
    .toISOString()
    .slice(0, 10);
}

// D5 (ExampleCo 2026-07-11): the nightly cap governs ONLY the 6:00 PM to 6:00 AM
// CT window. A charged call is IN the night window when its CT time is
// >= 18:00 or < 06:00; calls between 06:00 and 17:59 CT are governed by the
// monthly cap alone. Exported so tests can pin the boundaries.
function inNightWindow(dateLike) {
  const h = ctHour(toDate(dateLike));
  return h >= 18 || h < 6;
}

// The night bucket key is the night-of date: the CT date when the CT time is
// >= 18:00, the PREVIOUS CT date when it is < 06:00 (still the night that
// began yesterday evening). For daytime instants (outside the window) the
// key is the CT date, i.e. the night that begins tonight, so a daytime roll
// pre-clears the bucket tonight will use. Exported for tests.
function nightKey(dateLike) {
  const d = toDate(dateLike);
  const day = ctDateString(d);
  return ctHour(d) < 6 ? previousDateString(day) : day;
}

// The spend ledger path. opts.spendFile (tests) beats the env override beats
// the repo default, mirroring how REPO resolves via SECONDBRAIN_ROOT.
function resolveSpendFile(opts) {
  return (opts && opts.spendFile) || process.env.OPENAI_API_SPEND_FILE || SPEND_FILE;
}

// Normalize a raw ledger object onto the current CT buckets: a month change
// resets the month bucket, a night-of change resets the night bucket. Legacy
// pre-D5 day fields (day/daySpentUsd/dayCalls) are read as the night bucket
// so a mid-flight ledger keeps counting, then roll off on the next write
// (the returned shape carries only the night fields).
function rollSpendState(raw, now = new Date()) {
  const day = ctDateString(now);
  const month = day.slice(0, 7);
  const night = nightKey(now);
  const s = {
    month: raw.month,
    spentUsd: Number(raw.spentUsd) || 0,
    calls: Number(raw.calls) || 0,
    night: raw.night !== undefined ? raw.night : raw.day,
    nightSpentUsd:
      Number(raw.nightSpentUsd !== undefined ? raw.nightSpentUsd : raw.daySpentUsd) || 0,
    nightCalls: Number(raw.nightCalls !== undefined ? raw.nightCalls : raw.dayCalls) || 0,
    nightHistory:
      raw.nightHistory && typeof raw.nightHistory === 'object' && !Array.isArray(raw.nightHistory)
        ? { ...raw.nightHistory }
        : {},
    updatedAt: raw.updatedAt,
  };
  // Preserve the current legacy bucket as the first history row when the
  // history index is introduced. This makes the reporting upgrade truthful
  // immediately without pretending older nights can be reconstructed.
  if (s.night && !s.nightHistory[s.night]) {
    s.nightHistory[s.night] = {
      spentUsd: Math.max(0, Number(s.nightSpentUsd) || 0),
      calls: Math.max(0, Number(s.nightCalls) || 0),
    };
  }
  if (s.month !== month) {
    s.month = month;
    s.spentUsd = 0;
    s.calls = 0;
  }
  if (s.night !== night) {
    s.night = night;
    s.nightSpentUsd = 0;
    s.nightCalls = 0;
  }
  const cutoff = isoDateMinusDays(day, 45);
  for (const key of Object.keys(s.nightHistory)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key < cutoff || key > day) delete s.nightHistory[key];
  }
  return s;
}

// Historical strict spend read retained for attribution and migration tests.
function loadSpendState(file, now = new Date()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, state: rollSpendState({}, now) };
    return { ok: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ok: false };
    return { ok: true, state: rollSpendState(parsed, now) };
  } catch {
    return { ok: false };
  }
}

// Lenient read kept for existing callers (ec2-server health display): any
// unreadable state degrades to a zero counter instead of throwing. The cap
// gate uses loadSpendState() instead so corruption blocks spend, not reads.
function readSpend(file = resolveSpendFile(), now = new Date()) {
  const loaded = loadSpendState(file, now);
  return loaded.ok ? loaded.state : rollSpendState({}, now);
}

// Settle estUsd into the LOCAL file: the month bucket always, the night
// bucket only when the call instant (`at`) falls inside the 6pm-6am CT
// window. Daytime spend counts against the month alone (D5).
function recordSpend(estUsd, file = resolveSpendFile(), at = new Date()) {
  const now = toDate(at);
  const s = readSpend(file, now);
  s.spentUsd = Math.round((s.spentUsd + estUsd) * 10000) / 10000;
  s.calls += 1;
  if (inNightWindow(now)) {
    s.nightSpentUsd = Math.round((s.nightSpentUsd + estUsd) * 10000) / 10000;
    s.nightCalls += 1;
    const existing =
      s.nightHistory[s.night] && typeof s.nightHistory[s.night] === 'object'
        ? s.nightHistory[s.night]
        : {};
    const hasProviderBreakdown =
      existing.sealedAt ||
      existing.openaiSpentUsd !== undefined ||
      existing.bedrockSpentUsd !== undefined;
    if (hasProviderBreakdown) {
      const bedrockSpentUsd = Math.max(0, Number(existing.bedrockSpentUsd) || 0);
      const bedrockCalls = Math.max(0, Number(existing.bedrockCalls) || 0);
      s.nightHistory[s.night] = {
        ...existing,
        spentUsd: Math.round((s.nightSpentUsd + bedrockSpentUsd) * 10000) / 10000,
        calls: s.nightCalls + bedrockCalls,
        openaiSpentUsd: s.nightSpentUsd,
        openaiCalls: s.nightCalls,
        bedrockSpentUsd,
        bedrockCalls,
        proofComplete: false,
        source: existing.sealedAt ? 'charged-call-after-nightly-seal' : existing.source,
      };
      delete s.nightHistory[s.night].sealedAt;
    } else {
      s.nightHistory[s.night] = { spentUsd: s.nightSpentUsd, calls: s.nightCalls };
    }
  }
  s.updatedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(s, null, 1));
  } catch (e) {
    // The answer was already paid for: a lost ledger write must not crash the
    // caller, but it can never be silent either.
    appendJsonl(ATTEMPT_LOG, {
      ts: new Date().toISOString(),
      level: 'error',
      rung: 'openai-api',
      spendFile: file,
      error: 'spend-write-failed:' + String(e && e.message).slice(0, 80),
    });
  }
  return s;
}

// Settle one successful openai-api call into the cap buckets (month always,
// night when inside the 6pm-6am CT window) on the LOCAL file. A response
// with no usage block records DEFAULT_OPENAI_CALL_EST_USD instead of zero so
// missing telemetry cannot starve the caps. The live rung goes through the
// async settleOpenAiSpendViaLedger wrapper so a configured central ledger
// wins; this sync local settle stays the shared primitive (also used by the
// ec2-server floor and by the ledger endpoints themselves).
function settleOpenAiSpend(usage, opts = {}) {
  const estUsd = usage ? estimateOpenAiCostUsd(usage) : DEFAULT_OPENAI_CALL_EST_USD;
  const state = recordSpend(estUsd, resolveSpendFile(opts), toDate(opts.now));
  return { estUsd, state };
}

// ---- central spend ledger client (D3, ExampleCo 2026-07-11) ---------------------
//
// When SB_SPEND_LEDGER_URL and SB_SPEND_TOKEN are both set (the desktop
// points at EC2: SB_SPEND_LEDGER_URL=http://ExampleCo:3001), the cap gate
// reads spend from GET {url}/llm-spend and settlement POSTs
// {url}/llm-spend/settle {estUsd, at}, both authenticated with the
// x-sb-spend-token header. EC2 itself sets neither env and keeps using its
// local file directly (the endpoints and the local ladder share that file).
// FAIL-SAFE: any remote failure (timeout, non-2xx, bad JSON) falls back to
// the LOCAL file for both read and settle, with an attempt-log line noting
// the fallback. Local caps stay enforced; the briefing is never blocked by
// ledger network trouble.

const SPEND_LEDGER_TIMEOUT_MS = 3000;

function remoteLedgerConfig(opts = {}) {
  const url = (opts && opts.spendLedgerUrl) || process.env.SB_SPEND_LEDGER_URL || '';
  const token = (opts && opts.spendLedgerToken) || process.env.SB_SPEND_TOKEN || '';
  if (!url || !token) return null;
  return { url, token };
}

// One request against the remote ledger. Resolves the parsed JSON object on
// 2xx, null on ANY failure (never throws, never hangs past the timeout).
function ledgerRequest(remote, method, route, bodyObj) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(route, remote.url);
    } catch {
      return resolve(null);
    }
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const lib = u.protocol === 'https:' ? https : require('node:http');
    const req = lib.request(
      u,
      {
        method,
        headers: {
          'x-sb-spend-token': remote.token,
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
        timeout: SPEND_LEDGER_TIMEOUT_MS,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return resolve(null);
            resolve(parsed);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function logLedgerFallback(opts, what, remote) {
  appendJsonl(ATTEMPT_LOG, {
    ts: new Date().toISOString(),
    surface: (opts && opts.surface) || 'unknown',
    rung: 'openai-api',
    ledger: remote.url,
    fallback: what + ':using-local-file',
  });
}

// Gate-side read of the central ledger. Returns { ok:true, state } (rolled
// onto the current CT buckets) on success, null when the ledger is not
// configured OR unreachable (the caller then falls back to the local file).
async function readLedgerSpendState(opts = {}, now = new Date()) {
  const remote = remoteLedgerConfig(opts);
  if (!remote) return null;
  const state = await ledgerRequest(remote, 'GET', '/llm-spend');
  if (!state) {
    logLedgerFallback(opts, 'spend-ledger-read-failed', remote);
    return null;
  }
  return { ok: true, state: rollSpendState(state, now), via: 'remote' };
}

// Settlement used by the live openai-api rung: remote-first when the central
// ledger is configured, LOCAL file otherwise or on any remote failure.
async function settleOpenAiSpendViaLedger(usage, opts = {}) {
  const estUsd = usage ? estimateOpenAiCostUsd(usage) : DEFAULT_OPENAI_CALL_EST_USD;
  const at = toDate(opts.now);
  const remote = remoteLedgerConfig(opts);
  if (remote) {
    const state = await ledgerRequest(remote, 'POST', '/llm-spend/settle', {
      estUsd,
      at: at.toISOString(),
    });
    if (state) return { estUsd, state: rollSpendState(state, at), via: 'remote' };
    logLedgerFallback(opts, 'spend-ledger-settle-failed', remote);
  }
  return { estUsd, state: recordSpend(estUsd, resolveSpendFile(opts), at), via: 'local' };
}

// Warn-only visibility: returns a warning string past the warn threshold or
// the cap, never blocks. Blocking lives in chargedLlmApiGate.
function budgetWarning(budget) {
  const spent = budget.spentUsd;
  const cap = budget.capUsd;
  if (spent >= cap) {
    return `OpenAI API floor spend $${spent.toFixed(2)} has reached the hard $${cap} monthly cap; the gate blocks further paid-floor calls until the CT month rolls.`;
  }
  if (spent >= (budget.warnUsd ?? OPENAI_WARN_USD)) {
    return `OpenAI API floor spend $${spent.toFixed(2)} approaching the $${cap} monthly cap.`;
  }
  return null;
}

function isChargedApiRung(rung) {
  if (!rung) return false;
  return rung.paid === true || CHARGED_API_RUNGS.has(String(rung.name || ''));
}

// preloadedSpend (optional): { ok:true, state } already fetched from the
// central ledger (D3). When absent the gate reads the LOCAL spend file.
function chargedLlmApiGate(opts = {}, attempts = [], rungName, _preloadedSpend, prompt = '') {
  // The only charged answer-generation exception is the fail-closed,
  // timeboxed overnight-briefing Bedrock switch. Its deployment is not
  // authorization: the state file must carry a fresh owner instruction and
  // this call must prove every subscription rung was attempted first.
  if (String(rungName || '') === 'bedrock') {
    return authorizeBriefingApiFallback({
      rungName,
      attempts,
      now: opts.now,
      surface: opts.surface,
      briefingContext: opts.briefingContext === true,
      prompt,
      switchFile: opts.briefingApiSwitchFile,
      usageFile: opts.briefingApiUsageFile,
      dataDir: opts.dataDir,
      fsApi: opts.fsApi,
    });
  }
  // OpenAI, direct Anthropic, arbitrary paid injected rungs, Graphiti model
  // workers, and every non-briefing workload remain unconditionally blocked.
  return { ok: false, outcome: 'charged-api-disabled:owner-policy' };
}

// Estimate the USD cost of one OpenAI floor call from its usage block.
// gpt-4o-mini pricing: ~$0.15 / 1M input tokens, ~$0.60 / 1M output tokens.
// Pure and exported so the paid-floor cost accounting is unit-testable without
// a live HTTPS call, and so the formula lives in exactly one place.
function estimateOpenAiCostUsd(usage) {
  const u = usage || {};
  const est = ((u.prompt_tokens || 0) * 0.15 + (u.completion_tokens || 0) * 0.6) / 1e6;
  return Math.round(est * 1e6) / 1e6;
}

// ---- built-in rung implementations -----------------------------------------

// npm ships codex and claude as .cmd shims, which CreateProcess cannot launch, so
// every CLI rung must spawn with shell:true on Windows. Node does not escape args
// under shell:true, it only joins them with spaces and hands the string to cmd.exe,
// which then reparses it. An empty arg disappears entirely (so the next flag is read
// as its value) and quotes inside a JSON or TOML arg are stripped (so the callee
// rejects the config). Quoting here is what keeps one arg equal to one token.
function quoteWindowsShellArg(value) {
  const text = String(value);
  if (text === '') return '""';
  if (!/[\s"^&|<>()%!,{}[\]]/.test(text)) return text;
  // MSVCRT rules: double the backslashes that precede a quote, escape the quote,
  // and double a trailing run so it cannot escape the closing quote we add.
  const escaped = text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

function windowsSafeSpawnArgs(args) {
  return (args || []).map((arg) => quoteWindowsShellArg(arg));
}

// Only quote when we actually asked for a shell, otherwise the quotes become part
// of the argument value.
function spawnArgsForPlatform(args) {
  return process.platform === 'win32' ? windowsSafeSpawnArgs(args) : args;
}

function toolLessCodexHookConfig() {
  const hookPath = path.join(REPO, 'scripts', 'claude-hooks', 'deny-all-tools.mjs');
  const command = JSON.stringify(`node "${hookPath.replace(/\\/g, '/').replace(/"/g, '\\"')}"`);
  return (
    'hooks.PreToolUse=[' +
    '{matcher="^.*$",' +
    `hooks=[{type="command",command=${command},timeout=5}]}` +
    ']'
  );
}

function codexOutputSchemaArgs(schema, schemaFile) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  if (!schemaFile) throw new Error('Codex output schema requires a schema file path.');
  return ['--output-schema', schemaFile];
}

function claudeOutputSchemaArgs(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  return ['--output-format', 'json', '--json-schema', JSON.stringify(schema)];
}

function unwrapClaudeStructuredOutput(raw, schema) {
  const text = String(raw || '').trim();
  if (!schema) return text;
  try {
    const envelope = JSON.parse(text);
    const structured = envelope?.structured_output ?? envelope?.structuredOutput;
    if (!structured || typeof structured !== 'object') return null;
    return JSON.stringify(structured);
  } catch {
    return null;
  }
}

// The question deliberately does NOT go in argv. cmd.exe caps a command line at
// 8191 characters and a People projection prompt runs to tens of thousands, which
// failed as "The command line is too long." before reaching the model. --print
// reads the prompt from stdin, which has no such limit.
function toolLessClaudeArgs(question, opts = {}) {
  const effort = resolveModelEffort(opts);
  return [
    '--print',
    ...claudeRungPins(opts, effort),
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--tools',
    '',
    // Replaces the Claude Code harness prompt with the caller's short machine
    // contract. Measured on EC2 2026-09-17: a pinned, tool-less call with this
    // flag sent under 200 input tokens of overhead and no cached context.
    ...(opts.claudeSystemPrompt ? ['--system-prompt', String(opts.claudeSystemPrompt)] : []),
    ...claudeOutputSchemaArgs(opts.claudeOutputSchema),
  ];
}

// A caller may pin a cheaper audited model for its own Claude rung. The
// automation ceiling stays the default, and a model outside the audited list is
// refused rather than passed through, so a typo or a newer family cannot slip
// past the ceiling by name.
//
// A pinned model must also be enabled in config/model-routing.json: until
// 2026-09-24 a caller could pin the disabled claude-sonnet-5 here because only
// the audited list was checked. Under the night marker the pin is clamped down
// to the owner overnight ceiling (Opus 5.5 at medium) with a receipt, and
// --effort is always emitted. The owner report lock asks for exactly the
// ceiling and refuses anything else, so the report never delegates down.
//
// An unpinned rung passes its own timeout as the budget, so under the night
// marker a rung with under five minutes is capped at tier 1 exactly as the
// router caps any tight-budget Claude spawn. routerLedgerPath only redirects
// that receipt (tests keep the checkout ledger clean).
function claudeRungPins(opts = {}, effort, env = process.env) {
  const model = String(opts.claudeModel || '').trim();
  if (ownerReportLockApplies(opts)) {
    const lock = resolveOwnerReportLock('claude');
    if (model !== lock.model || effort !== lock.effort) {
      throw new Error(
        `claude-cli rung refused: the owner report lock requires ${lock.model}/${lock.effort}, got ${model || '(unpinned)'}/${effort || '(no effort)'}`,
      );
    }
    return ['--model', lock.model, '--effort', lock.effort];
  }
  if (!model) {
    return claudeCeilingPins(effort, {
      env,
      phase: opts.phase,
      budgetMs: resolveRungTimeoutMs(opts, CLAUDE_CLI_RUNG_TIMEOUT_MS),
      ledgerPath: opts.routerLedgerPath,
    });
  }
  if (!CLAUDE_MODELS_UNDER_CEILING.includes(model)) {
    throw new Error(
      `claude-cli rung refused: ${model} is not an audited model under the automation ceiling`,
    );
  }
  assertModelEnabled({ model }, 'Claude');
  if (overnightProfileActive('', env)) {
    return claudeCliPins({ model, effort: effort || OVERNIGHT_CEILING.claude.effort, reason: 'askAI claude-cli rung pin' }, { env });
  }
  return ['--model', model, ...(effort ? ['--effort', effort] : [])];
}

// Rung functions resolve null on failure by contract. The WHY (usage limit,
// auth, exit code, timeout) is stashed per call so the ladder can feed the
// durable brain switch; without it every failure looks alike and the switch
// could never tell "out of tokens" from a blip.
function noteRungFailure(opts, rung, detail) {
  if (!opts || typeof opts !== 'object') return;
  if (!opts.rungFailures || typeof opts.rungFailures !== 'object') opts.rungFailures = {};
  opts.rungFailures[rung] = String(detail || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

// Per-call receipt for the rung ledger: which model and effort ran and, when the
// CLI reported it, the exact token counts. Stashed per call like rungFailures.
function noteRungUsage(opts, rung, { model, effort, usage } = {}) {
  if (!opts || typeof opts !== 'object') return;
  if (!opts.rungUsage || typeof opts.rungUsage !== 'object') opts.rungUsage = {};
  const u = usage || {};
  const input = Number(u.input_tokens) || 0;
  const cached = Number(u.cached_input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  opts.rungUsage[rung] = {
    ...(model ? { model: String(model) } : {}),
    ...(effort ? { effort: String(effort) } : {}),
    ...(usage
      ? {
          inputTokens: input,
          cachedInputTokens: cached,
          outputTokens: output,
          processedTokens: Number(u.total_tokens) || input + cached + output,
        }
      : {}),
  };
}

function argAfter(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : '';
}

// Job identity for a ledger row: an explicit card or job id, then the scheduler's
// AMY_JOB_ID, then the caller's surface, then the entrypoint script, so a call
// with no surface is still attributable to the job that made it.
function ledgerIdentity(opts = {}, env = process.env) {
  const entry = path.basename(String((process.argv && process.argv[1]) || '')).replace(/\.(?:c|m)?js$/i, '');
  const surface = opts.surface && opts.surface !== 'unknown' ? opts.surface : '';
  const job = opts.jobId || opts.cardId || env.AMY_JOB_ID || surface || entry || 'unknown';
  return {
    job: String(job).slice(0, 120),
    ...(opts.cardId ? { card: String(opts.cardId).slice(0, 80) } : {}),
    host: isEc2Host(env) ? 'ec2' : 'desktop',
  };
}

function outputTail(value, n = 300) {
  const text = String(value || '').trim();
  return text.length > n ? text.slice(-n) : text;
}

// With --json, stdout is an event stream. If the final-message file is missing,
// only a non-JSON stdout (an older CLI that ignored the flag) is an answer.
function codexStdoutAnswer(stdout) {
  const text = String(stdout || '').trim();
  return text.startsWith('{') ? '' : text;
}

function runCodexRungAsync(question, opts) {
  return new Promise((resolve) => {
    const os = require('node:os');
    const crypto = require('node:crypto');
    const callId = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const outFile = path.join(os.tmpdir(), `ask-ai-codex-${callId}.txt`);
    const schemaFile = opts.codexOutputSchema
      ? path.join(os.tmpdir(), `ask-ai-codex-schema-${callId}.json`)
      : null;
    const args = [
      'exec',
      ...(opts.toolLess
        ? [
            '--ephemeral',
            '--ignore-user-config',
            '--strict-config',
            '--enable',
            'hooks',
            '--disable',
            'code_mode',
            '--disable',
            'code_mode_only',
            '--disable',
            'unified_exec',
            '--dangerously-bypass-hook-trust',
            '-c',
            toolLessCodexHookConfig(),
          ]
        : []),
      '--skip-git-repo-check',
      '-s',
      'read-only',
      ...codexOutputSchemaArgs(opts.codexOutputSchema, schemaFile),
      '--output-last-message',
      outFile,
      '--json',
    ];
    const { effort, model } = resolveCodexDecision(opts);
    if (model) args.push('--model', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    if (opts.codexImagePath) args.push('-i', opts.codexImagePath);
    const timeoutMs = resolveRungTimeoutMs(opts, 90000);
    let child = null;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    function cleanup() {
      try { fs.unlinkSync(outFile); } catch { /* already gone */ }
      if (schemaFile) {
        try { fs.unlinkSync(schemaFile); } catch { /* already gone */ }
      }
    }

    function finish(status, signal, error = null) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      let finalOutputBytes = null;
      try { finalOutputBytes = fs.statSync(outFile).size; } catch { /* no final file */ }
      if (!opts.rungDiagnostics) opts.rungDiagnostics = {};
      opts.rungDiagnostics.codex = {
        model,
        effort,
        exitCode: status ?? null,
        signal: signal || null,
        errorCode: error?.code || null,
        timeoutMs,
        stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
        stderrBytes: Buffer.byteLength(stderr, 'utf8'),
        finalOutputBytes,
        outputSchemaSha256: opts.codexOutputSchema
          ? require('node:crypto').createHash('sha256').update(JSON.stringify(opts.codexOutputSchema)).digest('hex')
          : null,
      };
      noteRungUsage(opts, 'codex', { model, effort, usage: parseCodexJsonlUsage(stdout) });
      try {
        if (error || status !== 0) {
          noteRungFailure(
            opts,
            'codex',
            error ? error.message : `exit ${status} ${outputTail(stderr)} ${outputTail(stdout)}`,
          );
          resolve(null);
          return;
        }
        let out = '';
        try { out = fs.readFileSync(outFile, 'utf8').trim(); }
        catch { out = codexStdoutAnswer(stdout); }
        if (!out || isCliFailureOutput(out)) {
          noteRungFailure(opts, 'codex', out || 'empty output');
          resolve(null);
          return;
        }
        resolve(out);
      } finally {
        cleanup();
      }
    }

    try {
      if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(opts.codexOutputSchema), 'utf8');
      const spawnProcess = opts.spawnProcess || spawn;
      const executable = resolveDirectCodex();
      child = spawnProcess(executable.command, [...executable.prefix, ...args], {
        env: buildCodexCliEnv(process.env),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
      child.once('error', (error) => finish(null, null, error));
      child.once('close', (status, signal) => finish(status, signal));
      timer = setTimeout(() => {
        const error = Object.assign(new Error(`Codex timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' });
        try { child.kill(); } catch { /* already exited */ }
        finish(null, 'SIGTERM', error);
      }, timeoutMs);
      child.stdin.on('error', () => {});
      child.stdin.end(withCodexAmyPrelude(question));
    } catch (error) {
      finish(null, null, error);
    }
  });
}

function runCodexRung(question, opts) {
  if (opts.codexAsyncSpawn) return runCodexRungAsync(question, opts);
  return new Promise((resolve) => {
    // --output-last-message writes the FINAL assistant turn to a file; stdout
    // carries session narration (tool calls, sandbox notes) that must never be
    // returned as the answer. Temp file per call, removed in finally.
    const os = require('node:os');
    const callId = `${process.pid}-${Date.now()}`;
    const outFile = path.join(os.tmpdir(), `ask-ai-codex-${callId}.txt`);
    const schemaFile = opts.codexOutputSchema
      ? path.join(os.tmpdir(), `ask-ai-codex-schema-${callId}.json`)
      : null;
    const args = [
      'exec',
      ...(opts.toolLess
        ? [
            '--ephemeral',
            '--ignore-user-config',
            '--strict-config',
            '--enable',
            'hooks',
            '--disable',
            'code_mode',
            '--disable',
            'code_mode_only',
            '--disable',
            'unified_exec',
            '--dangerously-bypass-hook-trust',
            '-c',
            toolLessCodexHookConfig(),
          ]
        : []),
      '--skip-git-repo-check',
      '-s',
      'read-only',
      ...codexOutputSchemaArgs(opts.codexOutputSchema, schemaFile),
      '--output-last-message',
      outFile,
      '--json',
    ];
    const { effort, model } = resolveCodexDecision(opts);
    if (model) args.push('--model', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    if (opts.codexImagePath) args.push('-i', opts.codexImagePath);
    try {
      if (schemaFile) {
        fs.writeFileSync(schemaFile, JSON.stringify(opts.codexOutputSchema), 'utf8');
      }
      const spawnSyncProcess = opts.spawnSyncProcess || spawnSync;
      const executable = resolveDirectCodex();
      const res = spawnSyncProcess(executable.command, [...executable.prefix, ...args], {
        input: withCodexAmyPrelude(question),
        encoding: 'utf8',
        timeout: resolveRungTimeoutMs(opts, 90000),
        env: buildCodexCliEnv(process.env),
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });
      // Keep structural failure evidence before the ephemeral final/schema
      // files are removed. Never persist prompt or generated content here.
      if (!opts.rungDiagnostics) opts.rungDiagnostics = {};
      let finalOutputBytes = null;
      try { finalOutputBytes = fs.statSync(outFile).size; } catch { /* no final file */ }
      opts.rungDiagnostics.codex = {
        model,
        effort,
        exitCode: res.status ?? null,
        signal: res.signal || null,
        errorCode: res.error?.code || null,
        timeoutMs: resolveRungTimeoutMs(opts, 90000),
        stdoutBytes: Buffer.byteLength(String(res.stdout || ''), 'utf8'),
        stderrBytes: Buffer.byteLength(String(res.stderr || ''), 'utf8'),
        finalOutputBytes,
        outputSchemaSha256: opts.codexOutputSchema
          ? require('node:crypto').createHash('sha256').update(JSON.stringify(opts.codexOutputSchema)).digest('hex')
          : null,
      };
      noteRungUsage(opts, 'codex', { model, effort, usage: parseCodexJsonlUsage(res.stdout) });
      if (res.error || res.status !== 0) {
        noteRungFailure(
          opts,
          'codex',
          res.error
            ? res.error.message
            : `exit ${res.status} ${outputTail(res.stderr)} ${outputTail(res.stdout)}`,
        );
        return resolve(null);
      }
      let out = '';
      try {
        out = fs.readFileSync(outFile, 'utf8').trim();
      } catch {
        out = codexStdoutAnswer(res.stdout);
      }
      if (!out || isCliFailureOutput(out)) {
        noteRungFailure(opts, 'codex', out || 'empty output');
        return resolve(null);
      }
      resolve(out);
    } finally {
      try {
        fs.unlinkSync(outFile);
      } catch {
        /* already gone */
      }
      if (schemaFile) {
        try {
          fs.unlinkSync(schemaFile);
        } catch {
          /* already gone */
        }
      }
    }
  });
}

function claudeProxyAutomationFields(opts = {}) {
  if (!opts.phase) return {};
  return {
    reasoning_effort: resolveModelEffort(opts) || undefined,
    work_phase: opts.phase,
    hard_question: opts.hardQuestion || undefined,
    return_condition: opts.returnCondition || undefined,
  };
}

function runClaudeProxyRung(question, opts) {
  return new Promise((resolve) => {
    const proxyUrl = opts.proxyUrl || process.env.CLAUDE_PROXY_URL || 'http://localhost:3456';
    let u;
    try {
      u = new URL('/v1/chat/completions', proxyUrl);
    } catch {
      return resolve(null);
    }
    const body = JSON.stringify({
      model: 'claude',
      ...claudeProxyAutomationFields(opts),
      tool_less: opts.toolLess === true,
      stream: false,
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: question },
      ],
    });
    const lib = u.protocol === 'https:' ? https : require('node:http');
    const req = lib.request(
      u,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: resolveRungTimeoutMs(opts, 45000),
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            noteRungFailure(opts, 'claude-proxy', `HTTP ${res.statusCode} ${outputTail(raw, 400)}`);
            return resolve(null);
          }
          try {
            // The proxy may return SSE streaming format (data: {...}\n\n lines)
            // even when stream:false is requested. Detect and collect delta content.
            const trimmed = raw.trim();
            let text = '';
            if (trimmed.startsWith('data:')) {
              for (const line of trimmed.split('\n')) {
                const stripped = line.replace(/^data:\s*/, '').trim();
                if (!stripped || stripped === '[DONE]') continue;
                try {
                  const chunk = JSON.parse(stripped);
                  text += chunk?.choices?.[0]?.delta?.content || '';
                } catch {
                  // skip malformed chunk
                }
              }
              text = text.trim();
            } else {
              text = String(JSON.parse(trimmed).choices?.[0]?.message?.content || '').trim();
            }
            if (!text || isCliFailureOutput(text)) {
              noteRungFailure(opts, 'claude-proxy', text || 'empty proxy answer');
              return resolve(null);
            }
            resolve(text);
          } catch {
            noteRungFailure(opts, 'claude-proxy', 'unparseable proxy response');
            resolve(null);
          }
        });
      },
    );
    req.on('error', (err) => {
      noteRungFailure(opts, 'claude-proxy', (err && err.message) || 'request error');
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      noteRungFailure(opts, 'claude-proxy', 'proxy-timeout');
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

// A caller may switch off hidden thinking for a bounded machine answer. Measured
// on EC2 2026-09-17: a Haiku name-judge screen wrote about 2,900 output tokens,
// 81% of them thinking, in about 47 s. The same prompt with thinking off
// returned the same verdict in about 600 tokens and 11 s.
function claudeRungEnv(opts = {}) {
  const env = buildClaudeCliEnv();
  if (opts && opts.claudeThinking === false) env.MAX_THINKING_TOKENS = '0';
  return env;
}

function runClaudeCliRung(question, opts) {
  return new Promise((resolve) => {
    const effort = resolveModelEffort(opts);
    // The prompt always travels on stdin, never argv. cmd.exe caps a command
    // line at 8191 chars and Linux rejects oversized argv with E2BIG (seven
    // EC2 `threw:spawn E2BIG` rows in the week before 2026-09-03). With Claude
    // leading, an argv prompt would silently hand every large prompt to the
    // Codex fallback instead of the default brain.
    let args;
    try {
      args = opts.toolLess
        ? toolLessClaudeArgs(question, opts)
        : [
            '--print',
            ...claudeRungPins(opts, effort),
            ...claudeOutputSchemaArgs(opts.claudeOutputSchema),
          ];
    } catch (err) {
      noteRungFailure(opts, 'claude-cli', (err && err.message) || 'refused model pin');
      resolve(null);
      return;
    }
    // The JSON envelope carries exact usage. The schema path already runs it.
    const jsonEnvelope = !args.includes('--output-format');
    if (jsonEnvelope) args.push('--output-format', 'json');
    const child = (opts.spawnProcess || spawn)('claude', spawnArgsForPlatform(args), {
      env: claudeRungEnv(opts),
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const maxBuffer = 10 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const terminate = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } else {
        child.kill('SIGTERM');
      }
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const append = (current, chunk) => {
      const next = current + String(chunk || '');
      if (Buffer.byteLength(next, 'utf8') > maxBuffer) {
        terminate();
        finish(null);
        return current;
      }
      return next;
    };
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (err) => {
      noteRungFailure(opts, 'claude-cli', (err && err.message) || 'spawn error');
      finish(null);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        noteRungFailure(
          opts,
          'claude-cli',
          `exit ${code} ${outputTail(stderr)} ${outputTail(stdout)}`,
        );
        return finish(null);
      }
      let out = stdout.trim();
      const parsedUsage = parseClaudeJsonUsage(out);
      noteRungUsage(opts, 'claude-cli', {
        model: parsedUsage.usage?.model || argAfter(args, '--model'),
        effort: argAfter(args, '--effort'),
        usage: parsedUsage.usage,
      });
      if (jsonEnvelope && parsedUsage.usage) out = parsedUsage.output.trim();
      if (!out || isCliFailureOutput(out)) {
        noteRungFailure(opts, 'claude-cli', out || `empty output ${outputTail(stderr)}`);
        return finish(null);
      }
      finish(unwrapClaudeStructuredOutput(out, opts.claudeOutputSchema));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(String(question || ''));
    timer = setTimeout(
      () => {
        terminate();
        noteRungFailure(opts, 'claude-cli', 'rung-timeout');
        finish(null);
      },
      resolveRungTimeoutMs(opts, CLAUDE_CLI_RUNG_TIMEOUT_MS),
    );
  });
}

function runOpenAiApiRung(question, opts) {
  return new Promise((resolve) => {
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey || apiKey.length < 20) return resolve(null);
    const body = JSON.stringify({
      model: opts.openaiModel || process.env.OPENAI_API_MODEL || 'gpt-4o-mini',
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: question },
      ],
      max_tokens: opts.maxTokens || 1500,
      stream: false,
    });
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: resolveRungTimeoutMs(opts, 45000),
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', async () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try {
            const parsed = JSON.parse(raw);
            const text = String(parsed.choices?.[0]?.message?.content || '').trim();
            // Settle the actual estimated cost into the cap buckets (month
            // always, night inside the 6pm-6am CT window), central ledger
            // first when configured (D3), local file otherwise; a missing
            // usage block records the conservative default.
            const { estUsd: est, state: s } = await settleOpenAiSpendViaLedger(parsed.usage, opts);
            // Attribute the estimated dollar cost to the calling surface so the
            // ladder observability rollup can answer "which surface burned the
            // paid floor, and for how much" -- not just the reliance rate. A
            // dedicated cost line (kind:'cost') never counts as a terminal rung
            // attempt; it only carries dollars.
            if (est > 0) {
              appendJsonl(ATTEMPT_LOG, {
                ts: new Date().toISOString(),
                surface: opts.surface || 'unknown',
                rung: 'openai-api',
                kind: 'cost',
                estUsd: est,
              });
            }
            const warn = budgetWarning({ spentUsd: s.spentUsd, capUsd: OPENAI_MONTHLY_CAP_USD });
            if (warn)
              appendJsonl(ATTEMPT_LOG, { ts: new Date().toISOString(), budgetWarning: warn });
            resolve(text || null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

const BRIEFING_BEDROCK_MODEL = 'us.anthropic.claude-sonnet-4-6';

function parseBedrockResponse(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const text = Array.isArray(parsed?.content)
      ? parsed.content
          .filter((part) => part && part.type === 'text')
          .map((part) => part.text || '')
          .join('\n')
          .trim()
      : '';
    return { text, usage: parsed?.usage || {} };
  } catch {
    return { text: '', usage: {} };
  }
}

function estimateBedrockCostUsd(usage = {}) {
  // Deliberately conservative accounting for the switch ledger. The up-front
  // $0.25 reservation is the hard cap; this estimate is observability only.
  const input = Number(usage.input_tokens || usage.inputTokens || 0);
  const output = Number(usage.output_tokens || usage.outputTokens || 0);
  return Math.round(((input * 6 + output * 30) / 1e6) * 1e6) / 1e6;
}

function runBedrockApiRung(question, opts, authorization) {
  if (!authorization?.ok) return Promise.resolve(null);
  const os = require('node:os');
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestFile = path.join(os.tmpdir(), `ask-ai-bedrock-request-${stamp}.json`);
  const outputFile = path.join(os.tmpdir(), `ask-ai-bedrock-output-${stamp}.json`);
  try {
    fs.writeFileSync(
      requestFile,
      JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1500,
        messages: [{ role: 'user', content: String(question || '') }],
      }),
      { mode: 0o600 },
    );
    const result = spawnSync(
      'aws',
      [
        'bedrock-runtime',
        'invoke-model',
        '--model-id',
        BRIEFING_BEDROCK_MODEL,
        '--region',
        'us-east-1',
        '--cli-binary-format',
        'raw-in-base64-out',
        '--body',
        `fileb://${requestFile}`,
        outputFile,
      ],
      {
        encoding: 'utf8',
        timeout: resolveRungTimeoutMs(opts, 90000),
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );
    if (result.error || result.status !== 0) return Promise.resolve(null);
    const parsed = parseBedrockResponse(fs.readFileSync(outputFile, 'utf8'));
    recordBriefingApiSettlement(authorization, {
      usage: parsed.usage,
      estimatedUsd: estimateBedrockCostUsd(parsed.usage),
      model: BRIEFING_BEDROCK_MODEL,
      now: opts.now,
      usageFile: opts.briefingApiUsageFile,
      dataDir: opts.dataDir,
      fsApi: opts.fsApi,
    });
    return Promise.resolve(parsed.text || null);
  } catch {
    return Promise.resolve(null);
  } finally {
    for (const file of [requestFile, outputFile]) {
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  }
}

// Cloud-only ownership (ExampleCo 2026-08-08): the PC has no overnight role, even
// as an observer or fallback. On EC2, claude-proxy is the SSH reverse tunnel
// to the laptop and is therefore excluded entirely. The local `claude` CLI
// authenticates with the pushed OAuth token
// (/home/ec2-user/.claude-oauth-token, reference_ec2_claude_auth.md).
// SB_LLM_HOST_PROFILE=ec2|desktop overrides detection explicitly.
// SB_LLM_RUNG_ORDER is an invocation-scoped operational override for a known
// provider outage. It is intentionally strict: one unknown rung invalidates
// the whole override and preserves the normal host-aware default.
function isEc2Host(env = process.env) {
  if (env.SB_LLM_HOST_PROFILE === 'ec2') return true;
  if (env.SB_LLM_HOST_PROFILE === 'desktop') return false;
  try {
    return process.platform === 'linux' && fs.existsSync('/home/ec2-user/.claude-oauth-token');
  } catch {
    return false;
  }
}

// G17: once the paid floor is present in a requested order, EVERY subscription
// rung must appear before it. Shared by the env override (defaultRungOrder)
// and the per-call override (resolveRungOrder). The 2026-07-25 ec2-spine-worker
// codex->openai-api skip rode the env path, which lacked this check, so the
// charged call ran with no logged claude-cli/claude-proxy attempts between.
function paidFloorJumpsSubscriptions(requested) {
  const paidAt = requested.indexOf('openai-api');
  if (paidAt < 0) return false;
  return !['codex', 'claude-cli', 'claude-proxy'].every((name) => {
    const at = requested.indexOf(name);
    return at >= 0 && at < paidAt;
  });
}

// Which rungs each brain owns on each host. EC2 never calls the laptop
// SSH-tunnel proxy (ExampleCo 2026-08-08 cloud-only ownership).
const HOST_BRAIN_RUNGS = Object.freeze({
  ec2: Object.freeze({ claude: ['claude-cli'], codex: ['codex'] }),
  desktop: Object.freeze({ claude: ['claude-cli'], codex: ['codex'] }),
});

function defaultRungOrder(env = process.env) {
  const configured = String(env.SB_LLM_RUNG_ORDER || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const known = new Set(['codex', 'claude-cli', 'claude-proxy']);
  if (configured.length && configured.every((name) => known.has(name))) {
    const requested = [...new Set(configured)].filter(
      (name) => !(isEc2Host(env) && name === 'claude-proxy'),
    );
    // The operator's SET is honored; the switch still decides which brain in
    // it leads. To force one brain, name only that brain's rungs.
    if (requested.length && !paidFloorJumpsSubscriptions(requested)) {
      return orderByLeadingBrain(requested, env);
    }
  }
  // ExampleCo 2026-09-03: the durable brain switch decides who leads. Claude by
  // source default; Codex the moment Claude reports it is out of tokens, or
  // when the owner flips it (node scripts/brain-switch.js set codex).
  const rungs = isEc2Host(env) ? HOST_BRAIN_RUNGS.ec2 : HOST_BRAIN_RUNGS.desktop;
  const [leading, trailing] = brainOrder({ env });
  return [...rungs[leading], ...rungs[trailing]];
}

// The ONE place an explicit per-call override meets the host-aware default
// (Codex review 2026-07-12 finding 7: overrides bypassing the host profile
// must be a deliberate, greppable choice, not an accident of `||`).
function resolveRungOrder(opts = {}, env = process.env) {
  if (!opts.rungOrder) return defaultRungOrder(env);
  const known = new Set(['codex', 'claude-cli', 'claude-proxy']);
  const requested = [
    ...new Set(
      (Array.isArray(opts.rungOrder) ? opts.rungOrder : String(opts.rungOrder).split(','))
        .map((name) => String(name).trim())
        .filter(Boolean),
    ),
  ].filter((name) => !(isEc2Host(env) && name === 'claude-proxy'));
  if (!requested.length || requested.some((name) => !known.has(name))) {
    return defaultRungOrder(env);
  }
  // Only subscription rungs are admissible. A stale override that names any
  // charged floor fails closed to the host-aware subscription default.
  // The caller's SET is honored (a narrowed override stays narrowed) but the
  // durable brain switch decides which brain within it leads, so a call site
  // written in the Codex-first era cannot bypass an owner flip or an
  // exhaustion flip (Codex review 2026-09-03). The one exception is an
  // owner-named lead below, which still yields to an exhaustion demotion.
  return orderByLeadingBrain(requested, env, ownerLeadBrain(opts));
}

// OWNER-NAMED LEAD. ExampleCo, 2026-09-24, on the overnight strategic report: "can
// that report always use opus 5.5 medium?" A surface listed here may ask for
// its named brain to lead in place of the switch's preferred brain. The
// switch still governs the rest: an active demotion of the named brain (out
// of quota, repeated failure) hands the lead to the other brain, and the other
// brain stays the fallback rung. Any other surface, or a mismatched brain, is
// ignored and follows the switch as before.
const OWNER_LEAD_SURFACES = Object.freeze({ 'overnight-strategic-briefing': 'claude' });

function ownerLeadBrain(opts = {}) {
  const named = OWNER_LEAD_SURFACES[String(opts.surface || '')];
  return named && opts.ownerLeadBrain === named ? named : null;
}

// Stable partition: the leading brain's rungs first, in the order given, then
// the other brain's rungs. Rungs that belong to neither brain keep their place
// at the end.
function orderByLeadingBrain(rungs, env = process.env, ownerLead = null) {
  const [leading] = ownerLead
    ? brainOrder({ env, state: { ...readBrainSwitchState({ env }), preferred: ownerLead } })
    : brainOrder({ env });
  const lead = rungs.filter((name) => brainOfRung(name) === leading);
  const rest = rungs.filter((name) => brainOfRung(name) !== leading);
  return [...lead, ...rest];
}

function builtinRungs(opts) {
  const all = {
    codex: { name: 'codex', fn: (q) => runCodexRung(q, opts) },
    'claude-proxy': { name: 'claude-proxy', fn: (q) => runClaudeProxyRung(q, opts) },
    'claude-cli': { name: 'claude-cli', fn: (q) => runClaudeCliRung(q, opts) },
    'openai-api': { name: 'openai-api', fn: (q) => runOpenAiApiRung(q, opts), paid: true },
    bedrock: {
      name: 'bedrock',
      fn: (q, authorization) => runBedrockApiRung(q, opts, authorization),
      paid: true,
    },
  };
  return modelRungOrder(opts).map((n) => all[n]).filter(Boolean);
}

// Every lane follows the durable brain switch (ExampleCo, 2026-09-22: "any work
// that can be done by one model should be able to fall back to the other
// model with the switch"; briefing work never refuses a model). Briefing
// context keeps its subscription-only boundary: the rung filter in askAI
// strips paid and charged rungs, the Codex rung keeps the Sol/medium clamp and
// the Claude rung keeps the automation ceiling. Before this, non-news briefing
// calls were Codex-only, so a Codex quota outage stranded them with a healthy
// Claude subscription untouched.
function modelRungOrder(opts = {}, env = process.env) {
  return resolveRungOrder(opts, env);
}

// ---- the ladder -------------------------------------------------------------
//
// askAI(question, opts) -> { text, rung, latencyMs, attempts }
//   opts.rungs       inject rung objects [{name, fn(question), paid?}] (tests)
//   opts.surface     caller label for the attempt log
//   opts.system      optional system prompt
//   opts.onAttempt   callback per attempt {rung, outcome, latencyMs}
//   opts.budget      inject {spentUsd, capUsd, warnUsd, warn(msg)} (tests)
//   opts.spendFile   inject the spend ledger path (tests); defaults to the
//                    OPENAI_API_SPEND_FILE env override, then SPEND_FILE
//   opts.spendLedgerUrl / opts.spendLedgerToken  inject the central ledger
//                    (tests); default to SB_SPEND_LEDGER_URL / SB_SPEND_TOKEN
//   opts.now         inject the call instant for the cap gate and settlement
//                    (tests); defaults to the real clock
//   opts.silent      return null instead of throwing BrainUnreachable
//   opts.rungRetries extra same-rung retries on a TRANSIENT throw before
//                    descending (default 1). A blip on the Claude rung must not
//                    bounce Amy to a paid floor; a non-transient failure (auth,
//                    null, sentinel) still descends immediately.
//   opts.sleep       injectable backoff delay (tests pass a noop)
// Feed the durable brain switch (ExampleCo 2026-09-03). Builtin rungs only:
// injected test rungs never touch the real switch file. Under vitest the
// switch must be pointed at a temp file explicitly, so an unrelated test
// cannot demote a brain on the dev box.
function trackBrainHealth(rungName, outcome, failureDetail, opts) {
  const brain = brainOfRung(rungName);
  if (!brain || opts.rungs) return null;
  const switchFile = opts.brainSwitchFile || process.env.SB_BRAIN_SWITCH_FILE || null;
  if (process.env.VITEST && !switchFile) return null;
  const switchOpts = {
    env: process.env,
    ...(switchFile ? { switchPath: switchFile } : {}),
    source: opts.surface || 'unknown',
  };
  try {
    if (outcome === 'answered') {
      const recovered = recordBrainSuccess(brain, switchOpts);
      if (recovered.flipped) {
        appendJsonl(ATTEMPT_LOG, {
          ts: new Date().toISOString(),
          surface: opts.surface || 'unknown',
          brainSwitch: 'recovered',
          brain,
          leading: recovered.leading,
        });
      }
      return recovered;
    }
    const detail =
      failureDetail ||
      (opts.rungFailures && opts.rungFailures[rungName]) ||
      outcome;
    const verdict = recordBrainFailure(brain, detail, switchOpts);
    appendJsonl(ATTEMPT_LOG, {
      ts: new Date().toISOString(),
      surface: opts.surface || 'unknown',
      brainSwitch: verdict.flipped ? 'flipped' : verdict.demoted ? 'demoted' : 'strike',
      brain,
      kind: verdict.kind,
      leading: verdict.leading,
      until: verdict.until,
      ...(verdict.receipt && !verdict.receipt.ok ? { receiptError: verdict.receipt.error } : {}),
    });
    return verdict;
  } catch (err) {
    // The switch is bookkeeping; a bad file must never kill an answer.
    appendJsonl(ATTEMPT_LOG, {
      ts: new Date().toISOString(),
      surface: opts.surface || 'unknown',
      brainSwitch: 'error',
      brain,
      error: String(err && err.message).slice(0, 120),
    });
    return null;
  }
}

function withBriefingToolLessDefault(opts = {}) {
  return opts.briefingContext === true && opts.toolLess === undefined
    ? { ...opts, toolLess: true }
    : opts;
}

// Every automated model exchange is recorded, prompt and answer (ExampleCo
// 2026-09-23: "even the prompt response should be saved"). Recording is
// fail-soft and never changes the answer or the error the caller sees.
async function askAI(question, opts = {}) {
  const record = (response) => {
    // Test runs never write the live ledger; they pass an explicit dataDir.
    if (process.env.VITEST && !opts.dataDir) return;
    try {
      const { recordModelExchange, modelSurface } = require('./model-exchange-provenance.js');
      recordModelExchange({
        surface: opts.surface ? `${modelSurface()}:${opts.surface}` : modelSurface(),
        prompt: typeof question === 'string' ? question : JSON.stringify(question),
        response: typeof response === 'string' ? response : typeof response?.text === 'string' ? response.text : JSON.stringify(response),
        dataDir: opts.dataDir || process.env.SECONDBRAIN_DATA_DIR,
        root: REPO,
      });
    } catch { /* missing evidence surfaces as a Gravity unknown */ }
  };
  try {
    const answer = await askAIUnrecorded(question, opts);
    record(answer);
    return answer;
  } catch (error) {
    record(`[no answer: ${String(error?.message || error).slice(0, 500)}]`);
    throw error;
  }
}

async function askAIUnrecorded(question, opts = {}) {
  // Briefing model calls write one bounded evidence packet and never need
  // tools, hooks, settings or MCP. On 2026-09-23 the Psychology card's real
  // prompt (Amy memory files as context) led a tool-enabled Claude call past
  // its 150 s rung timeout twice, while the same prompt tool-less answered in
  // seconds. A caller may still opt in explicitly with toolLess: false.
  opts = withBriefingToolLessDefault(opts);
  const contextDataDir =
    opts.dataDir || process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data');
  const contextSurface = opts.surface || 'briefing-model';
  const priorBriefingContext =
    opts.briefingContext === true
      ? readPriorContextReceipt({
          dataDir: contextDataDir,
          surface: contextSurface,
        })
      : {};
  const briefingContext =
    opts.briefingContext === true
      ? buildBriefingModelContext({
          surface: contextSurface,
          stableContext: opts.stableContext || opts.system || DEFAULT_STABLE_CONTEXT,
          currentEvidence: question,
          latestAttempt: opts.latestAttempt || '',
          untriedHypotheses: opts.untriedHypotheses || [],
          workerContract: opts.workerContract || {
            task: opts.workerTask || `Complete only the ${contextSurface} assignment.`,
            selectedSources:
              opts.selectedSources ||
              ['CURRENT EVIDENCE below is the complete selected evidence packet.'],
            answerShape:
              opts.answerShape || 'Return only the result requested by the evidence packet.',
            acceptanceChecks:
              opts.acceptanceChecks ||
              [
                'Use only the selected evidence packet and identify missing required input.',
                'Satisfy the caller-owned validator or explicit output contract.',
                'Stop after this one result; do not replay or continue the watcher conversation.',
              ],
          },
          priorStableHash: priorBriefingContext.stableHash || '',
          // Only an answered prior dispatch suppresses an identical retry.
          priorDynamicHash:
            priorBriefingContext.answered === true ? priorBriefingContext.dynamicHash || '' : '',
          // A caller may claim delta-only transport only when it owns a real,
          // still-live provider context handle. Stateless CLI/API calls keep
          // the byte-identical stable prefix so provider prompt caching can hit.
          resumableContext: opts.resumableContext === true,
          // Surfaces whose raw material is owner-critical (the overnight
          // strategic briefing) set their own budget. Without this plumbing the
          // 64 KB default silently refused the whole report on a bad night.
          ...(opts.maxStableBytes ? { maxStableBytes: opts.maxStableBytes } : {}),
          ...(opts.maxDynamicBytes ? { maxDynamicBytes: opts.maxDynamicBytes } : {}),
          ...(opts.maxPromptBytes ? { maxPromptBytes: opts.maxPromptBytes } : {}),
        })
      : null;
  if (briefingContext) {
    if (!briefingContext.shouldDispatch) {
      if (briefingContext.unchangedEvidence) return '';
      persistBriefingModelContextReceipt(briefingContext, { dataDir: contextDataDir });
      const error = new Error(
        `briefing context budget exceeded: ${briefingContext.budgetFailures.join('; ')}`,
      );
      error.code = 'BRIEFING_CONTEXT_BUDGET_EXCEEDED';
      throw error;
    }
  }
  const modelQuestion = briefingContext ? briefingContext.prompt : question;
  let circuitAdmission = null;
  const circuitGate = opts.briefingNightCircuitGate || admitBriefingModelLaunch;
  // Injected rungs are test or caller-owned execution boundaries. Production
  // briefing calls use the built-in ladder and must pass the shared circuit;
  // tests can exercise the gate explicitly by injecting briefingNightCircuitGate.
  if (
    (briefingContext || opts.briefingNightCircuit === true) &&
    (!opts.rungs || opts.briefingNightCircuitGate)
  ) {
    circuitAdmission = circuitGate({
      date: opts.briefingDate || process.env.BRIEFING_DATE || '',
      dataDir: contextDataDir,
      lane: contextSurface,
      priority: opts.briefingPriority || 'nonessential',
      estimatedTokens: opts.briefingEstimatedTokens,
      overrideReason: opts.briefingEmergencyOverrideReason || '',
      nowMs: opts.now ? toDate(opts.now).getTime() : Date.now(),
      env: opts.env || process.env,
    });
    if (!circuitAdmission.allowed) {
      appendJsonl(ATTEMPT_LOG, {
        ts: new Date().toISOString(),
        surface: contextSurface,
        rung: 'briefing-night-circuit',
        outcome: `denied:${circuitAdmission.reason}`,
        latencyMs: 0,
      });
      if (opts.silent) return null;
      const error = new Error(`briefing night circuit denied launch: ${circuitAdmission.reason}`);
      error.code = 'BRIEFING_NIGHT_CIRCUIT_DENIED';
      error.circuit = circuitAdmission;
      throw error;
    }
  }
  if (briefingContext) {
    // A denied circuit launch is not a dispatched attempt. Persist only after
    // admission so an identical retry can run when capacity becomes available.
    persistBriefingModelContextReceipt(briefingContext, { dataDir: contextDataDir });
  }
  const recordBriefingContextOutcome = (answered) => {
    try {
      markBriefingModelContextOutcome({
        dataDir: contextDataDir,
        surface: briefingContext.surface,
        dynamicHash: briefingContext.dynamicHash,
        answered,
      });
    } catch {
      // Outcome bookkeeping never changes the answer.
    }
  };
  const circuitSettle = opts.briefingNightCircuitSettle || settleBriefingModelLaunch;
  const settleCircuit = (outcome) => {
    if (!circuitAdmission || !circuitAdmission.enforced || !circuitAdmission.reservationId) return;
    try {
      circuitSettle({
        date: circuitAdmission.date,
        dataDir: contextDataDir,
        reservationId: circuitAdmission.reservationId,
        outcome,
        nowMs: opts.now ? toDate(opts.now).getTime() : Date.now(),
      });
    } catch (error) {
      appendJsonl(ATTEMPT_LOG, {
        ts: new Date().toISOString(),
        surface: contextSurface,
        rung: 'briefing-night-circuit',
        outcome: `settlement-failed:${String(error && error.message).slice(0, 80)}`,
        latencyMs: 0,
      });
    }
  };
  const requestedRungs = opts.rungs || builtinRungs(opts);
  // The ceiling is enforced twice on purpose: once when the builtin ladder is
  // built, and again here so an injected rung list obeys the same rule. Both
  // read one order, so a demoted Codex widens to the subscription Claude rung
  // in both paths or neither.
  const rungs = opts.briefingContext !== true
    ? requestedRungs
    : requestedRungs.filter((rung) => rung && rung.paid !== true && !isChargedApiRung(rung));
  const attempts = [];
  for (const r of rungs) {
    const started = Date.now();
    let text = null;
    let outcome = 'null';
    let ledgerSpend = null;
    let gateAuthorization = null;
    if (isChargedApiRung(r)) {
      // D3: the central ledger (when configured) is the gate's spend truth
      // for the openai-api floor; any remote failure already logged its
      // fallback and the gate reads the LOCAL file instead.
      if (r.name === 'openai-api') {
        ledgerSpend = await readLedgerSpendState(opts, toDate(opts.now));
      }
      const gate = chargedLlmApiGate(
        opts,
        attempts,
        r.name,
        ledgerSpend || undefined,
        modelQuestion,
      );
      if (!gate.ok) {
        const attempt = { rung: r.name, outcome: gate.outcome, latencyMs: 0 };
        attempts.push(attempt);
        if (typeof opts.onAttempt === 'function') opts.onAttempt(attempt);
        appendJsonl(ATTEMPT_LOG, {
          ts: new Date().toISOString(),
          surface: opts.surface || 'unknown',
          ...attempt,
        });
        continue;
      }
      gateAuthorization = gate;
    }
    // Warn-only visibility before a paid rung; the HARD caps were already
    // enforced by the gate above.
    if (isChargedApiRung(r) && r.name === 'openai-api') {
      const b = opts.budget || {
        spentUsd: (ledgerSpend && ledgerSpend.state
          ? ledgerSpend.state
          : readSpend(resolveSpendFile(opts), toDate(opts.now))
        ).spentUsd,
        capUsd: OPENAI_MONTHLY_CAP_USD,
      };
      const warn = budgetWarning(b);
      if (warn) {
        if (typeof b.warn === 'function') b.warn(warn);
        appendJsonl(ATTEMPT_LOG, {
          ts: new Date().toISOString(),
          surface: opts.surface || 'unknown',
          budgetWarning: warn,
        });
      }
    }
    const rungRetries = Number.isInteger(opts.rungRetries) ? opts.rungRetries : 1;
    let failureDetail = null;
    if (opts.rungFailures && typeof opts.rungFailures === 'object') delete opts.rungFailures[r.name];
    if (opts.rungDiagnostics && typeof opts.rungDiagnostics === 'object') delete opts.rungDiagnostics[r.name];
    if (opts.rungUsage && typeof opts.rungUsage === 'object') delete opts.rungUsage[r.name];
    try {
      const timeoutMs = resolveRungTimeoutMs(opts, 45000);
      const out = await withTransientRetry(
        () => withRungTimeout(() => r.fn(modelQuestion, gateAuthorization), timeoutMs, r.name),
        {
          retries: rungRetries,
          sleep: opts.sleep,
          isTransient: (err) => (err && err.rungTimeout ? false : isTransientError(err)),
          // Record each absorbed blip so the attempt log shows the rung held
          // through a transient failure instead of silently descending.
          onRetry: ({ attempt, error, delayMs }) => {
            const retryAttempt = {
              rung: r.name,
              outcome: 'transient-retry:' + String(error && error.message).slice(0, 48),
              latencyMs: delayMs,
            };
            attempts.push(retryAttempt);
            if (typeof opts.onAttempt === 'function') opts.onAttempt(retryAttempt);
            appendJsonl(ATTEMPT_LOG, {
              ts: new Date().toISOString(),
              surface: opts.surface || 'unknown',
              retry: attempt,
              ...retryAttempt,
            });
          },
        },
      );
      if (typeof out === 'string' && out.trim()) {
        if (isCliFailureOutput(out)) {
          outcome = 'sentinel-failure';
          failureDetail = out.trim();
        } else {
          text = out.trim();
          outcome = 'answered';
        }
      }
    } catch (e) {
      outcome = 'threw:' + String(e && e.message).slice(0, 60);
      failureDetail = String(e && e.message);
    }
    const attempt = { rung: r.name, outcome, latencyMs: Date.now() - started };
    if (outcome !== 'answered') {
      const detail = failureDetail || opts.rungFailures?.[r.name];
      if (detail) attempt.failureDetail = String(detail).replace(/\s+/g, ' ').trim().slice(0, 600);
      if (opts.rungDiagnostics?.[r.name]) attempt.diagnostic = opts.rungDiagnostics[r.name];
    }
    attempts.push(attempt);
    if (typeof opts.onAttempt === 'function') opts.onAttempt(attempt);
    appendJsonl(ATTEMPT_LOG, {
      ts: new Date().toISOString(),
      surface: opts.surface || 'unknown',
      ...ledgerIdentity(opts),
      ...attempt,
      ...(opts.rungUsage?.[r.name] || {}),
    });
    trackBrainHealth(r.name, outcome, failureDetail, opts);
    if (text) {
      settleCircuit(`answered:${r.name}`);
      if (briefingContext) recordBriefingContextOutcome(true);
      return {
        text,
        rung: r.name,
        latencyMs: attempt.latencyMs,
        attempts,
        ...(briefingContext
          ? {
              briefingContext: {
                stableHash: briefingContext.stableHash,
                dynamicHash: briefingContext.dynamicHash,
                stableReused: briefingContext.stableReused,
                transportMode: briefingContext.transportMode,
              },
            }
          : {}),
      };
    }
  }
  settleCircuit('all-rungs-failed');
  if (briefingContext) recordBriefingContextOutcome(false);
  if (opts.silent) return null;
  throw new BrainUnreachable(attempts);
}

module.exports = {
  askAI,
  withBriefingToolLessDefault,
  quoteWindowsShellArg,
  windowsSafeSpawnArgs,
  toolLessClaudeArgs,
  toolLessCodexHookConfig,
  codexOutputSchemaArgs,
  claudeOutputSchemaArgs,
  runCodexRung,
  runClaudeCliRung,
  claudeRungEnv,
  RungTimeoutError,
  BrainUnreachable,
  resolveRungTimeoutMs,
  withRungTimeout,
  defaultRungOrder,
  HOST_BRAIN_RUNGS,
  ledgerRequest,
  orderByLeadingBrain,
  trackBrainHealth,
  isEc2Host,
  modelRungOrder,
  resolveRungOrder,
  OWNER_LEAD_SURFACES,
  budgetWarning,
  chargedLlmApiGate,
  ctDateString,
  inNightWindow,
  nightKey,
  estimateOpenAiCostUsd,
  estimateBedrockCostUsd,
  parseBedrockResponse,
  readSpend,
  recordSpend,
  resolveSpendFile,
  settleOpenAiSpend,
  settleOpenAiSpendViaLedger,
  readLedgerSpendState,
  DEFAULT_OPENAI_CALL_EST_USD,
  SPEND_LEDGER_TIMEOUT_MS,
  ATTEMPT_LOG,
  ledgerIdentity,
  SPEND_FILE,
  toolLessClaudeArgs,
  unwrapClaudeStructuredOutput,
  toolLessCodexHookConfig,
  claudeProxyAutomationFields,
};
