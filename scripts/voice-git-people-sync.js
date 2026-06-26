#!/usr/bin/env node
/**
 * voice-git-people-sync.js -- run the people-file sync on the GIT machine.
 *
 * Phase 2 closes the loop: Fargate resolves voices and writes artifacts to EFS;
 * EC2 reconciles them into its dashboard dir; this script (run on the PC, the
 * git-authoritative machine) pulls the resolved registry + speaker-intelligence
 * artifacts down from EC2 and runs the people-file sync against the local git
 * checkout, then commits any people-file changes.
 *
 * Why the container does NOT do this: people files are git-tracked; a container
 * writing them to ephemeral EFS would diverge from git. So the container skips
 * people sync (VOICE_SKIP_PEOPLE_SYNC=1) and this runs where git lives.
 *
 * Confirmed-voiceprint-match-only gate is enforced inside
 * sync-voiceprints-to-people-files.js; this script does not relax it.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const EC2 = process.env.EC2_HOST || 'ec2-user@ExampleCo';
const SSH_KEY = process.env.EC2_SSH_KEY
  || [path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'sb-key.pem'),
      path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'secondbrain-backend-key.pem')]
    .find((p) => fs.existsSync(p));

// Resolved artifacts the people sync reads. Pulled EC2 (reconciled-from-EFS) ->
// local git checkout so the sync runs on the freshest Fargate output.
const PULL = [
  'data/life-archive/voice-identity-registry.json',
  'data/life-archive/voiceprints/otter-speaker-intelligence-latest.json',
  'data/life-archive/voiceprints/speaker-pareto-latest.json',
  'data/life-archive/voiceprints/otter-speaker-analytics-latest.json',
  'data/life-archive/voiceprints/voice-discovery-roster-latest.json',
];

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout: 120000, ...opts });
}

function pullArtifacts() {
  if (!SSH_KEY) return { ok: false, reason: 'no_ssh_key' };
  const sshOpts = ['-i', SSH_KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
  const pulled = [];
  for (const rel of PULL) {
    const r = sh('scp', [...sshOpts, `${EC2}:/opt/secondbrain/${rel}`, rel]);
    if (r.status === 0) pulled.push(rel);
  }
  return { ok: pulled.length > 0, pulled };
}

function pullEc2CreatedContacts() {
  if (!SSH_KEY) return { ok: false, reason: 'no_ssh_key', pulled: [] };
  const sshOpts = ['-i', SSH_KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
  const contactsDir = path.join(REPO, 'memory', 'contacts');
  fs.mkdirSync(contactsDir, { recursive: true });
  const list = sh('ssh', [...sshOpts, EC2, "find /opt/secondbrain/memory/contacts -maxdepth 1 -type f -name '*.md' -printf '%f\\n'"], { timeout: 30000 });
  if (list.status !== 0) return { ok: false, reason: 'remote_list_failed', pulled: [], stderr: String(list.stderr || '').slice(-300) };
  const pulled = [];
  for (const name of String(list.stdout || '').split(/\r?\n/).filter(Boolean)) {
    if (!/^[A-Za-z0-9_.-]+\.md$/.test(name) || name === 'INDEX.md' || name.startsWith('_')) continue;
    const localPath = path.join(contactsDir, name);
    if (fs.existsSync(localPath)) continue;
    const r = sh('scp', [...sshOpts, `${EC2}:/opt/secondbrain/memory/contacts/${name}`, localPath], { timeout: 30000 });
    if (r.status === 0) pulled.push(`memory/contacts/${name}`);
  }
  return { ok: true, pulled };
}

function runPeopleSync() {
  // The two people-sync steps, run directly against the git checkout.
  const a = sh(process.execPath, ['scripts/sync-otter-speaker-intelligence-to-people-files.js', '--write']);
  const b = sh(process.execPath, ['scripts/sync-voiceprints-to-people-files.js', '--write', '--all-contacts', '--json']);
  return { speaker_people_sync_ok: a.status === 0, voiceprint_people_sync_ok: b.status === 0,
    stderr: [String(a.stderr || '').slice(-300), String(b.stderr || '').slice(-300)].filter(Boolean).join(' | ') };
}

function publishCanonicalContactsToEc2() {
  if (!SSH_KEY) return { ok: false, reason: 'no_ssh_key' };
  const contactsDir = path.join(REPO, 'memory', 'contacts');
  if (!fs.existsSync(contactsDir)) return { ok: false, reason: 'contacts_dir_missing' };
  const sshOpts = ['-i', SSH_KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
  const tmpName = `secondbrain-contacts-${Date.now()}.tar`;
  const manifestName = `${tmpName}.manifest`;
  const tmpLocal = path.join(process.env.TEMP || process.env.TMPDIR || REPO, tmpName);
  const manifestLocal = path.join(process.env.TEMP || process.env.TMPDIR || REPO, manifestName);
  const contactFiles = fs.readdirSync(contactsDir)
    .filter((name) => name.endsWith('.md') && name !== 'INDEX.md' && !name.startsWith('_'))
    .sort();
  if (!contactFiles.length) return { ok: false, reason: 'no_contact_files' };
  const pack = sh('tar', ['-cf', tmpLocal, ...contactFiles], { cwd: contactsDir, timeout: 120000 });
  if (pack.status !== 0) return { ok: false, reason: 'tar_failed', stderr: String(pack.stderr || '').slice(-300) };
  fs.writeFileSync(manifestLocal, `${contactFiles.join('\n')}\n`, 'utf8');
  try {
    const copy = sh('scp', [...sshOpts, tmpLocal, `${EC2}:/tmp/${tmpName}`], { timeout: 120000 });
    if (copy.status !== 0) return { ok: false, reason: 'scp_failed', stderr: String(copy.stderr || '').slice(-300) };
    const copyManifest = sh('scp', [...sshOpts, manifestLocal, `${EC2}:/tmp/${manifestName}`], { timeout: 120000 });
    if (copyManifest.status !== 0) return { ok: false, reason: 'manifest_scp_failed', stderr: String(copyManifest.stderr || '').slice(-300) };
    const remoteScript = [
      'set -e',
      'contacts_dir=/opt/secondbrain/memory/contacts',
      `tar_path=/tmp/${tmpName}`,
      `manifest_path=/tmp/${manifestName}`,
      'mkdir -p "$contacts_dir"',
      'find "$contacts_dir" -maxdepth 1 -type f -name "*.md" ! -name "INDEX.md" ! -name "_*" -printf "%f\\n" | while IFS= read -r f; do',
      '  if ! grep -Fxq "$f" "$manifest_path"; then rm -f "$contacts_dir/$f"; fi',
      'done',
      'tar -xf "$tar_path" -C "$contacts_dir"',
      'rm -f "$tar_path" "$manifest_path"',
    ].join('\n');
    const extract = sh('ssh', [...sshOpts, EC2, remoteScript], { timeout: 120000 });
    if (extract.status !== 0) return { ok: false, reason: 'remote_extract_failed', stderr: String(extract.stderr || '').slice(-300) };
    return { ok: true, published: contactFiles.length };
  } finally {
    try { fs.unlinkSync(tmpLocal); } catch { /* ignore cleanup */ }
    try { fs.unlinkSync(manifestLocal); } catch { /* ignore cleanup */ }
  }
}

