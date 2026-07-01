'use strict';

const AUTO_CONTINUE_PROMPT =
  'NEWS_READER_AUTO_CONTINUE: Call read_briefing_news with action=next_article now. ' +
  'Then speak only the returned text verbatim. If the tool result is empty, say nothing.';

const STATE_TTL_MS = 2 * 60 * 60 * 1000;

const states = new Map(); // callId -> model-spoken news reader state

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

function getState(callId) {
  if (!callId) return null;
  cleanup();
  return states.get(String(callId)) || null;
}

function isNewsReaderModelLive(callId) {
  return !!getState(callId);
}

function clearNewsReaderModelPlayback(callId) {
  if (callId) states.delete(String(callId));
}

function resetNewsReaderModelPlaybackStates() {
  states.clear();
}

function normalizeAction(params = {}) {
  const raw = String(params.action || params.command || params.intent || 'start')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .trim();
  if (['skip_section', 'next_section', 'section'].includes(raw)) return 'next_section';
  if (['skip', 'next', 'next_article', 'article'].includes(raw)) return 'next_article';
  if (['previous', 'previous_article', 'back', 'go_back', 'last'].includes(raw)) return 'previous';
  if (['restart', 'start_over', 'startover', 'beginning', 'from_the_beginning'].includes(raw)) {
    return 'restart';
  }
  if (['repeat', 'current', 'again'].includes(raw)) return 'current';
  if (['stop', 'end', 'cancel'].includes(raw)) return 'stop';
  return 'start';
}

function isTerminalResult(text) {
  return /^End of briefing news\./i.test(String(text || ''));
}

function isStopResult(text) {
  return /^Done\.$/i.test(String(text || '').trim());
}

function isSpeakableArticle(text) {
  const value = String(text || '').trim();
  return !!value && !isStopResult(value) && !isTerminalResult(value) && !/^No briefing/i.test(value);
}

function ensureState(callObj) {
  const key = callKey(callObj);
  let state = states.get(key);
  if (!state) {
    state = {
      token: 0,
      status: 'idle',
      awaitingCleanEnd: false,
      interrupted: false,
      userTurnSeq: 0,
      consumedUserTurnSeq: 0,
      autoAdvanceToken: 0,
      autoAdvanceConsumedToken: 0,
      updatedAtMs: nowMs(),
    };
    states.set(key, state);
  }
  return state;
}

function prepareNewsReaderToolCall(callObj, params = {}) {
  cleanup();
  const callId = callKey(callObj);
  const action = normalizeAction(params);
  const state = states.get(callId);

  if (action === 'stop') return { shouldRun: true, action };

  if (action === 'start') {
    if (state && params.reload !== true) {
      touch(state);
      return { shouldRun: false, action, reason: 'duplicate_start' };
    }
    return { shouldRun: true, action };
  }

  if (!state) return { shouldRun: false, action, reason: 'not_live' };

  if (state.userTurnSeq > state.consumedUserTurnSeq) {
    state.consumedUserTurnSeq = state.userTurnSeq;
    state.autoAdvanceToken = 0;
    touch(state);
    return { shouldRun: true, action };
  }

  if (
    action === 'next_article' &&
    state.autoAdvanceToken > 0 &&
    state.autoAdvanceConsumedToken !== state.autoAdvanceToken
  ) {
    state.autoAdvanceConsumedToken = state.autoAdvanceToken;
    state.autoAdvanceToken = 0;
    touch(state);
    return { shouldRun: true, action };
  }

  touch(state);
  return { shouldRun: false, action, reason: 'duplicate_or_stale_navigation' };
}

function noteNewsReaderToolResult(callObj, params = {}, result = '') {
  cleanup();
  const callId = callKey(callObj);
  const action = normalizeAction(params);
  const text = String(result || '').trim();

  if (!text) return;
  if (action === 'stop' || isStopResult(text)) {
    states.delete(callId);
    return;
  }

  const state = ensureState(callObj);
  if (isTerminalResult(text)) {
    state.status = 'ended';
    state.awaitingCleanEnd = false;
    state.interrupted = false;
    state.autoAdvanceToken = 0;
    touch(state);
    return;
  }

  if (isSpeakableArticle(text)) {
    state.token += 1;
    state.status = 'armed';
    state.awaitingCleanEnd = false;
    state.interrupted = false;
    state.autoAdvanceToken = 0;
    touch(state);
  }
}

const EVENT_ROLE = (msg) => String((msg && msg.role) || '').toLowerCase();
const EVENT_STATUS = (msg) => String((msg && msg.status) || '').toLowerCase();
const EVENT_TYPE = (msg) => String((msg && msg.type) || '');

function isTranscriptEvent(msg) {
  return /^transcript(?:\[|$)/.test(EVENT_TYPE(msg));
}

function isUserFinalTranscript(msg) {
  if (!isTranscriptEvent(msg)) return false;
  if (EVENT_ROLE(msg) !== 'user') return false;
  const tt = String((msg && msg.transcriptType) || '').toLowerCase();
  return tt === '' || tt === 'final' || /\btranscriptType="final"/.test(EVENT_TYPE(msg));
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

function handleNewsReaderModelEvent(msg, callObj) {
  const state = getState(callKey(callObj));
  if (!state) return { effects: [] };

  const type = EVENT_TYPE(msg);

  if (type === 'user-interrupted') {
    state.userTurnSeq += 1;
    state.interrupted = true;
    state.awaitingCleanEnd = false;
    state.status = 'interrupted';
    state.autoAdvanceToken = 0;
    touch(state);
    return { effects: [] };
  }

  if (isUserFinalTranscript(msg)) {
    state.userTurnSeq += 1;
    state.interrupted = true;
    state.awaitingCleanEnd = false;
    state.status = 'interrupted';
    state.autoAdvanceToken = 0;
    touch(state);
    return { effects: [] };
  }

  if (isAssistantSpeechStarted(msg)) {
    if (state.status === 'armed') {
      state.status = 'speaking';
      state.awaitingCleanEnd = true;
      state.interrupted = false;
    }
    touch(state);
    return { effects: [] };
  }

  if (isAssistantSpeechEnded(msg)) {
    if (state.status === 'speaking' && state.awaitingCleanEnd && !state.interrupted) {
      state.awaitingCleanEnd = false;
      state.status = 'awaiting_auto';
      state.autoAdvanceToken = state.token;
      touch(state);
      return {
        effects: [
          {
            type: 'add-message',
            content: AUTO_CONTINUE_PROMPT,
            triggerResponseEnabled: true,
          },
        ],
      };
    }
    state.awaitingCleanEnd = false;
    touch(state);
    return { effects: [] };
  }

  touch(state);
  return { effects: [] };
}

function getNewsReaderModelPlaybackState(callId) {
  return getState(callId);
}

module.exports = {
  AUTO_CONTINUE_PROMPT,
  prepareNewsReaderToolCall,
  noteNewsReaderToolResult,
  handleNewsReaderModelEvent,
  isNewsReaderModelLive,
  getNewsReaderModelPlaybackState,
  clearNewsReaderModelPlayback,
  resetNewsReaderModelPlaybackStates,
  normalizeAction,
};
