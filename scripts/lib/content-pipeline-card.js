'use strict';
// CONTENT PIPELINE emptiness verdict (owner decision: "If there's no videos in
// the content pipeline, it should be red."). Pure functions so the dashboard
// builder in ec2-server.js and the tests share one definition.
//
// Empty = zero built videos awaiting approval AND zero proposals in flight for
// the current day. Empty grades RED and carries a plain-words cause built from
// data/agent/viral-tech-clips/<date>.json (its scan counts, quality-gate
// failures, search error, errors and proposals) and the latest built video in
// the content-review manifest.
const fs = require('fs');
const path = require('path');

// Proposal statuses that mean the proposal is no longer moving toward a video.
const TERMINAL_PROPOSAL_STATUSES = new Set([
  'rejected',
  'dismissed',
  'expired',
  'failed',
  'deleted',
  'posted',
  'skipped',
]);

function centralDate(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function readProposalDay(date, dirs, fsImpl = fs) {
  for (const dir of dirs || []) {
    const file = path.join(dir, `${date}.json`);
    try {
      return { file, state: JSON.parse(fsImpl.readFileSync(file, 'utf8')) };
    } catch {
      /* try next */
    }
  }
  return null;
}

function proposalsInFlight(state) {
  const rows = state && Array.isArray(state.proposals) ? state.proposals : [];
  return rows.filter(
    (p) => p && !TERMINAL_PROPOSAL_STATUSES.has(String(p.status || '').toLowerCase()),
  );
}

function formatRunTime(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(iso || ''));
  return m ? `${m[1]} ${m[2]}Z` : null;
}

function videoDate(v) {
  const raw = v.video_built_at || v.built_at || v.generated_date || v.created_at || '';
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String(raw));
  return m ? m[0] : null;
}

function lastBuiltVideo(videos) {
  let best = null;
  for (const v of Array.isArray(videos) ? videos : []) {
    if (!v) continue;
    const d = videoDate(v);
    if (!best || (d || '') > (best.date || '')) best = { date: d, title: v.title || v.id || null };
  }
  return best;
}

function oneLine(text, max = 160) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function describeProposalRun(date, found) {
  if (!found) {
    return `No proposal file exists for ${date}, so today's proposal run has not produced anything.`;
  }
  const s = found.state || {};
  const count = Array.isArray(s.proposals) ? s.proposals.length : 0;
  const when = formatRunTime(s.generatedAt);
  const head = `Last proposal run ${when || `for ${date}`} produced ${count} ${
    count === 1 ? 'proposal' : 'proposals'
  }`;
  const reasons = [];
  if (s.searchError) reasons.push(`search failed (${oneLine(s.searchError, 120)})`);
  if (s.failedQualityGate === true) {
    const scanned = Number(s.candidatesScanned || 0);
    const accepted = Number(s.candidatesAcceptedByJev || 0);
    reasons.push(`quality gate failed (${accepted} of ${scanned} candidates accepted)`);
  }
  const errs = Array.isArray(s.errors) ? s.errors.filter(Boolean) : [];
  if (errs.length) {
    const first = typeof errs[0] === 'string' ? errs[0] : errs[0].message || JSON.stringify(errs[0]);
    reasons.push(`${errs.length} error${errs.length === 1 ? '' : 's'}, first: ${oneLine(first, 120)}`);
  }
  if (!reasons.length) reasons.push('no reason was recorded');
  return `${head}: ${reasons.join('; ')}.`;
}

// manifest: parsed content-review manifest or null. readyCount: videos built
// and awaiting approval (videoReadyForApproval). Returns
// { empty, status: 'red'|'yellow'|null, cause, proposalsInFlight, builtAwaiting }.
function evaluateContentPipeline({
  date,
  now = new Date(),
  manifest = null,
  readyCount = 0,
  dirs = [],
  fsImpl = fs,
} = {}) {
  const day = date || centralDate(now);
  const found = readProposalDay(day, dirs, fsImpl);
  const inFlight = proposalsInFlight(found && found.state).length;
  const ready = Number(readyCount) || 0;
  if (ready > 0) {
    return { empty: false, status: null, cause: '', proposalsInFlight: inFlight, builtAwaiting: ready };
  }
  if (inFlight > 0) {
    return {
      empty: false,
      status: 'yellow',
      cause: `${inFlight} proposal${inFlight === 1 ? ' is' : 's are'} in flight for ${day}; no video is built yet.`,
      proposalsInFlight: inFlight,
      builtAwaiting: 0,
    };
  }
  const last = lastBuiltVideo(manifest && manifest.videos);
  const lastText = last
    ? ` Last built video: ${last.date || 'date unknown'} ${last.title || 'untitled'}.`
    : manifest
      ? ' No built video is on record.'
      : ' The content-review manifest is missing, so no built video is on record.';
  return {
    empty: true,
    status: 'red',
    cause: `No videos in the pipeline. ${describeProposalRun(day, found)}${lastText}`,
    proposalsInFlight: 0,
    builtAwaiting: 0,
  };
}

module.exports = {
  TERMINAL_PROPOSAL_STATUSES,
  centralDate,
  readProposalDay,
  proposalsInFlight,
  describeProposalRun,
  lastBuiltVideo,
  evaluateContentPipeline,
};
