'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const DISABLED_VOICE_FEATURES = [
  'apps',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode',
  'code_mode_host',
  'code_mode_only',
  'computer_use',
  'enable_fanout',
  'enable_mcp_apps',
  'goals',
  'hooks',
  'image_generation',
  'in_app_browser',
  'memories',
  'multi_agent',
  'plugins',
  'remote_plugin',
  'request_permissions_tool',
  'shell_tool',
  'shell_zsh_fork',
  'skill_mcp_dependency_install',
  'standalone_web_search',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'unified_exec',
  'unified_exec_zsh_fork',
  'workspace_dependencies',
];

const SAFE_ITEM_TYPES = new Set(['agentMessage', 'plan', 'reasoning', 'userMessage']);

function abortError() {
  const error = new Error('Codex app-server voice decision aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function isSameFile(left, right) {
  const a = fs.statSync(left);
  const b = fs.statSync(right);
  return a.dev === b.dev && a.ino === b.ino;
}

function prepareIsolatedCodexHome({ sourceCodexHome, runtimeHome } = {}) {
  const sourceHome = path.resolve(
    sourceCodexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  );
  const runtimeRoot = path.resolve(
    runtimeHome ||
      path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'secondbrain', 'codex-voice-runtime'),
  );
  if (sourceHome === runtimeRoot) {
    throw new Error('Codex voice runtime home must be isolated from the owner Codex home');
  }
  const sourceAuth = path.join(sourceHome, 'auth.json');
  if (!fs.existsSync(sourceAuth)) {
    throw new Error('Existing Codex subscription credential was not found');
  }
  fs.mkdirSync(runtimeRoot, { recursive: true });
  // Never reuse a prior runtime directory. A stale config.toml, plugin, hook,
  // skill, MCP definition, or workspace file must not become voice context.
  const isolatedHome = fs.mkdtempSync(path.join(runtimeRoot, 'process-'));
  const isolatedAuth = path.join(isolatedHome, 'auth.json');
  const workspace = path.join(isolatedHome, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  if (!fs.existsSync(isolatedAuth)) {
    // Preserve the exact existing credential. A hard link neither copies nor
    // rotates it and makes later credential changes visible to both paths.
    fs.linkSync(sourceAuth, isolatedAuth);
  }
  if (!isSameFile(sourceAuth, isolatedAuth)) {
    throw new Error('Isolated Codex voice credential is not the existing credential hard link');
  }
  return { isolatedHome, runtimeRoot, workspace };
}

function cleanupIsolatedCodexHome(runtime) {
  const runtimeRoot = path.resolve(String(runtime?.runtimeRoot || ''));
  const isolatedHome = path.resolve(String(runtime?.isolatedHome || ''));
  if (
    !runtimeRoot ||
    !isolatedHome ||
    path.dirname(isolatedHome) !== runtimeRoot ||
    !path.basename(isolatedHome).startsWith('process-')
  ) {
    throw new Error('Refusing to remove an unverified Codex voice runtime directory');
  }
  fs.rmSync(isolatedHome, { recursive: true, force: true });
}

function isForbiddenToolItem(event) {
  if (!['item/started', 'item/completed'].includes(String(event?.method || ''))) return false;
  const type = String(event?.params?.item?.type || '');
  return Boolean(type) && !SAFE_ITEM_TYPES.has(type);
}

const CODEX_VOICE_SCRUB_KEYS = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
]);

function isolatedVoiceRuntimeEnv(env = process.env) {
  const safe = { ...env };
  for (const key of CODEX_VOICE_SCRUB_KEYS) delete safe[key];
  return safe;
}

function normalizeUsage(value) {
  const source = value?.last || value || {};
  const inputTokens = Math.max(0, Number(source.inputTokens) || 0);
  const cachedInputTokens = Math.max(0, Number(source.cachedInputTokens) || 0);
  const outputTokens = Math.max(0, Number(source.outputTokens) || 0);
  const processedTokens = Math.max(
    0,
    Number(source.totalTokens) || inputTokens + outputTokens,
  );
  return { inputTokens, cachedInputTokens, outputTokens, processedTokens };
}

