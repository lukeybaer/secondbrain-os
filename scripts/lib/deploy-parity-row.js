'use strict';

// SYSTEM HEALTH row formatter for the C4 deploy-parity probe (Codex amendment
// 3, item W3a). Reads the JSON artifact scripts/verify-deploy-parity.js
// writes (data/agent/deploy-parity-latest.json) and renders the three
// possible states:
//   - green: build-path and live server match master.
//   - red: names the exact stale files (executive phrasing, not raw drift dumps).
//   - amber: the probe artifact is missing or stale (>26h), so the row says
//     honestly "the probe did not run" rather than claiming a false green.
//
// This module ONLY formats; it never runs the probe itself (that stays a
// separate scheduled process so the briefing render never blocks on git/SSH).

const fs = require('node:fs');
const path = require('node:path');
const { releaseShaFromPhysicalRoot } = require('./release-identity.js');

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

function currentRuntimeReleaseSha() {
  try {
    return releaseShaFromPhysicalRoot(
      fs.realpathSync(path.resolve(__dirname, '..', '..')),
    );
  } catch {
    return '';
  }
}

/**
 * @param {{dataDir:string, now?:number}} args
 * @returns {{status:'green'|'red'|'amber', detail:string}}
 */
function computeDeployParityVerdict({
  dataDir,
  now = Date.now(),
  expectedReleaseSha = currentRuntimeReleaseSha(),
} = {}) {
  const artifactPath = path.join(dataDir || '', 'agent', 'deploy-parity-latest.json');
  const report = readJson(artifactPath);

  if (!report) {
    return {
      status: 'amber',
      detail: 'the deploy-parity probe did not run (no artifact found)',
    };
  }

  const stamp = report.checkedAt;
  const ageHours = hoursSince(stamp, now);
  if (ageHours > STALE_HOURS) {
    return {
      status: 'amber',
      detail: `the deploy-parity probe did not run recently (last check ${stamp || 'unknown'}, >${STALE_HOURS}h old)`,
    };
  }

  if (!report.ok) {
    return {
      status: 'red',
      detail: `stale code detected: ${summarizeDrift(report.drift)}`,
    };
  }

  const proofReleaseSha = String(report.releaseSha || '').toLowerCase();
  const currentReleaseSha = String(expectedReleaseSha || '').toLowerCase();
  if (!proofReleaseSha || !currentReleaseSha) {
    return {
      status: 'amber',
      detail: 'deploy parity is green but is not bound to a provable current release',
    };
  }
  if (proofReleaseSha !== currentReleaseSha) {
    return {
      status: 'amber',
      detail: `deploy parity was proved for ${proofReleaseSha.slice(0, 12)}, but current release ${currentReleaseSha.slice(0, 12)} awaits its own proof`,
    };
  }

  if (report.ok) {
    return {
      status: 'green',
      detail: `build-path and live server match current release ${currentReleaseSha.slice(0, 12)}`,
    };
  }
}

/**
 * @param {{dataDir:string, now?:number}} args
 * @returns {string} a single glyphed SYSTEM HEALTH row line, e.g. "✓ Deploy parity: ..."
 */
function formatDeployParityRow({ dataDir, now, expectedReleaseSha } = {}) {
  return formatDeployParityVerdict(
    computeDeployParityVerdict({ dataDir, now, expectedReleaseSha }),
  );
}

function formatDeployParityVerdict(verdict) {
  const glyph = verdict.status === 'green' ? '✓' : verdict.status === 'red' ? '✗' : '?';
  return `${glyph} Deploy parity: ${verdict.detail}.`;
}

module.exports = {
  computeDeployParityVerdict,
  formatDeployParityRow,
  formatDeployParityVerdict,
  summarizeDrift,
  currentRuntimeReleaseSha,
  STALE_HOURS,
};
