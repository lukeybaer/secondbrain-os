/**
 * rejected-video-feedback.js
 *
 * Shared rejection-feedback signal for the daily video PROPOSAL generators
 * (morning-shorts-proposals.js, viral-tech-clip-proposals.js).
 *
 * The problem this closes (Luke 2026-05-18): "the briefing keeps re-teeing
 * up videos that are the same, ignoring the video feedback." When Luke
 * rejects a proposed video with feedback, the next briefing cycle pulls the
 * same HN/X/YouTube source and the LLM proposes the SAME idea again, with no
 * awareness that Luke already rejected it.
 *
 * The proposal generators previously read NO rejection store at all. This
 * module is the one place that:
 *   1. Reads every video rejection Luke has logged
 *      (content-review/rejections.jsonl + the pending manifest), and
 *   2. Exposes them as { rejectedKeys, rejectionNotes } so a generator can
 *      (a) drop a proposal whose stable identity matches an already-rejected
 *          video, and
 *      (b) inject Luke's actual rejection-feedback text into the
 *          generation/regen prompt so the new version addresses his
 *          complaint instead of repeating the rejected one.
 *
 * Stable identity: rejections do not carry a source_url, so we normalize on
 * the video id AND a normalized-title/topic slug. A proposal is considered
 * "already rejected" if either its id or its normalized title matches.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const REJECTIONS_CANDIDATES = [
  '/opt/secondbrain/content-review/rejections.jsonl',
  path.join(REPO, 'content-review', 'rejections.jsonl'),
];
const MANIFEST_CANDIDATES = [
  '/opt/secondbrain/content-review/pending/manifest.json',
  path.join(REPO, 'content-review', 'pending', 'manifest.json'),
];

// Normalize a title/topic into a stable comparison key. Strips punctuation,
// collapses whitespace, lowercases. "9 Free AI Tools (2026)!" and
// "9 free AI tools 2026" collapse to the same key so a rejected idea cannot
// sneak back in with cosmetic title tweaks.
function normalizeTopic(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstExisting(candidates) {
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

// Read every rejection from rejections.jsonl. Each line is
// { ts, id, note, target, source }.
function readRejectionsJsonl(rejectionsPath) {
  const out = [];
  const p = rejectionsPath || firstExisting(REJECTIONS_CANDIDATES);
  if (!p) return out;
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && (row.id || row.note)) out.push(row);
    } catch {
      /* skip malformed history row */
    }
  }
  return out;
}

// Read rejected entries straight from the pending manifest. The manifest
// carries the canonical title for each id, which rejections.jsonl lacks.
function readManifestRejections(manifestPath) {
  const out = [];
  const p = manifestPath || firstExisting(MANIFEST_CANDIDATES);
  if (!p) return out;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return out;
  }
  for (const v of (manifest && manifest.videos) || []) {
    if (!v) continue;
    const note = v.video_rejection_note || v.thumbnail_rejection_note || '';
    const isRejected =
      v.status === 'rejected' ||
      v.status === 'video_rejected' ||
      v.status === 'thumbnail_rejected' ||
      v.video_needs_regen === true;
    if (!isRejected && !note) continue;
    out.push({
      id: v.id || '',
      title: v.title || v.source_title || '',
      note,
      ts: v.rejected_at || v.video_rejected_at || '',
    });
  }
  return out;
}

/**
 * Build the rejection-feedback signal for a proposal generator.
 *
 * Returns:
 *   {
 *     rejectedIds:    Set<string>   // normalized video ids
 *     rejectedTopics: Set<string>   // normalized title/topic keys
 *     notes: [ { id, topic, note, ts } ]   // most recent first
 *     promptBlock: string           // ready-to-inject prompt text ('' if none)
 *   }
 */
function loadRejectionFeedback(options = {}) {
  const rows = [
    ...readRejectionsJsonl(options.rejectionsPath),
    ...readManifestRejections(options.manifestPath),
  ];
  const rejectedIds = new Set();
  const rejectedTopics = new Set();
  // Keep the most informative note per identity. Keyed by id|topic.
  const byKey = new Map();
  for (const row of rows) {
    const id = String(row.id || '').trim();
    const topic = normalizeTopic(row.title || row.topic || '');
    if (id) rejectedIds.add(id.toLowerCase());
    if (topic) rejectedTopics.add(topic);
    const note = String(row.note || '').trim();
    if (!note) continue;
    const key = `${id.toLowerCase()}|${topic}`;
    const prior = byKey.get(key);
    const ts = String(row.ts || '');
    if (!prior || ts > prior.ts) {
      byKey.set(key, { id, topic, note, ts });
    }
  }
  const notes = [...byKey.values()].sort((a, b) =>
    String(b.ts || '').localeCompare(String(a.ts || '')),
  );
  return {
    rejectedIds,
    rejectedTopics,
    notes,
    promptBlock: buildRejectionPromptBlock(notes),
  };
}

// True if a proposal's stable identity collides with an already-rejected
// video. Matches on id OR normalized title/topic so the "same video" cannot
// reappear unchanged under a cosmetically different title.
function isAlreadyRejected(feedback, proposal) {
  if (!feedback || !proposal) return false;
  const id = String(proposal.id || '').trim().toLowerCase();
  if (id && feedback.rejectedIds.has(id)) return true;
  const topic = normalizeTopic(proposal.title || proposal.topic || proposal.source_title || '');
  if (topic && feedback.rejectedTopics.has(topic)) return true;
  return false;
}

// Build the prompt block injected into the proposal LLM call. Lists the
// rejected topics + Luke's feedback so the model regenerates AROUND the
// complaint instead of re-proposing the rejected idea verbatim.
function buildRejectionPromptBlock(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return '';
  const lines = [
    '================ LUKE ALREADY REJECTED THESE (honor the feedback) ================',
    'Luke reviewed and REJECTED the videos below. Two hard rules:',
    '  1. Do NOT re-propose any of these topics unchanged. A new proposal',
    '     that is the same idea with a reworded title is still a rejection.',
    '  2. If you cover an adjacent topic, the new proposal MUST visibly',
    '     address the rejection feedback. The feedback is the spec.',
    '',
  ];
  for (const n of notes.slice(0, 25)) {
    const label = n.topic || n.id || 'rejected video';
    lines.push(`  - REJECTED: "${label}"`);
    if (n.note) lines.push(`    Luke's feedback: ${n.note}`);
  }
  lines.push('================ END REJECTED LIST ================');
  return lines.join('\n');
}

module.exports = {
  loadRejectionFeedback,
  isAlreadyRejected,
  buildRejectionPromptBlock,
  normalizeTopic,
  readRejectionsJsonl,
  readManifestRejections,
};
