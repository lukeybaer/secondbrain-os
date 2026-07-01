'use strict';

// News-reader live playback state machine (pure decision layer).
//
// Owns ONE source of control authority for the in-call briefing news reader:
// continuous auto-play with always-allowed interruptible skip. The caller
// (ec2-server.js webhook) performs the returned EFFECTS (mute / unmute / say);
// this module never touches the network so it can be unit-tested in isolation.
//
// Fixes the 2026-06-30 skip-storm + silent-stop:
//   - conversation-update never drives control (it re-emits the stale rolling
//     user tail, which caused one "Next" to re-fire many times).
//   - control consumes once per user utterance (dedupe identical text until the
//     user speaks again), replacing the old time-only 700ms debounce.
//   - a monotonic article token plus an `interrupted` flag stop a manual skip
//     and an auto-advance from both firing for the same article (no double
//     advance), and stop our own say's barge-in echo from advancing.
//   - reaching the end speaks a terminal line and KEEPS the session
//     controllable (start over / repeat), instead of silently tearing down
//     voice control.
//
// Auto-play trigger: a clean assistant speech-ended event for the live article
// (status 'speaking', not interrupted, not diverted to conversation) advances
// to the next article and speaks it with no user input.

const {
  classifyNewsReaderControl,
  extractLatestUserTextFromVapiMessage,
} = require('./vapi-news-control');
const { handleBriefingNewsReader } = require('./briefing-news-reader');

const TERMINAL_SPEECH =
  "That's the end of the news. Say start over to hear it again, or ask me anything.";

const STATE_TTL_MS = 2 * 60 * 60 * 1000;

const states = new Map(); // callId -> state

function nowMs() {
  return Date.now();
}

function callKey(callObj) {
  return String((callObj && callObj.id) || 'manual');
}

function touch(state) {
  if (state) state.updatedAtMs = nowMs();
}

function cleanup(nowTs = nowMs()) {
  for (const [key, state] of states.entries()) {
    if (!state || nowTs - Number(state.updatedAtMs || 0) > STATE_TTL_MS) states.delete(key);
  }
}

function isNewsReaderLive(callId) {
  if (!callId) return false;
  const state = states.get(String(callId));
  if (!state) return false;
  if (nowMs() - Number(state.updatedAtMs || 0) > STATE_TTL_MS) {
    states.delete(String(callId));
    return false;
  }
  return true;
}

function getNewsReaderPlaybackState(callId) {
  return states.get(String(callId)) || null;
}

function clearNewsReaderPlayback(callId) {
  if (callId) states.delete(String(callId));
}

function resetNewsReaderPlaybackStates() {
  states.clear();
}

// A start text that is actually an error reason from the reader, not an article.
function isErrorReason(text) {
  return /^No briefing/i.test(String(text || ''));
}

function isEndSpeech(text) {
  return /^End of briefing news/i.test(String(text || ''));
}

const EVENT_ROLE = (msg) => String((msg && msg.role) || '').toLowerCase();
const EVENT_STATUS = (msg) => String((msg && msg.status) || '').toLowerCase();
const EVENT_TYPE = (msg) => String((msg && msg.type) || '');

function isUserFinalTranscript(msg) {
  if (EVENT_TYPE(msg) !== 'transcript') return false;
  if (EVENT_ROLE(msg) !== 'user') return false;
  const tt = String((msg && msg.transcriptType) || '').toLowerCase();
  // When Vapi labels finality, require final. When it is absent, accept it
  // (some transcript payloads omit the field) but conversation-update is still
  // excluded entirely below, which is the real stale-tail source.
  return tt === '' || tt === 'final';
}

function isAssistantSpeechStarted(msg) {
  if (EVENT_TYPE(msg) === 'assistant.speechStarted') return true;
  return (
    EVENT_TYPE(msg) === 'speech-update' &&
    EVENT_ROLE(msg) === 'assistant' &&
    EVENT_STATUS(msg) === 'started'
  );
}

