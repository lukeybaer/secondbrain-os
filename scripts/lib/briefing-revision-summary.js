'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REVISION_STATES = Object.freeze([
  ['landed_live_verified', 'LANDED, LIVE VERIFIED'],
  ['landed_not_repainted', 'LANDED, NOT REPAINTED'],
  ['not_pushed', 'NOT PUSHED'],
  ['allowed_abandoned', 'ALLOWED ABANDONED'],
  ['explicitly_skipped', 'EXPLICITLY SKIPPED'],
  ['blocked_needing_ExampleCo', 'BLOCKED, NEEDING ExampleCo'],
  ['blocked_owned_by_amy', 'BLOCKED, OWNED BY AMY'],
]);
const STATE_LABEL_BY_KEY = new Map(REVISION_STATES);

function cleanLine(value) {
  return String(value == null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return { __readError: String((error && error.message) || error) };
  }
}

function revisionStateCounts(directives = []) {
  const counts = Object.fromEntries(REVISION_STATES.map(([key]) => [key, 0]));
  for (const directive of Array.isArray(directives) ? directives : []) {
    if (Object.hasOwn(counts, directive?.state)) counts[directive.state] += 1;
  }
  return counts;
}

function validateBriefingRevisionSummary(value, { date } = {}) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['revision summary must be an object'] };
  }
  if (cleanLine(value.date) !== cleanLine(date || value.date)) {
    errors.push(`revision date ${cleanLine(value.date) || 'missing'} does not equal ${date}`);
  }
  if (!cleanLine(value.heading)) errors.push('heading is missing');
  if (!cleanLine(value.summary)) errors.push('summary is missing');
  if (!cleanLine(value.liveNow)) errors.push('liveNow is missing');
  if (!cleanLine(value.stillOpen)) errors.push('stillOpen is missing');
  if (value.revisedReport != null) {
    const reportLabel = cleanLine(value.revisedReport?.label);
    const reportPath = cleanLine(value.revisedReport?.path);
    if (!reportLabel) errors.push('revisedReport.label is missing');
    if (!/^\/briefing\/watch-report\?date=\d{4}-\d{2}-\d{2}&version=revised$/.test(reportPath)) {
      errors.push('revisedReport.path must be the dated internal revised watch-report route');
    }
    const routeDate = (reportPath.match(/[?&]date=(\d{4}-\d{2}-\d{2})(?:&|$)/) || [])[1] || '';
    if (routeDate && routeDate !== cleanLine(value.date)) {
      errors.push(`revisedReport.path date ${routeDate} does not equal revision date ${cleanLine(value.date)}`);
    }
  }
  const directives = Array.isArray(value.directives) ? value.directives : [];
  if (!directives.length) errors.push('directives are missing');
  const seen = new Set();
  for (const directive of directives) {
    const id = cleanLine(directive?.id);
    if (!id) errors.push('directive id is missing');
    else if (seen.has(id)) errors.push(`duplicate directive id ${id}`);
    else seen.add(id);
    if (!cleanLine(directive?.title)) errors.push(`directive ${id || '?'} title is missing`);
    if (!STATE_LABEL_BY_KEY.has(directive?.state)) {
      errors.push(`directive ${id || '?'} has unknown state ${cleanLine(directive?.state)}`);
    }
  }
  for (const [index, thread] of (Array.isArray(value.openThreads) ? value.openThreads : []).entries()) {
    const prefix = `open thread ${index + 1}`;
    if (!cleanLine(thread?.title)) errors.push(`${prefix} title is missing`);
    if (!STATE_LABEL_BY_KEY.has(thread?.state)) errors.push(`${prefix} state is invalid`);
    for (const field of [
      'evidence',
      'whyItMatters',
      'attempted',
      'changedTactic',
      'nextProof',
      'owner',
      'greenWhen',
    ]) {
      if (!cleanLine(thread?.[field])) errors.push(`${prefix} ${field} is missing`);
    }
  }
  const counts = revisionStateCounts(directives);
  const declared = value.stateCounts && typeof value.stateCounts === 'object' ? value.stateCounts : null;
  if (declared) {
    for (const [key] of REVISION_STATES) {
      if (Number(declared[key]) !== counts[key]) {
        errors.push(`stateCounts.${key} declares ${declared[key]} but directives contain ${counts[key]}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, counts, directiveTotal: directives.length };
}

function readBriefingRevisionSummary({ dataDir, date, repoRoot } = {}) {
  const safeDate = cleanLine(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate)) {
    return { summary: null, sourcePath: null, error: 'revision date is invalid' };
  }
  const root = path.resolve(repoRoot || process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..', '..'));
  const candidates = [
    dataDir && path.join(dataDir, 'agent', 'briefing-revisions', `${safeDate}.json`),
    path.join(root, 'config', 'briefing-revisions', `${safeDate}.json`),
  ].filter(Boolean);
  const sourcePath = candidates.find((file) => fs.existsSync(file)) || null;
  if (!sourcePath) return { summary: null, sourcePath: null, error: '' };
  const summary = readJson(sourcePath);
  if (summary && summary.__readError) {
    return { summary: null, sourcePath, error: `revision summary is unreadable: ${summary.__readError}` };
  }
  const validation = validateBriefingRevisionSummary(summary, { date: safeDate });
  if (!validation.ok) {
    return {
      summary: null,
      sourcePath,
      error: `revision summary is invalid: ${validation.errors.join('; ')}`,
    };
  }
  if (dataDir && summary.revisedReport) {
    const reportPath = path.join(
      dataDir,
      'briefings',
      `watch-report-${safeDate}-revised.html`,
    );
    if (!fs.existsSync(reportPath)) {
      return {
        summary: null,
        sourcePath,
        error: `revision summary is invalid: revised report artifact is missing: ${reportPath}`,
      };
    }
  }
  return {
    summary: { ...summary, stateCounts: validation.counts, directiveTotal: validation.directiveTotal },
    sourcePath,
    error: '',
  };
}

function formatBriefingRevisionSummary(summary, { executiveLabels = false } = {}) {
  if (!summary) return '';
  const validation = validateBriefingRevisionSummary(summary, { date: summary.date });
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  const lines = [
    `${cleanLine(summary.heading)}:`,
    `Summary: ${cleanLine(summary.summary)}`,
    `Live now: ${cleanLine(summary.liveNow)}`,
    `Still open: ${cleanLine(summary.stillOpen)}`,
    `Directive total: ${validation.directiveTotal}`,
  ];
  if (summary.revisedReport) {
    lines.push(
      `Revised report: ${cleanLine(summary.revisedReport.label)} | ${cleanLine(summary.revisedReport.path)}`,
    );
  }
  for (const [key, label] of REVISION_STATES) {
    lines.push(`State count: ${label} = ${validation.counts[key]}`);
  }
  for (const [index, thread] of (summary.openThreads || []).entries()) {
    lines.push('');
    lines.push(`OPEN THREAD ${index + 1}: ${cleanLine(thread.title)}`);
    lines.push(`State: ${STATE_LABEL_BY_KEY.get(thread.state)}`);
    lines.push(`Current evidence: ${cleanLine(thread.evidence)}`);
    lines.push(`Why it matters: ${cleanLine(thread.whyItMatters)}`);
    lines.push(`${executiveLabels ? 'Attempted' : 'Amy already tried'}: ${cleanLine(thread.attempted)}`);
    lines.push(`Changed tactic: ${cleanLine(thread.changedTactic)}`);
    lines.push(`Next proof: ${cleanLine(thread.nextProof)}`);
    lines.push(
      `${executiveLabels ? 'Responsible party' : 'Owner'}: ${
        executiveLabels && /^Amy(?:\b|,)/i.test(cleanLine(thread.owner))
          ? cleanLine(thread.owner).replace(/^Amy\b/i, 'Automatic repair')
          : cleanLine(thread.owner)
      }`,
    );
    lines.push(`Green when: ${cleanLine(thread.greenWhen)}`);
  }
  lines.push('');
  lines.push('REVISION DIRECTIVES:');
  for (const directive of summary.directives || []) {
    lines.push(
      `DIRECTIVE ${cleanLine(directive.id)}: [${STATE_LABEL_BY_KEY.get(directive.state)}] ${cleanLine(directive.title)}`,
    );
  }
  lines.push("END WHAT'S CHANGED");
  return lines.join('\n');
}

module.exports = {
  REVISION_STATES,
  STATE_LABEL_BY_KEY,
  formatBriefingRevisionSummary,
  readBriefingRevisionSummary,
  revisionStateCounts,
  validateBriefingRevisionSummary,
};
