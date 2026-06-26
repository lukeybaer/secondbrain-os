// mcp-server-health.ts
//
// Active health monitor for MCP servers and other external tool
// providers. Tracks last_probe, p50/p95 latency, error_rate, and
// consecutive failures per server. Opens a circuit when a server
// crosses a configurable failure threshold so the agent loop routes
// around it instead of stacking up calls into a dead endpoint.
//
// SecondBrain talks to a long-lived set of MCP servers (the Claude_Preview
// browser, Claude_in_Chrome, computer-use, scheduled-tasks, gmail,
// mcp-registry, ccd_session_mgmt, others -- see the deferred-tools list
// on session start). These servers go up and down independently of
// Amy. When one is down, agent loops that try the dead server first
// burn budget, hit retry timeouts, and slow every downstream surface
// (briefing build, Vapi call, gmail dispatch). The agent should detect
// "this server is unhealthy right now" and skip to the next option
// without a stall.
//
// Why this is not redundant with existing modules:
//
//   - circuit-breaker.ts is a GENERIC breaker primitive (open/half/closed
//     state machine). It does not know about MCP servers, does not run
//     active probes, does not keep latency histograms, and does not
//     interact with the tool-router.
//   - pipeline-heartbeat.ts is for pipeline-level heartbeats (the
//     briefing build emits one heartbeat per stage). It does not probe
//     external endpoints.
//   - backoff-retry.ts is the PER-CALL retry primitive. It absorbs one
//     transient failure; it does not learn "this server has been failing
//     for the last 30 minutes, stop calling it."
//   - tool-fallback-chain.ts is the FALLBACK-ON-FAIL chain (try A; on
//     fail try B). It is reactive only -- it has no notion of
//     pre-emptive routing around a known-bad server. This module
//     provides the signal that fallback-chain can consult for the next
//     pick (see pickHealthy below).
//
// What was missing: a per-MCP-server health view that combines active
// probes, passive observations, and a circuit breaker, with a
// pickHealthy(...) primitive that the tool-router and fallback chain
// can use to route around dead servers BEFORE issuing the call.
//
// Pattern sources (2026 OSS + production playbooks):
//   - Anthropic MCP best practices "server health probes" guidance
//     (modelcontextprotocol.io/best-practices 2026-02) -- recommends a
//     lightweight probe (initialize-and-disconnect or capabilities echo)
//     per server every 30-60s, plus a circuit breaker on three
//     consecutive failures.
//   - Mastra MCPRegistry health-aware routing (mastra-ai/mastra v0.4
//     2026-03) -- registry exposes a health() per server; routes pick
//     the highest-health-score backend for a capability.
//   - Composio MCPRouter circuit breakers (composio/python-sdk 0.5
//     2026-04) -- per-server breaker with half-open trial after
//     cooldown, identical state machine to the one in this module.
//   - Netflix Hystrix (classic 2012, archived 2018) -- the canonical
//     reference for the closed/open/half-open breaker with rolling
//     stats. The variable naming here mirrors Hystrix to make it
//     immediately legible to anyone with that background.
//   - Sentry Performance "slow query / slow span" detector (sentry-cli
//     2024) -- the p95-degradation threshold pattern: classify as
//     "degraded" before "down".
//
// Design:
//   - Pure module. No I/O. The probe function and the clock are
//     injected; tests pass deterministic stubs.
//   - Rolling-window stats are computed over the last N samples (default
//     30). This avoids storing an unbounded latency history while still
//     being responsive to recent changes.
//   - The breaker state machine is closed -> open -> half_open -> closed.
//     Open is triggered by either consecutive failures or sustained
//     high error rate. Half-open lets one probe through after the
//     cooldown; success closes, failure re-opens.

// ── Types ─────────────────────────────────────────────────────────────────────

export type ServerStatus = 'up' | 'degraded' | 'down' | 'ExampleCo';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface ProbeResult {
  ok: boolean;
  latency_ms: number;
  error?: string;
}

export type ProbeFn = () => Promise<ProbeResult>;

export interface ServerSample {
  ts_ms: number;
  ok: boolean;
  latency_ms: number;
  error?: string;
  source: 'probe' | 'call';
}

export interface ServerHealth {
  id: string;
  status: ServerStatus;
  breaker: BreakerState;
  consecutive_failures: number;
  consecutive_successes: number;
  total_samples: number;
  ok_count: number;
  fail_count: number;
  error_rate: number;             // 0..1 over window
  p50_latency_ms: number;
  p95_latency_ms: number;
  last_sample_ts_ms?: number;
  last_success_ts_ms?: number;
  last_failure_ts_ms?: number;
  last_error?: string;
  opened_at_ms?: number;          // when breaker went open
  cooldown_until_ms?: number;     // when half-open trial may run
}

