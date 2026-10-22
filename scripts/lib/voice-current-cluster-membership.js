'use strict';

function identityForLabel(enriched, label) {
  const key = String(label || '');
  const track = enriched?.speaker_identity_tracks?.[key] || {};
  const segmentIdentity =
    (enriched?.segments || []).find(
      (segment) => String(segment?.speaker_model_label || '') === key && segment?.resolved_speaker,
    )?.resolved_speaker || {};
  return { ...segmentIdentity, ...track };
}

function currentIdentityTarget(identity) {
  if (identity?.person_id) return `person:${String(identity.person_id)}`;
  return String(
    identity?.acoustic_unknown_id ||
      identity?.unknown_speaker_id ||
      identity?.voice_cluster_id ||
      '',
  );
}

function expectedClusterTarget(cluster) {
  const personId = String(cluster?.confirmed_person_id || '').trim();
  return personId ? `person:${personId}` : String(cluster?.cluster_id || '');
}

function inspectCurrentClusterMembership(cluster, { loadEnriched, currentClusterIds } = {}) {
  const members = Array.isArray(cluster?.members) ? cluster.members : [];
  const expected = expectedClusterTarget(cluster);
  // With a currentClusterIds scope (the recluster artifact's own cluster id
  // space), an enriched target OUTSIDE that space is projection lag, not proof
  // the member moved: enriched tracks carry the artifact's ids only after
  // backprop, and resolver runs mint their own unknown ids per call. A
  // revision advance alone is fetch metadata. Without the scope, the strict
  // legacy semantics apply unchanged.
  const clusterIdScope =
    currentClusterIds == null
      ? null
      : currentClusterIds instanceof Set
        ? currentClusterIds
        : new Set([...currentClusterIds].map(String));
  const inspectable = members.filter(
    (member) => member?.otid && String(member?.speaker_model_label || '').trim(),
  );
  if (!inspectable.length || typeof loadEnriched !== 'function') {
    return {
      status: 'not_checked',
      pure: null,
      expected_target: expected,
      total_members: members.length,
      current_members: members,
      stale_members: [],
      lagged_members: [],
    };
  }

  const currentMembers = [];
  const staleMembers = [];
  const laggedMembers = [];
  for (const member of inspectable) {
    const enriched = loadEnriched(String(member.otid || ''));
    const currentTarget = currentIdentityTarget(
      identityForLabel(enriched, member.speaker_model_label),
    );
    const memberRevision = String(member.source_revision || '').toLowerCase();
    const currentRevision = String(
      enriched?.source_revision_hash || enriched?.source_revision || '',
    ).toLowerCase();
    const revisionMismatch = Boolean(
      memberRevision && currentRevision && memberRevision !== currentRevision,
    );
    const targetChanged = currentTarget !== expected;
    const emptyTarget = !currentTarget;
    const authoritativeMove =
      targetChanged &&
      !emptyTarget &&
      (/^person:/.test(currentTarget) ||
        (clusterIdScope ? clusterIdScope.has(currentTarget) : true));
    const lagReason =
      !clusterIdScope || !enriched
        ? ''
        : targetChanged && !authoritativeMove && !emptyTarget
          ? 'enriched_projection_lag'
          : !targetChanged && revisionMismatch
            ? 'source_revision_advanced'
            : '';
    // An enriched call with NO identity for this label proves nothing about
    // the member; it stays contaminated in both modes.
    const stale = clusterIdScope
      ? Boolean(!enriched || authoritativeMove || emptyTarget)
      : !(enriched && !targetChanged && !revisionMismatch);
    const detail = {
      ...member,
      current_target: currentTarget,
      current_source_revision: currentRevision,
      lag_reason: lagReason,
      stale_reason: !stale
        ? ''
        : !enriched
          ? 'current_enriched_missing'
          : !clusterIdScope && revisionMismatch
            ? 'source_revision_mismatch'
            : targetChanged
              ? 'current_identity_target_changed'
              : 'source_revision_mismatch',
    };
    if (stale) {
      staleMembers.push(detail);
    } else {
      currentMembers.push(detail);
      if (lagReason) laggedMembers.push(detail);
    }
  }

  return {
    status: staleMembers.length ? 'contaminated' : 'current',
    pure: staleMembers.length === 0 && currentMembers.length === inspectable.length,
    expected_target: expected,
    total_members: inspectable.length,
    current_members: currentMembers,
    stale_members: staleMembers,
    lagged_members: laggedMembers,
  };
}

module.exports = {
  identityForLabel,
  currentIdentityTarget,
  expectedClusterTarget,
  inspectCurrentClusterMembership,
};
