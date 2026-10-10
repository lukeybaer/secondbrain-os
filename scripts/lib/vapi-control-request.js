// vapi-control-request.js
//
// The ONLY sanctioned way to POST to a Vapi per-call controlUrl.
//
// ============================================================================
// WHY THIS EXISTS
// ============================================================================
// Inbound call 019f77d5, Saturday 2026-07-18 7:44 PM CT. ExampleCo asked Amy how the
// P2 briefing integrity session was going. Amy apologized once, then produced 54
// seconds of dead air, and ExampleCo hung up at 2m03s having received no answer. The
// answer he wanted was on disk the whole time and takes 228ms to read.
//
// Vapi gives the tool server a HARD 20-second budget to answer a tool-calls
// webhook. The check_spine path computed its answer instantly, then tried to
// speak it by POSTing to Vapi's per-call controlUrl, and awaited that POST
// inside the webhook response path. That fetch had no timeout and no
// AbortController, and Node's fetch waits up to 300 SECONDS by default. The POST
// stalled, the webhook blew its 20s budget, Vapi injected "Your server rejected
// `tool-calls` webhook. Error: timeout of 20000ms exceeded", the model retried
// the identical call, and the same thing happened again.
//
// ============================================================================
// THE CATEGORY, NOT THE INCIDENT
// ============================================================================
// Per feedback_frugal_regression_tests.md the lesson is encoded as the category:
// no unbounded network I/O may be awaited inside the webhook budget. The
// 2026-07-01 news-reader lesson already learned that mid-call controlUrl `say`
// is fragile and moved news to model-spoken text, but it was recorded as a
// news-reader special case, so check_spine kept the fragile pattern and died the
// same way. This module makes the bound structural rather than remembered:
// every controlUrl POST in the codebase routes through here, and a source-pin
// test forbids a raw fetch(controlUrl) anywhere else.
//
// ============================================================================
// CONTRACT
// ============================================================================
// postControlUrl NEVER throws and NEVER hangs. It always resolves to a plain
// result object, so a caller inside the webhook can await it without a
// try/catch and still be guaranteed to answer Vapi in time. A control POST is a
// courtesy: it is never worth spending the budget the spoken answer needs.

const DEFAULT_CONTROL_TIMEOUT_MS = 2500;

/**
 * POST a control payload to a Vapi per-call controlUrl, bounded by a hard
 * deadline.
 *
 * @param {string} controlUrl  Vapi's per-call control endpoint. Empty/missing is
 *                             a normal no-op (synthetic probe calls have none).
 * @param {object} payload     e.g. {type:'say', content:'...'}
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=2500]  hard deadline, well inside Vapi's 20s.
 * @param {function} [opts.fetchImpl]     injectable for tests.
 * @returns {Promise<{ok:boolean, status:number|null, timedOut:boolean,
 *                    skipped?:boolean, error?:string, elapsedMs:number}>}
 */
async function postControlUrl(controlUrl, payload, opts = {}) {
  const started = Date.now();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_CONTROL_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;

  if (!controlUrl || typeof controlUrl !== 'string') {
    // Not an error. A synthetic or probe call registers with an empty
    // controlUrl and there is simply nothing to talk to.
    return { ok: false, status: null, timedOut: false, skipped: true, elapsedMs: 0 };
  }

  const controller = new AbortController();
  // The whole point: this timer fires regardless of socket activity, so a server
  // that accepts the POST and then goes quiet forever cannot outlive the budget.
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(controlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload == null ? {} : payload),
      signal: controller.signal,
    });
    return {
      ok: Boolean(res && res.ok),
      status: res ? res.status : null,
      timedOut: false,
      elapsedMs: Date.now() - started,
    };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return {
      ok: false,
      status: null,
      timedOut: Boolean(aborted),
      error: String((e && e.message) || e).slice(0, 200),
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { postControlUrl, DEFAULT_CONTROL_TIMEOUT_MS };
