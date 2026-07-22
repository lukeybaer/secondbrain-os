const fs = require('fs');
const path = require('path');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function sequenceSlug(acousticGroupId) {
  return String(acousticGroupId || 'voice')
    .replace(/^ExampleCo_voice_ecapa_/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

function sourceManifestPath(sourceManifest, { repoRoot, dataDir }) {
  const source = String(sourceManifest || '').trim();
  if (!source) return '';
  if (path.isAbsolute(source)) return source;
  const normalized = source.replace(/\\/g, '/');
  if (normalized.startsWith('data/') && dataDir) {
    return path.join(dataDir, normalized.slice('data/'.length));
  }
  return path.join(repoRoot || path.resolve(__dirname, '..', '..'), source);
}

function candidateManifestPaths(acousticGroupId, options = {}) {
  const voiceprintDir = options.voiceprintDir;
  if (!voiceprintDir) return [];
  const slug = sequenceSlug(acousticGroupId);
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^voice-sequence-${escaped}(?:-\\d+)?\\.json$`, 'i');
  const candidates = [];
  const sourcePath = sourceManifestPath(options.sourceManifest, options);
  if (sourcePath) candidates.push(sourcePath);
  if (fs.existsSync(voiceprintDir)) {
    for (const name of fs.readdirSync(voiceprintDir)) {
      if (pattern.test(name)) candidates.push(path.join(voiceprintDir, name));
    }
  }
  return [...new Set(candidates.map((file) => path.resolve(file)))];
}

function loadBestVoiceSequenceManifest(acousticGroupId, options = {}) {
  const rows = candidateManifestPaths(acousticGroupId, options)
    .map((file) => ({ file, manifest: readJson(file, null) }))
    .filter(({ manifest }) => {
      if (!manifest || !Array.isArray(manifest.samples)) return false;
      return !manifest.target || String(manifest.target) === String(acousticGroupId);
    })
    .sort((a, b) => {
      const sampleDelta = b.manifest.samples.length - a.manifest.samples.length;
      if (sampleDelta) return sampleDelta;
      return String(b.manifest.generated_at || '').localeCompare(
        String(a.manifest.generated_at || ''),
      );
    });
  return rows[0] || null;
}

function buildConfirmedSequenceLineage(registry, options = {}) {
  const claims = new Map();
  const manifests = [];
  for (const [acousticGroupId, resolution] of Object.entries(
    registry?.acoustic_group_resolutions || {},
  )) {
    if (resolution?.status !== 'confirmed_by_ExampleCo' || !resolution.person_id) continue;
    const loaded = loadBestVoiceSequenceManifest(acousticGroupId, {
      ...options,
      sourceManifest: resolution.source_manifest || '',
    });
    if (!loaded) continue;
    manifests.push({
      acoustic_group_id: acousticGroupId,
      person_id: resolution.person_id,
      manifest: loaded.file,
      samples: loaded.manifest.samples.length,
    });
    for (const sample of loaded.manifest.samples) {
      const voiceClusterId = String(sample?.voiceClusterId || '').trim();
      if (!voiceClusterId) continue;
      if (!claims.has(voiceClusterId)) claims.set(voiceClusterId, new Map());
      claims.get(voiceClusterId).set(resolution.person_id, {
        person_id: resolution.person_id,
        display_name: resolution.display_name || '',
        acoustic_group_id: acousticGroupId,
        source_manifest: loaded.file,
      });
    }
  }

  const byVoiceClusterId = new Map();
  const conflicts = [];
  for (const [voiceClusterId, people] of claims) {
    if (people.size === 1) {
      byVoiceClusterId.set(voiceClusterId, [...people.values()][0]);
      continue;
    }
    conflicts.push({
      voice_cluster_id: voiceClusterId,
      person_ids: [...people.keys()].sort(),
    });
  }
  return { byVoiceClusterId, conflicts, manifests };
}

module.exports = {
  sequenceSlug,
  candidateManifestPaths,
  loadBestVoiceSequenceManifest,
  buildConfirmedSequenceLineage,
};
