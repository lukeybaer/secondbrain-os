'use strict';

// scripts/lib/briefing-cards/mortgage-rate-indexes-card.js
//
// W6 generator merge, card 1 (lowest risk: pure dated-artifact table render).
// The MORTGAGE RATE INDEXES builder moved VERBATIM out of
// scripts/cloud-morning-briefing.js; both generators consume THIS module so
// the card can never render two independently-drifting shapes again
// (big-decisions-card.js pattern). Source artifact:
// <dataDir>/agent/mortgage-rates/<date>.json written by
// scripts/mortgage-rate-indexes.js; the freshest not-after-<date> snapshot is
// used when today's is missing, labeled as a fallback in state.
//
// The dashboard parser keys on /^MORTGAGE RATE INDEXES\b/m
// (ec2-server.js), which this title preserves.

const fs = require('node:fs');
const path = require('node:path');
const {
  readJson,
  cleanExecutiveFragment,
  cleanPublicUrl,
  legacySection,
} = require('./card-format.js');

const TITLE = 'MORTGAGE RATE INDEXES';

// Latest not-after-<date> snapshot in <dataDir>/agent/mortgage-rates/. The
// files are named YYYY-MM-DD.json directly (no prefix). NOTE: the pre-move
// cloud builder routed this through findLatestDatedFile, which (a) appended
// an extra /agent segment and (b) required a "<prefix>-" dash the files never
// had, so the documented fallback branch could never fire and a missing
// same-day snapshot always rendered as "missing" (unit test caught it during
// the W6 extraction, 2026-07-12). Fixed here in the ONE shared reader.
function latestMortgageSnapshotFile(dataDir, date) {
  const dir = path.join(dataDir, 'agent', 'mortgage-rates');
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const rows = files
    .map((file) => {
      const m = file.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) return null;
      if (date && m[1] > date) return null;
      return { date: m[1], file: path.join(dir, file) };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
  return rows.length ? rows[rows.length - 1] : null;
}

function readMortgageRateSnapshot(dataDir, date) {
  const exact = readJson(path.join(dataDir, 'agent', 'mortgage-rates', `${date}.json`), null);
  if (exact && Array.isArray(exact.indexes))
    return { snapshot: exact, sourceDate: exact.date || date };
  const latest = latestMortgageSnapshotFile(dataDir, date);
  const snapshot = latest ? readJson(latest.file, null) : null;
  if (snapshot && Array.isArray(snapshot.indexes))
    return { snapshot, sourceDate: latest.date || snapshot.date };
  return { snapshot: null, sourceDate: null };
}

function fmtRateCell(value) {
  if (value == null || value === '') return 'blocked';
  if (typeof value === 'number') return `${value.toFixed(2)}%`;
  const text = cleanExecutiveFragment(value, { max: 24 });
  return text || 'blocked';
}

function buildMortgageRateIndexesCard(dataDir, date) {
  const { snapshot, sourceDate } = readMortgageRateSnapshot(dataDir, date);
  if (!snapshot) {
    return {
      markdown: legacySection(
        TITLE,
        'No mortgage-rate index snapshot is ready yet. This card remains unpublished until the source check passes.',
      ),
      state: { id: 'mortgage-rates', count: 0, ok: false, source: 'missing' },
    };
  }
  const indexes = (snapshot.indexes || []).filter((row) => row && row.id && row.today != null);
  const lines = [
    `Snapshot: ${sourceDate}; indexes are ExampleCod from the latest public readings when markets have not posted a Sunday update.`,
    '',
    '| Index | Today | DoD | WoW | MoM | Source |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const row of indexes) {
    const label = cleanExecutiveFragment(row.label || row.id, { max: 60 });
    const source = cleanPublicUrl(row.source || row.link, { allowGoogleNews: true });
    lines.push(
      `| ${label} | ${fmtRateCell(row.today)} | ${fmtRateCell(row.dod)} | ${fmtRateCell(row.wow)} | ${fmtRateCell(row.mom)} | ${source || 'public index'} |`,
    );
  }
  return {
    markdown: legacySection(TITLE, lines.join('\n')),
    state: {
      id: 'mortgage-rates',
      count: indexes.length,
      ok: indexes.length >= 3,
      source: sourceDate === date ? 'artifact' : `fallback-${sourceDate}`,
    },
  };
}

module.exports = {
  TITLE,
  readMortgageRateSnapshot,
  fmtRateCell,
  buildMortgageRateIndexesCard,
};
