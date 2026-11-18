const fs = require('fs');
const path = require('path');

function candidateManifestPaths(repoRoot, opts = {}) {
  const dataDir = opts.dataDir ? path.resolve(String(opts.dataDir)) : '';
  return [
    opts.manifestPath,
    dataDir ? path.join(dataDir, 'content-review', 'pending', 'manifest.json') : '',
    dataDir ? path.join(path.dirname(dataDir), 'content-review', 'pending', 'manifest.json') : '',
    path.join(repoRoot, 'content-review', 'pending', 'manifest.json'),
    '/opt/secondbrain/content-review/pending/manifest.json',
  ]
    .filter(Boolean)
    .map((file) => path.resolve(String(file)));
}

function readJsonIfPresent(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function resolveVideoManifestForRepair(repoRoot, opts = {}) {
  const candidates = [...new Set(candidateManifestPaths(repoRoot, opts))];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const manifest = readJsonIfPresent(file, null);
        if (manifest && Array.isArray(manifest.videos)) return { manifest, manifestPath: file };
      }
    } catch {
      /* try next */
    }
  }
  const first = candidates[0] || path.join(repoRoot, 'content-review', 'pending', 'manifest.json');
  return { manifest: { videos: [] }, manifestPath: first };
}

function titleFromVideoArtifact(id, metadata = {}) {
  const direct =
    metadata.title ||
    metadata.video_title ||
    metadata.headline ||
    metadata.name ||
    metadata.topic ||
    metadata.short_title;
  if (direct) return String(direct).trim();
  return String(id || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

function findPendingVideoThumbnail(pendingDir, id) {
  const candidates = [
    `${id}_thumb.jpg`,
    `${id}_thumb.jpeg`,
    `${id}_thumb.png`,
    `${id}.jpg`,
    `${id}.jpeg`,
    `${id}.png`,
    `${id}_thumbnail.jpg`,
    `${id}_thumbnail.png`,
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(path.join(pendingDir, file))) return file;
    } catch {
      /* try next */
    }
  }
  return '';
}

function metadataForPendingVideo(pendingDir, id) {
  const candidates = [`${id}.json`, `${id}_metadata.json`, `${id}.metadata.json`];
  for (const file of candidates) {
    const json = readJsonIfPresent(path.join(pendingDir, file), null);
    if (json && typeof json === 'object') return json;
  }
  return {};
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      /* best-effort cleanup of this helper's own temporary file */
    }
    throw error;
  }
}

function rebuildVideoManifestFromPendingArtifacts(repoRoot, opts = {}) {
  const { manifest, manifestPath } = resolveVideoManifestForRepair(repoRoot, opts);
  const pendingDir = opts.pendingDir
    ? path.resolve(String(opts.pendingDir))
    : path.dirname(manifestPath);
  let files = [];
  try {
    files = fs.readdirSync(pendingDir);
  } catch {
    return null;
  }
  const existingVideos = Array.isArray(manifest.videos) ? manifest.videos : [];
  const referenced = new Set();
  for (const video of existingVideos) {
    const id = String((video && video.id) || '').trim();
    const file = String((video && video.video_file) || '').trim();
    if (id) referenced.add(`${id}.mp4`.toLowerCase());
    if (file) referenced.add(path.basename(file).toLowerCase());
  }
  const recoveredAt = new Date().toISOString();
  const additions = [];
  for (const file of files.sort()) {
    if (!/\.(?:mp4|mov|webm|m4v)$/i.test(file)) continue;
    if (referenced.has(file.toLowerCase())) continue;
    const full = path.join(pendingDir, file);
    let stat = null;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const id = path.basename(file, path.extname(file));
    const metadata = metadataForPendingVideo(pendingDir, id);
    // The build's own timestamp outranks the file mtime. A regen install copies
    // the files into pending after the text-fit check ran, so an mtime-based
    // generated_at made a valid SHA-bound receipt look stale (Sep 28 2026:
    // RECEIPT_STALE on a passing revision, stuck five days).
    const generatedAt =
      metadata.generated_at ||
      metadata.created_at ||
      metadata.generatedDate ||
      metadata.builtAt ||
      metadata.built_at ||
      new Date(stat.mtimeMs).toISOString();
    additions.push({
      id,
      title: titleFromVideoArtifact(id, metadata),
      status: 'pending_approval',
      video_file: file,
      thumbnail_file: findPendingVideoThumbnail(pendingDir, id) || undefined,
      channel: metadata.channel || metadata.target_channel || metadata.platform || undefined,
      generated_at: generatedAt,
      generated_date: String(generatedAt).slice(0, 10),
      recovered_from_pending_artifact: true,
      recovered_from_pending_artifact_at: recoveredAt,
      telegram_notified_at: recoveredAt,
      notification_suppressed_reason: 'manifest-recovered-from-existing-artifact',
    });
    referenced.add(file.toLowerCase());
  }
  if (!additions.length) return null;
  const nextManifest = {
    ...manifest,
    videos: [...existingVideos, ...additions],
    recovered_from_pending_artifacts_at: recoveredAt,
    recovered_from_pending_artifacts_count:
      Number(manifest.recovered_from_pending_artifacts_count || 0) + additions.length,
  };
  try {
    writeJsonAtomic(manifestPath, nextManifest);
  } catch (error) {
    return {
      repaired: 0,
      cleared: false,
      actions: [
        { error: `failed to write rebuilt manifest: ${String(error.message).slice(0, 200)}` },
      ],
    };
  }
  return {
    repaired: additions.length,
    cleared: true,
    actions: additions.map((video) => ({
      action: 'recovered pending video artifact into approval manifest',
      videoId: video.id,
      file: video.video_file,
    })),
    manifestPath,
  };
}

module.exports = {
  rebuildVideoManifestFromPendingArtifacts,
  resolveVideoManifestForRepair,
};
