'use strict';

const fs = require('fs');

// Only for noninteractive children. On Windows libuv sets CREATE_NO_WINDOW
// only when no stdio slot is an inherited handle; the child then owns a hidden
// console that every descendant shares, so even an unhidden grandchild (git,
// cmd) opens no window. DETACHED_PROCESS is never used here: it leaves the
// child with no console at all, and each console grandchild then allocates a
// new visible one (the 2026-10-31 Git terminal popups).
function backgroundProcessOptions(options = {}, platform = process.platform) {
  if (platform !== 'win32') return { ...options };
  return { ...options, windowsHide: true };
}

// Log descriptors as stdio defeat CREATE_NO_WINDOW, so on Windows a child that
// logs to files gets pipes copied into those descriptors instead.
function loggedStdio(descriptors, platform = process.platform) {
  return platform === 'win32' ? ['ignore', 'pipe', 'pipe'] : ['ignore', ...descriptors];
}

// A descendant that outlives the child can hold the pipes open; stop copying
// shortly after exit so 'close' still settles the run.
function copyOutputToDescriptors(child, descriptors, { exitGraceMs = 2000 } = {}) {
  const streams = [child.stdout, child.stderr];
  streams.forEach((stream, index) => {
    if (stream) stream.on('data', (chunk) => fs.writeSync(descriptors[index], chunk));
  });
  child.once('exit', () => {
    setTimeout(() => streams.forEach((stream) => stream && stream.destroy()), exitGraceMs).unref();
  });
}

module.exports = { backgroundProcessOptions, loggedStdio, copyOutputToDescriptors };
