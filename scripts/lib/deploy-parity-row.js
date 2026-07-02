'use strict';

// SYSTEM HEALTH row formatter for the C4 deploy-parity probe (Codex amendment
// 3, item W3a). Reads the JSON artifact scripts/verify-deploy-parity.js
// writes (data/agent/deploy-parity-latest.json) and renders the three
// possible states:
//   - green: build-path and live server match master.
//   - red: names the exact stale files (executive phrasing, not raw drift dumps).
//   - ExampleCo: the probe artifact is missing or stale (>26h), so the row says
//     honestly "the probe did not run" rather than claiming a false green.
//
// This module ONLY formats; it never runs the probe itself (that stays a
// separate scheduled process so the briefing render never blocks on git/SSH).

const fs = require('node:fs');
const path = require('node:path');

const STALE_HOURS = 26;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function hoursSince(iso, now = Date.now()) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return Infinity;
  return Math.max(0, (now - t) / 3600000);
}

/**
 * Executive-phrased summary of drift entries, e.g.
 * "ec2-server.js, scripts/lib/foo.js (2 files out of sync)". Truncates to a
 * readable list so a large drift set does not flood the row.
 */
function summarizeDrift(drift) {
  const files = (drift || []).map((d) => d.file).filter(Boolean);
  if (!files.length) return 'files out of sync';
  const shown = files.slice(0, 5);
  const more = files.length - shown.length;
  const list = shown.join(', ') + (more > 0 ? `, +${more} more` : '');
  return `${list} (${files.length} file${files.length === 1 ? '' : 's'} out of sync)`;
}

/**
 * @param {{dataDir:string, now?:number}} args
 * @returns {{status:'green'|'red'|'ExampleCo', detail:string}}
 */
function computeDeployParityVerdict({ dataDir, now = Date.now() } = {}) {
  const artifactPath = path.join(dataDir || '', 'agent', 'deploy-parity-latest.json');
  const report = readJson(artifactPath);

  if (!report) {
    return {
      status: 'ExampleCo',
      detail: 'the deploy-parity probe did not run (no artifact found)',
    };
  }

  const stamp = report.checkedAt;
  const ageHours = hoursSince(stamp, now);
  if (ageHours > STALE_HOURS) {
    return {
      status: 'ExampleCo',
      detail: `the deploy-parity probe did not run recently (last check ${stamp || 'ExampleCo'}, >${STALE_HOURS}h old)`,
    };
  }

  if (report.ok) {
    return {
      status: 'green',
      detail: 'build-path and live server match master',
    };
  }

  return {
    status: 'red',
    detail: `stale code detected: ${summarizeDrift(report.drift)}`,
  };
}

/**
 * @param {{dataDir:string, now?:number}} args
 * @returns {string} a single glyphed SYSTEM HEALTH row line, e.g. "✓ Deploy parity: ..."
 */
function formatDeployParityRow({ dataDir, now } = {}) {
  const verdict = computeDeployParityVerdict({ dataDir, now });
  const glyph = verdict.status === 'green' ? '✓' : verdict.status === 'red' ? '✗' : '?';
  return `${glyph} Deploy parity: ${verdict.detail}.`;
}

module.exports = { computeDeployParityVerdict, formatDeployParityRow, summarizeDrift, STALE_HOURS };