function commitPeopleChanges() {
  const status = sh('git', ['status', '--porcelain', 'memory/contacts']);
  const changed = String(status.stdout || '').trim();
  if (!changed) return { committed: false, reason: 'no_people_changes' };
  sh('git', ['add', 'memory/contacts']);
  const msg = `chore(contacts): voice people-file sync from Fargate-resolved artifacts ${new Date().toISOString().slice(0, 10)}\n\nno-test-justification: generated people-file content from voice resolution, no code change`;
  const c = sh('git', ['commit', '-m', msg]);
  return { committed: c.status === 0, files: changed.split('\n').length, stderr: String(c.stderr || '').slice(-300) };
}

function main() {
  const noPull = process.argv.includes('--no-pull');
  // Default to NOT committing: --all-contacts regenerates "Last synced" blocks
  // across hundreds of files, and this repo is a multi-session shared tree.
  // Bulk-committing would sweep in peers' uncommitted work. Pass --commit to
  // opt in (the nightly people-sync job owns the routine bulk commit).
  const noCommit = !process.argv.includes('--commit');
  const report = { schema: 'life_archive_voice_git_people_sync.v1', generated_at: new Date().toISOString() };
  report.pull = noPull ? { skipped: true } : pullArtifacts();
  report.ec2_created_contacts = noPull ? { skipped: true } : pullEc2CreatedContacts();
  report.sync = runPeopleSync();
  report.publish_canonical_contacts = publishCanonicalContactsToEc2();
  report.commit = noCommit ? { skipped: true } : commitPeopleChanges();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = (report.sync.voiceprint_people_sync_ok && report.sync.speaker_people_sync_ok) ? 0 : 1;
}

if (require.main === module) main();

module.exports = { pullArtifacts, pullEc2CreatedContacts, runPeopleSync, publishCanonicalContactsToEc2, commitPeopleChanges };
