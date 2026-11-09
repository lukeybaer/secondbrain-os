'use strict';

// Owner decision: any caller, a stranger included, may hear a
// short hold on a slow turn, but it has to sound like conversation. It never
// covers two turns in a row and the words rotate. Each phrase stays true before
// any turn, lookup or not, so it never misdescribes the work. The trailing space
// keeps the hold and the answer as two spoken sentences.
const HOLD_PHRASES = ['One sec. ', 'Just a moment. ', 'One moment. '];

function holdPhraseFor(openaiBody) {
  const spoken = (Array.isArray(openaiBody?.messages) ? openaiBody.messages : [])
    .filter((message) => message?.role === 'assistant')
    .map((message) => (typeof message.content === 'string' ? message.content.trim() : ''))
    // A tool-call turn says nothing aloud, so it is not a spoken turn.
    .filter(Boolean);
  const holdIndex = (text) => HOLD_PHRASES.findIndex((phrase) => text.startsWith(phrase.trim()));
  if (spoken.slice(-2).some((text) => holdIndex(text) >= 0)) return null;
  // The next hold is the phrase after the last one said on this call.
  const last = [...spoken].reverse().map(holdIndex).find((index) => index >= 0);
  return HOLD_PHRASES[last == null ? 0 : (last + 1) % HOLD_PHRASES.length];
}

module.exports = { HOLD_PHRASES, holdPhraseFor };
