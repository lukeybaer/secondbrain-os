'use strict';

const OTTER_OFFSET_DIVISOR_CANDIDATES = [1000, 8000, 16000];

/**
 * Otter segment offsets use provider units while word alignment uses real
 * seconds relative to the segment. Their ratio is the only duration-independent
 * authority for the provider timebase. Recording duration includes silence and
 * must never override this evidence.
 */
function deriveDivisorFromAlignment(rows) {
  const ratios = [];
  for (const t of rows || []) {
    const span = Number(t.end_offset) - Number(t.start_offset);
    if (!Number.isFinite(span) || span <= 0) continue;
    const ends = (Array.isArray(t.alignment) ? t.alignment : [])
      .map((word) => Number(word.end))
      .filter(Number.isFinite);
    if (!ends.length) continue;
    const maxWordEnd = Math.max(...ends);
    if (!(maxWordEnd >= 0.5)) continue;
    ratios.push(span / maxWordEnd);
  }
  if (!ratios.length) return null;
  ratios.sort((a, b) => a - b);
  // Trailing silence can only inflate span/maxWordEnd. It cannot deflate it
  // below the true divisor, so the minimum observed ratio is the tightest
  // estimate. A median would be pulled upward by gappy segments.
  const tightestRatio = ratios[0];
  let best = null;
  for (const divisor of OTTER_OFFSET_DIVISOR_CANDIDATES) {
    const error = Math.abs(tightestRatio - divisor) / divisor;
    if (!best || error < best.error) best = { divisor, error };
  }
  if (!best || best.error > 0.15) return null;
  return {
    divisor: best.divisor,
    medianRatio: Number(tightestRatio.toFixed(3)),
    samples: ratios.length,
  };
}

function inferOtterOffsetDivisor(detail = {}) {
  const rows = Array.isArray(detail.transcripts) ? detail.transcripts : [];
  const offsets = rows
    .flatMap((t) => [Number(t.start_offset), Number(t.end_offset)])
    .filter(Number.isFinite);
  const maxOffset = offsets.length ? Math.max(...offsets) : 0;
  const duration = Number(detail.duration || detail.duration_sec || 0);

  const aligned = deriveDivisorFromAlignment(rows);
  if (aligned) {
    const relError =
      maxOffset > 0 && duration > 0
        ? Number(
            (Math.abs(maxOffset / aligned.divisor - duration) / Math.max(duration, 1)).toFixed(4),
          )
        : null;
    return {
      offset_divisor: aligned.divisor,
      max_offset: maxOffset || null,
      duration_seconds: duration || null,
      relative_error: relError,
      timebase_source: 'word-alignment',
      alignment_median_ratio: aligned.medianRatio,
      alignment_samples: aligned.samples,
    };
  }

  if (maxOffset > 0 && duration > 0) {
    const best = OTTER_OFFSET_DIVISOR_CANDIDATES.map((divisor) => ({
      divisor,
      error: Math.abs(maxOffset / divisor - duration) / Math.max(duration, 1),
    })).sort((a, b) => a.error - b.error)[0];
    if (best && best.error < 0.35) {
      return {
        offset_divisor: best.divisor,
        max_offset: maxOffset,
        duration_seconds: duration,
        relative_error: Number(best.error.toFixed(4)),
        timebase_source: 'duration-heuristic',
      };
    }
  }

  return {
    offset_divisor: 1000,
    max_offset: maxOffset || null,
    duration_seconds: duration || null,
    relative_error: null,
    timebase_source: 'unresolved',
    timebase_unresolved: true,
  };
}

module.exports = {
  OTTER_OFFSET_DIVISOR_CANDIDATES,
  deriveDivisorFromAlignment,
  inferOtterOffsetDivisor,
};
