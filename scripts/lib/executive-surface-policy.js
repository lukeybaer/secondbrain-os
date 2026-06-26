#!/usr/bin/env node
'use strict';

const { isCliFailureOutput } = require('./cli-output-guard.js');

const RAW_OPERATIONAL_PATTERNS = [
  /HTTP\s+[45]\d\d/i,
  /\b404\s+Not\s+Found\b/i,
  /\bnot_found_error\b/i,
  /\binvalid_request_error\b/i,
  /\boverloaded_error\b/i,
  /\bbackend\s*:?\s*3001\b/i,
  /\bpm2\b/i,
  /\bclaude\s+exit\s+\d+\b/i,
  /\bstack\s+trace\b/i,
  /\btraceback\b/i,
  /\bapi\.telegram\.org\b/i,
  /\btelegram_error\b/i,
  /\bBad Request:\s*message is too long\b/i,
  /\bprovider\b/i,
  /\bAnthropic\b/i,
  /\bClaude\b/i,
  /\bOpenAI\b/i,
  /\bCodex CLI\b/i,
  /\bVapi\b/i,
];

const SELF_TALK_PATTERNS = [
  /\bI will now\b/i,
  /\blet me\b/i,
  /\bwhat I tried\b/i,
  /\braw logs?\b/i,
  /\bPlan \+ ETA\b/i,
  /\bOwner:\s*Amy\b/i,
  /\bAmy owns\b/i,
  /\bAmy must\b/i,
  /\bAmy will\b/i,
];

function firstMatch(patterns, text) {
  const s = String(text || '');
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[0];
  }
  return '';
}

function containsRawOperationalLeak(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  return isCliFailureOutput(s) || RAW_OPERATIONAL_PATTERNS.some((re) => re.test(s));
}

function scrubExecutiveText(text) {
  let s = String(text || '');
  for (const re of RAW_OPERATIONAL_PATTERNS) {
    s = s.replace(re, 'internal service detail');
  }
  for (const re of SELF_TALK_PATTERNS) {
    s = s.replace(re, '');
  }
  s = s
    .replace(/\binternal service detail(?:[,;:]?\s*){2,}/gi, 'internal service detail ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (containsRawOperationalLeak(s)) {
    return 'Amy service status changed. Impact: the request was saved, but delivery may be delayed. Next action: No action needed from ExampleCo right now.';
  }
  return s;
}

function assertExecutiveText(text, { surface = 'user-facing' } = {}) {
  const failures = [];
  const s = String(text || '');
  if (!s.trim()) failures.push(`${surface}: empty text`);
  const raw = firstMatch(RAW_OPERATIONAL_PATTERNS, s);
  if (raw || isCliFailureOutput(s)) failures.push(`${surface}: raw operational detail leaked`);
  const selfTalk = firstMatch(SELF_TALK_PATTERNS, s);
  if (selfTalk) failures.push(`${surface}: self-talk leaked`);
  return { ok: failures.length === 0, failures };
}

function cleanFragment(value, fallback) {
  const s = scrubExecutiveText(value || '').replace(/[. \t]+$/g, '');
  return s || fallback;
}

function toExecutiveServiceStatus({
  service = 'Amy service',
  state = 'degraded',
  impact = 'Some requests may be delayed.',
  nextAction = 'No action needed from ExampleCo right now.',
} = {}) {
  const serviceText = cleanFragment(service, 'Amy service');
  const stateText = cleanFragment(state, 'degraded').toLowerCase();
  const impactText = cleanFragment(impact, 'Some requests may be delayed');
  const nextActionText = cleanFragment(nextAction, 'No action needed from ExampleCo right now');
  return `${serviceText} is ${stateText}.\nImpact: ${impactText}.\nNext action: ${nextActionText}.`;
}

function internalFailureToExecutiveStatus(raw, fallback = {}) {
  return toExecutiveServiceStatus({
    service: fallback.service || 'Amy execution',
    state: fallback.state || 'temporarily delayed',
    impact:
      fallback.impact ||
      'Telegram and phone requests are saved, but some replies may wait for the cloud retry loop',
    nextAction: fallback.nextAction || 'No action needed from ExampleCo right now',
  });
}

module.exports = {
  RAW_OPERATIONAL_PATTERNS,
  SELF_TALK_PATTERNS,
  containsRawOperationalLeak,
  scrubExecutiveText,
  assertExecutiveText,
  toExecutiveServiceStatus,
  internalFailureToExecutiveStatus,
};
