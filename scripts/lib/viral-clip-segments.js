'use strict';

// Woven viral clip segments, the shared contract for the proposer
// (scripts/viral-tech-clip-proposals.js), the dashboard card (ec2-server.js),
// and the builder (scripts/build-viral-clip.js).
//
// ExampleCo 2026-09-23: "this message isn't quite complete, you need to weave a
// couple clips together with some graphics to marry them up." A proposed short
// is a complete argument, not one fragment: 2 to 4 complete-sentence source
// segments that together make a whole point, joined by motion-graphics
// interstitials (one bridge line between each pair). The approved default
// motion style lives in
// skills/work/video-production/references/examplechannel-benchmark-motion.md.
//
// Legacy proposals without `segments` keep building as one range.

const SEGMENT_LIMITS = Object.freeze({
  minSegments: 2,
  maxSegments: 4,
  minSeconds: 4,
  maxSeconds: 30,
  minTotalSeconds: 12,
  maxTotalSeconds: 75,
  bridgeMaxChars: 40,
  bridgeMaxWords: 7,
});

const DEFAULT_BRIDGE_SECONDS = 1.6;
const FINAL_MAX_SECONDS = 75;
const DEFAULT_TAIL_SECONDS = 2;
const SENTENCE_END = /[.!?]["')\]]?\s*$/;

function timestampSeconds(value) {
  const parts = String(value || '')
    .trim()
    .split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const seconds = nums.reduce((total, n) => total * 60 + n, 0);
  return Number(seconds.toFixed(3));
}

function parseSegmentRange(value) {
  const match = String(value || '').match(
    /^\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\s*(?:-|to)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\s*$/i,
  );
  if (!match) return null;
  const startSec = timestampSeconds(match[1]);
  const endSec = timestampSeconds(match[2]);
  if (startSec == null || endSec == null || endSec <= startSec) return null;
  return { startSec, endSec };
}

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCompleteSentenceText(text) {
  const clean = cleanText(text);
  if (clean.split(' ').length < 4) return false;
  if (!/^["'(\[]?[A-Z0-9]/.test(clean)) return false;
  return SENTENCE_END.test(clean);
}

// Validates the woven-argument fields on a proposal. Returns normalized
// segments so every consumer reads the same shape:
//   { index, role, startSec, endSec, approxTimestamp, says, bridge, sourceAnchor }
// `bridge` is the interstitial line shown BEFORE that segment ('' for the first).
function validateClipSegments(proposal, { durationSeconds = 0 } = {}) {
  const errors = [];
  const raw = proposal && Array.isArray(proposal.segments) ? proposal.segments : [];
  const bridges = proposal && Array.isArray(proposal.bridges) ? proposal.bridges : [];
  if (raw.length < SEGMENT_LIMITS.minSegments || raw.length > SEGMENT_LIMITS.maxSegments) {
    errors.push(
      `segments must hold ${SEGMENT_LIMITS.minSegments} to ${SEGMENT_LIMITS.maxSegments} complete-sentence source segments (got ${raw.length})`,
    );
  }
  if (bridges.length !== Math.max(0, raw.length - 1)) {
    errors.push(
      `bridges must hold exactly one bridge line between each segment pair (need ${Math.max(0, raw.length - 1)}, got ${bridges.length})`,
    );
  }
  const duration = Number(durationSeconds) || 0;
  const segments = [];
  raw.forEach((segment, index) => {
    const label = `segment ${index + 1}`;
    const range = parseSegmentRange(segment && segment.approx_timestamp);
    if (!range) {
      errors.push(`${label} approx_timestamp does not parse as a real range`);
      return;
    }
    const seconds = Number((range.endSec - range.startSec).toFixed(3));
    if (seconds < SEGMENT_LIMITS.minSeconds || seconds > SEGMENT_LIMITS.maxSeconds) {
      errors.push(
        `${label} runs ${seconds} seconds; each segment must run ${SEGMENT_LIMITS.minSeconds} to ${SEGMENT_LIMITS.maxSeconds} seconds`,
      );
    }
    if (duration > 0 && range.endSec > duration) {
      errors.push(`${label} ends beyond the source runtime`);
    }
    const says = cleanText(segment && segment.says);
    if (!isCompleteSentenceText(says)) {
      errors.push(`${label} says must be one or more complete sentences spoken in the source`);
    }
    const bridge = index === 0 ? '' : cleanText(bridges[index - 1]).toUpperCase();
    if (index > 0) {
      const words = bridge ? bridge.split(' ').length : 0;
      if (
        !bridge ||
        bridge.length > SEGMENT_LIMITS.bridgeMaxChars ||
        words > SEGMENT_LIMITS.bridgeMaxWords
      ) {
        errors.push(
          `bridge ${index} must be 1 to ${SEGMENT_LIMITS.bridgeMaxWords} words and at most ${SEGMENT_LIMITS.bridgeMaxChars} characters`,
        );
      }
    }
    segments.push({
      index,
      role: cleanText(segment && segment.role) || (index === 0 ? 'claim' : 'support'),
      startSec: range.startSec,
      endSec: range.endSec,
      approxTimestamp: cleanText(segment.approx_timestamp),
      says,
      bridge,
      sourceAnchor: cleanText(segment && segment.source_anchor),
    });
  });
  const sorted = [...segments].sort((a, b) => a.startSec - b.startSec);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].startSec < sorted[i - 1].endSec) {
      errors.push(
        `segments ${sorted[i - 1].index + 1} and ${sorted[i].index + 1} overlap in the source`,
      );
    }
  }
  const total = Number(segments.reduce((sum, s) => sum + (s.endSec - s.startSec), 0).toFixed(3));
  const projectedFinalSeconds = Number((total + Math.max(0, segments.length - 1) * DEFAULT_BRIDGE_SECONDS + DEFAULT_TAIL_SECONDS).toFixed(3));
  if (
    segments.length &&
    (total < SEGMENT_LIMITS.minTotalSeconds || total > SEGMENT_LIMITS.maxTotalSeconds)
  ) {
    errors.push(
      `woven speech totals ${total} seconds; keep it between ${SEGMENT_LIMITS.minTotalSeconds} and ${SEGMENT_LIMITS.maxTotalSeconds}`,
    );
  }
  if (segments.length && projectedFinalSeconds > FINAL_MAX_SECONDS) {
    errors.push(
      `finished short projects to ${projectedFinalSeconds} seconds including bridges and tail; keep the final video at or below ${FINAL_MAX_SECONDS} seconds`,
    );
  }
  return { ok: errors.length === 0, errors, segments };
}

