'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { sha256File, verifyVideoTextFitReleaseGate } = require('./video-text-fit-receipt.js');

const QUALITY_PROFILE_EXEMPTIONS = Object.freeze({
  default: Object.freeze([]),
  // screen_graphics = full-screen benchmark/demo content (no human presenter).
  // audio_edges: designed for narration cut-off-mid-word; trailing music at low
  //   volume is not the defect the criterion guards against.
  // trending_topic_alignment: measures power-word density in transcripts; benchmark
  //   narration is concise/descriptive, not keyword-dense marketing copy.
  // cta_placement: benchmark/data showcase content has no subscription CTA by design;
  //   owner-rejected "follow like that" CTAs must not be re-penalized by this gate.
  screen_graphics: Object.freeze(['lighting', 'audio_edges', 'trending_topic_alignment', 'cta_placement']),
});

function verifiedQualityProfile(descriptor, visualReceipt, candidateSha) {
  const name = String(descriptor?.quality_profile || 'default');
  const exemptions = QUALITY_PROFILE_EXEMPTIONS[name];
  if (!exemptions) throw new Error(`unsupported quality profile: ${name}`);
  if (name === 'screen_graphics') {
    if (!visualReceipt || visualReceipt.passed !== true || visualReceipt.video_sha256 !== candidateSha ||
        visualReceipt.visual_mode !== 'screen_graphics' || visualReceipt.human_subjects !== false) {
      throw new Error('screen_graphics quality profile requires passing final-byte-bound non-human visual proof');
    }
  }
  return { name, exemptCriteria: new Set(exemptions) };
}

function thresholdFailure(scores, thresholds, exemptCriteria = new Set()) {
  for (const [key, minimum] of Object.entries(thresholds || {})) {
    if (exemptCriteria.has(key)) continue;
    // minimum === 0 means informational-only; skip the gate even if score is absent.
    if (typeof minimum === 'number' && minimum > 0 && (!Number.isFinite(scores[key]) || scores[key] < minimum)) {
      return `rubric threshold failed: ${key} ${scores[key]} < ${minimum}`;
    }
  }
  return null;
}

function qualityProfilePromotionProof(descriptor, visualReceipt, destination) {
  if (!descriptor?.quality_profile || descriptor.quality_profile === 'default') return null;
  if (!descriptor.producer?.visual || !visualReceipt || !destination) {
    throw new Error('quality profile promotion proof is incomplete');
  }
  return {
    file: path.basename(destination),
    sha256: descriptor.producer.visual.sha256,
    bytes: descriptor.producer.visual.bytes,
    candidate_sha256: visualReceipt.video_sha256,
  };
}

