'use strict';

const fs = require('fs');
const path = require('path');

// Where a turn's saved Gmail attachments live. The broker removes it when the turn closes.
const GMAIL_ATTACHMENT_FOLDER = 'gmail-attachments';

// A folder inside a workspace, made only of real folders. The engines cannot write
// there today, but a link planted by any other route would make trusted code write
// through it to a host file, and a workspace outlives its turn, so that link could
// wait for a later one. This check does not depend on the sandbox holding.
function plainWorkspaceDir(workspace, ...segments) {
  fs.mkdirSync(workspace, { recursive: true });
  let current = workspace;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${segment} in the workspace is not a plain folder`);
    }
  }
  return current;
}

module.exports = { GMAIL_ATTACHMENT_FOLDER, plainWorkspaceDir };
