// scripts/lib/ask-ai.js
//
// THE universal LLM ladder for all Amy text processing (ExampleCo's 2026-06-11
// policy, plan: dev-plans/llm-fallback-ladder-2026-06-11.html, Codex-reviewed).
//
// Rung order (defaultRungOrder):
//   1. codex         -- OpenAI subscription (Codex CLI), independent vendor
//   2. claude-proxy  -- Claude Max via the laptop SSH-tunnel proxy
//   3. claude-cli    -- Claude Max via the local `claude -p` CLI
//   4. bedrock       -- AWS Bedrock funded $20/mo lane (only where configured)
//   5. anthropic-api -- Anthropic API key floor (only if key set)
//   6. openai-api    -- OpenAI API key floor, SOFT-capped (never blocked)
//
// Hard requirement: no surface dead when the Claude subscription is down.
// Therefore: every rung failure (null, throw, or sentinel auth-error output)
// DESCENDS to the next rung; BrainUnreachable throws only when ALL rungs fail;
// and the paid-floor budget is a soft rolling counter that WARNS at the cap
// but never synchronously blocks (a hard cap would kill the floor exactly when
// both subscriptions are down -- Codex review ruling).
//
// Runs on EC2 and the PC (pure Node builtins). Surfaces inject per-call
// options; tests inject rung fns directly.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const https = require('node:https');
const { isCliFailureOutput, buildClaudeCliEnv } = require('./cli-output-guard.js');
const { withTransientRetry, isTransientError } = require('./transient-error.js');
const { withCodexAmyPrelude } = require('./codex-amy-prelude.js');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
const ATTEMPT_LOG = path.join(REPO, 'data', 'agent', 'ask-ai-rungs.jsonl');
const SPEND_FILE = path.join(REPO, 'data', 'agent', 'openai-api-spend.json');
const OPENAI_SOFT_CAP_USD = Number(process.env.OPENAI_API_SOFT_CAP_USD || 20);
const OPENAI_WARN_USD = Number(process.env.OPENAI_API_WARN_USD || 15);

class BrainUnreachable extends Error {
  constructor(attempts) {
    super('All LLM rungs failed: ' + attempts.map((a) => `${a.rung}=${a.outcome}`).join(', '));
    this.name = 'BrainUnreachable';
    this.attempts = attempts;
  }
}

function appendJsonl(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch {
    /* logging must never break the ladder */
  }
}

// ---- soft rolling monthly budget for the OpenAI API floor -----------------

function readSpend() {
  try {
    const j = JSON.parse(fs.readFileSync(SPEND_FILE, 'utf8'));
    const month = new Date().toISOString().slice(0, 7);
    if (j.month !== month) return { month, spentUsd: 0, calls: 0 };
    return j;
  } catch {
    return { month: new Date().toISOString().slice(0, 7), spentUsd: 0, calls: 0 };
  }
}

function recordSpend(estUsd) {
  const s = readSpend();
  s.spentUsd = Math.round((s.spentUsd + estUsd) * 10000) / 10000;
  s.calls += 1;
  s.updatedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(SPEND_FILE), { recursive: true });
    fs.writeFileSync(SPEND_FILE, JSON.stringify(s, null, 1));
  } catch {
    /* never block */
  }
  return s;
}

// Soft check: returns a warning string when past thresholds, never blocks.
function budgetWarning(budget) {
  const spent = budget.spentUsd;
  const cap = budget.capUsd;
  if (spent >= cap) {
    return `OpenAI API floor spend $${spent.toFixed(2)} is OVER the soft cap $${cap} this month (call allowed -- resilience beats the cap; investigate why the subs are failing).`;
  }
  if (spent >= (budget.warnUsd ?? OPENAI_WARN_USD)) {
    return `OpenAI API floor spend $${spent.toFixed(2)} approaching the $${cap} soft cap.`;
  }
  return null;
}

// ---- built-in rung implementations -----------------------------------------

