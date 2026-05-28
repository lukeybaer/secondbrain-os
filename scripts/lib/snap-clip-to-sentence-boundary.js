// snap-clip-to-sentence-boundary.js
//
// 2026-05-25 Luke flagged on the Otter feature-backlog feedback session:
// "These clips for the clipping proposals, these voices are getting cut off
// at awkward times. You're really not proposing a complete clip. It's always
// cut off mid-word."
//
// Root cause: viral-tech-clip-proposals.js picks endSec = startSec + fixed
// clip_seconds (8..25). The build downloads exactly that window. The hard
// cut frequently lands mid-word because chapter starts are real timestamps
// but chapter+N seconds is not.
//
// Fix here: given the proposal's startSec/endSec and the downloaded VTT
// subtitle file, return an adjusted endSec that snaps to the nearest natural
// sentence/phrase boundary within a tolerance window. Natural boundaries are
// (in priority order): VTT cue end that follows a sentence-terminating
// punctuation, then any VTT cue end, then the original proposed end (fall
// through, never extend beyond tolerance).

const fs = require('fs');

const SENTENCE_END = /[.!?][")\]]?\s*$/;
const PHRASE_END = /[,;:][")\]]?\s*$/;

// Parse a WEBVTT file into ordered cues with { startSec, endSec, text }.
function parseVtt(vttPath) {
  if (!vttPath || !fs.existsSync(vttPath)) return [];
  const raw = fs.readFileSync(vttPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const cues = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/(\d{1,2}:)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})\.(\d{3})/);
    if (m) {
      if (cur) cues.push(cur);
      const toSec = (h, mm, ss, ms) => (Number(h || 0) * 3600) + (Number(mm) * 60) + Number(ss) + (Number(ms) / 1000);
      cur = {
        startSec: toSec(m[1] && m[1].replace(':', ''), m[2], m[3], m[4]),
        endSec: toSec(m[5] && m[5].replace(':', ''), m[6], m[7], m[8]),
        text: '',
      };
    } else if (cur && line.trim() && !/^WEBVTT|^NOTE|^STYLE|^REGION/i.test(line)) {
      cur.text += (cur.text ? ' ' : '') + line.trim();
    }
  }
  if (cur) cues.push(cur);
  return cues;
}

// Given parsed cues + proposed startSec + proposed endSec + tolerance,
// return adjustedEndSec snapped to the nearest natural boundary within
// [endSec - tolerance, endSec + tolerance].
//
// tolerance defaults to 5 seconds so a 15s clip can become 10-20s when it
// avoids a mid-word cut.
function snapEndToSentenceBoundary({ cues, startSec, endSec, tolerance = 5 }) {
  if (!Array.isArray(cues) || cues.length === 0) return { endSec, reason: 'no cues' };
  const lo = endSec - tolerance;
  const hi = endSec + tolerance;
  // Candidates: cue end timestamps that end with sentence punctuation
  // first, then any cue end, all within tolerance and >= startSec + 4s.
  const minDur = startSec + 4;
  const inWindow = cues.filter((c) => c.endSec >= Math.max(lo, minDur) && c.endSec <= hi);
  if (inWindow.length === 0) return { endSec, reason: 'no cue end within tolerance' };

  const sentenceMatches = inWindow.filter((c) => SENTENCE_END.test(c.text));
  if (sentenceMatches.length > 0) {
    const best = sentenceMatches.reduce((a, b) => Math.abs(b.endSec - endSec) < Math.abs(a.endSec - endSec) ? b : a);
    return { endSec: best.endSec, reason: 'snapped to sentence end', cueText: best.text.slice(-60) };
  }
  const phraseMatches = inWindow.filter((c) => PHRASE_END.test(c.text));
  if (phraseMatches.length > 0) {
    const best = phraseMatches.reduce((a, b) => Math.abs(b.endSec - endSec) < Math.abs(a.endSec - endSec) ? b : a);
    return { endSec: best.endSec, reason: 'snapped to phrase end', cueText: best.text.slice(-60) };
  }
  // Last resort: snap to any cue end (avoids mid-word at least).
  const best = inWindow.reduce((a, b) => Math.abs(b.endSec - endSec) < Math.abs(a.endSec - endSec) ? b : a);
  return { endSec: best.endSec, reason: 'snapped to cue end (no punctuation match)', cueText: best.text.slice(-60) };
}

module.exports = { parseVtt, snapEndToSentenceBoundary };
