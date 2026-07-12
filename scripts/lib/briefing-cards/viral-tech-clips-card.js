'use strict';

// scripts/lib/briefing-cards/viral-tech-clips-card.js
//
// W6 generator merge, card 4. The VIRAL TECH CLIP PROPOSALS render moved
// VERBATIM out of scripts/cloud-morning-briefing.js; BOTH generators consume
// THIS module over the dated artifact data/agent/viral-tech-clips/<date>.json
// written by scripts/viral-tech-clip-proposals.js. The producer spawn stays
// in the generators (Codex 2026-07-12 finding 3: manual retires its stdout
// capture and renders the artifact once, killing the duplicate-header and
// stale-fallback-as-today class for this card).

const {
  readDatedArtifact,
  readLatestCompleteDatedArtifact,
  materializeFallbackArtifact,
  normalizeArtifactArray,
  cleanExecutiveFragment,
  cleanPublicContentFragment,
  formatWholeNumber,
  legacySection,
} = require('./card-format.js');
const { isFallbackExpired } = require('../briefing-fallback-expiry.js');

const TITLE = 'VIRAL TECH CLIP PROPOSALS';

// Render-time intro/opening/greeting/sponsor detector for the viral card
// (ExampleCo 2026-07-07 #learn: a viral clip must be a HOOK, never the intro). This
// is a compact mirror of viral-tech-clip-proposals.js isIntroLikeSegment. Full
// rule -> memory/feedback_viral_clip_never_intro_section.md. A stale fallback
// artifact (materialized before the generator's intro gate) can still carry an
// intro clip; this drops it at render so the card never surfaces one.
const VIRAL_CLIP_INTRO_RE =
  /\b(intro(?:duction|s)?|welcome(?:\s+(?:to|back))?|cold\s*open|opening|preamble|housekeeping|before\s+we\s+(?:start|begin|dive)|let'?s\s+get\s+started|thanks?\s+for\s+(?:watching|tuning|joining)|sponsor(?:ed)?\s+(?:by|read|segment|message)|brought\s+to\s+you\s+by|hit\s+the\s+(?:like|subscribe)|patreon|merch|table\s+of\s+contents|agenda)\b/i;
const VIRAL_CLIP_GREETING_RE =
  /^(?:hey|hi|hello|yo|what'?s\s+up|good\s+(?:morning|afternoon|evening))\b[\s,!.]*(?:everyone|everybody|guys|folks|friends|all|there|y'?all)?[\s,!.]*$/i;

function viralClipTextIsIntroLike(text) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return false;
  return VIRAL_CLIP_INTRO_RE.test(s) || VIRAL_CLIP_GREETING_RE.test(s);
}

function buildViralTechCard(dataDir, date, blockers, now = new Date()) {
  let raw = readDatedArtifact(dataDir, ['agent', 'viral-tech-clips'], date);
  let fallback = null;
  // Drop an expired materialized fallback before counting so a >24h-old clip
  // set never renders as today's; re-source or fall through to honest blocker.
  if (isFallbackExpired(raw, now)) raw = null;
  let proposalsRaw = normalizeArtifactArray(raw, ['proposals', 'clips', 'items']);
  if (proposalsRaw.length < 3) {
    fallback = readLatestCompleteDatedArtifact(
      dataDir,
      ['agent', 'viral-tech-clips'],
      date,
      ['proposals', 'clips', 'items'],
      3,
      2,
      now,
    );
    if (fallback) {
      materializeFallbackArtifact(
        dataDir,
        ['agent', 'viral-tech-clips'],
        date,
        fallback,
        'Viral tech clips',
        now,
      );
      raw = readDatedArtifact(dataDir, ['agent', 'viral-tech-clips'], date) || fallback.raw;
      proposalsRaw = normalizeArtifactArray(raw, ['proposals', 'clips', 'items']);
    }
  }
  // Render-time defense (ExampleCo 2026-07-07 #learn): the card must NEVER surface a
  // clip whose window is a plain intro/opening/greeting/sponsor section, even
  // when a STALE fallback artifact (materialized before the generator's intro
  // gate existed) resurfaces one. The generator drops intro segments at source;
  // this is the belt-and-suspenders at render so an old fallback set can't leak
  // an intro clip.
  proposalsRaw = proposalsRaw.filter((item) => {
    const fields = [
      item && item.insight,
      item && item.short_description,
      item && item.clip_description,
      item && item.speaker,
    ];
    return !fields.some((f) => viralClipTextIsIntroLike(f));
  });
  const proposals = proposalsRaw
    .map((item) => ({
      title: cleanPublicContentFragment(item && (item.source_title || item.title), { max: 140 }),
      source: cleanExecutiveFragment(item && (item.clip_url || item.source_url), { max: 220 }),
      preview: cleanExecutiveFragment(
        item && (item.embed_url || item.clip_url || item.source_url),
        { max: 260 },
      ),
      views: item && (item.views ?? item.view_count ?? item.viewCount),
      viewsPerDay: item && (item.viewsPerDay ?? item.views_per_day),
      timestamp: cleanExecutiveFragment(item && item.approx_timestamp, { max: 40 }),
      seconds: Number(item && item.clip_seconds) || 15,
      speaker: cleanPublicContentFragment(item && item.speaker, { max: 100 }),
      insight: cleanPublicContentFragment(item && item.insight, { max: 180 }),
      shortDescription: cleanPublicContentFragment(item && item.short_description, { max: 180 }),
      virality: cleanPublicContentFragment(item && item.virality_signal, { max: 140 }),
      status: item && item.status === 'approved' ? '[APPROVED]' : '[click to approve]',
    }))
    .filter((item) => item.title);
  const enough = proposals.length >= 3;
  const lines = [];
  if (!proposals.length) {
    lines.push('No viral clip proposals are ready yet.');
  } else {
    lines.push(`Verified clip proposals staged: ${Math.min(proposals.length, 3)}/3.`);
    if (fallback) {
      lines.push(
        `Fallback used: latest verified clip set from ${fallback.date}; approvals remain available while fresh YouTube sourcing continues.`,
      );
    }
  }
  for (const [idx, proposal] of proposals.slice(0, 3).entries()) {
    lines.push(`  ${idx + 1}. ${proposal.title} ${proposal.status}`);
    if (proposal.source) lines.push(`     Source: ${proposal.source}`);
    if (proposal.preview) lines.push(`     Preview clip: ${proposal.preview}`);
    if (proposal.speaker) lines.push(`     Speaker: ${proposal.speaker}`);
    if (proposal.insight) lines.push(`     Insight: ${proposal.insight}`);
    lines.push(
      `     Virality: ${proposal.virality || `${formatWholeNumber(proposal.views)} total, ${formatWholeNumber(proposal.viewsPerDay)} views/day`}`,
    );
    lines.push(
      `     Clip: ${proposal.timestamp || 'timestamp pending'}, ${proposal.seconds} seconds`,
    );
    if (proposal.shortDescription) lines.push(`     Short: ${proposal.shortDescription}`);
  }
  lines.push('  Approval queues the clip for extraction. Skip means no clip build today.');
  return {
    markdown: legacySection(`${TITLE} (${Math.min(proposals.length, 3)})`, lines.join('\n')),
    state: {
      id: 'viral-tech-clips',
      count: proposals.length,
      ok: enough,
      source: fallback ? `fallback-${fallback.date}` : raw ? 'artifact' : 'missing',
    },
  };
}

module.exports = {
  TITLE,
  VIRAL_CLIP_INTRO_RE,
  VIRAL_CLIP_GREETING_RE,
  viralClipTextIsIntroLike,
  buildViralTechCard,
};