class CodexAppServerClient {
  constructor({
    codexPath,
    model = 'gpt-5.6-terra',
    sourceCodexHome,
    runtimeHome,
    spawnImpl = spawn,
    threadPoolTarget = 6,
    maxActiveAttempts = 6,
    hedgeDelayMs = 1600,
    startupTimeoutMs = 8000,
    cancellationSettleTimeoutMs = 1200,
    forceTerminateAfterMs = 800,
  } = {}) {
    if (!codexPath) throw new Error('codexPath is required');
    this.codexPath = codexPath;
    this.model = model;
    this.sourceCodexHome = sourceCodexHome;
    this.runtimeHome = runtimeHome;
    this.spawnImpl = spawnImpl;
    this.proc = null;
    this.buffer = '';
    this.nextId = 1;
    this.nextAttemptId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.readyPromise = null;
    this.stderrHead = '';
    this.threadPool = [];
    this.threadPoolTarget = Math.max(1, Number(threadPoolTarget) || 6);
    this.threadCreatesInFlight = 0;
    this.maxActiveAttempts = Math.max(1, Number(maxActiveAttempts) || 6);
    this.activeAttempts = 0;
    this.hedgeDelayMs = Math.max(0, Number(hedgeDelayMs) || 0);
    this.startupTimeoutMs = Math.max(50, Number(startupTimeoutMs) || 8000);
    this.cancellationSettleTimeoutMs = Math.max(
      100,
      Number(cancellationSettleTimeoutMs) || 1200,
    );
    this.forceTerminateAfterMs = Math.max(100, Number(forceTerminateAfterMs) || 800);
    this.startFailureCount = 0;
    this.nextStartAt = 0;
    this.runtime = null;
    this.terminationPromise = null;
    this.terminationProc = null;
    this.closedProcesses = new WeakSet();
  }

  warm() {
    return this.#ensureReady();
  }

