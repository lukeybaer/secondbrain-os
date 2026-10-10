'use strict';

// scripts/lib/briefing-cards/shorts-proposals-card.js
//
// W6 generator merge, card 5. The TODAY'S 10 SHORTS PROPOSALS render moved
// VERBATIM out of scripts/cloud-morning-briefing.js; BOTH generators consume
// THIS module over the dated artifact data/agent/shorts-proposals/<date>.json
// written by scripts/morning-shorts-proposals.js. The producer spawn stays in
// the generators (Codex 2026-07-12 finding 3: manual retires its stdout
// capture and renders the artifact once).

const {
  readDatedArtifact,
  readLatestCompleteDatedArtifact,
  materializeFallbackArtifact,
  normalizeArtifactArray,
  cleanExecutiveFragment,
  cleanPublicContentFragment,
  legacySection,
} = require('./card-format.js');
const { isFallbackExpired } = require('../briefing-fallback-expiry.js');

const TITLE = "TODAY'S 10 SHORTS PROPOSALS";

function publicShortfallWall(wall, count) {
  const text = String(wall || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/^llm-unavailable\b/i.test(text)) {
    return `llm-unavailable: subscription generation unavailable after bounded attempts; only ${count}/10 proposals exist`;
  }
  return text
    .replace(/\b(?:claude cli|codex)\b/gi, 'subscription generation')
    .replace(/\bSHORTS_MIN_[A-Z_]+\b/g, 'source-quality floor')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildShortsProposalsCard(dataDir, date, blockers, now = new Date()) {
  let raw = readDatedArtifact(dataDir, ['agent', 'shorts-proposals'], date);
  let fallback = null;
  // A materialized fallback sitting in today's file is only good for 24h. Once
  // expired it is yesterday-as-today: drop it before counting so it can never
  // render as fresh content, and let the re-sourcing below find a current set
  // or fall through to an honest blocker.
  if (isFallbackExpired(raw, now)) raw = null;
  let proposalsRaw = normalizeArtifactArray(raw, ['proposals', 'items']);
  // ExampleCo paused the research (2026-09-07): a paused artifact is the truth for
  // the day and must never be replaced by the two-day fallback, or the tile
  // would show old proposals as today's (Codex review 696454d26df0).
  const ownerPaused = Boolean(
    raw && (raw.paused || /^paused-by-owner/i.test(String(raw.wall || ''))),
  );
  if (proposalsRaw.length < 10 && !ownerPaused) {
    fallback = readLatestCompleteDatedArtifact(
      dataDir,
      ['agent', 'shorts-proposals'],
      date,
      ['proposals', 'items'],
      10,
      2,
      now,
    );
    if (fallback) {
      materializeFallbackArtifact(
        dataDir,
        ['agent', 'shorts-proposals'],
        date,
        fallback,
        'Shorts proposals',
        now,
      );
      raw = readDatedArtifact(dataDir, ['agent', 'shorts-proposals'], date) || fallback.raw;
      proposalsRaw = normalizeArtifactArray(raw, ['proposals', 'items']);
    }
  }
  const proposals = proposalsRaw
    .map((item) => ({
      title: cleanPublicContentFragment(item && item.title, { max: 130 }),
      signal: cleanExecutiveFragment(item && (item.source_signal || item.virality_proof), {
        max: 130,
      }),
      source: cleanExecutiveFragment(item && item.source_url, { max: 220 }),
      status: item && item.status === 'approved' ? '[APPROVED]' : '[click to approve]',
    }))
    .filter((item) => item.title);
  const enough = proposals.length >= 10;
  const wall = raw && raw.wall ? String(raw.wall).replace(/\s+/g, ' ').trim() : '';
  const publicWall = publicShortfallWall(wall, proposals.length);
  const hasNamedWall = !!wall;
  const lines = [];
  if (!proposals.length && !hasNamedWall) {
    lines.push('No fresh shorts proposals are ready yet.');
  } else {
    lines.push(`Fresh proposals staged: ${Math.min(proposals.length, 10)}/10.`);
    if (fallback) {
      lines.push(
        `Fallback used: latest complete source-backed set from ${fallback.date}; approvals remain available while fresh sourcing continues.`,
      );
    } else if (!enough && publicWall) {
      lines.push(`Shortfall: only ${proposals.length}/10 today. Wall: ${publicWall}`);
    }
  }
  for (const [idx, proposal] of proposals.slice(0, 10).entries()) {
    lines.push(`  ${idx + 1}. ${proposal.title} ${proposal.status}`);
    if (proposal.signal) lines.push(`     Signal: ${proposal.signal}.`);
    if (proposal.source) lines.push(`     Source: ${proposal.source}`);
  }
  lines.push("  Approval starts today's build queue. No approval means no video build.");
  return {
    markdown: legacySection(TITLE, lines.join('\n')),
    state: {
      id: 'shorts-proposals',
      count: proposals.length,
      // A named wall is the honest shortfall contract for this card. It keeps
      // the tile publishable while preserving the 0/10 count for follow-up.
      ok: enough || hasNamedWall,
      source: fallback ? `fallback-${fallback.date}` : raw ? 'artifact' : 'missing',
      wall: publicWall || null,
    },
  };
}

module.exports = { TITLE, buildShortsProposalsCard, publicShortfallWall };
