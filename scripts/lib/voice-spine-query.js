'use strict';

const ARCHIVE_TERMS = new Set(['gmail', 'email', 'mail', 'otter', 'transcript', 'linkedin', 'whatsapp']);

const PROJECT_STATUS_TERMS = new Set([
  'amy',
  'bai',
  'briefing',
  'claude',
  'codex',
  'dashboard',
  'graphiti',
  'itm',
  'ExampleCo',
  'ExampleCo',
  'resilience',
  'secondbrain',
  'snack',
  'spine',
  'vapi',
  'voice',
]);

const STATUS_HINT_TERMS = new Set([
  'active',
  'current',
  'deploy',
  'deployment',
  'fix',
  'latest',
  'progress',
  'readiness',
  'repair',
  'scale',
  'scaleup',
  'scaling',
  'session',
  'status',
  'test',
  'thread',
  'work',
]);

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSpokenProjectAliases(value) {
  let text = ` ${normalizeSearchText(value)} `;
  text = text.replace(/\bpixie\s+pixie\b/g, ' ExampleCo ');
  text = text.replace(/\bpixie\s+(deployment|deploy|scale|scaling|session|status|app|test)\b/g, ' ExampleCo $1 ');
  text = text.replace(
    /\b(?:pix\s*seat|ExampleCo|pix\s*seed|pixseed|pick\s*seat|big\s*speed|pix\s*speed|pig\s*seed|pig\s*speed|pigs?\s*yet|pigs?y\s*et|pigs?y\s*at|pigs?\s*at|pigsyet|picc\s*c|picc|pic\s*c)\b/g,
    ' ExampleCo ',
  );
  text = text.replace(/\bscale\s+up\b/g, ' scaleup ');
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeSpineQueryForVoice(value) {
  return normalizeSpokenProjectAliases(value);
}

function spineQueryTerms(value) {
  return normalizeSpineQueryForVoice(value).split(/\s+/).filter(Boolean);
}

function isArchiveQueryTerms(terms = []) {
  return terms.some((term) => ARCHIVE_TERMS.has(term));
}

function isProjectStatusQueryTerms(terms = []) {
  if (!terms.length || isArchiveQueryTerms(terms)) return false;
  const hasProject = terms.some((term) => PROJECT_STATUS_TERMS.has(term));
  if (!hasProject) return false;
  return terms.length <= 3 || terms.some((term) => STATUS_HINT_TERMS.has(term));
}

function displaySpineQueryForVoice(rawQuery) {
  const normalized = normalizeSpineQueryForVoice(rawQuery);
  const raw = normalizeSearchText(rawQuery);
  return normalized && normalized !== raw ? normalized : String(rawQuery || '').trim();
}

module.exports = {
  normalizeSearchText,
  normalizeSpineQueryForVoice,
  spineQueryTerms,
  isArchiveQueryTerms,
  isProjectStatusQueryTerms,
  displaySpineQueryForVoice,
};
