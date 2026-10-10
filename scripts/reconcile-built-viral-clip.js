#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { appendBuiltClipToManifest } = require('./build-viral-clip.js');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--id') out.id = argv[++i];
    else if (argv[i] === '--date') out.date = argv[++i];
    else if (argv[i] === '--root') out.root = argv[++i];
    else if (argv[i] === '--data-dir') out.dataDir = argv[++i];
  }
  return out;
}

function resolveProposal({ dataDir, id, date }) {
  const dir = path.join(dataDir, 'agent', 'viral-tech-clips');
  const names = date
    ? [`${date}.json`]
    : fs.readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse();
  for (const name of names) {
    const statePath = path.join(dir, name);
    if (!fs.existsSync(statePath)) continue;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const proposal = (state.proposals || []).find((item) => item && item.id === id);
    if (proposal) return { proposal, statePath, date: name.slice(0, 10) };
  }
  throw new Error(`proposal not found: ${id}`);
}

function reconcileBuiltViralClip(options = {}) {
  const root = path.resolve(options.root || process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..'));
  const dataDir = path.resolve(options.dataDir || process.env.SECONDBRAIN_DATA_DIR || path.join(root, 'data'));
  const id = String(options.id || '').trim();
  if (!id) throw new Error('--id is required');
  const found = resolveProposal({ dataDir, id, date: options.date });
  const builtArtifact = String(found.proposal.built_artifact || '').trim();
  if (!builtArtifact) throw new Error(`proposal ${id} has no built_artifact`);
  const videoPath = path.resolve(root, builtArtifact);
  const videoStat = fs.statSync(videoPath);
  if (!videoStat.isFile() || videoStat.size < 1024) throw new Error(`built video is missing or empty: ${videoPath}`);

  const pendingDir = path.join(root, 'content-review', 'pending');
  const videoFile = path.basename(videoPath);
  const thumbnailFile = videoFile.replace(/\.mp4$/i, '_thumb.jpg');
  const thumbnailPath = path.join(pendingDir, thumbnailFile);
  if (!fs.existsSync(thumbnailPath)) {
    const run = options.spawnSyncImpl || spawnSync;
    const result = run(
      options.ffmpeg || 'ffmpeg',
      ['-y', '-ss', '1', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=720:-2', thumbnailPath],
      { encoding: 'utf8', timeout: 120000 },
    );
    if (result && result.status !== 0) {
      throw new Error(`thumbnail generation failed: ${String(result.stderr || result.stdout || '').trim()}`);
    }
  }
  if (!fs.existsSync(thumbnailPath)) throw new Error(`thumbnail was not created: ${thumbnailPath}`);

  const manifestPath = path.join(pendingDir, 'manifest.json');
  const entry = appendBuiltClipToManifest(
    manifestPath,
    found.proposal,
    videoFile,
    thumbnailFile,
  );
  return {
    ok: true,
    id,
    sourceDate: found.date,
    videoPath,
    videoBytes: videoStat.size,
    thumbnailPath,
    manifestPath,
    entry,
  };
}

function main() {
  const result = reconcileBuiltViralClip(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { parseArgs, resolveProposal, reconcileBuiltViralClip };
