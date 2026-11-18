'use strict';

const fs = require('node:fs');
const path = require('node:path');

function stagedLinkedInIntelPath(canonicalPath) {
  return `${canonicalPath}.in-progress`;
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the original write or rename error.
    }
    throw error;
  }
}

function writeLinkedInIntelSnapshot({ canonicalPath, repoPath, serialized, publish = false }) {
  if (!canonicalPath) throw new Error('canonicalPath is required');
  const content = String(serialized || '');
  const stagedPath = stagedLinkedInIntelPath(canonicalPath);

  if (!publish) {
    writeTextAtomic(stagedPath, content);
    return { published: false, stagedPath, repoError: '' };
  }

  writeTextAtomic(canonicalPath, content);
  let repoError = '';
  if (repoPath) {
    try {
      writeTextAtomic(repoPath, content);
    } catch (error) {
      repoError = error && error.message ? error.message : String(error);
    }
  }
  try {
    fs.rmSync(stagedPath, { force: true });
  } catch {
    // A stale progress file is harmless because readers consume canonicalPath.
  }
  return { published: true, stagedPath, repoError };
}

module.exports = {
  stagedLinkedInIntelPath,
  writeLinkedInIntelSnapshot,
};
