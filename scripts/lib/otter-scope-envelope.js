'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function uniqueOrdered(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableObject(value[key])]),
  );
}

function hashPayload(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableObject(value)))
    .digest('hex');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function revisionFromDocument(document = {}) {
  return String(
    document.source_revision_hash ||
      document.source_revision ||
      document.raw_sha256 ||
      document.revision_sha256 ||
      document.revision ||
      '',
  )
    .trim()
    .toLowerCase();
}

function resolveOtidRevision(dataDir, otid) {
  const candidates = [
    path.join(dataDir, 'otter', 'enriched', `${otid}.json`),
    path.join(dataDir, 'otter', 'raw', `${otid}.json`),
    path.join(dataDir, 'otter', 'raw', `archive-s3-${otid}.json`),
  ];
  for (const file of candidates) {
    const document = readJson(file);
    if (!document) continue;
    const documentId = String(
      document.otid || document.id || document.otter_id || document.conversation_id || otid,
    ).trim();
    if (documentId !== otid) continue;
    const revision = revisionFromDocument(document);
    if (revision) return { otid, revision, evidencePath: file };
  }
  return { otid, revision: '', evidencePath: '' };
}

function createOtterScopeEnvelope({
  date,
  cardIds = [],
  workUnitIds = [],
  otids = [],
  dataDir,
  revisions = null,
} = {}) {
  const orderedOtids = uniqueOrdered(otids);
  if (!orderedOtids.length) throw new Error('exact Otter scope requires at least one OTID');
  const revisionMap = new Map(
    (Array.isArray(revisions) ? revisions : [])
      .map((row) => [String(row?.otid || '').trim(), String(row?.revision || '').trim().toLowerCase()])
      .filter(([otid, revision]) => otid && revision),
  );
  const sourceRevisions = orderedOtids.map((otid) => {
    const resolved = revisionMap.has(otid)
      ? { otid, revision: revisionMap.get(otid), evidencePath: '' }
      : resolveOtidRevision(dataDir, otid);
    if (!resolved.revision) {
      throw new Error(`exact Otter scope cannot resolve source revision for '${otid}'`);
    }
    return { otid, revision: resolved.revision };
  });
  const payload = {
    schema: 'amy.otter_exact_scope.v1',
    date: String(date || '').slice(0, 10),
    cardIds: uniqueOrdered(cardIds),
    workUnitIds: uniqueOrdered(workUnitIds),
    otids: orderedOtids,
    sourceRevisions,
  };
  return { ...payload, scopeHash: hashPayload(payload) };
}

function parseOtterScopeEnvelope(value) {
  if (!value) return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || parsed.schema !== 'amy.otter_exact_scope.v1') {
    throw new Error('invalid exact Otter scope envelope schema');
  }
  const payload = {
    schema: parsed.schema,
    date: String(parsed.date || '').slice(0, 10),
    cardIds: uniqueOrdered(parsed.cardIds),
    workUnitIds: uniqueOrdered(parsed.workUnitIds),
    otids: uniqueOrdered(parsed.otids),
    sourceRevisions: (Array.isArray(parsed.sourceRevisions) ? parsed.sourceRevisions : []).map(
      (row) => ({
        otid: String(row?.otid || '').trim(),
        revision: String(row?.revision || '').trim().toLowerCase(),
      }),
    ),
  };
  if (!payload.otids.length || payload.sourceRevisions.length !== payload.otids.length) {
    throw new Error('exact Otter scope envelope is incomplete');
  }
  if (
    payload.sourceRevisions.some(({ otid, revision }, index) =>
      !otid || !revision || otid !== payload.otids[index],
    )
  ) {
    throw new Error('exact Otter scope revisions do not align with ordered OTIDs');
  }
  const expectedHash = hashPayload(payload);
  if (String(parsed.scopeHash || '') !== expectedHash) {
    throw new Error('exact Otter scope envelope hash mismatch');
  }
  return { ...payload, scopeHash: expectedHash };
}

function assertOtterScopeMatches(envelope, { date, otids = [] } = {}) {
  const parsed = parseOtterScopeEnvelope(envelope);
  if (String(date || '').slice(0, 10) !== parsed.date) {
    throw new Error('exact Otter scope date changed in transit');
  }
  if (JSON.stringify(uniqueOrdered(otids)) !== JSON.stringify(parsed.otids)) {
    throw new Error('exact Otter scope OTIDs changed in transit');
  }
  return parsed;
}