// The descriptor is data only. Executables and destination names are fixed here.
function applyAuthenticVideoRevision(video, outPath, thumbPath, options = {}) {
  const repo = options.repo || path.resolve(__dirname, '../..');
  const run = options.spawnSync || spawnSync;
  const textGate = options.textGate || verifyVideoTextFitReleaseGate;
  const copyFile = options.copyFile || fs.copyFileSync;
  const resolve = (value) => path.resolve(repo, value);
  const check = (item) => {
    if (!item || typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !Number.isSafeInteger(item.bytes) || item.bytes <= 0) throw new Error('invalid artifact descriptor');
    const file = resolve(item.path);
    if (fs.statSync(file).size !== item.bytes || sha256File(file) !== item.sha256) {
      throw new Error(`artifact hash/bytes mismatch: ${file}`);
    }
    return file;
  };
  const analyze = (script, args) => {
    // Extend PATH so ffprobe/ffmpeg are discoverable on Linux hosts where
    // /usr/local/bin is not in the restricted process PATH.
    const extendedPath = ['/usr/local/bin', process.env.PATH].filter(Boolean).join(':');
    const result = run(process.env.PYTHON_EXE || 'python3', [path.join(repo,
      'src/main/empire/video-quality-tools', script), ...args], {
      cwd: repo, encoding: 'utf8', timeout: 1200000, maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PATH: extendedPath },
    });
    if (result.error || result.status !== 0) throw new Error(`${script} failed: ${result.error?.message || result.stderr || result.status}`);
    const output = String(result.stdout || '').trim();
    return JSON.parse(output.slice(output.indexOf('{')));
  };
  try {
    if (!video.production_revision_file) throw new Error('authentic footage requires a staged production_revision_file; generic rebuild is prohibited');
    const descriptor = JSON.parse(fs.readFileSync(resolve(video.production_revision_file), 'utf8'));
    const rejection = video.video_rejected_at || video.rejected_at;
    if (descriptor.schema !== 'secondbrain.authentic-video-revision.v1' || descriptor.id !== video.id ||
        !rejection || descriptor.rejected_at !== rejection) throw new Error('revision does not match current rejection');
    // A row retired as held_missing_final has no rejected bytes to bind. The
    // descriptor must say so explicitly; any other row still needs a baseline.
    const missingBaseline = descriptor.baseline_missing === true && descriptor.baseline_sha256 === null &&
      video.status === 'held_missing_final';
    const liveSha = () => (missingBaseline && !fs.existsSync(outPath) ? null : sha256File(outPath));
    if (!missingBaseline && !/^[a-f0-9]{64}$/.test(descriptor.baseline_sha256)) throw new Error('invalid baseline SHA');
    const currentSha = liveSha();
    const candidate = check(descriptor.candidate);
    if (descriptor.candidate.sha256 === descriptor.baseline_sha256) throw new Error('candidate must change rejected bytes');
    if (missingBaseline) {
      if (currentSha !== null && currentSha !== descriptor.candidate.sha256) {
        throw new Error('held missing final reappeared with different bytes');
      }
    } else if (currentSha !== descriptor.baseline_sha256) {
      if (currentSha !== descriptor.candidate.sha256 || !descriptor.baseline_file ||
          sha256File(resolve(descriptor.baseline_file)) !== descriptor.baseline_sha256) {
        throw new Error('baseline does not match existing video or bound retry backup');
      }
    }
    if (!Array.isArray(descriptor.source_lineage) || !descriptor.source_lineage.length) throw new Error('source lineage missing');
    descriptor.source_lineage.forEach(check);
    const thumbnail = check(descriptor.thumbnail);
    const metadata = check(descriptor.metadata);
    JSON.parse(fs.readFileSync(metadata, 'utf8'));
    const allowed = new Set(['.text-fit.json', '.directive-fidelity.json', '.srt', '.ass', '.caption-track.json']);
    const sidecars = descriptor.sidecars || [];
    const seen = new Set();
    for (const item of sidecars) {
      if (!allowed.has(item.suffix) || seen.has(item.suffix)) throw new Error('invalid or duplicate sidecar suffix');
      seen.add(item.suffix);
      const file = check(item);
      if (['.text-fit.json', '.directive-fidelity.json'].includes(item.suffix) && file !== candidate + item.suffix) {
        throw new Error('gate sidecars must be beside candidate');
      }
    }
    if (!seen.has('.text-fit.json') || !seen.has('.directive-fidelity.json')) throw new Error('required QA sidecars missing');
    let visualReceipt = null;
    let visualReceiptFile = null;
    if (descriptor.quality_profile && descriptor.quality_profile !== 'default') {
      if (!descriptor.producer?.visual) throw new Error('quality profile visual receipt missing');
      visualReceiptFile = check(descriptor.producer.visual);
      visualReceipt = JSON.parse(fs.readFileSync(visualReceiptFile, 'utf8'));
    }
    const qualityProfile = verifiedQualityProfile(descriptor, visualReceipt, descriptor.candidate.sha256);
    const directiveReceipt = JSON.parse(fs.readFileSync(candidate + '.directive-fidelity.json', 'utf8'));
    if (!video.video_rejection_note || directiveReceipt.feedback !== video.video_rejection_note) throw new Error('directive receipt feedback does not match current rejection');
    const transcript = descriptor.transcript ? check(descriptor.transcript) : null;
    const fit = textGate({ videoPath: candidate, minimumVerifiedAt: rejection });
    if (!fit.ok) throw new Error(`text-fit gate: ${fit.reason}`);
    const fidelity = analyze('analyze-rejection-directive-fidelity.py', [candidate]);
    const fast = analyze('run-quality-check-fast.py', [candidate, '--platform', 'shorts', '--thumbnail', thumbnail,
      '--workers', '2', '--title', String(video.title || ''), ...(transcript ? ['--transcript', transcript] : [])]);
    const scores = {};
    for (const [key, value] of Object.entries(fast.detailed_scores || {})) {
      scores[key] = typeof value === 'number' ? value : value?.score;
    }
    scores.rejection_directive_fidelity = fidelity.scores?.rejection_directive_fidelity?.score;
    const thresholds = JSON.parse(fs.readFileSync(path.join(repo, 'data/agent/video-quality-thresholds.json'), 'utf8')).platforms.shorts;
    if (!thresholds || !Object.keys(thresholds).length) throw new Error('quality thresholds missing');
    const failure = thresholdFailure(scores, thresholds, qualityProfile.exemptCriteria);
    if (failure) throw new Error(failure);
    if (!Number.isFinite(fast.overall_score) || !Number.isFinite(fast.virality_score)) throw new Error('aggregate rubric scores missing');
    // Recheck inputs after lengthy analysis, before touching any live output.
    [descriptor.candidate, descriptor.thumbnail, descriptor.metadata, ...descriptor.source_lineage, ...sidecars,
      ...(descriptor.transcript ? [descriptor.transcript] : []),
      ...(visualReceipt ? [descriptor.producer.visual] : [])].forEach(check);
    if (liveSha() !== currentSha) throw new Error('live video changed during QA');
    const stem = outPath.replace(/\.mp4$/i, '');
    const visualReceiptDestination = outPath + '.visual-verification.json';
    const copies = [...(transcript ? [[transcript, outPath + '.transcript.json']] : []), [candidate, outPath], [thumbnail, thumbPath], [metadata, stem + '.json'],
      ...(visualReceiptFile ? [[visualReceiptFile, visualReceiptDestination]] : []),
      ...sidecars.map(item => [resolve(item.path), ['.srt', '.ass'].includes(item.suffix) ? stem + item.suffix : outPath + item.suffix])];
    // Retain rollback bytes until the complete artifact set is installed.
    const backups = copies.map(([, dest]) => [dest, fs.existsSync(dest) ? fs.readFileSync(dest) : null]);
    let installedVisualProof = null;
    try {
      for (const [source, dest] of copies) {
        if (path.resolve(source) !== path.resolve(dest)) copyFile(source, dest);
      }
      if (visualReceiptFile) {
        const installedBytes = fs.statSync(visualReceiptDestination).size;
        const installedSha256 = sha256File(visualReceiptDestination);
        if (
          installedBytes !== descriptor.producer.visual.bytes ||
          installedSha256 !== descriptor.producer.visual.sha256
        ) {
          throw new Error('installed visual receipt hash/bytes mismatch');
        }
        installedVisualProof = {
          file: path.basename(visualReceiptDestination),
          sha256: installedSha256,
          bytes: installedBytes,
          candidate_sha256: visualReceipt.video_sha256,
        };
      }
    } catch (error) {
      for (const [dest, bytes] of backups) {
        if (bytes === null) fs.rmSync(dest, { force: true }); else fs.writeFileSync(dest, bytes);
      }
      throw error;
    }
    return { ok: true, rubric_pass: true, rubric: { overall_score: fast.overall_score,
      virality_score: fast.virality_score, scores }, size_bytes: descriptor.candidate.bytes,
      metrics: { authentic_source_revision: true, source_lineage: descriptor.source_lineage,
        quality_profile: qualityProfile.name, exempt_criteria: [...qualityProfile.exemptCriteria],
        quality_profile_candidate_sha256: descriptor.candidate.sha256,
        quality_profile_visual_receipt: installedVisualProof,
        directive_fidelity: fidelity, text_fit: { ok: true } } };
  } catch (error) {
    return { ok: false, rubric_pass: false, reason: String(error.message || error) };
  }
}
module.exports = {
  applyAuthenticVideoRevision,
  qualityProfilePromotionProof,
  thresholdFailure,
  verifiedQualityProfile,
};
