// scripts/lib/otter-empty-shell.js
//
// One rule for "this recorder call is an empty shell": no transcript text, no
// segments, and recorder never gave it a title (the title is still the otid).
// The call-processing ledger closes such a call as a terminal empty_otter_call;
// the diarized segment backfill must agree, or one empty recording fails the
// speaker step on every run and blocks the rest of the voice pipeline
// (#b 2026-10-30 S-1, call _r_oAfRasc4JVfiHsWO3aubEli8, 264 s, no speech).

function isEmptyOtterShell(row = {}, otid = '') {
  const transcript = row.transcript;
  const hasTranscript =
    (typeof transcript === 'string' && Boolean(transcript.trim())) ||
    (Array.isArray(transcript) && transcript.length > 0) ||
    Number(row.transcript_chars || 0) > 0;
  const segments = row.otter_segments || row.segments;
  return (
    !hasTranscript &&
    (!Array.isArray(segments) || segments.length === 0) &&
    String(row.title || '').trim() === String(otid || '')
  );
}

module.exports = { isEmptyOtterShell };
