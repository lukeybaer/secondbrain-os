'use strict';

// Proof that a local full recording is exactly the object recorder serves.
// Recorder can serve a recording shorter than its transcript (one recording: 96 of 192
// minutes). A short local file is only accepted as complete after a fresh
// download returned the same bytes; an interrupted download hashes differently
// and is replaced instead. The probe stage's beyond_audio_end disposition is
// final only while this proof matches the current file's hash.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCHEMA = 'life_archive_otter_full_audio_provider_match.v1';
// A recording this much shorter than the transcript's last turn is "short".
const SHORT_AUDIO_TOLERANCE_SECONDS = 60;

function verificationPath(dataDir, otid) {
  return path.join(dataDir, 'otter', 'audio-full-verification', `${otid}.json`);
}

function fileSha256(file, fsApi = fs) {
  return crypto.createHash('sha256').update(fsApi.readFileSync(file)).digest('hex');
}

function transcriptEndSeconds(enriched) {
  let end = 0;
  for (const segment of enriched?.segments || []) {
    const value = Number(segment?.end_seconds);
    if (Number.isFinite(value) && value > end) end = value;
  }
  return end;
}

// ffprobe lives in /usr/local/bin on EC2, outside cron's default PATH.
function audioDurationSeconds(file, run = spawnSync) {
  const bins = [process.env.FFPROBE_PATH, 'ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'].filter(Boolean);
  for (const bin of bins) {
    const res = run(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file], {
      encoding: 'utf8',
      timeout: 15000,
    });
    if (res.error && ['ENOENT', 'EACCES'].includes(res.error.code)) continue;
    const value = res.status === 0 ? Number(String(res.stdout || '').trim()) : NaN;
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  return null;
}

function isShortAudio(audioSeconds, transcriptEnd) {
  return (
    Number.isFinite(audioSeconds) &&
    audioSeconds > 0 &&
    transcriptEnd - audioSeconds > SHORT_AUDIO_TOLERANCE_SECONDS
  );
}

function writeProviderMatch({ dataDir, otid, sha256, bytes, durationSeconds, transcriptEnd, now = () => new Date().toISOString(), fsApi = fs }) {
  const file = verificationPath(dataDir, otid);
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const value = {
    schema: SCHEMA,
    otid: String(otid),
    sha256: String(sha256),
    bytes: Number(bytes),
    duration_seconds: Number(durationSeconds),
    transcript_end_seconds: Number(transcriptEnd),
    evidence: 'fresh_provider_download_identical_bytes',
    verified_at: now(),
  };
  fsApi.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

// True only when a provider-match proof exists for this otid and names the
// current audio file's exact hash.
function providerMatchVerified({ dataDir, otid, audioFile, fsApi = fs }) {
  const file = verificationPath(dataDir, otid);
  if (!audioFile || !fsApi.existsSync(file) || !fsApi.existsSync(audioFile)) return false;
  let proof;
  try {
    proof = JSON.parse(fsApi.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  return (
    proof?.schema === SCHEMA &&
    String(proof.otid || '') === String(otid) &&
    /^[a-f0-9]{64}$/.test(String(proof.sha256 || '')) &&
    proof.sha256 === fileSha256(audioFile, fsApi)
  );
}

module.exports = {
  SCHEMA,
  SHORT_AUDIO_TOLERANCE_SECONDS,
  verificationPath,
  fileSha256,
  transcriptEndSeconds,
  audioDurationSeconds,
  isShortAudio,
  writeProviderMatch,
  providerMatchVerified,
};
