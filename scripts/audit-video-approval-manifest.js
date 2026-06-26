#!/usr/bin/env node
/**
 * Audit content-review/pending/manifest.json against the real video and
 * thumbnail quality gates. This prevents stale rejection notes from keeping
 * good artifacts blocked, and prevents broken artifacts from sitting in
 * pending_approval after a weak regen gate.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const MANIFEST = path.join(REPO, 'content-review', 'pending', 'manifest.json');
const PENDING_DIR = path.dirname(MANIFEST);
const THUMB_GATE = path.join(REPO, 'scripts', 'check-thumbnail-quality.py');
const VIDEO_GATE = path.join(REPO, 'scripts', 'check-video-content-not-blank.py');

function pythonBins() {
  return process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
}

function runGate(script, artifact, timeoutMs) {
  for (const bin of pythonBins()) {
    const r = spawnSync(bin, [script, artifact], { encoding: 'utf8', timeout: timeoutMs });
    if (r.error && r.error.code === 'ENOENT') continue;
    if (r.status === null) continue;
    try {
      return JSON.parse((r.stdout || '').trim());
    } catch {
      return { ok: false, reason: `gate output unparseable: ${(r.stdout || r.stderr || '').slice(0, 200)}` };
    }
  }
  return { ok: false, reason: 'no python runtime could run the gate' };
}

function compactReason(reason) {
  return String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function isVideoContentGateRejection(v) {
  const text = [
    v && v.video_rejection_note,
    v && v.regen_error,
    v && v.regen_status,
  ]
    .filter(Boolean)
    .join(' ');
  return /BLANK VIDEO|video content gate|content gate|blank frame|sampled frames|text-on-black|quality gate/i.test(
    text,
  );
}

function isThumbnailQualityGateRejection(v) {
  const text = [
    v && v.thumbnail_rejection_note,
    v && v.regen_error,
    v && v.regen_status,
    v && v.status,
  ]
    .filter(Boolean)
    .join(' ');
  return /thumbnail quality gate|blank thumbnail|procedural thumbnail|quality gate|thumbnail_rejected/i.test(
    text,
  );
}

function clearStaleThumbnailQualityGateRejection(v, result, now) {
  if (!v || !result || !result.ok) return false;
  if (!isThumbnailQualityGateRejection(v)) return false;
  const isBlockedState =
    v.thumbnail_needs_regen === true ||
    v.status === 'thumbnail_rejected' ||
    v.regen_status === 'failed' ||
    v.regen_status === 'dead-letter';
  if (!isBlockedState) return false;

  const priorNote = v.thumbnail_rejection_note || v.regen_error || '';
  v.thumbnail_needs_regen = false;
  if (result.metrics) v.regen_thumbnail_metrics = result.metrics;
  v.thumbnail_feedback_resolved_at = now;
  v.thumbnail_feedback_resolved_reason = 'thumbnail quality gate passed after audit';
  v.quality_audit_resolved_at = now;
  v.regen_status = 'gate_passed_after_audit';
  v.status = v.video_needs_regen ? 'video_rejected' : 'pending_approval';
  v.fix_summary =
    'quality audit passed: centered real thumbnail has visible content; cleared stale thumbnail rejection.';
  if (priorNote && !v.previous_thumbnail_feedback) v.previous_thumbnail_feedback = priorNote;
  v.thumbnail_rejection_note = null;
  delete v.regen_error;
  delete v.regen_failed_at;
  return true;
}

function clearStaleVideoContentGateRejection(v, result, now) {
  if (!v || !result || !result.ok) return false;
  if (!isVideoContentGateRejection(v)) return false;
  const isBlockedState =
    v.video_needs_regen === true ||
    v.status === 'video_rejected' ||
    v.regen_status === 'failed' ||
    v.regen_status === 'dead-letter' ||
    v.regen_status === 'content_gate_blank_frame';
  if (!isBlockedState) return false;

  const priorNote = v.video_rejection_note || v.regen_error || '';
  v.video_needs_regen = false;
  if (result.metrics) {
    v.regen_video_metrics = result.metrics;
    v.regen_video_content_metrics = result.metrics;
  }
  v.video_feedback_resolved_at = now;
  v.video_feedback_resolved_reason = 'video content gate passed after audit';
  v.quality_audit_resolved_at = now;
  v.regen_status = 'gate_passed_after_audit';
  v.status = v.thumbnail_needs_regen ? 'thumbnail_rejected' : 'pending_approval';
  v.fix_summary =
    'quality audit passed: dark real footage has visible content; cleared stale blank-video rejection.';
  if (priorNote && !v.previous_feedback) v.previous_feedback = priorNote;
  v.video_rejection_note = null;
  delete v.regen_error;
  delete v.regen_failed_at;
  delete v.content_gate_blank_at;
  delete v.content_gate_planner_advisory;
  return true;
}

function main() {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`manifest missing: ${MANIFEST}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const now = new Date().toISOString();
  const changes = [];

  for (const v of manifest.videos || []) {
    if (!v || !v.id) continue;

    const thumbName = v.thumbnail_file || `${v.id}_thumb.jpg`;
    const thumbPath = path.join(PENDING_DIR, thumbName);
    if (fs.existsSync(thumbPath) && fs.existsSync(THUMB_GATE)) {
      const result = runGate(THUMB_GATE, thumbPath, 15000);
      v.latest_thumbnail_gate = result;
      if (!result.ok) {
        v.status = 'thumbnail_rejected';
        v.thumbnail_needs_regen = true;
        v.thumbnail_rejection_note = compactReason(result.reason);
        v.regen_status = 'failed';
        v.regen_error = `thumbnail quality gate: ${compactReason(result.reason)}`;
        changes.push(`${v.id}: thumbnail rejected (${compactReason(result.reason)})`);
      } else if (clearStaleThumbnailQualityGateRejection(v, result, now)) {
        changes.push(`${v.id}: cleared stale thumbnail quality-gate rejection after gates passed`);
      } else if (v.thumbnail_rejection_note && !v.thumbnail_needs_regen) {
        v.thumbnail_feedback_resolved_at = now;
        v.thumbnail_rejection_note = null;
        changes.push(`${v.id}: cleared stale thumbnail rejection note`);
      }
    }

    const videoName = v.video_file || `${v.id}.mp4`;
    const videoPath = path.join(PENDING_DIR, videoName);
    if (fs.existsSync(videoPath) && fs.existsSync(VIDEO_GATE)) {
      const result = runGate(VIDEO_GATE, videoPath, 90000);
      v.latest_video_gate = result;
      if (!result.ok) {
        v.status = 'video_rejected';
        v.video_needs_regen = true;
        v.video_rejection_note = compactReason(result.reason);
        v.regen_status = 'failed';
        v.regen_error = `video content gate: ${compactReason(result.reason)}`;
        v.regen_video_content_metrics = result.metrics || {};
        changes.push(`${v.id}: video rejected (${compactReason(result.reason)})`);
      } else if (clearStaleVideoContentGateRejection(v, result, now)) {
        changes.push(`${v.id}: cleared stale video content-gate rejection after gates passed`);
      } else if (v.status === 'pending_approval' && v.regen_status === 'failed' && !v.video_needs_regen) {
        v.quality_audit_resolved_at = now;
        v.regen_status = 'gate_passed_after_audit';
        delete v.regen_error;
        delete v.regen_failed_at;
        changes.push(`${v.id}: cleared stale failed regen status after gates passed`);
      }
    }
  }

  manifest.audit_updated_at = now;
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, changes }, null, 2));
}

module.exports = {
  isThumbnailQualityGateRejection,
  clearStaleThumbnailQualityGateRejection,
  isVideoContentGateRejection,
  clearStaleVideoContentGateRejection,
};

if (require.main === module) main();