export interface HealthOptions {
  /** Rolling window size in samples (default 30). */
  window?: number;
  /** Consecutive failures that flip closed -> open (default 3). */
  open_after_consecutive_failures?: number;
  /** Rolling error rate that flips closed -> open (default 0.5). */
  open_at_error_rate?: number;
  /** Latency p95 above which a server is "degraded" (default 5000ms). */
  degraded_p95_ms?: number;
  /** Cooldown before half-open trial (default 60000ms). */
  cooldown_ms?: number;
  /** Consecutive successes in half_open to close again (default 1). */
  close_after_consecutive_successes?: number;
  /** Optional clock injection for deterministic tests. */
  now?: () => number;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULTS: Required<Omit<HealthOptions, 'now'>> = {
  window: 30,
  open_after_consecutive_failures: 3,
  open_at_error_rate: 0.5,
  degraded_p95_ms: 5000,
  cooldown_ms: 60_000,
  close_after_consecutive_successes: 1,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * (sorted.length - 1)))
  );
  return sorted[idx];
}

// ── Monitor ───────────────────────────────────────────────────────────────────

interface ServerEntry {
  id: string;
  probe?: ProbeFn;
  samples: ServerSample[];
  consecutive_failures: number;
  consecutive_successes: number;
  breaker: BreakerState;
  opened_at_ms?: number;
  cooldown_until_ms?: number;
  last_success_ts_ms?: number;
  last_failure_ts_ms?: number;
  last_error?: string;
}

export class McpServerHealth {
  private readonly _opts: Required<Omit<HealthOptions, 'now'>> &
    Pick<HealthOptions, 'now'>;
  private readonly _entries = new Map<string, ServerEntry>();

  constructor(opts: HealthOptions = {}) {
    this._opts = { ...DEFAULTS, ...opts };
  }

  private _now(): number {
    return (this._opts.now ?? Date.now)();
  }

  // ── Registration ──────────────────────────────────────────────────────────

  registerServer(id: string, probe?: ProbeFn): void {
    if (this._entries.has(id)) {
      // Update the probe but keep history.
      const existing = this._entries.get(id)!;
      existing.probe = probe;
      return;
    }
    this._entries.set(id, {
      id,
      probe,
      samples: [],
      consecutive_failures: 0,
      consecutive_successes: 0,
      breaker: 'closed',
    });
  }

  /** True if the server is registered. */
  has(id: string): boolean {
    return this._entries.has(id);
  }

  listIds(): string[] {
    return Array.from(this._entries.keys());
  }

  // ── Sample ingest ─────────────────────────────────────────────────────────

  /**
   * Passive observation: record a real tool call's outcome. Cheaper than
   * an active probe and reflects actual usage patterns.
   */
  recordCall(id: string, ok: boolean, latency_ms: number, error?: string): void {
    this._record(id, { ok, latency_ms, error, source: 'call' });
  }

  /**
   * Active probe: run the registered probe function and record the
   * result. If no probe is registered, throws -- callers that want a
   * silent no-op should check has() first.
   */
  async probe(id: string): Promise<ProbeResult> {
    const entry = this._mustGet(id);
    if (!entry.probe) {
      throw new Error(`no probe registered for server: ${id}`);
    }
    // Half-open gate: only one probe may pass while open.
    if (entry.breaker === 'open') {
      const now = this._now();
      if (entry.cooldown_until_ms && now < entry.cooldown_until_ms) {
        return {
          ok: false,
          latency_ms: 0,
          error: 'breaker_open_cooldown',
        };
      }
      entry.breaker = 'half_open';
    }
    const start = this._now();
    let result: ProbeResult;
    try {
      result = await entry.probe();
    } catch (e) {
      result = {
        ok: false,
        latency_ms: this._now() - start,
        error: (e as Error).message ?? 'probe_threw',
      };
    }
    this._record(id, {
      ok: result.ok,
      latency_ms: result.latency_ms,
      error: result.error,
      source: 'probe',
    });
    return result;
  }

  /**
   * Probe every registered server in parallel. Returns a map of
   * id -> result. Servers without a probe function are skipped.
   */
  async probeAll(): Promise<Record<string, ProbeResult>> {
    const ids = this.listIds().filter((id) => this._entries.get(id)?.probe);
    const results = await Promise.all(
      ids.map(async (id) => [id, await this.probe(id)] as const)
    );
    return Object.fromEntries(results);
  }

  // ── Health query ──────────────────────────────────────────────────────────

