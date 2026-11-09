'use strict';
// Shared exact matcher, preserving the Claude ESM entrypoint. No runtime memory reads.
const guidance = require('./amy-prompt-guidance');
const FAST_PROMPT_RE = /^\s*(?:#|hashtag\s+)fast\b/i;
function isFastPrompt(text) {
  if (typeof text !== 'string') return false;
  // Normalize exactly one leading presentation escape, never arbitrary text.
  return FAST_PROMPT_RE.test(text.replace(/^(\s*)\\(?=#)/, '$1'));
}
module.exports = { isFastPrompt, FAST_PROMPT_CONTEXT: guidance['fast-context'] };
