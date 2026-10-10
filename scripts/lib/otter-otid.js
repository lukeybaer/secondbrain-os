/**
 * Canonical Otter speech-id normalization.
 *
 * Raw transcript files are written by two paths that disagree on the `id`
 * field: `otter-ingest-watch.js` stores the bare otid (e.g.
 * "mdA9IFF0YB6EcecWrwHnGVyNzvY") while `otter-pull-today.js` historically
 * stored "otter_<otid>". Downstream code derives the otid from `raw.id` and
 * calls the Otter `/speech` API with it; a prefixed value 404s ("Speech not
 * found") and also leaks the prefix into enriched filenames.
 *
 * Category fix (feedback_frugal_regression_tests.md): every otid derivation
 * must yield the bare id regardless of which writer produced the raw file.
 */

function normalizeOtid(value) {
  const s = String(value || '').trim();
  return s.replace(/^otter_/, '');
}

/**
 * Pull the canonical bare otid out of a parsed raw transcript object,
 * tolerating the id/otid/speech_id field drift and the otter_ prefix.
 */
function rawOtid(raw) {
  if (!raw || typeof raw !== 'object') return '';
  return normalizeOtid(raw.otterId || raw.id || raw.otid || raw.speech_id || '');
}

module.exports = { normalizeOtid, rawOtid };
