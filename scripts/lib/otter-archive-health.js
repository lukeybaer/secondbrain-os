'use strict';

/**
 * Shared "Past-7-day Otter archive health" display-status computation for the
 * VOICE CONFIRMATION / SPEAKER LEARNING card.
 *
 * The underlying otter-text-audio-coverage-latest.json `last_7_days.status` is
 * RED when a repairable timestamp wall falls outside its audio's duration, even
 * when every call in the window has full audio and every transcript segment is
 * backed by that audio. A SMALL rounding-tail of out-of-bounds timestamps (a
 * couple of segments landing microscopically past the audio's end -- an
 * encoding/rounding artifact) is not a missing-audio/missing-text problem Amy
 * can repair by re-running an ingest, so the DISPLAY status softens RED to
 * "GREEN with timestamp warnings" for that narrow case (never masking the
 * anomaly count, just not crying "archive health failure" over a rounding
 * quirk).
 *
 * A NEAR-UNIVERSAL timestamp failure is a different animal: it means timestamp
 * verification is functionally broken for the window, which is exactly the
 * kind of recoverable processing defect gradeLast7Coverage() (the function that
 * COMPUTES this RED in the first place, scripts/otter-text-audio-coverage-
 * report.js) calls out as a real repair target. So the downgrade only applies
 * below OUT_OF_BOUNDS_RATE_CAP -- Codex adversarial review 2026-07-06 caught an
 * earlier version of this function downgrading ANY nonzero anomaly count
 * regardless of rate, which would have silently greenwashed a live incident of
 * 2,649/2,651 (99.9%) timestamps out of bounds. A provider-declared duration
 * that agrees with the downloaded audio while the provider's own transcript
 * extends beyond both is a separate, unrecoverable source limitation and is
 * graded YELLOW by the report producer. This helper preserves that YELLOW.
 *
 * One module owns this rule so the render (ec2-server.js
 * otterTextAudioCoverageSummary) and the markdown generator
 * (refresh-briefing-generated-sections.js) can never drift -- ExampleCo 2026-07-06
 * #gap: the render already applied a downgrade but the generator printed the
 * raw RED status straight from the artifact, so the VOICE CONFIRMATION tile hit
 * a real "Past-7-day Otter archive health: RED" line and the render QC (which
 * trusts the generator's own text) correctly, but unhelpfully, flagged the card
 * as a live render defect that no repair loop can ever clear FOR THE ROUNDING-
 * TAIL case. A near-universal failure like 2,649/2,651 must stay RED (a real,
 * repairable defect), not be softened.
 */

// Mirrors gradeLast7Coverage's own in-bounds tolerance (>= 99.9% in bounds is
// GREEN at the artifact level): the DISPLAY downgrade only applies to the
// SAME small-tail band, so "GREEN with timestamp warnings" can never cover a
// failure gradeLast7Coverage itself would call a real repairable defect.
const OUT_OF_BOUNDS_RATE_CAP = 0.001;

function computeLast7DisplayStatus(last7) {
  const l7 = last7 || {};
  const h = l7.summary || {};
  const audioComplete =
    Number(h.calls_missing_full_audio || 0) === 0 &&
    Number(h.calls_with_full_audio || 0) === Number(h.unique_real_otter_calls || 0) &&
    Number(h.segments_in_calls_with_full_audio || 0) ===
      Number(h.transcript_text_segments_total || 0);
  const timestampAnomalies = Number(h.timestamped_segments_outside_audio_duration || 0);
  const timestampedInAudioCalls = Number(h.timestamped_segments_in_audio_calls || 0);
  // Segments whose audio duration the probe could not read were neither
  // verified nor out of bounds (the 2026-07-06 ffprobe-PATH incident). A RED
  // driven even partly by unverifiable segments is a probe repair the grade is
  // naming honestly -- the rounding-tail downgrade must never soften it.
  const unverifiable = Number(h.timestamped_segments_unverifiable_audio_duration || 0);
  const outOfBoundsRate =
    timestampedInAudioCalls > 0 ? timestampAnomalies / timestampedInAudioCalls : 0;
  const isSmallRoundingTail =
    timestampAnomalies > 0 &&
    timestampedInAudioCalls > 0 &&
    unverifiable === 0 &&
    outOfBoundsRate <= OUT_OF_BOUNDS_RATE_CAP;
  const isRed = String(l7.status || '').toUpperCase() === 'RED';
  if (isRed && audioComplete && isSmallRoundingTail) return 'GREEN with timestamp warnings';
  return l7.status || '';
}

// Tile-status guard for the VOICE CONFIRMATION card: the per-card artifact body
// may carry a stale archive-health label (e.g. "GREEN" when the artifact was
// generated, "RED" by the time the dashboard renders because the coverage report
// re-ran). The live coverage JSON (via parseVoiceConfirmationBody ->
// otterTextAudioCoverageSummary) is authoritative. When the two diverge, the
// tile status must reflect the WORSE of the body-parsed stat and the live
// archive health so a stale GREEN artifact body can never hide a live RED state.
//
// Hierarchy: red(3) > yellow(2) > green(1). "GREEN with timestamp warnings" maps
// to rank 1 (same as green) so it never UPGRADES a tile above green. PRIVATE_NAME or
// empty statuses rank 0 -- never let a missing live status downgrade an honest
// body-parsed status.
//
// Provenance: this shipped as an UNTRACKED hot-patch applied directly to the
// running release /opt/secondbrain during the 2026-07-18 incident and existed in
// no git history, so the next deploy-ec2-server.sh would have silently destroyed
// an anti-greenwashing guard. Forward-ported here 2026-07-18 so prod and master
// agree and the guard is version-controlled. See dev-plans/core/briefing.md.
function _archiveStatusRank(s) {
  const lower = String(s || '').toLowerCase();
  if (lower === 'red') return 3;
  if (lower === 'yellow') return 2;
  if (lower.startsWith('green')) return 1;
  return 0;
}

function upgradeVoiceConfirmationStat(stat, data) {
  if (!stat || !data || data.kind !== 'voiceConfirmation') return stat;
  const coverage = data.textAudioCoverage;
  if (!coverage) return stat;
  const liveL7Status = String((coverage.last7 || {}).status || '').toLowerCase();
  if (_archiveStatusRank(liveL7Status) > _archiveStatusRank(stat.status || '')) {
    return { ...stat, status: liveL7Status };
  }
  return stat;
}

module.exports = { computeLast7DisplayStatus, upgradeVoiceConfirmationStat };