// Builder entry point. A proposal that declares segments must satisfy the
// contract (fail closed before any source acquisition). A legacy proposal
// with only approx_timestamp still builds as one segment.
function resolveClipSegments(proposal, options = {}) {
  if (proposal && Array.isArray(proposal.segments) && proposal.segments.length > 0) {
    const result = validateClipSegments(proposal, options);
    if (!result.ok) {
      throw new Error('woven clip segments invalid: ' + result.errors.join('; '));
    }
    return { mode: 'woven', segments: result.segments };
  }
  const range = parseSegmentRange(proposal && proposal.approx_timestamp);
  // The builder's legacy single-range parser stays the authority for this
  // path and reports its own parse error.
  if (!range) return { mode: 'single', segments: [] };
  return {
    mode: 'single',
    segments: [
      {
        index: 0,
        role: 'clip',
        startSec: range.startSec,
        endSec: range.endSec,
        approxTimestamp: cleanText(proposal.approx_timestamp),
        says: '',
        bridge: '',
        sourceAnchor: '',
      },
    ],
  };
}

// Lays segments and bridge interstitials on the output timeline in proposal
// order. The payoff tail follows the final segment.
function planWovenTimeline(
  segments,
  { bridgeSeconds = DEFAULT_BRIDGE_SECONDS, tailSeconds = 0 } = {},
) {
  const entries = [];
  const bridges = [];
  let cursor = 0;
  const count = segments.length;
  segments.forEach((segment, i) => {
    if (i > 0) {
      const bridge = {
        kind: 'bridge',
        index: segment.index,
        text: segment.bridge,
        outStart: cursor,
        outEnd: Number((cursor + bridgeSeconds).toFixed(3)),
        ordinal: i + 1,
        of: count,
      };
      entries.push(bridge);
      bridges.push(bridge);
      cursor = bridge.outEnd;
    }
    const dur = Number((segment.endSec - segment.startSec).toFixed(3));
    entries.push({
      kind: 'segment',
      index: segment.index,
      startSec: segment.startSec,
      endSec: segment.endSec,
      outStart: cursor,
      outEnd: Number((cursor + dur).toFixed(3)),
    });
    cursor = Number((cursor + dur).toFixed(3));
  });
  const speechEndSec = cursor;
  const totalDur = Number((speechEndSec + (Number(tailSeconds) || 0)).toFixed(3));
  if (totalDur > FINAL_MAX_SECONDS) {
    throw new Error(`woven final runtime ${totalDur} seconds exceeds ${FINAL_MAX_SECONDS} seconds`);
  }
  return {
    entries,
    bridges,
    speechEndSec,
    totalDur,
  };
}

function assTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = Math.floor(value % 60);
  const cs = Math.min(99, Math.floor((value - Math.floor(value)) * 100 + 1e-6));
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function assSafe(value) {
  return String(value || '')
    .replace(/\\/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function bridgeFontSize(text) {
  // Same conservative all-caps glyph estimate the builder uses for headers,
  // held inside the 972 px title-safe width with margin.
  const estimated = Math.max(1, String(text || '').length) * 0.72;
  return Math.max(48, Math.min(96, Math.floor(860 / estimated)));
}

// Motion-graphics interstitial for each bridge, in the approved benchmark
// motion grammar: over the blurred, dimmed, slowly pushed-in source plate
// (buildBridgeClip in scripts/build-viral-clip.js), a gradient glow rail with a
// moving sheen, the bridge line scaling in with a back-ease pop, and a small
// ordinal chip. No full-frame veil (the text-fit gate would read it as
// out-of-safe-area content) and no decorative lightning bolt (the bolt marks a
// real edit only).
function bridgeOverlayDialogues(bridges) {
  const lines = [];
  for (const bridge of bridges || []) {
    const start = assTime(bridge.outStart);
    const end = assTime(bridge.outEnd);
    const durMs = Math.max(200, Math.round((bridge.outEnd - bridge.outStart) * 1000));
    const text = assSafe(bridge.text).toUpperCase();
    const size = bridgeFontSize(text);
    const rail = 'm 0 0 l 760 0 l 760 10 l 0 10';
    const sheen = 'm 0 0 l 140 0 l 140 10 l 0 10';
    lines.push(
      `Dialogue: 7,${start},${end},Default,,0,0,0,,{\\an5\\pos(540,1050)\\p1\\bord0\\shad0\\blur6\\1c&H00FF72F5&\\fscx10\\t(0,${Math.round(durMs * 0.35)},\\fscx100)\\fad(120,200)}${rail}`,
      `Dialogue: 8,${start},${end},Default,,0,0,0,,{\\an5\\move(230,1050,850,1050,120,${Math.round(durMs * 0.8)})\\p1\\bord0\\shad0\\blur3\\1c&H00FFFFFF&\\alpha&H40&\\fad(160,200)}${sheen}`,
      `Dialogue: 9,${start},${end},Default,,0,0,0,,{\\an5\\pos(540,960)\\fnDejaVu Sans\\fs${size}\\b1\\fsp2\\1c&H00F8F7F2&\\3c&H00CF6FFF&\\bord4\\blur3\\shad0\\fscx70\\fscy70\\t(0,180,\\fscx106\\fscy106)\\t(180,300,\\fscx100\\fscy100)\\fad(120,220)}${text}`,
      `Dialogue: 9,${start},${end},Default,,0,0,0,,{\\an5\\pos(540,1120)\\fnDejaVu Sans\\fs30\\b1\\fsp6\\1c&H009DEFFF&\\3c&H00101010&\\bord2\\shad0\\fad(200,200)}${bridge.ordinal} / ${bridge.of}`,
    );
  }
  return lines;
}

function offsetWords(words, offsetSec) {
  const offset = Number(offsetSec) || 0;
  return (words || []).map((w) => ({
    ...w,
    start: Number((Number(w.start) + offset).toFixed(3)),
    end: Number((Number(w.end) + offset).toFixed(3)),
  }));
}

function segmentSummary(proposal) {
  const raw = proposal && Array.isArray(proposal.segments) ? proposal.segments : [];
  if (raw.length < 2) return '';
  return `${raw.length} segments woven: ${raw.map((s) => cleanText(s && s.approx_timestamp)).join(', ')}`;
}

module.exports = {
  SEGMENT_LIMITS,
  DEFAULT_BRIDGE_SECONDS,
  FINAL_MAX_SECONDS,
  parseSegmentRange,
  isCompleteSentenceText,
  validateClipSegments,
  resolveClipSegments,
  planWovenTimeline,
  bridgeOverlayDialogues,
  offsetWords,
  segmentSummary,
};
