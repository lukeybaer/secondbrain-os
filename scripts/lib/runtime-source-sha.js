'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fileHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function sourceSha(root) {
  const resolved = fs.realpathSync(root);
  const manifestPath = path.join(resolved, 'runtime-manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.schema !== 'amy.desktop-capability-runtime.v1' || !/^[a-f0-9]{40}$/.test(manifest.source_commit) || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('installed runtime source manifest is unproven');
    for (const relative of manifest.files) {
      const file = path.resolve(resolved, relative);
      if (!file.startsWith(resolved + path.sep) || !/^[a-f0-9]{64}$/.test(manifest.file_hashes?.[relative]) || fileHash(file) !== manifest.file_hashes[relative]) throw new Error(`installed runtime hash mismatch: ${relative}`);
    }
    if (!manifest.files.includes('scripts/desktop-snapshot-maintenance.js')) throw new Error('installed runtime has no snapshot producer provenance');
    return manifest.source_commit;
  }
  const release = path.basename(resolved).match(/^([a-f0-9]{40})(?:-reland-[a-zA-Z0-9-]+)?$/);
  if (release) return release[1];
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true });
  const sha = String(result.stdout || '').trim();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('producer source SHA is unproven');
  return sha;
}
module.exports = { sourceSha, fileHash };
