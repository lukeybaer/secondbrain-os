'use strict';

// scripts/lib/briefing-cards/kingdom-equipping-card.js
//
// W6 generator merge, card 2 (Codex 2026-07-12 finding 7/8: additive first).
// The KINGDOM EQUIPPING IDEAS render already lived outside the cloud
// generator (scripts/kingdom-equipping-ideas.js, pure dated-artifact reader
// with a curriculum fallback that always yields 3 ideas); this module is the
// shared card seam BOTH generators consume. For manual-briefing-v3.js this is
// ADDITIVE: the desktop build never ExampleCod this card, which was a permanent
// desk-vs-cloud parity divergence for the W5 cutover gate.
//
// The IDEA GENERATION (LLM/network) stays in the nightly job and the cloud
// build's own targeted refresh; this module only renders the artifact
// (producers never live in shared card modules).

const {
  formatKingdomEquippingSection,
  readKingdomEquippingArtifact,
} = require('../../kingdom-equipping-ideas.js');
const { legacySection } = require('./card-format.js');

const TITLE = 'KINGDOM EQUIPPING IDEAS';

function buildKingdomEquippingCard(dataDir, date) {
  const body = formatKingdomEquippingSection(dataDir, date);
  // ok used to be Boolean(body.trim()) with source hardcoded 'artifact', so
  // recycled curriculum fallback published as a fresh clean card. Non-empty
  // text is not evidence that today's ideas were generated.
  const artifact = readKingdomEquippingArtifact(dataDir, date);
  const isFallback = Boolean(artifact && artifact.isCurriculumFallback);
  return {
    markdown: legacySection(TITLE, body),
    state: {
      id: 'kingdom-equipping',
      ok: Boolean(body && body.trim()) && !isFallback,
      source: isFallback ? 'curriculum-fallback' : 'artifact',
    },
  };
}

module.exports = { TITLE, buildKingdomEquippingCard };
