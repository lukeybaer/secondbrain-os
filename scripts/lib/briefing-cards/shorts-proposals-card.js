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

function buildShortsProposalsCard(dataDir, date, blockers, now = new Date()) {
  let raw = readDatedArtifact(dataDir, ['agent', 'shorts-proposals'], date);
  let fallback = null;
  // A materialized fallback sitting in today's file is only good for 24h. Once
  // expired it is yesterday-as-today: drop it before counting so it can never
  // render as fresh content, and let the re-sourcing below find a current set
  // or fall through to an honest blocker.
  if (isFallbackExpired(raw, now)) raw = null;
  let proposalsRaw = normalizeArtifactArray(raw, ['proposals', 'items']);
  if (proposalsRaw.length < 10) {
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
  const lines = [];
  if (!proposals.length) {
    lines.push('No fresh shorts proposals are ready yet.');
  } else {
    lines.push(`Fresh proposals staged: ${Math.min(proposals.length, 10)}/10.`);
    if (fallback) {
      lines.push(
        `Fallback used: latest complete source-backed set from ${fallback.date}; approvals remain available while fresh sourcing continues.`,
      );
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
      ok: enough,
      source: fallback ? `fallback-${fallback.date}` : raw ? 'artifact' : 'missing',
    },
  };
}

module.exports = { TITLE, buildShortsProposalsCard };
