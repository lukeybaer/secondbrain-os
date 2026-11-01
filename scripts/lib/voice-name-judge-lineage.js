'use strict';

/**
 * Lineage worker for retired name-judge records (Owner decision: "build the
 * full fix ... lineage worker").
 *
 * A retired record is an old name judgment whose cluster id no longer exists.
 * The orphan scan maps it forward by CALL id, and a call carries several
 * speaker tracks, so a call can sit in several current clusters at once. When
 * every candidate is already judged, ordinary re-judging never clears it: that
 * is `lineage_blocked`.
 *
 * Call ids are the wrong unit. The recluster history records which speaker
 * TRACKS (`otid|speaker_model_label`) the retired id held, and today's
 * recluster records which cluster holds each track, so the record can be
 * followed to the voice it described instead of to every voice on the call.
 *
 * Outcomes, one per record, each with a receipt:
 *   - resolved_into_confirmed: every surviving judged track now sits in a
 *     confirmed or frozen identity. Finished work. A judged name that disagrees
 *     with the confirmed person is flagged, never applied: names never overrule
 *     voice evidence.
 *   - superseded_by_lineage: every unknown holder already carries a judgment
 *     under its current fingerprint that heard the judged calls.
 *   - rejudge_dispatched: an unknown holder has not been judged on those calls,
 *     so the CURRENT holder id is handed to the ordinary re-judge dispatch.
 *   - untraceable: no judged track survives in any current cluster (the call
 *     was re-diarized, or the id never appears in the recluster history). The
 *     name cannot attach to any voice that exists, so it is closed with that
 *     reason rather than left as a permanent yellow.
 *   - history_incomplete: the id was not found and some history file could
 *     not be read or parsed, so "not found" is unproven. Stays blocked; never
 *     closed as untraceable on a partial scan.
 *
 * Every outcome with confirmed holders carries their tracks and any name
 * disagreement, even while unknown holders are still draining, so a mixed
 * confirmed group always reaches the red review lane.
 */

const fs = require('fs');
const path = require('path');
const { fingerprintCluster } = require('./voice-name-judge-coverage.js');
const { judgedCallOtids } = require('./voice-name-judge-orphans.js');
const { namesPossiblySame, personNameTokens } = require('./voice-direct-address-contradiction.js');

const LINEAGE_SCHEMA = 'voice_name_judge_lineage.v1';
const LINEAGE_CACHE_SCHEMA = 'voice_name_judge_lineage_cache.v1';
const OUTCOME = Object.freeze({
  RESOLVED: 'resolved_into_confirmed',
  SUPERSEDED: 'superseded_by_lineage',
  REJUDGE: 'rejudge_dispatched',
  UNTRACEABLE: 'untraceable',
  HISTORY_INCOMPLETE: 'history_incomplete',
});
const CLOSED_OUTCOMES = new Set([OUTCOME.RESOLVED, OUTCOME.SUPERSEDED, OUTCOME.UNTRACEABLE]);