function isAssistantSpeechEnded(msg) {
  return (
    EVENT_TYPE(msg) === 'speech-update' &&
    EVENT_ROLE(msg) === 'assistant' &&
    (EVENT_STATUS(msg) === 'stopped' || EVENT_STATUS(msg) === 'ended')
  );
}

function isUserSpeechStarted(msg) {
  return (
    EVENT_TYPE(msg) === 'speech-update' &&
    EVENT_ROLE(msg) === 'user' &&
    EVENT_STATUS(msg) === 'started'
  );
}

function mapControlToReaderAction(control) {
  switch (control) {
    case 'next_section':
      return 'next_section';
    case 'restart':
      return 'restart';
    case 'previous':
      return 'previous';
    case 'repeat':
      return 'current';
    case 'next_article':
    default:
      return 'next_article';
  }
}

// Build the "speak this next" effect set from a reader result.
function speakResult(state, result, { mute = false } = {}) {
  const effects = [];
  if (mute) {
    effects.push({ type: 'mute' });
    effects.push({ type: 'unmute' });
  }
  if (isEndSpeech(result)) {
    state.status = 'ended';
    effects.push({ type: 'say', text: TERMINAL_SPEECH, source: 'terminal' });
  } else {
    state.status = 'advancing';
    state.token += 1;
    effects.push({ type: 'say', text: result, source: 'news' });
  }
  touch(state);
  return effects;
}

// Register a fresh reader session for a call and return the opening article text
// for the caller to speak. Does not itself emit a say effect (the tool path
// speaks the start text), but it arms the playback state so auto-advance and
// server-side skip take over from there.
function startNewsReaderPlayback(callObj, opts = {}, startParams = {}) {
  cleanup();
  const key = callKey(callObj);
  const text = handleBriefingNewsReader(
    { action: 'start', date: startParams.date, reload: startParams.reload },
    callObj,
    opts,
  );
  if (isErrorReason(text)) {
    states.delete(key);
    return { ok: false, text };
  }
  states.set(key, {
    token: 1,
    status: 'advancing', // waiting for assistant.speechStarted on the opening article
    interrupted: false,
    awaitingCleanEnd: false, // armed by speechStarted; only the first end advances
    userSpokeNew: true, // opening article is a fresh turn; the first control is allowed
    divertedToConversation: false,
    updatedAtMs: nowMs(),
  });
  return { ok: true, text };
}

