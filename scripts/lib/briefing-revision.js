'use strict';

const fs = require('node:fs');
const path = require('node:path');

function normalizeBriefingRevision(value, date) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Number(value.schemaVersion) !== 1) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  if (String(value.date || '') !== String(date)) return null;
  const heading = String(value.heading || '').trim();
  if (!heading) return null;

  const directives = (Array.isArray(value.directives) ? value.directives : [])
    .map((row) => ({
      id: String(row && row.id || '').trim(),
      state: String(row && row.state || '').trim(),
      title: String(row && row.title || '').trim(),
    }))
    .filter((row) => row.id && row.state && row.title);
  const stateCounts = Object.entries(value.stateCounts || {})
    .map(([state, count]) => ({ state: String(state).trim(), count: Number(count) }))
    .filter((row) => row.state && Number.isFinite(row.count) && row.count >= 0);
  const openThreads = (Array.isArray(value.openThreads) ? value.openThreads : [])
    .filter((row) => row && typeof row === 'object' && String(row.title || '').trim())
    .map((row) => ({ ...row, title: String(row.title).trim() }));
  const revisedReport = value.revisedReport && typeof value.revisedReport === 'object'
    && /^\/briefing\/watch-report\?date=\d{4}-\d{2}-\d{2}&version=revised$/.test(
      String(value.revisedReport.path || ''),
    )
    ? {
        label: String(value.revisedReport.label || 'Open revised report').trim(),
        path: String(value.revisedReport.path),
      }
    : null;

  return {
    heading,
    summary: String(value.summary || '').trim(),
    liveNow: String(value.liveNow || '').trim(),
    stillOpen: String(value.stillOpen || '').trim(),
    revisedReport,
    directiveTotal: directives.length,
    stateCounts,
    openThreads,
    directives,
  };
}

function readBriefingRevision({ repoRoot, date }) {
  const file = path.join(repoRoot, 'config', 'briefing-revisions', `${date}.json`);
  try {
    if (!fs.existsSync(file)) return null;
    return normalizeBriefingRevision(JSON.parse(fs.readFileSync(file, 'utf8')), date);
  } catch {
    return null;
  }
}

module.exports = { normalizeBriefingRevision, readBriefingRevision };
