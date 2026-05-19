# SecondBrain Security Threat Model

## Scope

This document covers local SecondBrain data at rest, local/S3 backup snapshots,
restore operations, and companion Graphiti data handling. It does not claim to
secure a compromised Windows account, a malicious Electron runtime, or a host
where the backup encryption key is already exposed.

## Primary Assets

- `data/`: conversations, projects, memory indexes, task state, SQLite data, and
  derived app state.
- `config.json`: local integration configuration and API credentials.
- `backups/`: local snapshot directories, `manifest.json`, and encrypted backup
  payloads.
- Graphiti/Neo4j companion data: temporal knowledge graph facts, entities, and
  episodes.

## Backup Encryption

New snapshots are encrypted by default with Node `crypto` using AES-256-GCM.
Snapshot file contents are written under `backups/<snapshot-id>/payload/`; the
legacy cleartext `data/` and top-level `config.json` copies are no longer
created for new snapshots. Per-snapshot metadata remains cleartext so listing,
retention, pruning, and S3 parity checks can run without decrypting user data.

The backup data key is resolved in this order:

1. `SECONDBRAIN_BACKUP_KEY`: 32-byte base64, 64-char hex, or a passphrase that is
   SHA-256 hashed to 32 bytes.
2. `SECONDBRAIN_BACKUP_PASSPHRASE`: PBKDF2-SHA256 with
   `SECONDBRAIN_BACKUP_PASSPHRASE_SALT` or the default SecondBrain salt.
3. Local generated key file: `%APPDATA%/secondbrain/backups/.backup-key`.

The generated key file is not placed inside snapshot directories and is not
included in S3 snapshot archives. Off-machine restore requires preserving the
key file separately or using one of the environment-based key options.

## Integrity

AES-GCM authenticates each encrypted file with a per-file IV, auth tag, and AAD
bound to the snapshot ID and relative path. Each encrypted file header stores
the plaintext SHA-256 and byte count. Snapshot metadata stores plaintext and
ciphertext tree hashes plus a non-secret key ID. Restore, test-restore, file
read, and SQLite query paths verify the GCM tag and plaintext hash before
returning data.

## Legacy Snapshots

Existing unencrypted snapshots remain readable. The app detects legacy snapshots
by the absence of `encrypted: true`/`payload/` and continues to browse, read,
test-restore, and restore their cleartext `data/` and `config.json` contents.
Legacy snapshots should be treated as sensitive cleartext until rotated out by
retention or manually removed.

## Restore Safety

`commitRestore()` creates an encrypted `pre-restore` safety snapshot before it
decrypts the selected snapshot into a temporary restore directory. Live data is
not removed or overwritten until the safety snapshot exists and extraction has
completed. `testRestore()` only decrypts into `_test-restore-*` directories and
never touches live data. Temporary restore/staging directories are cleaned on
success and swept by the daily cleanup path if left behind by a crash.

## Manifests And Logs

Backup manifests intentionally avoid storing config contents, file contents, or
backup keys. Snapshot notes are redacted before being written. Backup log output
redacts common API key, bearer token, password, AWS key, and SSH key patterns,
and locked-file logs use relative paths instead of full local paths.

## Residual Risks

- A local attacker with access to the Windows account and `.backup-key` can
  decrypt local and copied snapshots.
- Snapshot paths and file names remain visible in encrypted payload directories.
- Test-restore output is cleartext by design until `cleanupTestRestores()` is
  run.
- Environment-provided backup keys can leak through process inspection or shell
  history if operators handle them carelessly.
