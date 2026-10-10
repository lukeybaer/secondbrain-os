#!/usr/bin/env node
/**
 * voice-stage-reference-audio.js -- stage enrollment reference audio onto EFS.
 *
 * The reference_people:0 defect (2026-06-02): the Fargate resolver re-embeds
 * each confirmed enrollment's reference clip with ECAPA, but those clips
 * (data/otter/audio/.../*.wav) were never copied to EFS, so embeddingFor()'s
 * existsSync fails for every enrollment and reference_people is 0 -- no
 * voiceprint ever confirms.
 *
 * This runs on the PC/git machine (where the audio lives; EC2 does NOT hold the
 * otter/audio tree). It reads the registry's GATED enrollments (the same gate
 * the resolver applies: person confirmed_by_ExampleCo + enrolled, or a ExampleCo-confirmed
 * cluster resolution), collects each enrollment's reference clip, and ships the
 * small bounded set (~80 files / ~60 MB) to EFS at data/otter/audio/... via EC2.
 *
 * Fail-loud: reports every enrollment whose reference clip is missing locally,
 * so a shortfall in reference_people is visible instead of silent.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveRepoAudioPath } = require('./lib/repo-audio-path');

const REPO = path.resolve(__dirname, '..');
const REGISTRY = path.join(REPO, 'data', 'life-archive', 'voice-identity-registry.json');
const EC2 = process.env.EC2_HOST || 'ec2-user@ExampleCo';
const EFS_MOUNT = process.env.VOICE_EFS_MOUNT_REMOTE || '/mnt/sbvoice';
const SSH_KEY = process.env.EC2_SSH_KEY
  || [path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'sb-key.pem'),
      path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'secondbrain-backend-key.pem')]
    .find((p) => fs.existsSync(p));

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}

// Apply the SAME gate the resolver uses, so we stage exactly the enrollments it
// will try to load (no more, no less).
function gatedEnrollments(identity) {
  const out = [];
  for (const e of identity.enrollments || []) {
    if (e.calibration_quarantine_status === 'quarantined') continue;
    const person = identity.people?.[e.person_id] || {};
    const clusterId = e.voice_cluster_id || null;
    const resolution = clusterId ? identity.voice_cluster_resolutions?.[clusterId] : null;
    const personConfirmed = person.identity_confirmation_status === 'confirmed_by_ExampleCo'
      && person.voiceprint_status === 'enrolled';
    const ownerAllowed = e.person_id === 'ExampleCo' && personConfirmed;
    if (!ownerAllowed && !personConfirmed && resolution?.status !== 'confirmed_by_ExampleCo') continue;
    const rel = e.reference_audio_rel || e.reference_audio_path;
    if (!rel) continue;
    out.push({ person_id: e.person_id, enrollment_id: e.enrollment_id, raw: rel });
  }
  return out;
}

// Compute the repo-relative POSIX tail for an enrollment's clip (what it must be
// on EFS), plus the local absolute source.
function planFiles(enrollments) {
  const plan = [];
  const missing = [];
  const seen = new Set();
  const dataRoot = path.join(REPO, 'data');
  for (const e of enrollments) {
    const localAbs = resolveRepoAudioPath(e.raw, REPO);
    // Codex review #3: explicit containment. Only stage files genuinely under
    // REPO/data; reject anything that escapes (../) or never resolved to a
    // repo-data path, so we never tar a foreign absolute by accident.
    const within = path.resolve(localAbs).startsWith(path.resolve(dataRoot) + path.sep);
    if (!within) { missing.push({ ...e, reason: 'not_under_repo_data' }); continue; }
    const relPosix = path.relative(REPO, localAbs).replace(/\\/g, '/');
    if (!relPosix.startsWith('data/')) { missing.push({ ...e, reason: 'not_under_repo_data' }); continue; }
    if (seen.has(relPosix)) continue;
    seen.add(relPosix);
    if (!fs.existsSync(localAbs)) { missing.push({ ...e, rel: relPosix, reason: 'local_file_missing' }); continue; }
    plan.push({ rel: relPosix, localAbs });
  }
  return { plan, missing };
}

function pushToEfs(plan) {
  if (!SSH_KEY) return { ok: false, reason: 'no_ssh_key' };
  if (!plan.length) return { ok: true, pushed: 0, note: 'nothing_to_push' };
  const sshOpts = ['-i', SSH_KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20'];
  // The EFS access-point root maps to the container's /opt/secondbrain/data, so
  // on the EFS mount the tree is rooted at otter/... (NOT data/otter/...). Tar
  // the clips with paths RELATIVE TO data/ (strip the leading "data/") and
  // extract at the mount root, so a clip lands at <mount>/otter/audio/... ==
  // container /opt/secondbrain/data/otter/audio/... . Tarring data/otter/...
  // and extracting at the mount would double-nest to data/data/otter (the
  // exact nesting bug from the earlier EFS seed).
  // Use a data-relative tarball + list path with cwd=REPO/data and --force-local
  // so Windows tar/scp do not read the "C:" drive as a remote host (the
  // drive-letter gotcha). The tarball lives under data/ transiently.
  const dataDir = path.join(REPO, 'data');
  const tarRel = `.refaudio-${process.pid}.tar`;
  const listRel = `.refaudio-${process.pid}.list`;
  const tmpTar = path.join(dataDir, tarRel);
  const listFileAbs = path.join(dataDir, listRel);
  const relsFromData = plan.map((p) => p.rel.replace(/^data\//, ''));
  fs.writeFileSync(listFileAbs, relsFromData.join('\n') + '\n', 'utf8');
  try {
    const pack = spawnSync('tar', ['--force-local', '-cf', tarRel, '-T', listRel], { cwd: dataDir, encoding: 'utf8', timeout: 300000 });
    if (pack.status !== 0) return { ok: false, reason: 'tar_failed', detail: String(pack.stderr || '').slice(-300) };
    const remoteTar = `/tmp/refaudio-${process.pid}.tar`;
    const scp = spawnSync('scp', [...sshOpts, tarRel, `${EC2}:${remoteTar}`], { cwd: dataDir, encoding: 'utf8', timeout: 300000 });
    if (scp.status !== 0) return { ok: false, reason: 'scp_failed', detail: String(scp.stderr || '').slice(-300) };
    // Extract at the EFS mount root; tar paths are otter/audio/... so a clip
    // lands at <mount>/otter/audio/... == container /opt/secondbrain/data/otter/...
    const remoteCmd = [
      'set -e',
      `mkdir -p ${EFS_MOUNT}/otter/audio`,
      `tar -xf ${remoteTar} -C ${EFS_MOUNT}`,
      `chmod -R 0777 ${EFS_MOUNT}/otter/audio 2>/dev/null || true`,
      `rm -f ${remoteTar}`,
      'echo OK',
    ].join(' && ');
    const ext = spawnSync('ssh', [...sshOpts, EC2, remoteCmd], { encoding: 'utf8', timeout: 300000 });
    if (ext.status !== 0 || !String(ext.stdout || '').includes('OK')) {
      return { ok: false, reason: 'remote_extract_failed', detail: String(ext.stderr || '').slice(-300) };
    }
    // Codex review #5 (cheapest guard): verify a sample clip actually landed at
    // the container-visible path, so a wrong tar destination fails loud instead
    // of silently leaving reference_people:0.
    const sampleRel = relsFromData[0];
    const verify = spawnSync('ssh', [...sshOpts, EC2, `test -f ${EFS_MOUNT}/${sampleRel} && echo PRESENT || echo ABSENT`], { encoding: 'utf8', timeout: 30000 });
    if (!String(verify.stdout || '').includes('PRESENT')) {
      return { ok: false, reason: 'post_extract_verify_failed', detail: `sample ${sampleRel} not at ${EFS_MOUNT}` };
    }
    return { ok: true, pushed: plan.length, verified_sample: sampleRel };
  } finally {
    try { fs.unlinkSync(tmpTar); } catch { /* ignore */ }
    try { fs.unlinkSync(listFileAbs); } catch { /* ignore */ }
  }
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const identity = readJson(REGISTRY, {});
  const enrollments = gatedEnrollments(identity);
  const { plan, missing } = planFiles(enrollments);
  const report = {
    schema: 'life_archive_voice_stage_reference_audio.v1',
    generated_at: new Date().toISOString(),
    gated_enrollments: enrollments.length,
    stageable_files: plan.length,
    missing_local: missing.length,
    missing_detail: missing.slice(0, 20),
  };
  if (dryRun) {
    report.dry_run = true;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  report.push = pushToEfs(plan);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  // Fail loud if we could not push what we have, OR if a large fraction is
  // missing locally (so reference_people shortfalls are never silent).
  process.exitCode = (report.push && report.push.ok) ? 0 : 1;
}

if (require.main === module) main();

module.exports = { gatedEnrollments, planFiles };
