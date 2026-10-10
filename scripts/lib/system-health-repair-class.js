'use strict';

// REPAIR CLASS for every System Health row (ExampleCo, Oct 2026, top-15 item 6).
//
// Each registered row declares exactly one class. Only `code_fixable` may start
// a model repair session. A row with no declared class is `unclassified`: it
// gets no model session (fail closed) and a visible note, so a new row costs no
// tokens until someone decides what kind of repair it can have.
//
//   code_fixable         a code or data change can turn the row green
//   ages_out             history (a past count, a past receipt) that only time clears
//   external_dependency  the fix lives outside Amy's code (host, vendor, a site)
//   owner_decision       only ExampleCo can settle it (policy, identity, a disabled service)
//
// This replaces the per-row exceptions that grew from burns on Sep 14 (owner
// gated lanes), Sep 24 and Oct 3 (session limits) and the Oct 4 elapsed-call
// preflight: owner-gated lanes are classed here, and the preflight reports
// the same `ages_out` class when current evidence shows history only.
// A code_fixable row can still be settled without a model when current evidence
// shows history only (spec churn, elapsed Otter calls); those preflights stay.
// Selection stays ExampleCo's: briefing-healer-policy.js still lists which
// code_fixable rows have a coding healer.

const { isOwnerGatedSystemHealthWorkUnit, isOwnerDisabledServiceWorkUnit } = require('./system-health-owner-gated.js');
const { isOwnerPausedVideoWork } = require('./video-work-policy.js');

const REPAIR_CLASSES = Object.freeze({
  CODE_FIXABLE: 'code_fixable',
  AGES_OUT: 'ages_out',
  EXTERNAL_DEPENDENCY: 'external_dependency',
  OWNER_DECISION: 'owner_decision',
});
const UNCLASSIFIED = 'unclassified';
const VALID = new Set(Object.values(REPAIR_CLASSES));

const CLASS_LABELS = Object.freeze({
  code_fixable: 'Code can fix',
  ages_out: 'Ages out',
  external_dependency: 'Outside dependency',
  owner_decision: 'Owner decision',
  unclassified: 'Unclassified, no model',
});

function ids(cls, list) {
  return list.map((slug) => [`system_health:${slug}`, cls]);
}

const DECLARED = Object.freeze(
  Object.fromEntries([
    ...ids('code_fixable', [
      'api-audit', 'briefing-delivery-slo', 'memory', 'neo4j-cpu-cap', 'spec-changes',
      'news-headlines-with-a-full-story', 'otter-call-processing-sla',
      'otter-hypothesis-projection', 'otter-name-resolver', 'otter-speaker-enrichment',
      'past-week-voice-name-judge-orphans', 'scheduled-tasks', 'stuck-videos',
      'voice-confirmation-save-actions', 'voice-people-projection',
      'signal-flow-graphiti', 'cloud-briefing', 'dispatch-backlog', 'video-pipeline',
      'session-search-projection', 'session-terminal-receipts', 'session-transcript-freshness',
      'signal-flow-archive', 'signal-flow-capture', 'signal-flow-linked-context',
      'signal-flow-message-completeness', 'signal-flow-people-knowledge',
    ]),
    ...ids('ages_out', [
      'watcher-interventions', 'otter-lifetime-call-processing-completion',
      'voice-name-judge-orphans', 'automated-regression-suite',
      'tests-action-item-ranker', 'tests-auto-reply', 'tests-briefing', 'tests-dashboard',
      'tests-devops', 'tests-dispatch', 'tests-ingest', 'tests-memory', 'tests-other',
      'tests-self-heal', 'tests-studio', 'tests-vapi', 'tests-video',
    ]),
    ...ids('external_dependency', [
      'backend-pm2-fleet', 'backups', 'backups-coverage', 'dev-ops', 'deploy-parity',
      'ec2', 'ec2-disk', 'ec2-ssh-sessions', 'gmail-scan', 'graphiti', 'graphiti-advisor',
      'recall-broker', 'ExampleCo', 'client-app-app', 'client-app-backups', 'client-app-email',
      'telegram-phone-intake',
    ]),
    ...ids('owner_decision', [
      'amy-gravity', 'voice-name-conflicts', 'voiceprint-text-conflicts',
      'life-archive-backup', 'life-claude-code-sessions', 'life-codex-sessions',
      'life-dispatches', 'life-gmail', 'life-linkedin-dms', 'life-linkedin-posts',
      'life-other-prompt-surfaces', 'life-otter', 'life-sms-imessage', 'life-vapi-amy',
      'life-whatsapp',
    ]),
  ]),
);

function key(id) {
  return String(id || '').trim().toLowerCase();
}

// The class the row declares. `unclassified` for anything not in the table.
function declaredRepairClass(id) {
  const cls = DECLARED[key(id)];
  return VALID.has(cls) ? cls : UNCLASSIFIED;
}

// The class in force now: the declared class, overlaid by owner policy. A row
// measuring an owner-disabled service or owner-paused video work is an owner
// decision while the policy holds, so re-enabling the service restores its
// declared class with no code change.
function repairClassOf(id, options = {}) {
  const declared = declaredRepairClass(id);
  if (declared === UNCLASSIFIED) return UNCLASSIFIED;
  if (isOwnerPausedVideoWork(id, options) || isOwnerDisabledServiceWorkUnit(id, options)) {
    return REPAIR_CLASSES.OWNER_DECISION;
  }
  if (isOwnerGatedSystemHealthWorkUnit(id, options) && declared === REPAIR_CLASSES.CODE_FIXABLE) {
    return REPAIR_CLASSES.OWNER_DECISION;
  }
  return declared;
}

function isSystemHealthRowId(id) {
  return /^system_health:/.test(key(id));
}

// May a model session start for this row? Rows outside System Health (cards
// without health rows) have no class and are decided by the existing card
// policy, so they pass here.
function modelSessionAllowedForRow(id, options = {}) {
  if (!isSystemHealthRowId(id)) return { allowed: true, repairClass: '', note: '' };
  const repairClass = repairClassOf(id, options);
  if (repairClass === REPAIR_CLASSES.CODE_FIXABLE) return { allowed: true, repairClass, note: '' };
  const note =
    repairClass === UNCLASSIFIED
      ? `unclassified: ${id} has no repair class, so no model session starts until it is classified`
      : `${CLASS_LABELS[repairClass]}: no model session, a code change cannot clear ${id}`;
  return { allowed: false, repairClass, note };
}

module.exports = {
  REPAIR_CLASSES,
  UNCLASSIFIED,
  CLASS_LABELS,
  DECLARED_REPAIR_CLASSES: DECLARED,
  declaredRepairClass,
  repairClassOf,
  isSystemHealthRowId,
  modelSessionAllowedForRow,
};