function scopedOtterEvidence(envelope, dataDir) {
  const parsed = parseOtterScopeEnvelope(envelope);
  const selectedOtids = new Set(parsed.otids);
  const roster = readJson(
    path.join(
      dataDir,
      'life-archive',
      'voiceprints',
      'otter-call-speaker-rosters-latest.json',
    ),
  );
  const rosterByOtid = new Map(
    (Array.isArray(roster?.calls) ? roster.calls : [])
      .filter((call) => call?.otid)
      .map((call) => [String(call.otid), call]),
  );
  const recluster = readJson(
    path.join(dataDir, 'life-archive', 'voiceprints', 'recluster-latest.json'),
  );
  const resolver = readJson(
    path.join(
      dataDir,
      'life-archive',
      'voiceprints',
      'voice-identity-overnight-name-resolver-status.json',
    ),
  );
  // A successful incremental recluster changes the repairable source even when
  // the immutable transcript revisions, roster rows, and call summaries do not.
  // Keep this evidence exact by retaining only memberships for the envelope's
  // OTIDs. Unrelated reclusters therefore cannot defeat the no-repeat guard.
  const clusterFactsByOtid = new Map(parsed.otids.map((otid) => [otid, []]));
  for (const cluster of Array.isArray(recluster?.clusters) ? recluster.clusters : []) {
    const selectedMembers = (Array.isArray(cluster?.member_track_keys)
      ? cluster.member_track_keys
      : []
    )
      .map((value) => String(value || ''))
      .filter((trackKey) => selectedOtids.has(trackKey.split('|')[0]))
      .sort();
    if (!selectedMembers.length) continue;
    const membership = {
      clusterId: cluster?.cluster_id || null,
      confirmedPersonId: cluster?.confirmed_person_id || null,
      members: selectedMembers,
    };
    for (const trackKey of selectedMembers) {
      clusterFactsByOtid.get(trackKey.split('|')[0]).push(membership);
    }
  }
  // Name resolution is downstream of clustering and can make an exact repair
  // ready without changing transcript revisions or cluster membership. Bind
  // only the semantic terminal result for clusters touched by this OTID scope.
  // Timestamps, run ids, logs, and unrelated cluster results are deliberately
  // excluded so they cannot defeat the no-repeat guard.
  const selectedClusterIds = new Set(
    [...clusterFactsByOtid.values()]
      .flat()
      .map((membership) => String(membership?.clusterId || '').trim())
      .filter(Boolean),
  );
  const resolverFactsByCluster = new Map();
  for (const result of Array.isArray(resolver?.results) ? resolver.results : []) {
    const target = String(result?.target || '').trim();
    if (!selectedClusterIds.has(target)) continue;
    const targetRows = Array.isArray(result?.progress?.targets) ? result.progress.targets : [];
    const terminal =
      [...targetRows].reverse().find((row) => row?.batch === 'consolidation') ||
      targetRows[targetRows.length - 1] ||
      null;
    resolverFactsByCluster.set(target, {
      target,
      ok: result?.ok === true,
      inputFingerprint: String(result?.input_fingerprint || ''),
      bestName: terminal?.best_name || null,
      canonicalPersonId: terminal?.canonical_person_id_if_known || null,
      confidence: terminal?.confidence ?? null,
      clearEvidenceCount: Number(terminal?.clear_evidence_count || 0),
      directNameEvidenceCount: Number(terminal?.direct_name_evidence_count || 0),
      counterevidenceCount: Number(terminal?.counterevidence_count || 0),
    });
  }
  const facts = parsed.sourceRevisions.map(({ otid, revision }) => {
    const current = resolveOtidRevision(dataDir, otid);
    const summaryPath = path.join(dataDir, 'agent', 'otter-call-exec-summaries', `${otid}.json`);
    const summary = readJson(summaryPath);
    const rosterCall = rosterByOtid.get(otid) || null;
    return {
      otid,
      expectedRevision: revision,
      currentRevision: current.revision || null,
      revisionMatches: current.revision === revision,
      rosterHash: rosterCall ? hashPayload(rosterCall) : null,
      summaryStatus: summary?.status || null,
      summaryGeneratedAt: summary?.generatedAt || summary?.generated_at || null,
      summaryHash: summary ? hashPayload(summary) : null,
      clusterMemberships: (clusterFactsByOtid.get(otid) || []).sort((left, right) =>
        String(left.clusterId || '').localeCompare(String(right.clusterId || '')),
      ),
      resolverFacts: (clusterFactsByOtid.get(otid) || [])
        .map((membership) => resolverFactsByCluster.get(String(membership?.clusterId || '')))
        .filter(Boolean)
        .sort((left, right) => left.target.localeCompare(right.target)),
    };
  });
  return { digest: hashPayload({ scopeHash: parsed.scopeHash, facts }), facts };
}

function isOtterScopeFamily(family) {
  return family === 'otter' || family === 'otter-pareto';
}

module.exports = {
  assertOtterScopeMatches,
  createOtterScopeEnvelope,
  hashPayload,
  isOtterScopeFamily,
  parseOtterScopeEnvelope,
  resolveOtidRevision,
  scopedOtterEvidence,
  uniqueOrdered,
};
