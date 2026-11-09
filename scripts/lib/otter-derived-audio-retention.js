'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DERIVED_XWIN_PATTERN = /-xwin-[^/\\]+\.wav$/i;

function normalizedPath(value) {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}

function audioBasename(value) {
  return path.basename(String(value || '')).toLowerCase();
}

function collectReferencedAudioBasenames(value, output = new Set()) {
  if (typeof value === 'string') {
    if (/\.wav$/i.test(value.trim())) output.add(audioBasename(value.trim()));
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferencedAudioBasenames(item, output);
    return output;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectReferencedAudioBasenames(item, output);
    }
  }
  return output;
}

function basenamesInDir(dir, fsApi = fs) {
  if (!fsApi.existsSync(dir)) return new Set();
  return new Set(
    fsApi
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.parse(entry.name).name.toLowerCase()),
  );
}

function candidateRows({
  dataDir,
  nowMs = Date.now(),
  minAgeDays = 14,
  protectedAudioBasenames = new Set(),
  fsApi = fs,
} = {}) {
  const audioDir = path.join(dataDir, 'otter', 'audio');
  const fullAudioIds = basenamesInDir(path.join(dataDir, 'otter', 'audio-full'), fsApi);
  const enrichedIds = basenamesInDir(path.join(dataDir, 'otter', 'enriched'), fsApi);
  const protectedNames = new Set(
    [...protectedAudioBasenames].map((value) => audioBasename(value)),
  );
  const cutoffMs = nowMs - Math.max(0, Number(minAgeDays) || 0) * 24 * 60 * 60 * 1000;
  const candidates = [];
  const skipped = {
    not_derived_xwin: 0,
    too_new: 0,
    not_reconstructible: 0,
    referenced: 0,
  };
  if (!fsApi.existsSync(audioDir)) return { candidates, skipped };
  const callDirs = fsApi
    .readdirSync(audioDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const callDir of callDirs) {
    const otid = callDir.name;
    const dir = path.join(audioDir, otid);
    for (const entry of fsApi.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!DERIVED_XWIN_PATTERN.test(entry.name)) {
        skipped.not_derived_xwin += 1;
        continue;
      }
      const file = path.join(dir, entry.name);
      const stats = fsApi.statSync(file);
      if (stats.mtimeMs > cutoffMs) {
        skipped.too_new += 1;
        continue;
      }
      if (!fullAudioIds.has(otid.toLowerCase()) || !enrichedIds.has(otid.toLowerCase())) {
        skipped.not_reconstructible += 1;
        continue;
      }
      if (protectedNames.has(entry.name.toLowerCase())) {
        skipped.referenced += 1;
        continue;
      }
      candidates.push({
        otid,
        file,
        relative_path: normalizedPath(path.relative(dataDir, file)),
        bytes: Number(stats.size || 0),
        mtime_ms: Number(stats.mtimeMs || 0),
      });
    }
  }
  candidates.sort(
    (left, right) =>
      left.mtime_ms - right.mtime_ms ||
      left.relative_path.localeCompare(right.relative_path),
  );
  return { candidates, skipped };
}

async function executeRetention({
  candidates = [],
  maxFiles = 5000,
  concurrency = 1,
  actionSampleLimit = 20,
  targetFreeBytes = 15 * 1024 ** 3,
  capacitySnapshot,
  archiveAndVerify,
  appendReceipt,
  onProgress = () => {},
  unlinkFile = (file) => fs.unlinkSync(file),
  generatedAt = () => new Date().toISOString(),
} = {}) {
  const result = {
    archived: 0,
    deleted: 0,
    bytes_reclaimed: 0,
    stopped_reason: '',
    actions: [],
  };
  const selected = candidates.slice(0, Math.max(0, Number(maxFiles) || 0));
  const workerCount = Math.min(
    selected.length,
    Math.max(1, Math.floor(Number(concurrency) || 1)),
  );
  let cursor = 0;
  let targetReached = false;
  let fatalError = null;
  async function work() {
    while (!targetReached && !fatalError) {
      const index = cursor;
      cursor += 1;
      if (index >= selected.length) return;
      const candidate = selected[index];
      if (!candidate) return;
      const before = capacitySnapshot();
      if (Number(before.available_bytes || 0) >= Number(targetFreeBytes || 0)) {
        targetReached = true;
        return;
      }
      try {
        const archive = await archiveAndVerify(candidate);
        const archivedReceipt = {
          schema: 'life_archive_otter_derived_audio_retention_receipt.v1',
          event: 'archive_verified',
          at: generatedAt(),
          ...candidate,
          archive,
        };
        appendReceipt(archivedReceipt);
        result.archived += 1;
        unlinkFile(candidate.file);
        const deletedReceipt = {
          ...archivedReceipt,
          event: 'local_deleted',
          at: generatedAt(),
        };
        appendReceipt(deletedReceipt);
        result.deleted += 1;
        result.bytes_reclaimed += Number(candidate.bytes || 0);
        result.actions.push(deletedReceipt);
        const sampleLimit = Math.max(0, Math.floor(Number(actionSampleLimit) || 0));
        if (result.actions.length > sampleLimit) {
          result.actions.splice(0, result.actions.length - sampleLimit);
        }
        await onProgress({
          archived: result.archived,
          deleted: result.deleted,
          bytes_reclaimed: result.bytes_reclaimed,
          last_action: deletedReceipt,
        });
      } catch (error) {
        fatalError ||= error;
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => work()));
  if (fatalError) throw fatalError;
  if (targetReached) result.stopped_reason = 'target_free_capacity_reached';
  if (!result.stopped_reason) {
    result.stopped_reason =
      result.deleted >= Math.max(0, Number(maxFiles) || 0)
        ? 'max_files_reached'
        : 'eligible_candidates_exhausted';
  }
  return result;
}

module.exports = {
  DERIVED_XWIN_PATTERN,
  normalizedPath,
  collectReferencedAudioBasenames,
  candidateRows,
  executeRetention,
};
