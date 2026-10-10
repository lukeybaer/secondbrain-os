'use strict';

const CT_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function ctDate(value = new Date()) {
  const parts = Object.fromEntries(
    CT_FORMAT.formatToParts(value instanceof Date ? value : new Date(value))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftDate(date, days) {
  const [year, month, day] = String(date).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function filesystemSnapshot(stat) {
  const blockSize = Number(stat.bsize || stat.frsize || 0);
  const totalBytes = blockSize * Number(stat.blocks || 0);
  const availableBytes = blockSize * Number(stat.bavail ?? stat.bfree ?? 0);
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const usePercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : null;
  return {
    total_bytes: totalBytes,
    available_bytes: availableBytes,
    used_bytes: usedBytes,
    use_percent: usePercent == null ? null : Math.round(usePercent * 10) / 10,
  };
}

const FREE_SPACE_RED_THRESHOLD_BYTES = 15 * 1024 * 1024 * 1024; // 15 GB

// A red rule for the daily disk sample: an ENOSPC incident on 2026-08-23 broke
// Otter recluster after the root disk hit 98% full (3.7GB free). No probe
// currently reads this sample (checked scripts/health-self-heal.js and the
// briefing System Health readers) -- this only makes the SAMPLE itself carry a
// status, per the instruction not to invent a new metric where none is wired.
function freeSpaceStatus(availableBytes, thresholdBytes = FREE_SPACE_RED_THRESHOLD_BYTES) {
  const bytes = Number(availableBytes);
  const gib = (value) => `${(value / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (!Number.isFinite(bytes)) {
    return { status: 'unknown', status_detail: 'available_bytes unreadable' };
  }
  if (bytes < thresholdBytes) {
    return {
      status: 'red',
      status_detail: `${gib(bytes)} free, below the ${gib(thresholdBytes)} floor`,
    };
  }
  return { status: 'green', status_detail: `${gib(bytes)} free` };
}

function storageDecision({ samples = [], baselineAt = '', thresholdPercent = 80 } = {}) {
  const baselineMs = Date.parse(baselineAt);
  const byDate = new Map();
  for (const sample of samples) {
    const at = Date.parse(sample?.sampled_at || '');
    if (!Number.isFinite(at) || !Number.isFinite(baselineMs) || at < baselineMs) continue;
    if (!sample.ct_date || !Number.isFinite(Number(sample.use_percent))) continue;
    byDate.set(sample.ct_date, sample);
  }
  const ordered = [...byDate.values()].sort((a, b) => a.ct_date.localeCompare(b.ct_date));
  const latest = ordered.slice(-3);
  const consecutive =
    latest.length === 3 &&
    latest[1].ct_date === shiftDate(latest[0].ct_date, 1) &&
    latest[2].ct_date === shiftDate(latest[1].ct_date, 1);
  const allAbove = consecutive && latest.every((row) => Number(row.use_percent) > thresholdPercent);
  return {
    schema: 'secondbrain.storage-pressure-decision.v1',
    generated_at: new Date().toISOString(),
    cleanup_baseline_at: baselineAt || null,
    threshold_percent: thresholdPercent,
    evaluated_days: latest.map((row) => ({ ct_date: row.ct_date, use_percent: row.use_percent })),
    consecutive_days: consecutive,
    conditional_authorization_met: allAbove,
    recommendation: allAbove
      ? 'conditional-authorization-met:gp3-160gib'
      : 'hold:gp3-120gib-continue-safe-cleanup',
  };
}

module.exports = {
  ctDate,
  filesystemSnapshot,
  shiftDate,
  storageDecision,
  freeSpaceStatus,
  FREE_SPACE_RED_THRESHOLD_BYTES,
};