function runCodexRung(question, opts) {
  return new Promise((resolve) => {
    // --output-last-message writes the FINAL assistant turn to a file; stdout
    // ExampleCos session narration (tool calls, sandbox notes) that must never be
    // returned as the answer. Temp file per call, removed in finally.
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), `ask-ai-codex-${process.pid}-${Date.now()}.txt`);
    const args = [
      'exec',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '--output-last-message',
      outFile,
    ];
    if (opts.codexImagePath) args.push('-i', opts.codexImagePath);
    try {
      const res = spawnSync('codex', args, {
        input: withCodexAmyPrelude(question),
        encoding: 'utf8',
        timeout: opts.rungTimeoutMs || 90000,
        env: { ...process.env, CLAUDECODE: '' },
        shell: process.platform === 'win32',
        maxBuffer: 10 * 1024 * 1024,
      });
      if (res.error || res.status !== 0) return resolve(null);
      let out = '';
      try {
        out = fs.readFileSync(outFile, 'utf8').trim();
      } catch {
        out = (res.stdout || '').trim();
      }
      if (!out || isCliFailureOutput(out)) return resolve(null);
      resolve(out);
    } finally {
      try {
        fs.unlinkSync(outFile);
      } catch {
        /* already gone */
      }
    }
  });
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
        timeout: opts.rungTimeoutMs || 45000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try {
            const text = String(JSON.parse(raw).choices?.[0]?.message?.content || '').trim();
            if (!text || isCliFailureOutput(text)) return resolve(null);
            resolve(text);
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

function runClaudeCliRung(question, opts) {
  return new Promise((resolve) => {
    const res = spawnSync('claude', ['-p', question], {
      encoding: 'utf8',
      timeout: opts.rungTimeoutMs || 120000,
      env: buildClaudeCliEnv(),
      shell: process.platform === 'win32',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (res.error || res.status !== 0) return resolve(null);
    const out = (res.stdout || '').trim();
    if (!out || isCliFailureOutput(out)) return resolve(null);
    resolve(out);
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
        timeout: opts.rungTimeoutMs || 45000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try {
            const parsed = JSON.parse(raw);
            const text = String(parsed.choices?.[0]?.message?.content || '').trim();
            // Rough cost estimate from usage (gpt-4o-mini: ~$0.15/M in, $0.60/M out)
            const u = parsed.usage || {};
            const est = ((u.prompt_tokens || 0) * 0.15 + (u.completion_tokens || 0) * 0.6) / 1e6;
            const s = recordSpend(est);
            const warn = budgetWarning({ spentUsd: s.spentUsd, capUsd: OPENAI_SOFT_CAP_USD });
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

function defaultRungOrder() {
  return ['codex', 'claude-proxy', 'claude-cli', 'openai-api'];
}

function builtinRungs(opts) {
  const all = {
    codex: { name: 'codex', fn: (q) => runCodexRung(q, opts) },
    'claude-proxy': { name: 'claude-proxy', fn: (q) => runClaudeProxyRung(q, opts) },
    'claude-cli': { name: 'claude-cli', fn: (q) => runClaudeCliRung(q, opts) },
    'openai-api': { name: 'openai-api', fn: (q) => runOpenAiApiRung(q, opts), paid: true },
  };
  const order = opts.rungOrder || defaultRungOrder();
  return order.map((n) => all[n]).filter(Boolean);
}

// ---- the ladder -------------------------------------------------------------
//
// askAI(question, opts) -> { text, rung, latencyMs, attempts }
//   opts.rungs       inject rung objects [{name, fn(question), paid?}] (tests)
//   opts.surface     caller label for the attempt log
//   opts.system      optional system prompt
//   opts.onAttempt   callback per attempt {rung, outcome, latencyMs}
//   opts.budget      inject {spentUsd, capUsd, warnUsd, warn(msg)} (tests)
//   opts.silent      return null instead of throwing BrainUnreachable
//   opts.rungRetries extra same-rung retries on a TRANSIENT throw before
//                    descending (default 1). A blip on the Claude rung must not
//                    bounce Amy to a paid floor; a non-transient failure (auth,
//                    null, sentinel) still descends immediately.
//   opts.sleep       injectable backoff delay (tests pass a noop)
async function askAI(question, opts = {}) {
  const rungs = opts.rungs || builtinRungs(opts);
  const attempts = [];
  for (const r of rungs) {
    const started = Date.now();
    let text = null;
    let outcome = 'null';
    // Soft budget: warn (never block) before a paid rung when over thresholds.
    if (r.paid) {
      const b = opts.budget || { spentUsd: readSpend().spentUsd, capUsd: OPENAI_SOFT_CAP_USD };
      const warn = budgetWarning(b);
      if (warn) {
        if (typeof b.warn === 'function') b.warn(warn);
        appendJsonl(ATTEMPT_LOG, {
          ts: new Date().toISOString(),
          surface: opts.surface || 'ExampleCo',
          budgetWarning: warn,
        });
      }
    }
    const rungRetries = Number.isInteger(opts.rungRetries) ? opts.rungRetries : 1;
    try {
      const out = await withTransientRetry(() => r.fn(question), {
        retries: rungRetries,
        sleep: opts.sleep,
        isTransient: isTransientError,
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
            surface: opts.surface || 'ExampleCo',
            retry: attempt,
            ...retryAttempt,
          });
        },
      });
      if (typeof out === 'string' && out.trim()) {
        if (isCliFailureOutput(out)) {
          outcome = 'sentinel-failure';
        } else {
          text = out.trim();
          outcome = 'answered';
        }
      }
    } catch (e) {
      outcome = 'threw:' + String(e && e.message).slice(0, 60);
    }
    const attempt = { rung: r.name, outcome, latencyMs: Date.now() - started };
    attempts.push(attempt);
    if (typeof opts.onAttempt === 'function') opts.onAttempt(attempt);
    appendJsonl(ATTEMPT_LOG, {
      ts: new Date().toISOString(),
      surface: opts.surface || 'ExampleCo',
      ...attempt,
    });
    if (text) return { text, rung: r.name, latencyMs: attempt.latencyMs, attempts };
  }
  if (opts.silent) return null;
  throw new BrainUnreachable(attempts);
}

module.exports = {
  askAI,
  BrainUnreachable,
  defaultRungOrder,
  budgetWarning,
  readSpend,
  ATTEMPT_LOG,
  SPEND_FILE,
};
