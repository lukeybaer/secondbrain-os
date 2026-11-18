'use strict';

// The Claude plan meter (data/agent/claude-plan-usage.json, written by
// scripts/collect-claude-plan-usage.js) and the one freshness rule its readers
// share. scripts/claude-token-refresh.js refuses to push a meter older than six
// hours to EC2; the overnight quota guard in scripts/lib/model-router.js reads
// the meter with the same rule, so a days-old reading can neither step work
// down forever nor pose as protection.
const CLAUDE_PLAN_METER_FILE = 'claude-plan-usage.json';
const CLAUDE_PLAN_METER_MAX_AGE_MS = 6 * 3600000;

// True when the reading cannot be trusted: no parseable generated_at, or older
// than the shared six-hour limit.
function claudePlanMeterStale(generatedAtMs, nowMs = Date.now()) {
  return !Number.isFinite(generatedAtMs) || nowMs - generatedAtMs > CLAUDE_PLAN_METER_MAX_AGE_MS;
}

module.exports = {
  CLAUDE_PLAN_METER_FILE,
  CLAUDE_PLAN_METER_MAX_AGE_MS,
  claudePlanMeterStale,
};
