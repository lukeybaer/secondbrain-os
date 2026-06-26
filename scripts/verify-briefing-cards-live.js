#!/usr/bin/env node
/**
 * verify-briefing-cards-live.js  (CONSOLIDATED -> verify-dashboard-cards-live.js)
 *
 * There is exactly ONE render-level QC for the briefing dashboard:
 * scripts/verify-dashboard-cards-live.js. This file used to be a second,
 * overlapping render-QC (it parsed the same live tiles and asserted per-card
 * status), which is precisely the fragmentation the 2026-06-21 failure traced to
 * (dev-plans/core/briefing-qc.LESSONS.md). It is now a THIN re-export of the
 * single QC so no second render-QC implementation exists.
 *
 * Its one unique check -- a news card delivering fewer than its requested count
 * (US/AI/World/Immigration/Mortgage = 10, COVID = 5, Employer = mention-or-zero
 * placeholder) -- was ported INTO the dashboard QC as newsCountDefects(), reading
 * the counts from the single target source (briefing-card-manifest.js
 * getNewsTarget / mentionOrZero). No coverage was lost.
 *
 * Anything importing this module keeps working (verifyDashboard, newsShortDefect
 * re-exported); running it as a CLI runs the single render-QC.
 *
 * The drift-lint (scripts/verify-briefing-qc-drift.js) enforces that this file no
 * longer fetches the live dashboard and asserts per-card render status itself, so
 * it can never silently regrow into a parallel QC.
 */
'use strict';

const dashboardQc = require('./verify-dashboard-cards-live.js');
const manifest = require('./lib/briefing-card-manifest.js');
const { loadOperatorIdentity } = require('./lib/operator-identity.js');

// Employer name is operator PII; the scanned-zero placeholder regex names it, so
// it is built from the runtime config rather than hardcoded in source.
const EMPLOYER_RX = loadOperatorIdentity()
  .owner.employer.toLowerCase()
  .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EMPLOYER_ZERO_PLACEHOLDER = new RegExp(
  '(?:no\\s+' + EMPLOYER_RX + '\\s+mentions|0\\s+matches|noise-free|scanned\\s+\\d+)',
  'i',
);

// Back-compat shim for the one unique check this file used to own. It is now a
// thin adapter over the manifest's single target source so callers that imported
// newsShortDefect still get the same news-count verdict, with no duplicate
// target table. `cardName` is the rendered "<BASE> NEWS (N)" data-section title.
function newsShortDefect(cardName, cardText = '') {
  const m = String(cardName || '').match(/\((\d+)\)\s*$/);
  const actual = m ? parseInt(m[1], 10) : null;
  // Find the manifest card whose matcher accepts this title (drops the suffix).
  const base = String(cardName || '').replace(/\s*\(\d+\)\s*$/, '');
  const card = manifest.CARDS.find((c) => c.match.test(base) || c.match.test(cardName));
  if (!card) return null;

  if (card.mentionOrZero) {
    if (actual === null || actual > 0) return null;
    if (EMPLOYER_ZERO_PLACEHOLDER.test(cardText)) return null;
    return `SHORT: ${base} delivered 0 mentions without a scanned-zero placeholder`;
  }

  const target = manifest.getNewsTarget(card);
  if (target === null || actual === null) return null;
  if (actual < target) return `SHORT: ${base} delivered ${actual}/${target} articles`;
  return null;
}

module.exports = {
  ...dashboardQc,
  newsShortDefect,
};

if (require.main === module) {
  // Delegate the CLI to the single render-QC so `node verify-briefing-cards-live.js`
  // and `npm run verify:briefing-cards` both run the one authoritative tool with
  // its real fetch + exit codes preserved.
  const path = require('path');
  const { spawnSync } = require('child_process');
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, 'verify-dashboard-cards-live.js'), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exit(r.status === null ? 1 : r.status);
}
