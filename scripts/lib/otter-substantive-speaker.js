'use strict';

// Shared acoustic-coverage denominator used by the probe producer and exact
// envelope verifier. Keep this definition centralized so a track cannot be
// probed by one stage and silently omitted by the next.
function isSubstantiveSpeakerTrack(track) {
  return Number(track?.word_count || 0) >= 30 || Number(track?.segment_count || 0) >= 3;
}

module.exports = { isSubstantiveSpeakerTrack };
