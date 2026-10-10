'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readSessionProjection } = require('./session-cloud-plane.js');

function boundedLimit(value, fallback = 10) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.floor(parsed))) : fallback;
}

function searchable(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function projectionMatches(projection, query, limit) {
  const terms = searchable(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return Object.values(projection.activities || {})
    .map((activity) => {
      const haystack = searchable([
        activity.title,
        activity.prompt_summary,
        activity.progress_summary,
        activity.result_summary,
      ].join(' '));
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { activity, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || (Date.parse(b.activity.updated_at || '') || 0) - (Date.parse(a.activity.updated_at || '') || 0))
    .slice(0, limit)
    .map(({ activity }) => ({
      source: 'cloud-session-projection',
      provider: activity.provider,
      session_id: activity.session_id,
      activity_id: activity.activity_id,
      title: activity.title,
      status: activity.status,
      updated_at: activity.updated_at,
      prompt_summary: activity.prompt_summary || '',
      result_summary: activity.result_summary || activity.progress_summary || '',
      terminal_receipt_verified: activity.terminal_receipt_verified === true,
      raw: activity.raw || null,
    }));
}

function defaultFtsSearch({ dataDir, repoRoot, query, limit }) {
  const script = path.join(repoRoot || path.resolve(__dirname, '..', '..'), 'scripts', 'session-fts.py');
  const db = path.join(dataDir, 'session-fts.sqlite');
  const candidates = [
    [process.env.PYTHON || 'python3', [script, '--db', db, 'search', query, '--limit', String(limit)]],
    ['python', [script, '--db', db, 'search', query, '--limit', String(limit)]],
    ['py', ['-3', script, '--db', db, 'search', query, '--limit', String(limit)]],
  ];
  for (const [command, args] of candidates) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    if (result.status !== 0 || !result.stdout) continue;
    try {
      const parsed = JSON.parse(result.stdout);
      return { ok: true, results: Array.isArray(parsed.results) ? parsed.results : [] };
    } catch {
      continue;
    }
  }
  return { ok: false, reason: 'EC2 session FTS is unavailable', results: [] };
}

function querySessionCloud(args = {}, {
  dataDir = process.env.SECONDBRAIN_DATA_DIR || path.join(process.cwd(), 'data'),
  repoRoot = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..'),
  ftsSearch = defaultFtsSearch,
} = {}) {
  const query = String(args.query || args.question || '').trim();
  if (!query) return { ok: false, status: 'invalid', reason: 'session query is required', matches: [] };
  const limit = boundedLimit(args.limit, 10);
  const projection = readSessionProjection({ dataDir });
  const projected = projectionMatches(projection, query, limit);
  let fts = { ok: false, reason: 'not attempted', results: [] };
  try {
    fts = ftsSearch({ dataDir, repoRoot, query, limit }) || fts;
  } catch (error) {
    fts = { ok: false, reason: String(error?.message || error), results: [] };
  }
  const exact = (fts.results || []).slice(0, limit).map((row) => ({
    source: 'ec2-session-fts',
    provider: String(row.repo || '').split(':')[0] || 'unknown',
    session_id: row.session_id,
    activity_id: null,
    title: row.repo || 'Session transcript match',
    status: 'archived',
    updated_at: row.ts,
    prompt_summary: row.snippet || '',
    result_summary: row.body || '',
    terminal_receipt_verified: null,
    byte_range: row.byte_range,
  }));
  const matches = [...projected, ...exact]
    .filter((row, index, all) => all.findIndex((candidate) =>
      candidate.source === row.source && candidate.session_id === row.session_id && candidate.activity_id === row.activity_id && candidate.byte_range === row.byte_range,
    ) === index)
    .slice(0, limit);
  return {
    ok: matches.length > 0 || fts.ok === true,
    scope: 'cloud-session-projection+ec2-fts',
    projection_updated_at: projection.updated_at,
    exact_search_ok: fts.ok === true,
    exact_search_reason: fts.ok === true ? null : fts.reason,
    matches,
  };
}

function sessionStatusSnapshot(args = {}, {
  dataDir = process.env.SECONDBRAIN_DATA_DIR || path.join(process.cwd(), 'data'),
  nowMs = Date.now(),
} = {}) {
  const projection = readSessionProjection({ dataDir });
  const limit = boundedLimit(args.limit, 20);
  const recentWindowMs = Math.max(60 * 60 * 1000, Number(args.recent_hours || 7 * 24) * 60 * 60 * 1000);
  const sessionsByKey = projection.sessions || {};
  const activities = Object.values(projection.activities || {})
    .filter((activity) => {
      if (activity.status === 'running') return true;
      const updated = Date.parse(activity.updated_at || activity.completed_at || '');
      return Number.isFinite(updated) && nowMs - updated <= recentWindowMs;
    })
    .sort((a, b) => (Date.parse(b.updated_at || '') || 0) - (Date.parse(a.updated_at || '') || 0))
    .slice(0, limit)
    .map((activity) => {
      const session = sessionsByKey[`${activity.provider}:${activity.session_id}`] || {};
      const lastObservedMs = Date.parse(session.last_observed_at || activity.last_observed_at || '');
      const sourceAvailable = session.source_available === false
        ? false
        : activity.status === 'running'
          ? Number.isFinite(lastObservedMs) && nowMs - lastObservedMs <= 20 * 60 * 1000
          : Boolean(session.source_available);
      return {
        provider: activity.provider,
        session_id: activity.session_id,
        activity_id: activity.activity_id,
        title: activity.title || session.title || `${activity.provider} session`,
        status: activity.status,
        updated_at: activity.updated_at,
        source_available: sourceAvailable,
        last_observed_at: session.last_observed_at || activity.last_observed_at || null,
        result_summary: activity.result_summary || activity.progress_summary || '',
        terminal_receipt_verified: activity.terminal_receipt_verified === true,
      };
    });
  return {
    ok: true,
    schema: 'amy.cloud-dev-sessions.v1',
    source: 'cloud-session-projection',
    observed_at: new Date(nowMs).toISOString(),
    projection_updated_at: projection.updated_at,
    count: activities.length,
    sessions: activities,
  };
}

module.exports = {
  defaultFtsSearch,
  projectionMatches,
  querySessionCloud,
  sessionStatusSnapshot,
};
