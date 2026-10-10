// skill-runner-ladder.js
//
// Pure decision logic for run-scheduled-skill.js (P1 of the 2026-06-11 ladder
// plan). Split out so the SUCCESS-lie fix and rung descent are unit-testable
// without spawning CLIs.
//
// Rung order: the durable brain switch decides who leads (ExampleCo 2026-09-03,
// scripts/lib/brain-switch.js) -- Claude by source default, Codex the moment
// Claude reports it is out of tokens, or whichever brain the owner flips to.
// RUNG_ORDER below is the source-default order only (claude first, codex as
// the rescue rung); live callers use rungOrder()/nextRung(current, opts).
// Both fail -> honest FAILED exit, durable outcome row, surfaced by
// probeScheduledSkillOutcomes in the 2:45am diagnostic.

'use strict';

const { isCliFailureOutput } = require('./cli-output-guard.js');
const { brainOrder } = require('./brain-switch.js');

const RUNG_ORDER = ['claude', 'codex'];

// classifyRunOutput(exitCode, output)
//   -> 'ok' | 'sentinel-failure' | 'self-reported-failure' | 'failed'
// THE SUCCESS LIE FIX: a zero exit code is NOT success when the output is an
// auth/quota sentinel (claude prints "Not logged in" and exits 0), empty, or
// the agent's own Protocol verdict explicitly says the task is blocked/red.
function selfReportedFailure(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  const explicitDeliveryFailure = lines.some((line) =>
    /^(?:Could not land\b|The changes are not landed\b|(?:TLDR:\s*)?.*\blanding failed\b)/i.test(
      line,
    ),
  );
  if (explicitDeliveryFailure) return true;
  if (
    lines.some((line) =>
      /^(?:#{1,6}\s*)?Protocol\s*:\s*(?:blocked\b|red\b|failed\b|failure\b|unable\b|not completed\b|incomplete\b)/i.test(
        line,
      ),
    )
  ) {
    return true;
  }
  const protocolIndex = lines.findIndex((line) => /^#{1,6}\s+Protocol\b/i.test(line));
  if (protocolIndex < 0) return false;
  const verdict = lines.slice(protocolIndex + 1).find((line) => line && !/^#{1,6}\s+/.test(line));
  return /^(?:blocked\b|red\b|failed\b|failure\b|unable\b|not completed\b|incomplete\b)/i.test(
    verdict || '',
  );
}

function classifyRunOutput(exitCode, output) {
  const text = String(output || '').trim();
  if (exitCode !== 0) return 'failed';
  if (!text) return 'failed';
  if (isCliFailureOutput(text)) return 'sentinel-failure';
  if (selfReportedFailure(text)) return 'self-reported-failure';
  return 'ok';
}

function shouldRecordProviderFailure(result) {
  if (!result || result.policyDenied === true) return false;
  return result.verdict !== 'ok' && result.verdict !== 'self-reported-failure';
}

// The live order every caller should walk: [leading, other], per the durable
// brain switch. opts passes through to brainOrder() (env, switchPath, now).
function rungOrder(opts) {
  return brainOrder(opts);
}

// A caller mid-run must walk the SAME order it started with: recordBrainFailure
// on the current rung can flip the live switch before nextRung is asked for
// the fallback, and re-reading the switch here would silently drop the
// fallback rung (2026-09-03 fix). Pass the order the run snapshotted via
// opts.order; only fall back to a fresh read when no snapshot is given.
function nextRung(current, opts) {
  const order = opts && Array.isArray(opts.order) ? opts.order : rungOrder(opts);
  const i = order.indexOf(current);
  if (i === -1 || i === order.length - 1) return null;
  return order[i + 1];
}

module.exports = {
  classifyRunOutput,
  nextRung,
  rungOrder,
  shouldRecordProviderFailure,
  RUNG_ORDER,
};
