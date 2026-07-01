'use strict';

function compactText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function openAiContentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      if (part && typeof part.content === 'string') return part.content;
      return '';
    })
    .filter(Boolean)
    .join(' ');
}

function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  return compactText(
    message.transcript ||
      message.originalTranscript ||
      message.message ||
      message.text ||
      openAiContentToText(message.content),
  );
}

function extractLatestUserTextFromVapiMessage(msg = {}) {
  if (!msg || typeof msg !== 'object') return '';
  const type = String(msg.type || '');
  if (/^transcript(?:\[|$)/.test(type) && String(msg.role || '').toLowerCase() === 'user') {
    return messageText(msg);
  }

  const messageSets = [msg.messages, msg.messagesOpenAIFormatted].filter(Array.isArray);
  for (const messages of messageSets) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const item = messages[i] || {};
      const role = String(item.role || '').toLowerCase();
      if (role !== 'user') continue;
      const text = messageText(item);
      if (text) return text;
    }
  }
  return '';
}

function classifyNewsReaderControl(text) {
  const value = compactText(text).toLowerCase();
  if (!value) return '';
  if (
    /^(?:stop|pause|done|cancel|end)(?:\s+(?:news|reader|reading|the news))?[.!?]*$/.test(value)
  ) {
    return 'stop';
  }
  if (
    /\b(?:skip|next|advance|jump)\s+(?:the\s+)?(?:section|category|topic)\b/.test(value) ||
    /\b(?:skip|next)[-\s]?section\b/.test(value)
  ) {
    return 'next_section';
  }
  if (
    /^(?:amy\s+)?(?:please\s+)?(?:skip|next)(?:\s+(?:please|this|that|one|article|headline|story))?[.!?]*$/.test(
      value,
    ) ||
    /\b(?:skip|next)\s+(?:this|that|one|article|headline|story)\b/.test(value)
  ) {
    return 'next_article';
  }
  if (
    /^(?:amy\s+)?(?:please\s+)?(?:start over|start from the (?:beginning|top)|restart|begin again)[.!?]*$/.test(
      value,
    ) ||
    /\b(?:start over|start from the (?:beginning|top)|from the (?:beginning|top)|restart)\b/.test(
      value,
    )
  ) {
    return 'restart';
  }
  if (
    /^(?:amy\s+)?(?:please\s+)?(?:go back|back|previous|last one|the one before)[.!?]*$/.test(
      value,
    ) ||
    /\b(?:go back|previous(?:\s+(?:one|article|headline|story))?|the (?:last|previous)\s+(?:one|article|headline|story))\b/.test(
      value,
    )
  ) {
    return 'previous';
  }
  if (
    /^(?:amy\s+)?(?:please\s+)?(?:repeat|repeat that|again|say (?:that|it) again|read (?:that|it) again|one more time)[.!?]*$/.test(
      value,
    )
  ) {
    return 'repeat';
  }
  return '';
}

module.exports = {
  classifyNewsReaderControl,
  extractLatestUserTextFromVapiMessage,
};
