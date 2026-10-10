'use strict';

// METRIC DRILL-DOWN HEADER.
//
// ExampleCo, 2026-09-23: every metric drill-down must START with (1) the metric
// definition in plain English, (2) exactly what is failing, and (3) what
// happened versus what was expected, precisely. Green metrics show the
// definition and "Passing: <actual> meets expected: <expected>".
//
// The definition and expected pass condition come from the registry in
// system-health-metric-definitions.js, keyed by the exact work-unit id. The
// failing statement and the actual value come from the row's current verdict
// data (what the producer rendered), never from hardcoded per-card prose. The
// renderer places this block before every other drill-down element.

const {
  resolveMetricDefinition,
} = require('./system-health-metric-definitions.js');
const {
  CLASS_LABELS,
  isSystemHealthRowId,
  repairClassOf,
} = require('./system-health-repair-class.js');

function clean(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

// Row text that names no concrete fact. It cannot stand alone as "what is
// failing"; the registry failure condition is shown next to it instead.
const VAGUE_ROW_TEXT = new RegExp(
  [
    '^\\(?see detail below\\)?$',
    '^source / technical detail$',
    '^the probe found a problem',
    '^producer result is not green$',
    '^not green$',
    '^red$',
    '^yellow$',
    '^unknown$',
    '^never proven by live qc$',
  ].join('|'),
  'i',
);

function isVague(text) {
  const t = clean(text).replace(/[.]+$/, '');
  return !t || t.length < 12 || VAGUE_ROW_TEXT.test(t);
}

function inlineTimestamp(value) {
  const m = clean(value).match(
    /\b(?:as of|last (?:ran|run|backup|write|captured|processed|checked)|captured|snapshot captured|proof)\s+[^.;,]+/i,
  );
  return m ? m[0].trim() : '';
}

function lowerFirst(text) {
  const t = clean(text);
  if (!t) return t;
  if (/^[A-Z][A-Z0-9]/.test(t)) return t; // acronym such as EC2, S3, SLA
  return t.charAt(0).toLowerCase() + t.slice(1);
}

function stripTrailingPeriod(text) {
  return clean(text).replace(/[.]+$/, '');
}

function statusKind(status) {
  const s = clean(status).toLowerCase();
  if (s === 'green') return 'passing';
  if (s === 'info') return 'informational';
  if (s === 'yellow') return 'advisory';
  return 'failing';
}

/**
 * Build the header facts for one System Health metric row.
 * @param {object} item parsed row: { name, status, detail, wrong, actual, expected, probe }
 * @param {{ workUnitId?: string }} options
 */
function buildMetricDrilldownHeader(item = {}, { workUnitId = '' } = {}) {
  const name = clean(item.name) || 'This metric';
  const registered = resolveMetricDefinition(workUnitId, item.name);
  const definition = registered
    ? registered.definition
    : `No registered definition exists for "${name}" (${workUnitId || 'no work-unit id'}); this is a registry defect.`;
  // A producer may supply a machine-readable expected value for today's run;
  // otherwise the registry's pass condition is the expectation.
  const expected = clean(item.expected) || (registered ? registered.expected : 'No registered pass condition.');
  const failureCondition = registered ? registered.failure : '';
  const probe = (item && item.probe) || {};
  const detail = clean(item.detail);
  const wrong = clean(item.wrong);
  const actualCandidates = [item.actual, detail, wrong, probe.data, probe.note].map(clean);
  const actual =
    actualCandidates.find((v) => v && !isVague(v)) ||
    actualCandidates.find(Boolean) ||
    'The producer recorded no measured value for this row.';
  const checkedAt = clean(probe.at) || inlineTimestamp(detail) || inlineTimestamp(wrong);
  const kind = statusKind(item.status);

  let failing = '';
  if (kind === 'failing' || kind === 'advisory') {
    const rowFailure = [wrong, detail].find((v) => v && !isVague(v)) || wrong || detail;
    if (rowFailure && !isVague(rowFailure)) {
      failing = rowFailure;
    } else {
      failing = `${name} reported only "${rowFailure || 'no failure text'}". ${failureCondition || 'No registered failure condition exists.'}`;
    }
  }

  const repairClass = isSystemHealthRowId(workUnitId) ? repairClassOf(workUnitId) : '';
  return {
    workUnitId,
    repairClass,
    name,
    status: clean(item.status) || 'red',
    kind,
    registered: Boolean(registered),
    definition,
    failing,
    failureCondition,
    actual,
    expected,
    checkedAt,
  };
}

/**
 * Render the header. `escapeHtml` is required; `formatTime` converts any
 * machine timestamps inside face text to CT labels.
 */
function renderMetricDrilldownHeader(header, { escapeHtml, formatTime = (v) => v } = {}) {
  if (typeof escapeHtml !== 'function') throw new Error('renderMetricDrilldownHeader requires escapeHtml');
  const e = (v) => escapeHtml(formatTime(clean(v)));
  const checked = header.checkedAt ? `(checked ${stripTrailingPeriod(header.checkedAt)})` : '';
  const lines = [
    `<p class="metric-def"><strong>What this measures:</strong> ${e(header.definition)}</p>`,
  ];
  if (header.kind === 'passing' || header.kind === 'informational') {
    const label = header.kind === 'passing' ? 'Passing' : 'Informational';
    lines.push(
      `<p class="metric-verdict metric-passing"><strong>${label}:</strong> ${e(stripTrailingPeriod(header.actual))}${checked ? ` ${e(checked)}` : ''} meets expected: ${e(lowerFirst(header.expected))}</p>`,
    );
  } else {
    lines.push(
      `<p class="metric-verdict metric-failing"><strong>${header.kind === 'advisory' ? 'What is behind (advisory)' : 'What is failing'}:</strong> ${e(header.failing)}</p>`,
    );
    lines.push(
      `<p class="metric-vs"><strong>Happened:</strong> ${e(stripTrailingPeriod(header.actual))}${checked ? ` ${e(checked)}` : ''}. <strong>Expected:</strong> ${e(header.expected)}</p>`,
    );
  }
  if (header.repairClass) {
    lines.push(
      `<p class="metric-repair-class" data-repair-class="${escapeHtml(header.repairClass)}"><strong>Repair class:</strong> ${escapeHtml(CLASS_LABELS[header.repairClass] || header.repairClass)}${header.repairClass === 'code_fixable' ? '' : header.repairClass === 'unclassified' ? ' (no repair class declared, so no model session runs)' : ' (no model session runs on this row)'}</p>`,
    );
  }
  return `<section class="metric-drilldown-header" data-role="metric-drilldown-header" data-metric-id="${escapeHtml(header.workUnitId || '')}" data-metric-status="${escapeHtml(header.status)}">${lines.join('')}</section>`;
}

module.exports = {
  buildMetricDrilldownHeader,
  renderMetricDrilldownHeader,
  isVagueMetricRowText: isVague,
};
