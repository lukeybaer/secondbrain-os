#!/usr/bin/env node
'use strict';

// EC2 nightly: grade the Codex and Claude Code session backups by comparing the
// PC-published manifest with what S3 actually holds (S-10). Writes
// <data dir>/life-archive/session-backup-grade.json atomically; every reader
// resolves the same path through gradeFilePath.
//   node scripts/session-backup-s3-grade.js [--data-dir <dir>]

const g = require('./lib/session-backup-grade.js');

function main(argv = process.argv.slice(2), { readManifest = g.readManifest, listObjects = (prefix) => g.s3ListObjects(prefix), now = Date.now() } = {}) {
  const i = argv.indexOf('--data-dir');
  const dataDir = i >= 0 ? argv[i + 1] : undefined;
  const grade = g.gradeManifest({ manifest: readManifest(), listObjects, now });
  g.writeGradeFile(grade, dataDir);
  const brief = Object.fromEntries(Object.entries(grade.sources).map(([k, v]) => [k, v.status === 'green' ? 'green' : v.reason]));
  console.log(`SESSION_BACKUP_GRADE ${JSON.stringify(brief)}`);
  return grade;
}

if (require.main === module) main();
module.exports = { main };
