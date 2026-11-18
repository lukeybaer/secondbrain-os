// Test guard: a test must never spend on a paid model API.
//
// Why (Oct 29): scripts/__tests__/agentic-healer-integration-resume.test.js read
// this PC's real Jev on/off switch and, when the owner had it on, made a real paid
// Jev call and failed at random. Paid spend needs explicit owner grants
// (memory/AMY_AUTHORIZATIONS.md); a test run is never one.
//
// Two layers, both test-only (loaded from vitest.config.ts setupFiles):
//  1. Switches forced off. JEV_CONTROL_PLANE_BACKEND=off (the env value may only
//     narrow the durable switch, never widen it, so the PC's real "on" file is
//     ignored) and the paid API keys are removed from the test environment.
//  2. Paid HTTP clients refuse. https/http request+get and global fetch throw a
//     PaidApiTestGuardError for paid model hosts. A test that injects its own
//     fake (the client's `request` parameter, vi.spyOn(https, 'request'), or a
//     stubbed globalThis.fetch) replaces the guard for that call and is unaffected.
// Limit: child processes (the aws CLI bedrock rung) are not covered.
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const PAID_HOSTS = [
  /^api\.typesafe\.ai$/i,
  /^api\.openai\.com$/i,
  /^api\.anthropic\.com$/i,
  /^bedrock(-runtime)?\.[a-z0-9-]+\.amazonaws\.com$/i,
  /^generativelanguage\.googleapis\.com$/i,
  /^api\.x\.ai$/i,
  /^api\.groq\.com$/i,
  /^openrouter\.ai$/i,
  /^api\.elevenlabs\.io$/i,
];

export class PaidApiTestGuardError extends Error {
  constructor(host) {
    super(`test guard: refused a real network call to paid API host ${host}; inject a fake instead`);
    this.name = 'PaidApiTestGuardError';
    this.code = 'PAID_API_TEST_GUARD';
  }
}

export function isPaidHost(host) {
  const bare = String(host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return PAID_HOSTS.some((re) => re.test(bare));
}

function hostFromArgs(args) {
  const [first, second] = args;
  if (typeof first === 'string') {
    try { return new URL(first).host; } catch { return ''; }
  }
  if (first instanceof URL) return first.host;
  const opts = first && typeof first === 'object' ? first : second && typeof second === 'object' ? second : {};
  return opts.hostname || opts.host || '';
}

const KEY = Symbol.for('amy.paidApiTestGuard');
if (!globalThis[KEY]) {
  globalThis[KEY] = true;
  for (const mod of [https, http]) {
    for (const name of ['request', 'get']) {
      const real = mod[name];
      mod[name] = function guarded(...args) {
        const host = hostFromArgs(args);
        if (isPaidHost(host)) throw new PaidApiTestGuardError(host);
        return real.apply(this, args);
      };
    }
  }
  if (typeof globalThis.fetch === 'function') {
    const realFetch = globalThis.fetch;
    globalThis.fetch = function guardedFetch(input, init) {
      let host = '';
      try { host = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).host; } catch { /* not a URL */ }
      if (isPaidHost(host)) return Promise.reject(new PaidApiTestGuardError(host));
      return realFetch.call(this, input, init);
    };
  }
  syncBuiltinESMExports();
}

process.env.JEV_CONTROL_PLANE_BACKEND = 'off';
for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY']) delete process.env[name];
