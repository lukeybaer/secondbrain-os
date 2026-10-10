'use strict';

function loadedArtifactGenerationRows(sections = []) {
  return (sections || [])
    .map((section) => section && section.artifact)
    .filter((artifact) => artifact && artifact.id && artifact.acceptedGenerationId)
    .map((artifact) => ({
      id: String(artifact.id),
      generationId: String(artifact.acceptedGenerationId),
    }));
}

function generationRowsForBriefingRender({ sections = [], loadedGateAPreview = null, liveBoard = null, date = '' } = {}) {
  if (loadedGateAPreview) return loadedArtifactGenerationRows(sections);
  if (
    !liveBoard ||
    !liveBoard.artifact ||
    liveBoard.stale ||
    liveBoard.artifact.date !== date ||
    !Array.isArray(liveBoard.artifact.cards)
  ) {
    return [];
  }
  return liveBoard.artifact.cards;
}

function generationIdForBriefingSection({ section = null, loadedGateAPreview = null, liveCard = null } = {}) {
  if (loadedGateAPreview) {
    return String((section && section.artifact && section.artifact.acceptedGenerationId) || '');
  }
  return String((liveCard && liveCard.generationId) || '');
}

function statusForBriefingSection({ section = null, loadedGateAPreview = null, liveCard = null } = {}) {
  const candidate = section && section.artifact;
  const candidateGenerationId = String((candidate && candidate.acceptedGenerationId) || '');
  const isLoadedCandidate = Boolean(
    loadedGateAPreview &&
    candidate &&
    String(candidate.id || '') === String(loadedGateAPreview.cardId || '') &&
    candidateGenerationId &&
    candidateGenerationId === String(loadedGateAPreview.generationId || ''),
  );
  // The loader, not the query string, establishes loadedGateAPreview after
  // manifest/journal/hash validation. Only that exact card may escape the
  // incumbent live-board status during Gate A; siblings remain accepted truth.
  if (isLoadedCandidate) return candidate.status === 'clean' ? 'green' : 'red';
  if (liveCard) return liveCard.status === 'clean' ? 'green' : 'red';
  return '';
}

module.exports = {
  generationIdForBriefingSection,
  generationRowsForBriefingRender,
  loadedArtifactGenerationRows,
  statusForBriefingSection,
};
