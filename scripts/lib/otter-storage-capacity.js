'use strict';

const fs = require('node:fs');

const GIB = 1024 ** 3;
const DEFAULT_MIN_FREE_BYTES = 5 * GIB;
const DEFAULT_MIN_FREE_RATIO = 0.08;
const DEFAULT_TARGET_FREE_BYTES = 15 * GIB;

function finiteNonnegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function storageCapacitySnapshot({
  targetPath,
  statfsSync = fs.statfsSync,
  minFreeBytes = DEFAULT_MIN_FREE_BYTES,
  minFreeRatio = DEFAULT_MIN_FREE_RATIO,
  targetFreeBytes = DEFAULT_TARGET_FREE_BYTES,
} = {}) {
  if (!targetPath) throw new Error('storage capacity targetPath is required');
  let stats;
  try {
    stats = statfsSync(targetPath);
  } catch (cause) {
    const error = new Error(
      `OTTER_STORAGE_CAPACITY_WAIT: cannot inspect storage for ${targetPath}`,
      { cause },
    );
    error.code = 'OTTER_STORAGE_CAPACITY_WAIT';
    throw error;
  }
  const blockSize = finiteNonnegative(stats.bsize, 0);
  const totalBytes = finiteNonnegative(stats.blocks, 0) * blockSize;
  const availableBytes =
    finiteNonnegative(stats.bavail, finiteNonnegative(stats.bfree, 0)) * blockSize;
  const ratioFloor = totalBytes * finiteNonnegative(minFreeRatio, DEFAULT_MIN_FREE_RATIO);
  const requiredFreeBytes = Math.ceil(
    Math.max(finiteNonnegative(minFreeBytes, DEFAULT_MIN_FREE_BYTES), ratioFloor),
  );
  const desiredFreeBytes = Math.ceil(
    Math.max(
      finiteNonnegative(targetFreeBytes, DEFAULT_TARGET_FREE_BYTES),
      requiredFreeBytes,
    ),
  );
  return {
    schema: 'life_archive_otter_storage_capacity.v1',
    target_path: String(targetPath),
    total_bytes: totalBytes,
    available_bytes: availableBytes,
    available_ratio: totalBytes > 0 ? availableBytes / totalBytes : 0,
    required_free_bytes: requiredFreeBytes,
    target_free_bytes: desiredFreeBytes,
    shortfall_bytes: Math.max(0, requiredFreeBytes - availableBytes),
    target_shortfall_bytes: Math.max(0, desiredFreeBytes - availableBytes),
    ok: totalBytes > 0 && availableBytes >= requiredFreeBytes,
  };
}

function assertHeavyOtterCapacity(options = {}) {
  const snapshot = storageCapacitySnapshot(options);
  if (snapshot.ok) return snapshot;
  const error = new Error(
    `OTTER_STORAGE_CAPACITY_WAIT: ${snapshot.available_bytes} bytes available; ${snapshot.required_free_bytes} required`,
  );
  error.code = 'OTTER_STORAGE_CAPACITY_WAIT';
  error.capacity = snapshot;
  throw error;
}

function saveCapacityWaitReport({ file, report, saveJson } = {}) {
  try {
    saveJson(file, report);
  } catch (error) {
    report.status_write_error = String(
      error?.code || error?.message || error,
    );
  }
  return report;
}

module.exports = {
  GIB,
  DEFAULT_MIN_FREE_BYTES,
  DEFAULT_MIN_FREE_RATIO,
  DEFAULT_TARGET_FREE_BYTES,
  storageCapacitySnapshot,
  assertHeavyOtterCapacity,
  saveCapacityWaitReport,
};