function trackKey(member = {}) {
  const otid = String(member?.otid || '').trim();
  const label = String(member?.speaker_model_label || '').trim();
  return otid && label ? `${otid}|${label}` : '';
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Last known track membership for each retired id, from the recluster history.
 *
 * The history is ~6 GB. Every file read is parsed so a corrupt file can never
 * count as proof of absence; the string match only picks which clusters to
 * inspect. The cache remembers both what was found and how far each miss has been
 * searched (`searched_through_mtime`). A target already searched only reads
 * files written after that point, so the full scan runs once per new target.
 * Newest files first: the newest membership is the one the judge most likely
 * saw, and once every target is found the scan stops.
 */
function lineageMemberships({ targets, runsDir, cache = {} }) {
  const found = { ...(cache.found || {}) };
  const searched = { ...(cache.searched_through_mtime || {}) };
  const want = new Set(targets.filter((target) => !found[target]));
  let files = [];
  try {
    files = fs
      .readdirSync(runsDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ name, mtime: fs.statSync(path.join(runsDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return { found, searched, files_read: 0, history_readable: false, history_complete: false };
  }
  const newestMtime = files.length ? files[0].mtime : 0;
  let filesRead = 0;
  // Any unreadable or unparseable candidate file makes the scan incomplete:
  // the watermark does not advance, and misses are not proof of absence.
  let complete = true;
  for (const file of files) {
    if (!want.size) break;
    const pending = [...want].filter((target) => !(searched[target] >= file.mtime));
    if (!pending.length) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(runsDir, file.name), 'utf8');
    } catch {
      complete = false;
      continue;
    }
    filesRead += 1;
    // Every file read is parsed, hit or not: a truncated file that lacks the
    // literal is not proof the id was absent from it.
    let run = null;
    try {
      run = JSON.parse(text);
    } catch {
      complete = false;
      continue;
    }
    if (!run || !Array.isArray(run.clusters)) {
      complete = false;
      continue;
    }
    const hits = pending.filter((target) => text.includes(target));
    if (!hits.length) continue;
    const hitSet = new Set(hits);
    for (const cluster of run.clusters) {
      const id = String(cluster?.cluster_id || '');
      if (!hitSet.has(id) || found[id]) continue;
      found[id] = {
        run_file: file.name,
        run_id: String(run?.run_id || ''),
        track_keys: (cluster.members || []).map(trackKey).filter(Boolean),
      };
      want.delete(id);
    }
  }
  if (complete) for (const target of want) searched[target] = newestMtime;
  return { found, searched, files_read: filesRead, history_readable: true, history_complete: complete };
}

/**
 * Decide one retired record against today's clusters, from its traced tracks.
 */
function decideLineage({ row, proposal, membership, holderByTrack, judgments, historyComplete = true }) {
  const judged = proposal ? judgedCallOtids(proposal.summary, proposal.row).otids : new Set();
  const traced = (membership?.track_keys || []).filter(
    (key) => !judged.size || judged.has(key.split('|')[0]),
  );
  const holders = new Map();
  for (const key of traced) {
    const cluster = holderByTrack.get(key);
    if (!cluster) continue;
    const id = String(cluster.cluster_id || '');
    if (!holders.has(id)) holders.set(id, { cluster, otids: new Set(), keys: [] });
    holders.get(id).otids.add(key.split('|')[0]);
    holders.get(id).keys.push(key);
  }
  const base = {
    target: row.target,
    best_name: row.best_name || '',
    judged_at: row.judged_at || '',
    artifact: row.artifact || '',
    traced_from_run: membership?.run_id || '',
    traced_track_count: traced.length,
    holders: [...holders.keys()],
  };
  if (!membership && !historyComplete) {
    return {
      ...base,
      outcome: OUTCOME.HISTORY_INCOMPLETE,
      reason: 'some recluster history files could not be read, so the retired id was not proven absent',
    };
  }
  if (!holders.size) {
    return {
      ...base,
      outcome: OUTCOME.UNTRACEABLE,
      reason: membership
        ? 'none of the judged speaker tracks exists in any current cluster, so the name cannot attach to a voice that exists'
        : 'the retired id does not appear in any recluster history run, so its tracks cannot be followed',
    };
  }
  const unknown = [...holders.values()].filter(
    ({ cluster }) => !cluster.confirmed_person_id && !cluster.frozen,
  );
  // Confirmed holders are judged on their own, whatever the unknown holders
  // still need. Nickname, prefix and ASR spelling families count as the same
  // name (a short form, a full form, or a misspelling), so only a genuinely
  // different name is flagged.
  const confirmedHolders = [...holders].filter(([, { cluster }]) => cluster.confirmed_person_id);
  const confirmed = {
    confirmed_people: [...new Set(confirmedHolders.map(([, { cluster }]) => cluster.confirmed_person_id))],
    holder_tracks: Object.fromEntries(confirmedHolders.map(([id, entry]) => [id, entry.keys])),
    name_disagrees_with: confirmedHolders
      .filter(() => base.best_name)
      .filter(
        ([, { cluster }]) =>
          !personNameTokens(cluster.confirmed_person_id, cluster.confirmed_display_name).some(
            (token) => namesPossiblySame(base.best_name, token),
          ),
      )
      .map(([, { cluster }]) => cluster.confirmed_person_id),
  };
  if (!unknown.length) {
    return {
      ...base,
      outcome: OUTCOME.RESOLVED,
      ...confirmed,
      reason: 'every judged track now sits inside a confirmed identity',
    };
  }
  const needsJudge = unknown.filter(({ cluster, otids }) => {
    const fingerprint = fingerprintCluster(cluster);
    if (!fingerprint) return true;
    return !(judgments.get(String(cluster.cluster_id)) || []).some((entry) => {
      if (entry.fingerprint !== fingerprint) return false;
      const heard = judgedCallOtids(entry.summary, entry.row).otids;
      return [...otids].every((otid) => heard.has(otid));
    });
  });
  if (!needsJudge.length) {
    return {
      ...base,
      outcome: OUTCOME.SUPERSEDED,
      ...confirmed,
      reason: 'every unknown voice holding the judged tracks has its own current judgment that heard those calls',
    };
  }
  return {
    ...base,
    outcome: OUTCOME.REJUDGE,
    ...confirmed,
    rejudge_targets: needsJudge.map(({ cluster }) => String(cluster.cluster_id)),
    reason: 'an unknown voice now holding the judged tracks was never judged on those calls',
  };
}

/**
 * Resolve every lineage-blocked record. Pure apart from reading the history.
 */
function resolveLineageBlocked({ rows, recluster, judgments, runsDir, cache = {} }) {
  const targets = rows.map((row) => String(row.target));
  const history = lineageMemberships({ targets, runsDir, cache });
  const holderByTrack = new Map();
  for (const cluster of recluster?.clusters || []) {
    for (const member of cluster.members || []) {
      const key = trackKey(member);
      if (key) holderByTrack.set(key, cluster);
    }
  }
  const outcomes = rows.map((row) => {
    const proposal = (judgments.get(String(row.target)) || []).find(
      (entry) => entry.artifact === row.artifact,
    );
    return decideLineage({
      row,
      proposal,
      membership: history.found[String(row.target)] || null,
      holderByTrack,
      judgments,
      historyComplete: history.history_complete !== false,
    });
  });
  const counts = Object.values(OUTCOME).reduce((acc, outcome) => ({ ...acc, [outcome]: 0 }), {});
  for (const entry of outcomes) counts[entry.outcome] += 1;
  return {
    outcomes,
    counts,
    history_readable: history.history_readable,
    history_complete: history.history_complete !== false,
    history_files_read: history.files_read,
    cache: {
      schema: LINEAGE_CACHE_SCHEMA,
      found: history.found,
      searched_through_mtime: history.searched,
    },
  };
}

/**
 * Fold the worker's outcomes back into the orphan scan's counts and rows.
 *
 * Closed records leave the unresolvable set. Re-judge dispatches are draining
 * work now, because the ordinary judge will reach the dispatched holder. Only
 * a record the worker could not process (history unreadable) stays blocked.
 */
function applyLineageOutcomes({ counts, unresolvableRows, lineage }) {
  const next = { ...counts };
  const byTarget = new Map((lineage?.outcomes || []).map((entry) => [String(entry.target), entry]));
  next.retired_targets_lineage_closed = 0;
  next.retired_targets_lineage_rejudge = 0;
  next.retired_targets_lineage_name_disagreements = 0;
  if (!lineage || lineage.history_readable === false) {
    return { counts: next, unresolvableRows, lineageBlockedRows: unresolvableRows.filter((row) => row.disposition === 'lineage_blocked') };
  }
  const rows = [];
  for (const row of unresolvableRows) {
    const outcome = row.disposition === 'lineage_blocked' ? byTarget.get(String(row.target)) : null;
    if (!outcome) {
      rows.push(row);
      continue;
    }
    if ((outcome.name_disagrees_with || []).length) next.retired_targets_lineage_name_disagreements += 1;
    if (outcome.outcome === OUTCOME.HISTORY_INCOMPLETE) {
      rows.push({ ...row, lineage_outcome: outcome.outcome });
      continue;
    }
    next.retired_targets_lineage_blocked -= 1;
    if (CLOSED_OUTCOMES.has(outcome.outcome)) {
      next.retired_targets_unresolvable -= 1;
      next.retired_targets_lineage_closed += 1;
      continue;
    }
    next.retired_targets_auto_draining += 1;
    next.retired_targets_lineage_rejudge += 1;
    rows.push({ ...row, disposition: 'auto_draining', lineage_outcome: outcome.outcome, rejudge_targets: outcome.rejudge_targets });
  }
  return {
    counts: next,
    unresolvableRows: rows,
    lineageBlockedRows: rows.filter((row) => row.disposition === 'lineage_blocked'),
  };
}

module.exports = {
  CLOSED_OUTCOMES,
  applyLineageOutcomes,
  LINEAGE_CACHE_SCHEMA,
  LINEAGE_SCHEMA,
  OUTCOME,
  decideLineage,
  lineageMemberships,
  readJson,
  resolveLineageBlocked,
  trackKey,
};