  health(id: string): ServerHealth {
    const entry = this._mustGet(id);
    const samples = entry.samples;
    const okCount = samples.filter((s) => s.ok).length;
    const failCount = samples.length - okCount;
    const errRate = samples.length === 0 ? 0 : failCount / samples.length;
    const sortedLat = samples
      .map((s) => s.latency_ms)
      .filter((x) => Number.isFinite(x))
      .sort((a, b) => a - b);
    const p50 = quantile(sortedLat, 0.5);
    const p95 = quantile(sortedLat, 0.95);
    let status: ServerStatus;
    if (samples.length === 0) {
      status = 'ExampleCo';
    } else if (entry.breaker === 'open') {
      status = 'down';
    } else if (
      errRate >= 0.25 ||
      p95 > this._opts.degraded_p95_ms ||
      entry.consecutive_failures > 0
    ) {
      status = 'degraded';
    } else {
      status = 'up';
    }
    return {
      id,
      status,
      breaker: entry.breaker,
      consecutive_failures: entry.consecutive_failures,
      consecutive_successes: entry.consecutive_successes,
      total_samples: samples.length,
      ok_count: okCount,
      fail_count: failCount,
      error_rate: errRate,
      p50_latency_ms: p50,
      p95_latency_ms: p95,
      last_sample_ts_ms: samples[samples.length - 1]?.ts_ms,
      last_success_ts_ms: entry.last_success_ts_ms,
      last_failure_ts_ms: entry.last_failure_ts_ms,
      last_error: entry.last_error,
      opened_at_ms: entry.opened_at_ms,
      cooldown_until_ms: entry.cooldown_until_ms,
    };
  }

  allHealth(): ServerHealth[] {
    return this.listIds().map((id) => this.health(id));
  }

  /**
   * Returns the first id from `candidates` whose breaker is not open
   * and whose status is up or degraded. Used by the tool-router and
   * fallback-chain to route around dead servers without issuing the
   * call first. Returns undefined when every candidate is down.
   *
   * `allowDegraded` defaults to true: a degraded server is still
   * preferred over a down one. Set to false to force "only up" picks.
   */
  pickHealthy(
    candidates: string[],
    opts: { allowDegraded?: boolean; allowExampleCo?: boolean } = {}
  ): string | undefined {
    const allowDegraded = opts.allowDegraded ?? true;
    const allowExampleCo = opts.allowExampleCo ?? true;
    for (const id of candidates) {
      if (!this._entries.has(id)) continue;
      const h = this.health(id);
      if (h.status === 'down') continue;
      if (h.status === 'degraded' && !allowDegraded) continue;
      if (h.status === 'ExampleCo' && !allowExampleCo) continue;
      return id;
    }
    return undefined;
  }

  /** Test/admin helper: reset a server's history and breaker state. */
  reset(id: string): void {
    const entry = this._mustGet(id);
    entry.samples = [];
    entry.consecutive_failures = 0;
    entry.consecutive_successes = 0;
    entry.breaker = 'closed';
    entry.opened_at_ms = undefined;
    entry.cooldown_until_ms = undefined;
    entry.last_error = undefined;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private _mustGet(id: string): ServerEntry {
    const e = this._entries.get(id);
    if (!e) throw new Error(`server not registered: ${id}`);
    return e;
  }

  private _record(
    id: string,
    sample: Omit<ServerSample, 'ts_ms'>
  ): void {
    const entry = this._mustGet(id);
    const ts = this._now();
    const row: ServerSample = { ...sample, ts_ms: ts };
    entry.samples.push(row);
    if (entry.samples.length > this._opts.window) {
      entry.samples.splice(0, entry.samples.length - this._opts.window);
    }
    if (sample.ok) {
      entry.consecutive_failures = 0;
      entry.consecutive_successes += 1;
      entry.last_success_ts_ms = ts;
    } else {
      entry.consecutive_successes = 0;
      entry.consecutive_failures += 1;
      entry.last_failure_ts_ms = ts;
      entry.last_error = sample.error;
    }
    this._updateBreaker(entry);
  }

  private _updateBreaker(entry: ServerEntry): void {
    const samples = entry.samples;
    const fails = samples.filter((s) => !s.ok).length;
    const errRate = samples.length === 0 ? 0 : fails / samples.length;
    const now = this._now();
    if (entry.breaker === 'closed') {
      const tripByCount =
        entry.consecutive_failures >=
        this._opts.open_after_consecutive_failures;
      const tripByRate =
        samples.length >= 5 && errRate >= this._opts.open_at_error_rate;
      if (tripByCount || tripByRate) {
        entry.breaker = 'open';
        entry.opened_at_ms = now;
        entry.cooldown_until_ms = now + this._opts.cooldown_ms;
      }
      return;
    }
    if (entry.breaker === 'half_open') {
      // The most recent sample drove us here; check it.
      const last = samples[samples.length - 1];
      if (last?.ok) {
        if (
          entry.consecutive_successes >=
          this._opts.close_after_consecutive_successes
        ) {
          entry.breaker = 'closed';
          entry.opened_at_ms = undefined;
          entry.cooldown_until_ms = undefined;
        }
      } else {
        entry.breaker = 'open';
        entry.opened_at_ms = now;
        entry.cooldown_until_ms = now + this._opts.cooldown_ms;
      }
      return;
    }
    // entry.breaker === 'open'
    // Stay open until probe() flips us to half_open on the next attempt.
  }
}
