// skill-runner-ladder.js
//
// Pure decision logic for run-scheduled-skill.js (P1 of the 2026-06-11 ladder
// plan). Split out so the SUCCESS-lie fix and rung descent are unit-testable
// without spawning CLIs.
//
// Rung order: claude first (agentic skills are tuned for Claude and write to
// the repo; Claude stays preferred per the Codex review), codex (OpenAI
// subscription) as the rescue rung so a Claude-subscription outage no longer
// kills the midnight fleet. Both fail -> honest FAILED exit, durable outcome
// row, surfaced by probeScheduledSkillOutcomes in the 2:45am diagnostic.

'use strict';

const { isCliFailureOutput } = require('./cli-output-guard.js');

const RUNG_ORDER = ['claude', 'codex'];

// classifyRunOutput(exitCode, output) -> 'ok' | 'sentinel-failure' | 'failed'
// THE SUCCESS LIE FIX: a zero exit code is NOT success when the output is an
// auth/quota sentinel (claude prints "Not logged in" and exits 0) or empty.
function classifyRunOutput(exitCode, output) {
  const text = String(output || '').trim();
  if (exitCode !== 0) return 'failed';
  if (!text) return 'failed';
  if (isCliFailureOutput(text)) return 'sentinel-failure';
  return 'ok';
}

function nextRung(current) {
  const i = RUNG_ORDER.indexOf(current);
  if (i === -1 || i === RUNG_ORDER.length - 1) return null;
  return RUNG_ORDER[i + 1];
}

module.exports = { classifyRunOutput, nextRung, RUNG_ORDER };
