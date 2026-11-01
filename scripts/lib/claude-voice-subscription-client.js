'use strict';

// A deliberately small EC2-only Claude Max decision client.  Voice turns must
// never inherit a developer checkout, Claude settings, hooks, MCP servers, or
// a metered provider key.  The pushed OAuth token is the only credential this
// process receives.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  buildClaudeCliEnv,
  isCliFailureOutput,
} = require('./cli-output-guard');
const { isolatedVoiceRuntimeEnv } = require('./codex-app-server-client');

// This pin is the EC2 subscription route that passed the isolated OAuth
// canary. Keep it independent from paid-provider configuration and from the
// global brain switch, which intentionally does not select phone lanes.
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_RUNTIME_ROOT = '/opt/secondbrain/runtime/claude-voice';
const STRIPPED_VOICE_ENV_KEYS = Object.freeze([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'AGENTIC_CODEX_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'VAPI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
]);

function isolatedClaudeRuntimeEnv(baseEnv = process.env, tokenPath) {
  // buildClaudeCliEnv is the proved EC2 OAuth boundary.  Apply the generic
  // voice scrub afterward so future paid-provider variables cannot leak in.
  const cleanBase = { ...baseEnv };
  for (const key of STRIPPED_VOICE_ENV_KEYS) delete cleanBase[key];
  const env = isolatedVoiceRuntimeEnv(buildClaudeCliEnv(cleanBase, tokenPath));
  for (const key of STRIPPED_VOICE_ENV_KEYS) {
    if (key !== 'CLAUDE_CODE_OAUTH_TOKEN') delete env[key];
  }
  return env;
}

function prepareIsolatedClaudeRuntime({ runtimeRoot = DEFAULT_RUNTIME_ROOT, mkdtempSync = fs.mkdtempSync } = {}) {
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(runtimeRoot, 'turn-'));
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  return { root, configDir };
}

function cleanupIsolatedClaudeRuntime(runtime) {
  if (!runtime?.root) return;
  try { fs.rmSync(runtime.root, { recursive: true, force: true }); } catch { /* best effort */ }
}

function claudeVoiceArgs({ model = DEFAULT_MODEL } = {}) {
  return [
    '--print',
    '--model', model,
    '--effort', 'low',
    '--setting-sources',
    '',
    '--settings',
    '{"disableAllHooks":true}',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    // The result arrives as one stream event before the CLI's exit cleanup.
    // This is not Claude structured output: the existing local validator still
    // admits only the exact voice decision object.
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];
}

