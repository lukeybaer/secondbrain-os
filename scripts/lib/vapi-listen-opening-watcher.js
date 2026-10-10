// vapi-listen-opening-watcher.js
//
// How people answer a phone: the callee speaks first ("Hello, this is Sam").
// Amy's third-party outbound calls listen from the moment the call connects
// and answer that greeting. If the line stays silent, Amy checks for a listener
// once with "Hello?" and then waits for the answer before her opening.
//
// The silence check must cover ONLY the opening. Vapi's customer.speech.timeout
// hook stays armed for the whole call and would say "Hello?" into a later hold
// or a pause while the callee checks a quote (Codex review, 2026-10-05). This
// watcher runs on the EC2 webhook instead: it arms when the call goes
// in-progress, disarms forever on the first sign of callee speech, and fires
// at most once through the bounded controlUrl helper.
//
// Calls opt in with metadata.amyListenOpening === true (the outbound broker's
// listen opening and the self-test's listen mode). Every other call is ignored.

const LISTEN_OPENING_SILENCE_MS = 3000;
const LISTEN_OPENING_LINE = 'Hello?';
const STATE_TTL_MS = 60 * 60 * 1000;
const MAX_HELLO_ATTEMPTS = 2;
const HELLO_RETRY_MS = 1000;

function isListenOpeningCall(call) {
  const flag = call && call.metadata && call.metadata.amyListenOpening;
  return flag === true || flag === 'true';
}

function isCalleeRole(msg) {
  const role = String((msg && msg.role) || '').toLowerCase();
  return role === 'user' || role === 'customer';
}

// Transcribed callee words settle the opening for good.
function isCalleeWords(msg) {
  return (
    isCalleeRole(msg) &&
    String((msg && msg.type) || '').startsWith('transcript') &&
    String(msg.transcript || '').trim().length > 0
  );
}

// Voice activity alone pauses the timer while the callee talks; a line click
// or background noise with no words must not leave the call in dead air.
function calleeVoiceActivity(msg) {
  if (!isCalleeRole(msg) || !msg || msg.type !== 'speech-update') return null;
  return msg.status === 'started' ? 'started' : msg.status === 'stopped' ? 'stopped' : null;
}

function isCallEnd(msg) {
  return msg && (msg.type === 'end-of-call-report' || (msg.type === 'status-update' && msg.status === 'ended'));
}

/**
 * @param {object} deps
 * @param {(controlUrl:string, payload:object) => Promise<object>} deps.post  bounded controlUrl POST
 * @param {number} [deps.silenceMs]
 * @param {Function} [deps.setTimer]
 * @param {Function} [deps.clearTimer]
 * @param {() => number} [deps.now]
 * @param {(event:object) => void} [deps.log]
 */
function createListenOpeningWatcher(deps = {}) {
  const post = deps.post;
  const silenceMs = Number.isFinite(deps.silenceMs) ? deps.silenceMs : LISTEN_OPENING_SILENCE_MS;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const calls = new Map(); // callId -> { timer, settled, at }

  function prune() {
    const cutoff = now() - STATE_TTL_MS;
    for (const [id, state] of calls) {
      if (state.at < cutoff) {
        if (state.timer) clearTimer(state.timer);
        calls.delete(id);
      }
    }
  }

  function settle(id, state, outcome) {
    state.settled = true;
    if (state.timer) clearTimer(state.timer);
    state.timer = null;
    log({ callId: id, outcome });
    return outcome;
  }

  // Returns a short outcome label for logging and tests, or null when the
  // event does not concern a listen-opening call.
  function observe(msg, call) {
    const id = call && call.id;
    if (!id || !isListenOpeningCall(call)) return null;
    prune();
    let state = calls.get(id);

    if (isCallEnd(msg)) {
      if (state && state.timer) clearTimer(state.timer);
      calls.delete(id);
      return 'ended';
    }

    if (isCalleeWords(msg)) {
      if (!state) {
        calls.set(id, { timer: null, settled: true, at: now() });
        return 'heard';
      }
      return state.settled ? null : settle(id, state, 'heard');
    }

    const activity = calleeVoiceActivity(msg);
    if (activity && state && !state.settled && !state.inFlight) {
      if (state.timer) clearTimer(state.timer);
      state.timer = null;
      // The final transcript often lands after "stopped"; a short re-arm would
      // say Hello? over a greeting whose words have not arrived yet.
      if (activity === 'stopped') arm(id, state, silenceMs);
      return activity === 'started' ? 'paused' : 'rearmed';
    }

    const controlUrl = (call.monitor && call.monitor.controlUrl) || call.controlUrl || '';
    if (state && !state.controlUrl && controlUrl) state.controlUrl = controlUrl;

    if (msg && msg.type === 'status-update' && msg.status === 'in-progress' && !state) {
      state = { timer: null, settled: false, at: now(), controlUrl, attempts: 0 };
      calls.set(id, state);
      arm(id, state, silenceMs);
      return 'armed';
    }
    return null;
  }

  // A missing control URL or a failed say is retried once while the callee is
  // still silent; a silent failure would recreate the dead-air call.
  function arm(id, state, delayMs) {
    state.timer = setTimer(() => {
      state.timer = null;
      if (state.settled) return;
      state.attempts += 1;
      const lastAttempt = state.attempts >= MAX_HELLO_ATTEMPTS;
      const fail = (reason) => {
        if (state.settled) return;
        if (lastAttempt) {
          settle(id, state, 'hello-undelivered');
          log({ callId: id, outcome: 'hello-undelivered', reason, level: 'error' });
        } else {
          arm(id, state, HELLO_RETRY_MS);
        }
      };
      if (!state.controlUrl) return fail('no-control-url');
      state.inFlight = true;
      Promise.resolve(post(state.controlUrl, { type: 'say', content: LISTEN_OPENING_LINE }))
        .then((r) => {
          state.inFlight = false;
          if (r && r.ok) {
            if (!state.settled) settle(id, state, 'hello');
          } else {
            fail('post-not-ok:' + String((r && (r.status || r.error)) || 'unknown'));
          }
        })
        .catch((e) => {
          state.inFlight = false;
          fail('post-threw:' + String(e && e.message));
        });
    }, delayMs);
  }

  return { observe, size: () => calls.size };
}

module.exports = {
  LISTEN_OPENING_SILENCE_MS,
  LISTEN_OPENING_LINE,
  createListenOpeningWatcher,
  isListenOpeningCall,
};
