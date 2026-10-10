'use strict';

const { CARDS, getCardById } = require('./briefing-card-manifest.js');
const { isOwnerPausedVideoWork } = require('./video-work-policy.js');
const {
  REPAIR_CLASSES,
  declaredRepairClass,
  isSystemHealthRowId,
} = require('./system-health-repair-class.js');

// Owner-approved overhaul, 2026-09-07. These cards still refresh and pass QC.
// Their failures are report evidence, never recursive model-healer work.
const DETERMINISTIC_CARD_IDS = new Set([
  'system_health', 'self_heal_health', 'memory_hygiene', 'memory_md_changes',
  'people_files_changes', 'uncommitted_parked', 'token_usage',
  'jev_spend', 'full_life_backup', 'aws_costs', 'big_decisions',
]);
// Independent exact-card workers may overlap. Cross-process host admission
// remains the authority: it refuses the second worker on memory, load, I/O,
// coredump, CPU-credit, or provider-capacity pressure.
const AGENTIC_HEALER_CONCURRENCY = 2;
// ExampleCo, 2026-09-09: these exact metrics get their coding healer back. The
// System Health parent and every other machinery metric remain deterministic.
//
// ExampleCo, 2026-09-16 (second widening): "anything red currently should be allowed
// to be tied to a healer". Every metric that was red on the live board at
// 23:11 CT is therefore listed below, generated from that board rather than
// hand-typed. Eligibility is not a launch: a row whose planning is owner-only,
// such as amy-gravity, is still never auto-planned, and mechanical-first still
// runs before any model so a stale artifact costs no worker.
//
// ExampleCo, 2026-09-16: added the three Otter identity metrics below by explicit
// selection. Each is a real measured red with its own failing mechanism, not a
// receipt-provenance artifact: hypothesis projection reports Pareto and roster
// provenance that do not match, the name resolver reports every one of 55
// selected targets failing, and speaker enrichment reports its coverage report
// 48 hours stale. The System Health parent and every unselected sibling stay
// deterministic, and mechanical-first still runs before any model.
const AGENTIC_SYSTEM_HEALTH_IDS = new Set([
  'system_health:amy-gravity',
  'system_health:api-audit',
  'system_health:briefing-delivery-slo',
  'system_health:memory',
  'system_health:neo4j-cpu-cap',
  // ExampleCo 2026-09-24: News write-ups is retired; its selected news healer
  // lane carries to the one remaining news pipeline metric.
  'system_health:news-headlines-with-a-full-story',
  'system_health:otter-call-processing-sla',
  'system_health:otter-hypothesis-projection',
  'system_health:otter-name-resolver',
  'system_health:otter-speaker-enrichment',
  'system_health:past-week-voice-name-judge-orphans',
  'system_health:scheduled-tasks',
  'system_health:signal-flow-graphiti',
  'system_health:spec-changes',
  'system_health:stuck-videos',
  'system_health:voice-confirmation-save-actions',
  'system_health:voice-people-projection',
]);

function parentCardId(value) {
  return String(value || '').trim().toLowerCase().split(':', 1)[0];
}

function deterministicOnly(value, options = {}) {
  return DETERMINISTIC_CARD_IDS.has(parentCardId(value)) &&
    !AGENTIC_SYSTEM_HEALTH_IDS.has(String(value || '').trim().toLowerCase());
}

function agenticHealerAllowed(value, workUnitIds = [], options = {}) {
  const id = parentCardId(value);
  if (!getCardById(id)) return false;
  if (isOwnerPausedVideoWork(value, options)) return false;
  // Repair class gate: only a code_fixable System Health row may start a model
  // session, and a row with no class fails closed. Selection below is a second,
  // separate condition.
  if (isSystemHealthRowId(value) && declaredRepairClass(value) !== REPAIR_CLASSES.CODE_FIXABLE) {
    return false;
  }
  if (Array.isArray(workUnitIds) && workUnitIds.length) {
    return workUnitIds.every(
      unit => parentCardId(unit) === id && agenticHealerAllowed(unit, [], options),
    );
  }
  return !deterministicOnly(value, options);
}

function healerMarkerHtml(sectionTitle) {
  const card = CARDS.find((entry) => entry.match.test(String(sectionTitle || '')));
  if (!card || !deterministicOnly(card.id)) return '';
  if (card.id === 'system_health') {
    return '<span class="tile-healer-policy" data-agentic-healer="scoped" aria-label="Selected metric coding healers" title="API audit, Signal flow / Graphiti, Past 24h call processing SLA, News write-ups, Briefing spec drift, Stuck videos, and Tier 2 memory have coding healers. Other metrics run refresh and QC only.">Selected metric healers</span>';
  }
  return '<span class="tile-healer-policy" data-agentic-healer="off" aria-label="No automatic coding healer" title="Refresh and QC run nightly. Remaining failures are explained in the overnight report."><span aria-hidden="true">&#9671;</span> No healer</span>';
}

module.exports = {
  DETERMINISTIC_CARD_IDS,
  AGENTIC_HEALER_CONCURRENCY,
  AGENTIC_SYSTEM_HEALTH_IDS,
  deterministicOnly,
  agenticHealerAllowed,
  healerMarkerHtml,
};