// Single entry point the webhook calls for every Vapi event. Returns
// { handled, effects }. handled=true means the webhook should treat the event
// as fully owned by the news reader (do not also let the model act on it).
function handleNewsReaderVapiEvent(msg, callObj, opts = {}) {
  const callId = callKey(callObj);
  const state = states.get(callId);
  if (!state) return { handled: false, effects: [] };
  if (nowMs() - Number(state.updatedAtMs || 0) > STATE_TTL_MS) {
    states.delete(callId);
    return { handled: false, effects: [] };
  }

  const type = EVENT_TYPE(msg);

  // STARVATION GATE: only live-control event types are owned here. tool-calls,
  // assistant-request, end-of-call-report, status-update etc must fall through
  // so a control classification can never swallow a real tool-call delivery.
  const OWNED = new Set([
    'transcript',
    'conversation-update',
    'speech-update',
    'assistant.speechStarted',
    'user-interrupted',
  ]);
  if (!OWNED.has(type)) return { handled: false, effects: [] };

  // conversation-update never drives control (stale rolling tail). Ignore it
  // outright for playback, but do not claim it so other handlers still run.
  if (type === 'conversation-update') return { handled: false, effects: [] };

  if (type === 'user-interrupted') {
    state.interrupted = true;
    touch(state);
    return { handled: true, effects: [{ type: 'mute' }] };
  }

  if (isUserSpeechStarted(msg)) {
    state.userSpokeNew = true;
    touch(state);
    return { handled: false, effects: [] };
  }

  if (isAssistantSpeechStarted(msg)) {
    if (state.status === 'advancing') state.status = 'speaking';
    state.interrupted = false;
    // A cut article's stale speech-ended events can be MULTIPLE (a 'stopped'
    // plus an 'ended', or an interruption-stop plus a buffer-flush stop). Arm
    // exactly ONE clean end per speechStarted: the first speech-ended after
    // this start is the live article's completion; any further ends for the
    // same segment are stale and ignored, no matter how many the cut emitted.
    state.awaitingCleanEnd = true;
    // The news article is speaking again, so any prior conversational diversion
    // is over -- re-enable auto-advance for this segment.
    state.divertedToConversation = false;
    touch(state);
    return { handled: false, effects: [] };
  }

  if (isAssistantSpeechEnded(msg)) {
    // Only the FIRST speech-ended after a speechStarted can advance. Everything
    // else (a cut article's extra flush end, a duplicate end, an end with no
    // live segment) is stale and ignored. This is identity-based, not a fixed
    // count, so a cut emitting any number of ends cannot double-advance.
    if (!state.awaitingCleanEnd) {
      touch(state);
      return { handled: false, effects: [] };
    }
    state.awaitingCleanEnd = false;
    // Auto-play: advance only on a CLEAN completion of the live article.
    if (state.status === 'speaking' && !state.interrupted && !state.divertedToConversation) {
      const result = handleBriefingNewsReader({ action: 'next_article' }, callObj, opts);
      const effects = speakResult(state, result);
      return { handled: true, effects };
    }
    // Interrupted / superseded / diverted stop: never auto-advance.
    return { handled: false, effects: [] };
  }

  if (isUserFinalTranscript(msg)) {
    const text = extractLatestUserTextFromVapiMessage(msg);
    const control = classifyNewsReaderControl(text);

    if (!control) {
      // Real conversation, not a control. Let the model handle it; if we had
      // muted on a prior barge, resume by unmuting.
      state.divertedToConversation = true;
      const effects = [];
      if (state.interrupted) {
        state.interrupted = false;
        effects.push({ type: 'unmute' });
      }
      touch(state);
      return { handled: effects.length > 0, effects };
    }

    // Consume-once per user speech turn: after we act on one control, ignore
    // EVERY further control -- identical, punctuation/ASR variant, or even a
    // different command -- until the user actually speaks again (a fresh user
    // speech-started event sets userSpokeNew). This is what kills the skip-storm:
    // Vapi re-emitting the same "next" utterance across many events can only
    // advance the cursor once per real spoken turn.
    if (!state.userSpokeNew) {
      touch(state);
      return { handled: true, effects: [] };
    }
    state.userSpokeNew = false;
    state.divertedToConversation = false;

    if (control === 'stop') {
      clearNewsReaderPlayback(callId);
      return { handled: true, effects: [{ type: 'mute' }, { type: 'unmute' }] };
    }

    // Manual skip / section / previous / restart / repeat: cut current speech,
    // advance, speak the new article. Disarming awaitingCleanEnd here means the
    // replaced (cut) article's speech-ended events are all stale and ignored;
    // only the NEW article's own speechStarted re-arms a clean end.
    state.interrupted = true;
    state.awaitingCleanEnd = false;
    const result = handleBriefingNewsReader(
      { action: mapControlToReaderAction(control) },
      callObj,
      opts,
    );
    const effects = speakResult(state, result, { mute: true });
    return { handled: true, effects };
  }

  return { handled: false, effects: [] };
}

module.exports = {
  TERMINAL_SPEECH,
  startNewsReaderPlayback,
  handleNewsReaderVapiEvent,
  isNewsReaderLive,
  getNewsReaderPlaybackState,
  clearNewsReaderPlayback,
  resetNewsReaderPlaybackStates,
};
