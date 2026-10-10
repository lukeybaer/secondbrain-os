'use strict';

function normalizeVideoManifestEntries(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.videos)) return raw.videos;
  if (!raw || typeof raw !== 'object') return [];
  return Object.values(raw).filter(
    (value) => value && typeof value === 'object' && typeof value.id === 'string',
  );
}

function withVideoManifestEntries(raw, entries) {
  const document = raw && !Array.isArray(raw) && typeof raw === 'object' && Array.isArray(raw.videos)
    ? { ...raw }
    : {};
  document.videos = Array.isArray(entries) ? entries : [];
  return document;
}

module.exports = { normalizeVideoManifestEntries, withVideoManifestEntries };
