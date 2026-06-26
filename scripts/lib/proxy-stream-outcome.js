// Pure outcome decision for a finished `claude -p` stream in claude-proxy.js.
//
// Root incident (2026-06-11 LLM fallback ladder audit, Codex-verified): when
// the Max-plan OAuth token expired, the spawned `claude -p` exited nonzero
// (or exited 0 having streamed nothing) and claude-proxy.js still closed the
// SSE response as a normal completion. Downstream callers (EC2
// askAmyViaProxy -> Vapi) read the clean empty stream as a successful
// answer, so live calls went silent instead of falling through to the next
// ladder rung ("empty-200 bug").
//
// Category, not literal trigger: ANY nonzero or null exit code, ANY auth or
// quota sentinel in the head of the child output (the CLI prints "Not logged
// in · Please run /login" and exits 0), and ANY stream that delivered zero
// content bytes is an error. A null exit code means the child was killed by
// a signal (e.g. the proxy's 90s timeout); that is a failure too, never a
// partial success -- same rule the EC2 side pins in
// amy-proxy-timeout-falls-through.test.js.
//
// Extracted to its own module so the decision is unit-testable without
// booting the proxy server (claude-proxy.js listens on require).

'use strict';

const { isCliFailureOutput } = require('./cli-output-guard.js');

// decideStreamOutcome({ exitCode, bytesStreamed, outputHead })
//   -> { outcome: 'ok' | 'error', reason: string }
//
//   exitCode:      child process exit code (null when killed by signal)
//   bytesStreamed: count of content chars actually streamed to the client
//                  (text deltas + tool-call name/argument JSON)
//   outputHead:    first ~1000 chars of raw child output (stdout + stderr),
//                  classified with the shared cli-output-guard sentinels
function decideStreamOutcome({ exitCode, bytesStreamed, outputHead } = {}) {
  if (exitCode !== 0) {
    return { outcome: 'error', reason: 'claude -p exited ' + exitCode };
  }
  if (isCliFailureOutput(outputHead)) {
    return {
      outcome: 'error',
      reason: 'auth/quota failure output: ' + String(outputHead).trim().slice(0, 200),
    };
  }
  if (!Number.isFinite(bytesStreamed) || bytesStreamed <= 0) {
    return { outcome: 'error', reason: 'exit 0 but zero content bytes streamed' };
  }
  return { outcome: 'ok', reason: 'streamed ' + bytesStreamed + ' content chars' };
}

module.exports = { decideStreamOutcome };
