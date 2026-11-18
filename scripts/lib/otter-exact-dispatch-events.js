'use strict';

const path = require('node:path');

const EXACT_DISPATCH_DIRNAME = 'otter-exact-call-dispatch-events';

function exactDispatchEventPaths(voiceprintsDir) {
  const root = path.join(voiceprintsDir, EXACT_DISPATCH_DIRNAME);
  return {
    root,
    events: path.join(root, 'events'),
    pending: path.join(root, 'pending'),
  };
}

module.exports = {
  EXACT_DISPATCH_DIRNAME,
  exactDispatchEventPaths,
};
