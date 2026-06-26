'use strict';

const RAW_OBJECT_PATTERN = /\[object Object\]|\bObject object\b/i;
const BANNED_LIVE_STATUS_TAIL_RE =
  /\b(?:if you need (?:anything else|more details|further action)[^.?!]*|let me know(?:[^.?!]*)?|just let me know(?:[^.?!]*)?|if there'?s a specific action[^.?!]*|if you'd like me to[^.?!]*|if you need to start or continue work[^.?!]*|want to start something new[^.?!]*|start something new[^.?!]*|investigate further[^.?!]*|please let me know[^.?!]*)[.?!]?/gi;

function compact(text) {
  return String(text || '')
    .replace(RAW_OBJECT_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLiveSpeechArtifacts(text) {
  return compact(
    String(text || '')
      .replace(/```[a-z0-9_-]*\s*/gi, ' ')
      .replace(/```/g, ' ')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/(^|\n)\s*(?:={3,}|-{3,}|_{3,}|\*{3,}|#{3,})\s*(?=\n|$)/g, '\n')
      .replace(/[=*_~#]{3,}/g, ' ')
      .replace(/\b(?:equal sign|equals sign)(?:\s+(?:equal sign|equals sign)){1,}\b/gi, ' ')
      .replace(/\b(?:open|close) code fence\b/gi, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/`/g, ''),
  );
}

function removeBannedLiveStatusTails(text) {
  return compact(String(text || '').replace(BANNED_LIVE_STATUS_TAIL_RE, ''));
}

function limitSentences(text, maxSentences = 0) {
  const cleaned = compact(text);
  if (!maxSentences || maxSentences < 1) return cleaned;
  const pieces = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  if (pieces.length <= maxSentences) return cleaned;
  return compact(pieces.slice(0, maxSentences).join(' '));
}

function bestTextField(obj) {
  for (const key of ['summary', 'message', 'result', 'text', 'answer', 'detail', 'error']) {
    const value = obj && obj[key];
    if (typeof value === 'string') {
      const cleaned = compact(value);
      if (cleaned) return cleaned;
    }
  }
  return '';
}

function formatToolResultForVoice(rawResult, { toolName = 'tool', maxChars = 400, maxSentences = 0 } = {}) {
  let text = '';

  if (rawResult == null) {
    text = '';
  } else if (typeof rawResult === 'string') {
    text = compact(rawResult);
  } else if (typeof rawResult === 'number' || typeof rawResult === 'boolean') {
    text = String(rawResult);
  } else if (typeof rawResult === 'object') {
    text = bestTextField(rawResult);
    if (!text && rawResult.effect_kind) {
      const status = compact(rawResult.status || 'done');
      text = `${rawResult.effect_kind} ${status}.`;
    }
    if (!text && rawResult.ok === true) {
      text = `${toolName} succeeded.`;
    }
    if (!text) {
      text = 'I have the result, but it needs a readable summary before I say it out loud.';
    }
  } else {
    text = compact(rawResult);
  }

  text = stripLiveSpeechArtifacts(removeBannedLiveStatusTails(text));
  text = limitSentences(text, maxSentences);
  if (!text) return '';
  return text.slice(0, maxChars).trim();
}

module.exports = {
  formatToolResultForVoice,
  stripLiveSpeechArtifacts,
  removeBannedLiveStatusTails,
  limitSentences,
  RAW_OBJECT_PATTERN,
};
