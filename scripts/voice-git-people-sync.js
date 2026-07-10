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
const { ensureCodexWorktree, isSharedCheckout } = require('./lib/codex-worktree.js');

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

function runIsolatedPeopleSync(argv = process.argv.slice(2)) {
  const isolation = ensureCodexWorktree({
    repoRoot: REPO,
    purpose: 'voice-git-people-sync',
    branchPrefix: 'codex/voice-people-sync',
  });
  const script = path.join(isolation.cwd, 'scripts', 'voice-git-people-sync.js');
  const forwarded = argv.filter((arg) => !['--isolated-child', '--publish-only', '--no-publish', '--commit'].includes(arg));
  const child = spawnSync(
    process.execPath,
    [script, ...forwarded, '--isolated-child', '--commit', '--no-publish'],
    {
      cwd: isolation.cwd,
      encoding: 'utf8',
      timeout: 30 * 60 * 1000,
      env: { ...process.env, SECONDBRAIN_MAIN_ROOT: REPO },
    },
  );
  const report = {
    schema: 'life_archive_voice_git_people_sync_isolated.v1',
    generated_at: new Date().toISOString(),
    worktree: isolation.cwd,
    branch: isolation.branch,
    child_status: child.status,
    child_stdout: String(child.stdout || '').slice(-12000),
    child_stderr: String(child.stderr || '').slice(-2000),
  };
  if (child.status !== 0) return { ...report, ok: false, stage: 'sync_and_commit' };

  let childReport = null;
  try {
    childReport = JSON.parse(String(child.stdout || ''));
  } catch {
    // The child status is still authoritative; parsing only avoids a no-op land.
  }
  const noPeopleChanges = childReport?.commit?.reason === 'no_people_changes';
  const land = noPeopleChanges
    ? { status: 0, stdout: '', stderr: '', skipped: 'no_people_changes' }
    : spawnSync(process.execPath, ['scripts/land.js', '--apply'], {
        cwd: isolation.cwd,
        encoding: 'utf8',
        timeout: 30 * 60 * 1000,
      });
  report.land_status = land.status;
  report.land_stdout = String(land.stdout || '').slice(-8000);
  report.land_stderr = String(land.stderr || '').slice(-2000);
  report.land_skipped = land.skipped || null;
  if (land.status !== 0) return { ...report, ok: false, stage: 'land' };

  const publishArgs = ['--isolated-child', '--publish-only'];
  const publish = spawnSync(process.execPath, [script, ...publishArgs], {
    cwd: isolation.cwd,
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
    env: { ...process.env, SECONDBRAIN_MAIN_ROOT: REPO },
  });
  report.publish_status = publish.status;
  report.publish_stdout = String(publish.stdout || '').slice(-4000);
  report.publish_stderr = String(publish.stderr || '').slice(-2000);
  return { ...report, ok: publish.status === 0, stage: publish.status === 0 ? 'complete' : 'publish' };
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
  const b = sh(process.execPath, ['scripts/sync-voiceprints-to-people-files.js', '--write', '--json']);
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
  const ownedPaths = ['memory/contacts', 'memory/user_profile.md'];
  const status = sh('git', ['status', '--porcelain', '--', ...ownedPaths]);
  const changed = String(status.stdout || '').trim();
  if (!changed) return { committed: false, reason: 'no_people_changes' };
  sh('git', ['add', '--', ...ownedPaths]);
  const msg = `chore(contacts): voice people-file sync from Fargate-resolved artifacts ${new Date().toISOString().slice(0, 10)}\n\nno-test-justification: generated people-file content from voice resolution, no code change`;
  const c = sh('git', ['commit', '-m', msg]);
  return { committed: c.status === 0, files: changed.split('\n').length, stderr: String(c.stderr || '').slice(-300) };
}

function main() {
  if (process.argv.includes('--publish-only')) {
    const publish = publishCanonicalContactsToEc2();
    process.stdout.write(`${JSON.stringify({ publish_canonical_contacts: publish }, null, 2)}\n`);
    process.exitCode = publish.ok ? 0 : 1;
    return;
  }
  if (!process.argv.includes('--isolated-child') && isSharedCheckout(REPO)) {
    const isolated = runIsolatedPeopleSync();
    process.stdout.write(`${JSON.stringify(isolated, null, 2)}\n`);
    process.exitCode = isolated.ok ? 0 : 1;
    return;
  }

  const noPull = process.argv.includes('--no-pull');
  const noPublish = process.argv.includes('--no-publish');
  // Default to NOT committing: even semantic people-file updates need an owned
  // landing decision in a multi-session repository. Pass --commit to opt in.
  const noCommit = !process.argv.includes('--commit');
  const report = { schema: 'life_archive_voice_git_people_sync.v1', generated_at: new Date().toISOString() };
  report.pull = noPull ? { skipped: true } : pullArtifacts();
  report.ec2_created_contacts = noPull ? { skipped: true } : pullEc2CreatedContacts();
  report.sync = runPeopleSync();
  report.commit = noCommit ? { skipped: true } : commitPeopleChanges();
  const syncOk = report.sync.voiceprint_people_sync_ok && report.sync.speaker_people_sync_ok;
  const commitOk = noCommit || report.commit.committed || report.commit.reason === 'no_people_changes';
  report.publish_canonical_contacts = noPublish
    ? { skipped: true }
    : syncOk && commitOk
      ? publishCanonicalContactsToEc2()
      : { skipped: 'sync_or_commit_failed' };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const publishOk = noPublish || report.publish_canonical_contacts.ok;
  process.exitCode = syncOk && commitOk && publishOk ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  pullArtifacts,
  pullEc2CreatedContacts,
  runPeopleSync,
  publishCanonicalContactsToEc2,
  commitPeopleChanges,
  runIsolatedPeopleSync,
};