function streamAssistantText(event) {
  if (event?.type !== 'assistant' || !Array.isArray(event?.message?.content)) return '';
  return event.message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function unwrapStructuredDecision(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return '';
  try {
    const envelope = JSON.parse(text);
    const structured = envelope?.structured_output ?? envelope?.structuredOutput;
    return structured && typeof structured === 'object' ? JSON.stringify(structured) : text;
  } catch {
    return text;
  }
}

class ClaudeVoiceSubscriptionClient {
  constructor({
    claudePath = process.env.CLAUDE_VOICE_PATH || process.env.AMY_CLAUDE_COMMAND || 'claude',
    tokenPath = process.env.CLAUDE_VOICE_OAUTH_TOKEN_PATH || path.join(os.homedir(), '.claude-oauth-token'),
    runtimeRoot = process.env.CLAUDE_VOICE_RUNTIME_ROOT || DEFAULT_RUNTIME_ROOT,
    model = process.env.CLAUDE_VOICE_MODEL || DEFAULT_MODEL,
    spawnProcess = spawn,
    baseEnv = process.env,
  } = {}) {
    this.claudePath = claudePath;
    this.tokenPath = tokenPath;
    this.runtimeRoot = runtimeRoot;
    this.model = model;
    this.spawnProcess = spawnProcess;
    this.baseEnv = baseEnv;
  }

  isolationReport() {
    const env = isolatedClaudeRuntimeEnv(this.baseEnv, this.tokenPath);
    return {
      runtimeRoot: this.runtimeRoot,
      tokenPresent: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN),
      paidKeysPresent: STRIPPED_VOICE_ENV_KEYS.filter((key) => key !== 'CLAUDE_CODE_OAUTH_TOKEN')
        .filter((key) => Object.prototype.hasOwnProperty.call(env, key)),
      toolsDisabled: true,
      mcpDisabled: true,
      hooksDisabled: true,
    };
  }

  warm() {
    const report = this.isolationReport();
    if (!report.tokenPresent) return Promise.reject(new Error('Claude voice OAuth token is unavailable'));
    // `--version` proves the binary can start without sending a model request.
    return this.#run([], '', { timeoutMs: 1500, validate: () => ({ ok: true }), versionOnly: true })
      .then(() => ({ ok: true, lane: 'claude-cli', ...report }));
  }

  runVoiceDecision({ prompt, outputSchema, validate, signal, timeoutMs, onAttemptEvent = () => {} } = {}) {
    if (typeof validate !== 'function') return Promise.reject(new Error('voice decision validator is required'));
    const attemptId = `claude-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    onAttemptEvent({ event: 'started', attemptId, label: 'claude-cli' });
    const startedAt = Date.now();
    // Claude's CLI structured-output transport starts a second schema path
    // after an otherwise valid answer and missed the phone's whole 3 s
    // deadline on EC2. The decision prompt already requires one exact object;
    // preserve that contract by parsing it locally exactly once before SSE.
    return this.#run(claudeVoiceArgs({ model: this.model }), prompt, { signal, timeoutMs, validate })
      .then((decision) => {
        onAttemptEvent({ event: 'settled', attemptId, outcome: 'completed-valid', outputBytes: Buffer.byteLength(JSON.stringify(decision)), usage: {} });
        return { decision };
      })
      .catch((error) => {
        onAttemptEvent({ event: 'settled', attemptId, outcome: error?.name === 'AbortError' ? 'aborted' : 'failed', outputBytes: 0, usage: { durationMs: Date.now() - startedAt } });
        throw error;
      });
  }

  #run(args, prompt, { signal, timeoutMs, validate, versionOnly = false } = {}) {
    const runtime = prepareIsolatedClaudeRuntime({ runtimeRoot: this.runtimeRoot });
    return new Promise((resolve, reject) => {
      const env = isolatedClaudeRuntimeEnv(this.baseEnv, this.tokenPath);
      env.HOME = runtime.root;
      env.CLAUDE_CONFIG_DIR = runtime.configDir;
      let child;
      try {
        child = this.spawnProcess(this.claudePath, versionOnly ? ['--version'] : args, {
          cwd: runtime.root,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        cleanupIsolatedClaudeRuntime(runtime);
        reject(error);
        return;
      }
      let stdout = '';
      let stderr = '';
      let streamBuffer = '';
      let settled = false;
      let timer = null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        cleanupIsolatedClaudeRuntime(runtime);
        if (error) reject(error); else resolve(value);
      };
      const abortError = () => Object.assign(new Error('Claude voice decision aborted'), { name: 'AbortError' });
      const stop = () => { try { child.kill('SIGTERM'); } catch { /* already stopped */ } };
      const onAbort = () => { stop(); finish(abortError()); };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => { stop(); finish(Object.assign(new Error('Claude voice decision deadline exceeded'), { name: 'AbortError' })); }, timeoutMs);
      }
      child.stdout?.on('data', (chunk) => {
        const text = String(chunk);
        stdout += text;
        if (versionOnly || settled) return;
        streamBuffer += text;
        while (!settled) {
          const newline = streamBuffer.indexOf('\n');
          if (newline < 0) break;
          const line = streamBuffer.slice(0, newline);
          streamBuffer = streamBuffer.slice(newline + 1);
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            // A partial line is retained above; malformed non-decision events
            // are not a reason to accept or reject a phone decision.
            continue;
          }
          const decisionText = streamAssistantText(event);
          if (!decisionText) continue;
          try {
            // A full assistant event is emitted only after the decision text
            // completes. Validate before committing it, then stop the one-use
            // child instead of waiting for unrelated CLI result bookkeeping.
            const decision = validate(decisionText);
            stop();
            finish(null, decision);
          } catch (error) {
            stop();
            finish(error);
          }
        }
      });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      child.on?.('error', (error) => finish(error));
      child.on?.('close', (code) => {
        if (settled) return;
        const raw = `${stdout}\n${stderr}`.trim();
        if (code !== 0 || isCliFailureOutput(raw)) {
          return finish(new Error(`Claude voice CLI unavailable: ${raw.slice(0, 800) || `exit ${code}`}`));
        }
        if (versionOnly) return finish(null, { version: stdout.trim() });
        try {
          finish(null, validate(unwrapStructuredDecision(stdout)));
        } catch (error) {
          finish(error);
        }
      });
      child.stdin?.on?.('error', () => {});
      if (versionOnly) child.stdin?.end?.(); else child.stdin?.end?.(String(prompt || ''));
    });
  }
}

module.exports = {
  ClaudeVoiceSubscriptionClient,
  DEFAULT_MODEL,
  DEFAULT_RUNTIME_ROOT,
  claudeVoiceArgs,
  cleanupIsolatedClaudeRuntime,
  isolatedClaudeRuntimeEnv,
  prepareIsolatedClaudeRuntime,
  unwrapStructuredDecision,
};
