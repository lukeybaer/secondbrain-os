"use strict";

const { graphitiIngestionAdmission } = require("./graphiti-ingestion-policy.js");
const { isOwnerPausedVideoWork } = require("./video-work-policy.js");

// Owner-gated System Health lanes: informational yellow, never a healer target.
//
// ExampleCo, 2026-09-02: "lifetimes are yellow." ExampleCo, 2026-09-14: rows that measure
// a disabled service, release bookkeeping, or lifetime catch-up are
// informational yellow with no healer, under the same rule. The 2026-09-14
// board carried 44 red metric rows; thirteen test categories were red only
// because their receipt came from a different release, Dev Ops was red because
// the EC2 shared checkout sat 236 commits behind, Graphiti and the Recall Broker
// were red although Graphiti is off, and every one of those reds queued a
// scoped repair unit that could not turn it green.
//
// A lane in this module renders yellow unless its proof is green, is never
// actionable from the board, and never becomes a healer target unless the owner
// explicitly targets the work unit. One shared module, read by the controller
// bootstrap and fanout, the refresh-card in-progress marker, the System Health
// row parser, the ledger planning, the chip status, the healer expansion, and
// the report red register, so they cannot drift apart again.

const OWNER_GATED_SYSTEM_HEALTH_LANES = Object.freeze({
  // Historical archive catch-up only the owner targets.
  "lifetime-catch-up": Object.freeze([
    "system_health:otter-lifetime-call-processing-completion",
    "system_health:voice-name-judge-orphans",
  ]),
  // Whether receipts, checkouts and releases line up, not an outcome ExampleCo sees.
  "release-bookkeeping": Object.freeze([
    "system_health:dev-ops",
    "system_health:deploy-parity",
    "system_health:automated-regression-suite",
    "system_health:tests",
    "system_health:tests-action-item-ranker",
    "system_health:tests-auto-reply",
    "system_health:tests-briefing",
    "system_health:tests-dashboard",
    "system_health:tests-devops",
    "system_health:tests-dispatch",
    "system_health:tests-ingest",
    "system_health:tests-memory",
    "system_health:tests-other",
    "system_health:tests-self-heal",
    "system_health:tests-studio",
    "system_health:tests-vapi",
    "system_health:tests-video",
  ]),
});

// Rows that measure an owner-disabled service. They are gated only while the
// tracked owner policy keeps that service off, so re-enabling Graphiti turns
// them back into operational red/green rows without a code change.
const OWNER_DISABLED_SERVICE_WORK_UNITS = Object.freeze({
  graphiti: Object.freeze([
    "system_health:graphiti",
    "system_health:graphiti-advisor",
    "system_health:recall-broker",
    "system_health:signal-flow-graphiti",
  ]),
});

// A test category added later is the same release-bookkeeping class.
const TEST_CATEGORY_ID = /^system_health:tests(?:-[a-z0-9-]+)?$/;

const OWNER_GATED_SYSTEM_HEALTH_WORK_UNITS = new Set(
  Object.values(OWNER_GATED_SYSTEM_HEALTH_LANES).flat(),
);

function normalizedWorkUnitId(id) {
  return String(id || "")
    .trim()
    .toLowerCase();
}

function isOwnerDisabledServiceWorkUnit(id, { graphitiPolicyPath } = {}) {
  const key = normalizedWorkUnitId(id);
  return Boolean(
    OWNER_DISABLED_SERVICE_WORK_UNITS.graphiti.includes(key) &&
      graphitiIngestionAdmission({ policyPath: graphitiPolicyPath }).ownerDisabled,
  );
}

function ownerGatedSystemHealthLaneCategory(id, options = {}) {
  const key = normalizedWorkUnitId(id);
  if (!key) return "";
  if (isOwnerPausedVideoWork(key, options)) return "owner-paused-video";
  for (const [category, ids] of Object.entries(OWNER_GATED_SYSTEM_HEALTH_LANES)) {
    if (ids.includes(key)) return category;
  }
  if (TEST_CATEGORY_ID.test(key)) return "release-bookkeeping";
  return isOwnerDisabledServiceWorkUnit(key, options) ? "disabled-service" : "";
}

function isOwnerGatedSystemHealthWorkUnit(id, options) {
  return Boolean(ownerGatedSystemHealthLaneCategory(id, options));
}

module.exports = {
  OWNER_DISABLED_SERVICE_WORK_UNITS,
  OWNER_GATED_SYSTEM_HEALTH_LANES,
  OWNER_GATED_SYSTEM_HEALTH_WORK_UNITS,
  isOwnerDisabledServiceWorkUnit,
  isOwnerGatedSystemHealthWorkUnit,
  ownerGatedSystemHealthLaneCategory,
};
