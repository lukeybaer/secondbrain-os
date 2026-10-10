'use strict';

const REPUTATION_SCAN_MAX_AGE_MS = 30 * 60 * 60 * 1000;

function reputationArtifactTimestamp(artifact) {
  return String(
    artifact && (artifact.generatedAt || artifact.generated_at || artifact.ts || ''),
  ).trim();
}

function reputationArtifactIsFresh(artifact, { nowMs = Date.now() } = {}) {
  const generatedAtMs = Date.parse(reputationArtifactTimestamp(artifact));
  const clockMs = Number(nowMs);
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(clockMs)) return false;
  const ageMs = clockMs - generatedAtMs;
  return ageMs >= 0 && ageMs <= REPUTATION_SCAN_MAX_AGE_MS;
}

module.exports = {
  REPUTATION_SCAN_MAX_AGE_MS,
  reputationArtifactTimestamp,
  reputationArtifactIsFresh,
};
