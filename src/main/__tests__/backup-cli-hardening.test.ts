/**
 * Regression test for the scheduled-task backup script.
 *
 * `scripts/backup-cli.ts` is the STANDALONE backup that Windows Task Scheduler
 * runs nightly at 3 AM. It's a code-duplication sibling of `src/main/backups.ts`
 * (which the Electron app uses in-process). Because they share logic only by
 * convention, hardening applied to one silently drifts from the other.
 *
 * This exact drift caused a 4-day backup outage (Apr 8-11 2026): `src/main/
 * backups.ts` had `skip-on-EBUSY` in `copyDir` but `scripts/backup-cli.ts` did
 * not. The scheduled task crashed every night on a locked WhatsApp Chromium
 * cache file, the health check flagged red every morning, and nothing
 * self-healed. See feedback_backup_hardening.md for the full postmortem.
 *
 * This test is a static source-level drift detector. It reads the file as
 * text and asserts the hardening patterns are present. If someone removes
 * them, CI fails before the next silent midnight crash.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const CLI_PATH = path.join(__dirname, '..', '..', '..', 'scripts', 'backup-cli.ts');

describe('scripts/backup-cli.ts hardening (drift detector)', () => {
  const src = fs.readFileSync(CLI_PATH, 'utf8');

  it('file exists at expected path', () => {
    expect(fs.existsSync(CLI_PATH)).toBe(true);
  });

  it('copyDir skips files locked with EBUSY / EPERM / EACCES (skip-on-lock)', () => {
    // Must catch the three Windows lock codes inside the copyFile path so one
    // locked Chromium cache file cannot kill the whole snapshot.
    expect(src).toMatch(/copyFile\([^)]*\)/);
    expect(src).toMatch(/'EBUSY'/);
    expect(src).toMatch(/'EPERM'/);
    expect(src).toMatch(/'EACCES'/);
    expect(src).toMatch(/skip-locked/);
  });

  it('excludes Chromium cache subdirs under whatsapp-web/*/Default/Cache', () => {
    // Root cause of the Apr 8-11 outage. Backing these up is both pointless
    // and fatal while the Electron client is running.
    expect(src).toMatch(/whatsapp-web[^\n]*Default[^\n]*Cache/);
    expect(src).toMatch(/COPY_EXCLUDE_PATTERNS/);
  });

  it('prune tolerates EBUSY on rmdir and defers to next run', () => {
    // Old snapshots sometimes have file handles held by Windows Search
    // Indexer / Defender / Electron. A single stuck dir must not block the
    // whole prune step.
    expect(src).toMatch(/skip-prune-locked/);
    expect(src).toMatch(/pruneSnapshots/);
  });

  it('s3Upload uses --no-progress and sets maxBuffer + timeout on execSync', () => {
    // Root cause of S3 upload silent failures Apr 9-10 2026: aws s3 cp streams
    // one progress line per MiB to stdout; for an 11 GB archive that is ~11,000
    // lines (~880 KB) which blew execSync's default 1 MB maxBuffer. The upload
    // threw silently (caught by try/catch), leaving snapshots with S3: "-" even
    // when the local backup succeeded.
    // --no-progress suppresses the per-MiB lines entirely.
    // maxBuffer + timeout are defensive ceilings.
    expect(src).toMatch(/--no-progress/);
    expect(src).toMatch(/maxBuffer/);
    expect(src).toMatch(/timeout.*90|90.*timeout/);
  });
});
