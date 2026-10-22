'use strict';

// owner decision: "Just make the volume of the music 40% lower, then just
// post - no need to present it once more for approval." The rejection rebuilt
// the video and put it straight back in the approval queue, because nothing
// read the second half of the note. A rejection note that tells Amy to post
// once fixed is the owner's approval of the fixed video.
//
// Fail closed everywhere (Codex review db25e2822a3a): only unambiguous
// affirmative post language counts, any negation voids it, the directive is
// recorded only when the rejected bytes have a known SHA, and it releases
// only the rebuild of the exact rejection round it was stamped on (any later
// rejection on any surface rewrites rejected_at and so voids it).

const POST_INTENT = [
  /\bthen\s+(?:just\s+)?(?:post|upload|publish|ship)\b/,
  /\b(?:and|,)\s*(?:just\s+)?(?:post|upload|publish|ship)\s+(?:it|this|that)\b/,
  /\bno\s+need\s+to\s+(?:re-?)?(?:present|show|send)\b/,
  /\bskip\s+(?:the\s+)?(?:re-?)?approval\b/,
];

const NEGATION = [
  /\b(?:don'?t|do\s+not|never|not|no|won'?t|can'?t|shouldn'?t)\s+(?:yet\s+|just\s+|ever\s+)?(?:post|upload|publish|ship|approve|skip)/,
  /\b(?:wait|hold)\b[^.!?]{0,40}\b(?:before|until)\b/,
  /\buntil\s+i\b/,
  /\b(?:show|send)\s+(?:it\s+(?:to\s+)?)?me\s+(?:first|before)\b/,
];

function detectOwnerPostAfterFix(note) {
  const text = String(note || '').toLowerCase().replace(/[‘’]/g, "'");
  if (!text.trim()) return false;
  if (NEGATION.some((re) => re.test(text))) return false;
  return POST_INTENT.some((re) => re.test(text));
}

function normalSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(sha) ? sha : null;
}

// Stamped by the reject handler after it sets rejected_at. Returns null (the
// caller deletes any prior directive) without post intent, without a known
// rejected SHA, or without a rejection revision to bind to.
function buildPostAfterFixDirective(row = {}, note = '', nowIso = new Date().toISOString()) {
  if (!detectOwnerPostAfterFix(note)) return null;
  const baseline = normalSha(row.video_sha256);
  const revision = String(row.rejected_at || '').trim();
  if (!baseline || !revision) return null;
  return {
    requested_at: nowIso,
    rejection_revision: revision,
    baseline_sha256: baseline,
    note: String(note).slice(0, 500),
    source: 'owner_rejection_note',
  };
}

// Rows whose owner already said "post it once fixed" and whose rebuild of
// that same round is back in the queue with different bytes. Readiness
// (text-fit release gate, rejection cleared, not posted) is the caller's own
// approve-button check.
function selectPostAfterFixApprovals(videos = [], { isReady = () => true } = {}) {
  return (Array.isArray(videos) ? videos : []).filter((v) => {
    const d = v && v.owner_post_after_fix;
    if (!d || d.consumed_at) return false;
    if (String(v.status) !== 'pending_approval') return false;
    if (v.video_needs_regen === true || v.thumbnail_needs_regen === true) return false;
    const baseline = normalSha(d.baseline_sha256);
    const sha = normalSha(v.video_sha256);
    if (!baseline || !sha || sha === baseline) return false;
    if (!d.rejection_revision || d.rejection_revision !== String(v.rejected_at || '').trim()) {
      return false;
    }
    return isReady(v);
  });
}

module.exports = {
  detectOwnerPostAfterFix,
  buildPostAfterFixDirective,
  selectPostAfterFixApprovals,
};
