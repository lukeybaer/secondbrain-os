'use strict';

const RAW_OBJECT_PATTERN = /\[object Object\]|\bObject object\b/i;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const UUID_TEST_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const LONG_HEX_PATTERN = /\b[0-9a-f]{16,}\b/gi;
const INTERNAL_ID_PATTERN =
  /\b(?:codex-thread|spine-session|self_test_seed|call|vapi)[-_][a-z0-9][a-z0-9._-]{8,}\b/gi;
const RAW_ID_SENTENCE_PATTERN =
  /\b(?:Amy Call|Vapi Call|call id|call record|codex-thread-|spine-session-|self_test_seed|019[a-f0-9])\b/i;
const BANNED_LIVE_STATUS_TAIL_RE =
  /\b(?:if you need (?:anything else|more details|further action)[^.?!]*|let me know(?:[^.?!]*)?|just let me know(?:[^.?!]*)?|if there'?s a specific action[^.?!]*|if you'd like me to[^.?!]*|if you need to start or continue work[^.?!]*|want to start something new[^.?!]*|start something new[^.?!]*|investigate further[^.?!]*|please let me know[^.?!]*)[.?!]?/gi;

function compact(text) {
  return String(text || '')
    .replace(RAW_OBJECT_PATTERN, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

function collapseSpacedDigitRuns(text) {
  return String(text || '').replace(/\b(?:\d\s+){2,}\d\b/g, (match) => match.replace(/\s+/g, ''));
}

function normalizeExampleCoVoiceAliases(text) {
  return String(text || '')
    .replace(/\bpig\s+seed\b/gi, 'ExampleCo')
    .replace(/\bpig\s+seat\b/gi, 'ExampleCo')
    .replace(/\bpigsyet\b/gi, 'ExampleCo')
    .replace(/\bPix\s*Seat\b/gi, 'ExampleCo')
    .replace(/\bP(?:I?CC|IC|CC)(?:'s)?\s+seat\b/gi, 'ExampleCo')
    .replace(/\bP(?:I?CC|IC|CC)(?:'s)?(?=\s+(?:scale|scale-up|up readiness|large-scale))\b/gi, 'ExampleCo')
    .replace(/\bExampleCo\s+seat\b/gi, 'ExampleCo')
    .replace(/\bExampleCo\b/g, 'the deployment')
    .replace(/\bthe deployment\s+seat\b/gi, 'the deployment');
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

function replaceScaleResultPhrases(text) {
  return normalizeExampleCoVoiceAliases(collapseSpacedDigitRuns(text))
    .replace(/\bthe deployment\.\s+Large scale\b/gi, 'the deployment large-scale')
    .replace(/\b7\s*k\s+scale[- ]?up\s+test\s+completed\b/gi, 'large-scale test completed')
    .replace(/\b7\s*k\s+scale[- ]?up\b/gi, 'large-scale')
    .replace(
      /\b7000\s+launched[,.]?\s*7000\s+completed[,.]?\s*0\s+failed[,.]?\s*7000\s+reached\s+playback\b/gi,
      'the large-scale playback test completed with no failures',
    )
    .replace(
      /\b7000\s*\/\s*7000\s+completed\s+and\s+reached\s+playback\s+across\s+\d+\s+instances?\b/gi,
      'large-scale playback completed',
    )
    .replace(
      /\b7000\s+(?:of|\/)\s+7000\s+completed(?:\s+and\s+reached\s+playback)?\b/gi,
      'the large-scale playback run completed',
    )
    .replace(
      /\b\d{2,4}\s+and\s+\d{1,4}\.\s*\d{1,4}\s+completed\s+and\s+reached\s+playback\b/gi,
      'large-scale playback completed',
    )
    .replace(/\b\d{2,4}\s+and\s+\d(?:\s+\d){0,3}\.\s*/gi, '')
    .replace(/\b\d{1,4}\s+completed\s+and\s+reached\s+playback\b/gi, '')
    .replace(/\b7000\s+user\s+scale\s+test\s+completed\s+with\s+0\s+failures\s+and\s+reached\s+playback\b/gi, 'large-scale playback test completed with no failures')
    .replace(/\b7000\s+scale\s+up\s+test\s+completed\b/gi, 'large-scale test completed')
    .replace(/\b7\s*k\b/gi, 'large-scale')
    .replace(/\b0\s+failed\b/gi, 'no failures')
    .replace(/\bzero\s+failures\b/gi, 'no failures')
    .replace(/\bno\s+429s?\b/gi, 'no rate-limit errors')
    .replace(/\bno\s+429\s*s\b/gi, 'no rate-limit errors')
    .replace(/\bMP3\b/g, 'audio')
    .replace(/\b5xx\b/gi, 'server-error')
    .replace(/\bno\s+Redis\s+evictions?\b/gi, 'no cache evictions')
    .replace(/\bservices?\s+(?:is\s+)?idle\s+and\s+(?:Redis|read)\s+(?:is\s+|as\s+)?idle\b/gi, 'service and cache are idle')
    .replace(/\b(?:Redis|read)\s+(?:is\s+|as\s+)?idle\b/gi, 'cache is idle')
    .replace(/\bcool\s*down\s+returned\s+to\s+idle\b/gi, 'service is idle')
    .replace(/\bcaveat\s+network\s+timeouts?\s+and\s+server-error\s+need\s+follow-up\b/gi, 'network and server-error caveats remain')
    .replace(/\bnetwork\s+timeouts?\s+and\s+server-error\s+need\s+follow-up\b/gi, 'network and server-error caveats remain')
    .replace(/\bcool\s*down\s+returned\s+ECS\s+to\s+\d+(?:\s+running)?(?:\s+and\s+read\s+as\s+idle)?\b/gi, 'service is idle')
    .replace(/\bacross\s+\d+\s+instances?\b/gi, '')
    .replace(/\b\d{4,}\s+network\s+timeouts?\b/gi, 'network-timeout caveats')
    .replace(/\b\d{3,}\s+server-error\b/gi, 'server-error caveats')
    .replace(/\b\d{5,}\s+requests?\b/gi, 'the request volume');
}

function focusKnownTopic(text) {
  const cleaned = compact(text);
  if (!/\bthe deployment\b/i.test(cleaned)) return cleaned;
  const pieces = cleaned.match(/[^.!?;]+[.!?;]+|[^.!?;]+$/g) || [cleaned];
  const idx = pieces.findIndex((piece) => /\bthe deployment\b/i.test(piece));
  if (idx <= 0) return cleaned;
  return compact([...pieces.slice(idx), ...pieces.slice(0, idx)].join(' '));
}

function stripRawIdentifiers(text) {
  return String(text || '')
    .replace(UUID_PATTERN, ' ')
    .replace(INTERNAL_ID_PATTERN, ' ')
    .replace(LONG_HEX_PATTERN, ' ')
    .replace(/\b[A-Z0-9]{10,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeRawIdentifierSentences(text) {
  const cleaned = compact(text);
  if (!cleaned) return '';
  const pieces = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
  const kept = pieces.filter((piece) => !RAW_ID_SENTENCE_PATTERN.test(piece) && !UUID_TEST_PATTERN.test(piece));
  if (kept.length) return compact(kept.join(' '));
  return stripRawIdentifiers(cleaned);
}

function sanitizeLiveStatusSpeech(text) {
  let out = replaceScaleResultPhrases(String(text || ''));
  out = removeRawIdentifierSentences(out);
  out = stripRawIdentifiers(out)
    .replace(/\bI found \d+ matching spine items? for\b/gi, 'Best match for')
    .replace(/\bI found \d+ active or recent spine items?\b/gi, 'Best active or recent spine item')
    .replace(/\bSource scope:[^.?!]*[.?!]?/gi, '')
    .replace(/\bDetails:\s*/gi, 'Details: ')
    .replace(/\b([A-Za-z0-9_-]+)\.\s+(js|ts|tsx|jsx|json|md|mjs|cjs|py)\b/g, '$1.$2')
    .replace(/\s+([,.!?;:])/g, '$1');
  return focusKnownTopic(out);
}

function removeBannedLiveStatusTails(text) {
  return compact(String(text || '').replace(BANNED_LIVE_STATUS_TAIL_RE, ''));
}

function limitSentences(text, maxSentences = 0) {
  const cleaned = compact(text);
  if (!maxSentences || maxSentences < 1) return cleaned;
  const pieces = cleaned.match(/[^.!?;]+[.!?;]+|[^.!?;]+$/g) || [];
  if (pieces.length <= maxSentences) return cleaned;
  const limited = compact(pieces.slice(0, maxSentences).join(' ')).replace(/[;:]+$/g, '');
  return /[.!?]$/.test(limited) ? limited : limited + '.';
}

function truncateForVoice(text, maxChars = 0) {
  const cleaned = compact(text);
  if (!maxChars || cleaned.length <= maxChars) return cleaned;
  const clipped = compact(cleaned.slice(0, maxChars).replace(/\s+\S*$/, '').replace(/[,:;]+$/, ''));
  if (!clipped) return cleaned.slice(0, maxChars).trim();
  return /[.!?]$/.test(clipped) ? clipped : clipped + '.';
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
  text = sanitizeLiveStatusSpeech(text);
  text = limitSentences(text, maxSentences);
  if (!text) return '';
  return truncateForVoice(text, maxChars);
}

module.exports = {
  formatToolResultForVoice,
  stripLiveSpeechArtifacts,
  sanitizeLiveStatusSpeech,
  removeBannedLiveStatusTails,
  limitSentences,
  truncateForVoice,
  RAW_OBJECT_PATTERN,
};
