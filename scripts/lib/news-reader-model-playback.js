'use strict';

const AUTO_CONTINUE_PROMPT =
  'NEWS_READER_AUTO_CONTINUE: Call read_briefing_news with action=next_article now. ' +
  'Then speak only the returned text verbatim. If the tool result is empty, say nothing.';
const RESUME_PROMPT =
  'NEWS_READER_RESUME: The interruption has been answered. Call read_briefing_news with ' +
  'action=next_article now, then speak only the returned text verbatim. If the tool result is ' +
  'empty, say nothing.';

const STATE_TTL_MS = 2 * 60 * 60 * 1000;
const AUTO_CONTINUE_GRACE_MS = 650;

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
  if (['save', 'save_current', 'save_article', 'bookmark', 'bookmark_current'].includes(raw)) {
    return 'save_current';
  }
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
      scheduleSeq: 0,
      pendingScheduleToken: 0,
      pendingScheduleKind: '',
      userTurnOpen: false,
      interactionPending: false,
      sideToolDepth: 0,
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
    if (state && state.status !== 'ended' && params.reload !== true) {
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
    state.pendingScheduleToken = 0;
    touch(state);
    return;
  }

  if (action === 'save_current') {
    state.status = 'ack_armed';
    state.awaitingCleanEnd = false;
    state.interrupted = false;
    state.autoAdvanceToken = 0;
    state.pendingScheduleToken = 0;
    state.interactionPending = true;
    touch(state);
    return;
  }

  if (isSpeakableArticle(text)) {
    state.token += 1;
    state.status = 'armed';
    state.awaitingCleanEnd = false;
    state.interrupted = false;
    state.autoAdvanceToken = 0;
    state.pendingScheduleToken = 0;
    state.pendingScheduleKind = '';
    state.userTurnOpen = false;
    state.interactionPending = false;
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

function isUserSpeechStarted(msg) {
  return (
    EVENT_TYPE(msg) === 'speech-update' &&
    EVENT_ROLE(msg) === 'user' &&
    EVENT_STATUS(msg) === 'started'
  );
}

function cancelScheduledAdvance(state) {
  state.pendingScheduleToken = 0;
  state.pendingScheduleKind = '';
  state.autoAdvanceToken = 0;
}

function noteUserTurn(state) {
  if (!state.userTurnOpen) {
    state.userTurnSeq += 1;
    state.userTurnOpen = true;
  }
  state.interrupted = true;
  state.awaitingCleanEnd = false;
  state.status = 'interrupted';
  state.interactionPending = true;
  cancelScheduledAdvance(state);
  touch(state);
}

function scheduleAdvance(state, kind) {
  state.scheduleSeq += 1;
  state.pendingScheduleToken = state.scheduleSeq;
  state.pendingScheduleKind = kind;
  state.status = kind === 'resume' ? 'awaiting_resume_grace' : 'awaiting_auto_grace';
  touch(state);
  return {
    type: 'schedule-add-message',
    delayMs: AUTO_CONTINUE_GRACE_MS,
    token: state.pendingScheduleToken,
    content: kind === 'resume' ? RESUME_PROMPT : AUTO_CONTINUE_PROMPT,
    triggerResponseEnabled: true,
  };
}

function consumeScheduledNewsReaderEffect(callId, token) {
  const state = getState(callId);
  const requested = Number(token || 0);
  if (!state || !requested || state.pendingScheduleToken !== requested) return null;

  const kind = state.pendingScheduleKind;
  if (!['auto', 'resume'].includes(kind)) return null;

  state.pendingScheduleToken = 0;
  state.pendingScheduleKind = '';
  state.autoAdvanceToken = requested;
  state.interactionPending = false;
  state.userTurnOpen = false;
  state.status = 'awaiting_auto';
  touch(state);
  return {
    type: 'add-message',
    content: kind === 'resume' ? RESUME_PROMPT : AUTO_CONTINUE_PROMPT,
    triggerResponseEnabled: true,
  };
}

function noteNewsReaderSideToolStarted(callObj, toolName = '') {
  const state = getState(callKey(callObj));
  if (!state || String(toolName) === 'read_briefing_news') return;
  state.sideToolDepth += 1;
  state.status = 'tool_pending';
  state.interactionPending = true;
  cancelScheduledAdvance(state);
  touch(state);
}

function noteNewsReaderSideToolFinished(callObj, toolName = '') {
  const state = getState(callKey(callObj));
  if (!state || String(toolName) === 'read_briefing_news') return;
  state.sideToolDepth = Math.max(0, state.sideToolDepth - 1);
  state.status = state.sideToolDepth > 0 ? 'tool_pending' : 'interaction_result';
  state.interactionPending = true;
  touch(state);
}

function handleNewsReaderModelEvent(msg, callObj) {
  const state = getState(callKey(callObj));
  if (!state) return { effects: [] };

  const type = EVENT_TYPE(msg);

  if (type === 'user-interrupted' || isUserSpeechStarted(msg) || isUserFinalTranscript(msg)) {
    noteUserTurn(state);
    return { effects: [] };
  }

  if (isAssistantSpeechStarted(msg)) {
    if (state.status === 'armed') {
      state.status = 'speaking';
      state.awaitingCleanEnd = true;
      state.interrupted = false;
    } else if (state.sideToolDepth > 0) {
      state.status = 'tool_pending';
      state.awaitingCleanEnd = false;
    } else if (state.interactionPending) {
      cancelScheduledAdvance(state);
      state.status = 'replying';
      state.awaitingCleanEnd = true;
    }
    touch(state);
    return { effects: [] };
  }

  if (isAssistantSpeechEnded(msg)) {
    if (state.status === 'speaking' && state.awaitingCleanEnd && !state.interrupted) {
      state.awaitingCleanEnd = false;
      return { effects: [scheduleAdvance(state, 'auto')] };
    }
    if (
      state.status === 'replying' &&
      state.awaitingCleanEnd &&
      state.interactionPending &&
      state.sideToolDepth === 0
    ) {
      state.awaitingCleanEnd = false;
      state.userTurnOpen = false;
      return { effects: [scheduleAdvance(state, 'resume')] };
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
  RESUME_PROMPT,
  AUTO_CONTINUE_GRACE_MS,
  prepareNewsReaderToolCall,
  noteNewsReaderToolResult,
  noteNewsReaderSideToolStarted,
  noteNewsReaderSideToolFinished,
  handleNewsReaderModelEvent,
  consumeScheduledNewsReaderEffect,
  isNewsReaderModelLive,
  getNewsReaderModelPlaybackState,
  clearNewsReaderModelPlayback,
  resetNewsReaderModelPlaybackStates,
  normalizeAction,
};
