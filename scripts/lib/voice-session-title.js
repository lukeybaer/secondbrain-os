'use strict';

const { speechSafe } = require('./speech-safe');

function compactSessionTitleForVoice(value, max = 160) {
  let title = speechSafe(String(value || ''))
    .replace(/^codex thread:\s*/i, '')
    .replace(/^claude(?: code)? session:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const automation = title.match(/^Automation:\s*(.+?)\s+Automation ID:/i);
  if (automation && automation[1]) title = automation[1].trim();
  if (/^You are Amy doing self-heal\.?\s+ONE failing test file to clear\.?$/i.test(title)) {
    title = 'Self-heal failing test repair';
  }
  return title.slice(0, max).trim();
}

module.exports = {
  compactSessionTitleForVoice,
};