  isolationReport() {
    const sourceHome = path.resolve(
      this.sourceCodexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    );
    const runtimeHome = path.resolve(
      this.runtimeHome ||
        path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'secondbrain', 'codex-voice-runtime'),
    );
    const scrubbed = isolatedVoiceRuntimeEnv(process.env);
    return {
      runtimeRoot: runtimeHome,
      tokenPresent: fs.existsSync(path.join(sourceHome, 'auth.json')),
      paidKeysPresent: CODEX_VOICE_SCRUB_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(scrubbed, key)),
      toolsDisabled: true,
      mcpDisabled: true,
      hooksDisabled: true,
      // The process uses a fresh workspace and an empty dynamic tool list.
      workspaceIsolated: sourceHome !== runtimeHome,
    };
  }

  close() {
    if (this.proc) this.#failProcess(this.proc, new Error('Codex app-server client closed'));
  }

  async runVoiceDecision({
    prompt,
    outputSchema,
    validate,
    onFirstDelta,
    onAttemptEvent,
    signal,
    timeoutMs = 12000,
  } = {}) {
    // A hedge is another physical attempt for the same voice decision, not a
    // second decision with its own latency allowance.  Establish this before
    // startup too: a cold app-server must not consume the caller's budget and
    // then hand the model a fresh full timeout.
    const decisionTimeoutMs = Math.max(1, Number(timeoutMs) || 12000);
    const deadlineAt = Date.now() + decisionTimeoutMs;
    const remainingDecisionMs = () => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        throw new Error(`Codex app-server voice decision exceeded ${decisionTimeoutMs}ms`);
      }
      return remaining;
    };
    throwIfAborted(signal);
    await this.#ensureReady();
    throwIfAborted(signal);
    remainingDecisionMs();

    const primaryAbort = new AbortController();
    const hedgeAbort = new AbortController();
    let hedgeTimer = null;
    let hedgeStarted = false;
    let rejectHedge = null;
    const abortBoth = () => {
      if (hedgeTimer) clearTimeout(hedgeTimer);
      primaryAbort.abort();
      hedgeAbort.abort();
      rejectHedge?.(abortError());
    };
    if (signal) signal.addEventListener('abort', abortBoth, { once: true });

    const primary = this.#runVoiceDecisionAttempt({
      label: 'primary',
      prompt,
      outputSchema,
      validate,
      onFirstDelta,
      onAttemptEvent,
      signal: primaryAbort.signal,
      timeoutMs: remainingDecisionMs(),
    });
    const hedge = new Promise((resolve, reject) => {
      rejectHedge = reject;
      hedgeTimer = setTimeout(() => {
        hedgeStarted = true;
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        let remainingMs;
        try {
          remainingMs = remainingDecisionMs();
        } catch (error) {
          reject(error);
          return;
        }
        this.#runVoiceDecisionAttempt({
          label: 'hedge',
          prompt,
          outputSchema,
          validate,
          onFirstDelta,
          onAttemptEvent,
          signal: hedgeAbort.signal,
          timeoutMs: remainingMs,
        }).then(resolve, reject);
      }, this.hedgeDelayMs);
    });
    try {
      return await Promise.any([primary, hedge]);
    } finally {
      if (hedgeTimer) clearTimeout(hedgeTimer);
      primaryAbort.abort();
      if (hedgeStarted) hedgeAbort.abort();
      else rejectHedge?.(abortError());
      if (signal) signal.removeEventListener('abort', abortBoth);
      // The winner is not the whole logical receipt. Wait for every started
      // physical attempt to observe cancellation and emit its settled event.
      await Promise.allSettled([primary, hedge]);
    }
  }

  async #runVoiceDecisionAttempt({
    label,
    prompt,
    outputSchema,
    validate,
    onFirstDelta,
    onAttemptEvent,
    signal,
    timeoutMs,
  }) {
    const attemptId = `${label}-${this.nextAttemptId++}`;
    const startedAt = Date.now();
    const emitAttempt = (event) => {
      try { onAttemptEvent?.({ attemptId, label, ...event }); } catch { /* telemetry is non-fatal */ }
    };
    emitAttempt({ event: 'started' });
    let attemptOutcome = 'failed';
    let attemptUsage = normalizeUsage();
    let outputBytes = 0;
    try {
      throwIfAborted(signal);
      await this.#ensureReady();
      throwIfAborted(signal);
      if (this.activeAttempts >= this.maxActiveAttempts) {
        throw new Error('Codex app-server voice capacity exceeded');
      }
      this.activeAttempts += 1;
      let threadId = '';
      const attemptProc = this.proc;
      try {
        throwIfAborted(signal);
        threadId = this.threadPool.shift();
        if (!threadId) throw new Error('Codex app-server voice pool exhausted');
        throwIfAborted(signal);
        const result = await this.#completeTurn({
          threadId,
          prompt,
          outputSchema,
          onFirstDelta,
          signal,
          timeoutMs,
        });
        const decision = typeof validate === 'function' ? validate(result.text) : null;
        outputBytes = Buffer.byteLength(result.text || '');
        attemptUsage = result.usage;
        attemptOutcome = 'completed-valid';
        return { ...result, decision, attemptId, label };
      } finally {
        try {
          if (threadId) await this.#retireVoiceThread(threadId, attemptProc);
        } finally {
          this.activeAttempts = Math.max(0, this.activeAttempts - 1);
          await this.#replenishThreadPool();
        }
      }
    } catch (error) {
      attemptOutcome = error?.name === 'AbortError' ? 'aborted' : `failed:${String(error?.message || error).slice(0, 80)}`;
      throw error;
    } finally {
      emitAttempt({
        event: 'settled',
        outcome: attemptOutcome,
        outputBytes,
        durationMs: Date.now() - startedAt,
        usage: attemptUsage,
      });
    }
  }

  async #completeTurn({ threadId, prompt, outputSchema, onFirstDelta, signal, timeoutMs }) {
    const attemptProc = this.proc;
    let turnId = '';
    let text = '';
    let firstDeltaSeen = false;
    let settled = false;
    let timeout = null;
    let cancellationTimer = null;
    let abortHandler = null;
    let cancellationRequested = false;
    let turnStartSent = false;
    let terminationPending = false;
    let usage = normalizeUsage();

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (cancellationTimer) clearTimeout(cancellationTimer);
      this.listeners.delete(onEvent);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    };
    const interrupt = () => {
      if (!turnId || this.proc !== attemptProc) return;
      this.#request('turn/interrupt', { threadId, turnId }, 800).catch(() => {});
    };

    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const fail = (error, { discardProcess = false } = {}) => {
      if (settled || terminationPending) return;
      if (discardProcess && this.proc === attemptProc) {
        terminationPending = true;
        cleanup();
        Promise.resolve(this.#failProcess(attemptProc, error)).then(() => {
          settled = true;
          terminationPending = false;
          rejectCompletion(error);
        });
        return;
      }
      settled = true;
      cleanup();
      rejectCompletion(error);
    };
    const beginCancellation = () => {
      if (settled || cancellationRequested) return;
      cancellationRequested = true;
      if (!turnStartSent) {
        fail(abortError());
        return;
      }
      interrupt();
      cancellationTimer = setTimeout(() => {
        fail(abortError(), { discardProcess: true });
      }, this.cancellationSettleTimeoutMs);
    };
    const onEvent = (event) => {
      if (event?.method === 'codex/app-server/failed') {
        fail(event.error || new Error('Codex app-server failed'));
        return;
      }
      if (event?.params?.threadId !== threadId) return;
      if (isForbiddenToolItem(event)) {
        fail(new Error(`Codex app-server voice isolation blocked item ${event.params.item.type}`), {
          discardProcess: true,
        });
        return;
      }
      if (event.method === 'thread/tokenUsage/updated') {
        if (!turnId || event.params?.turnId === turnId) usage = normalizeUsage(event.params?.tokenUsage);
        return;
      }
      if (event.method === 'item/agentMessage/delta') {
        const delta = String(event.params?.delta || '');
        if (delta && !firstDeltaSeen) {
          firstDeltaSeen = true;
          try { onFirstDelta?.(); } catch { /* caller telemetry cannot break inference */ }
        }
        text += delta;
        return;
      }
      if (event.method !== 'turn/completed') return;
      if (turnId && event.params?.turn?.id !== turnId) return;
      if (settled) return;
      const status = event.params?.turn?.status;
      usage = normalizeUsage(event.params?.turn?.usage || event.params?.turn?.tokenUsage || usage);
      settled = true;
      cleanup();
      if (cancellationRequested) {
        rejectCompletion(abortError());
      } else if (status === 'completed') {
        resolveCompletion({ text, threadId, turnId, firstDeltaSeen, usage });
      } else {
        rejectCompletion(new Error(`Codex app-server turn ${status || 'failed'}`));
      }
    };
    this.listeners.add(onEvent);
    timeout = setTimeout(
      () =>
        fail(new Error(`Codex app-server voice decision exceeded ${timeoutMs}ms`), {
          discardProcess: true,
        }),
      timeoutMs,
    );
    abortHandler = beginCancellation;
    if (signal) {
      if (signal.aborted) abortHandler();
      else signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
      throwIfAborted(signal);
      turnStartSent = true;
      this.#request(
        'turn/start',
        {
          threadId,
          input: [{ type: 'text', text: String(prompt || '') }],
          model: this.model,
          effort: 'low',
          summary: 'none',
          outputSchema,
        },
        this.startupTimeoutMs,
      )
        .then((turnResult) => {
          turnId = String(turnResult?.turn?.id || '');
          if (!turnId) {
            fail(new Error('Codex app-server did not return a turn id'), {
              discardProcess: true,
            });
            return;
          }
          if (cancellationRequested) interrupt();
        })
        .catch((error) => fail(error, { discardProcess: true }));
    } catch (error) {
      fail(error);
    }
    return completion;
  }

  async #ensureReady() {
    if (this.terminationPromise) await this.terminationPromise;
    if (this.proc && !this.proc.killed && this.readyPromise) return this.readyPromise;
    if (Date.now() < this.nextStartAt) {
      throw new Error('Codex app-server restart is cooling down after startup failure');
    }
    const startPromise = this.#start()
      .then(() => {
        this.startFailureCount = 0;
        this.nextStartAt = 0;
      })
      .catch((error) => {
        this.startFailureCount = Math.min(8, this.startFailureCount + 1);
        this.nextStartAt = Date.now() + Math.min(30000, 250 * 2 ** (this.startFailureCount - 1));
        throw error;
      });
    this.readyPromise = startPromise;
    return startPromise;
  }

  async #start() {
    this.buffer = '';
    this.stderrHead = '';
    const runtime = prepareIsolatedCodexHome({
      sourceCodexHome: this.sourceCodexHome,
      runtimeHome: this.runtimeHome,
    });
    this.runtime = runtime;
    const args = [];
    for (const feature of DISABLED_VOICE_FEATURES) args.push('--disable', feature);
    args.push('app-server', '--listen', 'stdio://');
    const proc = this.spawnImpl(this.codexPath, args, {
      cwd: runtime.workspace,
      env: {
        ...isolatedVoiceRuntimeEnv(process.env),
        CODEX_HOME: runtime.isolatedHome,
        CODEX_SQLITE_HOME: runtime.isolatedHome,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.codexPath),
      windowsHide: true,
    });
    this.proc = proc;
    // Exit status can be observable before stdout/stderr and descendants are
    // closed. Only this spawn-time close latch is physical termination.
    proc.once('close', () => this.closedProcesses.add(proc));
    proc.stdout.on('data', (chunk) => this.#onStdout(chunk));
    proc.stderr.on('data', (chunk) => {
      if (this.stderrHead.length < 800) {
        this.stderrHead = (this.stderrHead + chunk.toString()).slice(0, 800);
      }
    });
    proc.stdin.on('error', (error) => this.#failProcess(proc, error));
    proc.on('error', (error) => this.#failProcess(proc, error));
    proc.on('close', (code) => this.#failProcess(proc, new Error(`Codex app-server exited ${code}`)));
    try {
      await this.#request(
        'initialize',
        {
          clientInfo: { name: 'amy-voice-proxy', title: 'Amy Voice Proxy', version: '1.0.0' },
          capabilities: { experimentalApi: true },
        },
        this.startupTimeoutMs,
      );
      this.#notify('initialized');
      await Promise.all(
        Array.from({ length: this.threadPoolTarget }, async () => {
          this.threadPool.push(await this.#createVoiceThread());
        }),
      );
    } catch (error) {
      this.#failProcess(proc, error);
      throw error;
    }
  }

  async #createVoiceThread() {
    if (!this.runtime) throw new Error('Codex app-server isolated runtime is not ready');
    const threadResult = await this.#request(
      'thread/start',
      {
        model: this.model,
        cwd: this.runtime.workspace,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        // Persist only inside the fresh private runtime long enough for the
        // app-server to honor thread/delete. Ephemeral threads cannot be
        // explicitly deleted by the protocol and would accumulate in memory.
        ephemeral: false,
        dynamicTools: [],
        runtimeWorkspaceRoots: [this.runtime.workspace],
        selectedCapabilityRoots: [],
        baseInstructions:
          'You are an isolated low-latency voice decision engine. Return only the JSON required by the supplied output schema. Never inspect files, use tools, or add commentary.',
        config: {
          apps: { _default: { enabled: false, destructive_enabled: false, open_world_enabled: false } },
          hooks: {},
          include_apps_instructions: false,
          include_collaboration_mode_instructions: false,
          include_environment_context: false,
          include_permissions_instructions: false,
          mcp_servers: {},
          model_reasoning_effort: 'low',
          plugins: {},
          project_doc_max_bytes: 0,
          skills: { bundled: { enabled: false }, config: [], include_instructions: false },
          web_search: 'disabled',
        },
      },
      this.startupTimeoutMs,
    );
    const threadId = threadResult?.thread?.id;
    if (!threadId) throw new Error('Codex app-server did not return a thread id');
    return threadId;
  }

  async #retireVoiceThread(threadId, proc) {
    if (!threadId || this.proc !== proc || proc?.killed) return;
    try {
      await this.#request('thread/delete', { threadId }, this.startupTimeoutMs);
    } catch (error) {
      // If one-use destruction is not confirmed, discard the whole process so
      // no completed voice thread can accumulate or be reused.
      this.#failProcess(proc, error);
      throw error;
    }
  }

  async #replenishThreadPool() {
    if (!this.proc || this.proc.killed) return;
    const missing = Math.max(
      0,
      this.threadPoolTarget -
        this.threadPool.length -
        this.activeAttempts -
        this.threadCreatesInFlight,
    );
    const creations = [];
    for (let index = 0; index < missing; index += 1) {
      this.threadCreatesInFlight += 1;
      const creation = this.#createVoiceThread()
        .then((threadId) => {
          if (this.threadPool.length < this.threadPoolTarget) this.threadPool.push(threadId);
        })
        .catch((error) => {
          if (this.proc) this.#failProcess(this.proc, error);
        })
        .finally(() => {
          this.threadCreatesInFlight = Math.max(0, this.threadCreatesInFlight - 1);
        });
      creations.push(creation);
    }
    await Promise.allSettled(creations);
  }

  #onStdout(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.id != null && this.pending.has(event.id)) {
        const waiter = this.pending.get(event.id);
        this.pending.delete(event.id);
        clearTimeout(waiter.timeout);
        if (event.error) waiter.reject(new Error(JSON.stringify(event.error)));
        else waiter.resolve(event.result);
        continue;
      }
      for (const listener of this.listeners) {
        try { listener(event); } catch { /* one listener cannot disrupt other calls */ }
      }
    }
  }

  #request(method, params, timeoutMs) {
    const proc = this.proc;
    if (!proc || proc.killed || !proc.stdin.writable) {
      return Promise.reject(new Error('Codex app-server is not running'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      const failWrite = (error) => {
        if (!error || !this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(error);
        this.#failProcess(proc, error);
      };
      try {
        proc.stdin.write(JSON.stringify({ id, method, params }) + '\n', failWrite);
      } catch (error) {
        failWrite(error);
      }
    });
  }

  #notify(method, params = {}) {
    const proc = this.proc;
    if (!proc || proc.killed || !proc.stdin.writable) return;
    try {
      proc.stdin.write(JSON.stringify({ method, params }) + '\n', (error) => {
        if (error) this.#failProcess(proc, error);
      });
    } catch (error) {
      this.#failProcess(proc, error);
    }
  }

  #trackProcessTermination(proc) {
    if (!proc || this.closedProcesses.has(proc)) return Promise.resolve();
    if (this.terminationProc === proc && this.terminationPromise) return this.terminationPromise;
    let resolveTermination;
    const termination = new Promise((resolve) => { resolveTermination = resolve; });
    this.terminationProc = proc;
    this.terminationPromise = termination;
    const forceTimer = setTimeout(() => {
      if (this.closedProcesses.has(proc)) return;
      if (process.platform === 'win32' && proc.pid) {
        try {
          const killer = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          killer.once('error', () => {
            try { proc.kill('SIGKILL'); } catch { /* termination remains fail-closed */ }
          });
          killer.once('close', (code) => {
            if (code === 0) return;
            try { proc.kill('SIGKILL'); } catch { /* termination remains fail-closed */ }
          });
          return;
        } catch {
          /* direct forced termination below */
        }
      }
      try { proc.kill('SIGKILL'); } catch { /* termination remains fail-closed */ }
    }, this.forceTerminateAfterMs);
    forceTimer.unref?.();
    proc.once('close', () => {
      clearTimeout(forceTimer);
      if (this.terminationProc === proc) {
        this.terminationProc = null;
        this.terminationPromise = null;
      }
      resolveTermination();
    });
    return termination;
  }

  #failProcess(proc, error) {
    if (this.proc !== proc) return this.#trackProcessTermination(proc);
    const termination = this.#trackProcessTermination(proc);
    const runtime = this.runtime;
    this.proc = null;
    this.readyPromise = null;
    this.runtime = null;
    this.nextStartAt = Math.max(this.nextStartAt, Date.now() + 250);
    this.threadPool = [];
    this.threadCreatesInFlight = 0;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners) {
      try { listener({ method: 'codex/app-server/failed', error }); } catch { /* best effort */ }
    }
    const cleanupRuntime = () => {
      if (!runtime) return;
      try { cleanupIsolatedCodexHome(runtime); } catch { /* a later startup uses a fresh directory */ }
    };
    proc?.once?.('close', cleanupRuntime);
    if (proc && !proc.killed && !this.closedProcesses.has(proc)) {
      try { proc.kill(); } catch { /* already stopped */ }
    }
    const cleanupTimer = setTimeout(cleanupRuntime, 1000);
    cleanupTimer.unref?.();
    return termination;
  }
}

module.exports = {
  CodexAppServerClient,
  DISABLED_VOICE_FEATURES,
  cleanupIsolatedCodexHome,
  isForbiddenToolItem,
  normalizeUsage,
  isolatedVoiceRuntimeEnv,
  prepareIsolatedCodexHome,
};
