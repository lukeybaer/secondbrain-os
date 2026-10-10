'use strict';

const { graphitiIngestionAdmission } = require('./graphiti-ingestion-policy.js');
const { isOwnerGatedSystemHealthWorkUnit } = require('./system-health-owner-gated.js');

function isOwnerDisabledGraphitiItem(item, { graphitiPolicyPath } = {}) {
  const exact = item && (item.id === 'system_health:signal-flow-graphiti' ||
    (!item.id && item.name === 'Signal flow / Graphiti'));
  return Boolean(exact && graphitiIngestionAdmission({ policyPath: graphitiPolicyPath }).ownerDisabled);
}

function measurementKey(item) {
  if (!item) return '';
  if (item.id) return String(item.id).trim().toLowerCase();
  // Rendered items can arrive by name only. Resolve through the one label
  // registry, required lazily because that module requires this one.
  if (!item.name) return '';
  const { stableMeasurementKey } = require('./system-health-nongreen.js');
  return stableMeasurementKey(item.name);
}

// ExampleCo, 2026-09-08: Life archive coverage is advisory yellow until proven
// green. Operational metrics retain the red/green contract. This predicate
// owns the exception for ledger, board counts, rendering and live QC.
function isLifeArchiveItem(item) {
  return Boolean(
    item &&
    (String(item.id || '')
      .toLowerCase()
      .startsWith('system_health:life-') ||
      /^Life:/i.test(String(item.name || ''))),
  );
}

function isLifeArchiveAdvisory(item) {
  return isLifeArchiveItem(item) && item.status !== 'green';
}

// ExampleCo, 2026-09-14: rows that measure an owner-disabled service, release
// bookkeeping, or lifetime catch-up (system-health-owner-gated.js) are yellow
// until proven green, exactly like Life coverage.
function isOwnerGatedSystemHealthItem(item, options) {
  return isOwnerGatedSystemHealthWorkUnit(measurementKey(item), options);
}

// Every row that can never be a red defect.
function isAdvisorySystemHealthItem(item, options) {
  return (
    isLifeArchiveItem(item) ||
    isOwnerDisabledGraphitiItem(item, options) ||
    isOwnerGatedSystemHealthItem(item, options)
  );
}

// A rendered roster row "<glyph> Name: detail" for an advisory (owner-gated)
// measurement carries the informational yellow glyph, never a cross or "?".
// Probes print their own verdict; the policy decides the glyph (2026-09-29:
// 17 owner-gated rows rendered as red crosses and failed card QC).
// The optional "Life:" prefix mirrors the System Health row parser, so
// "Life: Gmail: stale" resolves as "Life: Gmail", not "Life".
const ADVISORY_ROW_RE =
  /^(\s*)([✗?])(\s+)((?:Life:\s+)?[A-Za-z][\w:\s+&/().#>-]*?)(?::(?:\s|$)|\s*$)/;

// The measurement id a rendered roster row or bare attention heading names,
// or '' when the line is not a glyph row.
function systemHealthRowMeasurementId(line) {
  const match = String(line == null ? '' : line).match(
    /^\s*[✓✗⚠?]\s+((?:Life:\s+)?[A-Za-z][\w:\s+&/().#>-]*?)(?::(?:\s|$)|\s*$)/,
  );
  if (!match) return '';
  const { stableMeasurementKey } = require('./system-health-nongreen.js');
  return stableMeasurementKey(match[1].trim());
}

function advisorySystemHealthRowGlyph(line, options) {
  const text = String(line == null ? '' : line);
  const match = text.match(ADVISORY_ROW_RE);
  if (!match) return text;
  const name = match[4].trim();
  const { stableMeasurementKey } = require('./system-health-nongreen.js');
  if (!isAdvisorySystemHealthItem({ id: stableMeasurementKey(name), name }, options)) return text;
  return `${match[1]}⚠${text.slice(match[1].length + match[2].length)}`;
}

function isBlockingSystemHealthItem(item) {
  return Boolean(item && systemHealthChipStatus(item) === 'red');
}

function systemHealthChipStatus(item, options) {
  if (!item) return 'neutral';
  if (isOwnerDisabledGraphitiItem(item, options)) return 'yellow';
  if (item.status === 'green') return 'green';
  return isLifeArchiveItem(item) || isOwnerGatedSystemHealthItem(item, options) ? 'yellow' : 'red';
}

function systemHealthFaceSummary(items) {
  const source = (Array.isArray(items) ? items : []).filter(Boolean)
    .map(item => ({...item, status:systemHealthChipStatus(item)}));
  const greens = source.filter((item) => item && item.status === 'green');
  const reds = source.filter((item) => item.status === 'red');
  const yellows = source.filter((item) => item.status === 'yellow');
  const lifeArchiveAdvisories = yellows.filter(isLifeArchiveItem);
  const nonLifeAdvisories = yellows.filter(item => !isLifeArchiveItem(item));
  const defects = [...reds];
  const infos = [];
  return {
    reds,
    yellows,
    lifeArchiveAdvisories,
    nonLifeAdvisories,
    defects,
    greens,
    infos,
    gradedCount: source.length,
    allGreen: source.every(item => item.status === 'green'),
    // The owner-visible count is exactly the number of red measurements.
    unhealthyCount: defects.length,
  };
}

module.exports = {
  advisorySystemHealthRowGlyph,
  systemHealthRowMeasurementId,
  isAdvisorySystemHealthItem,
  isLifeArchiveItem,
  isOwnerDisabledGraphitiItem,
  isOwnerGatedSystemHealthItem,
  isLifeArchiveAdvisory,
  isBlockingSystemHealthItem,
  systemHealthChipStatus,
  systemHealthFaceSummary,
};
