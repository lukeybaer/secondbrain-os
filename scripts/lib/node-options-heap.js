'use strict';

// Shared by the briefing card refresh and the scheduled-job fleet. A child
// process does not inherit its parent's --max-old-space-size CLI flag, so the
// heap is set through NODE_OPTIONS, replacing any inherited heap flag and
// keeping every other inherited option.
function nodeOptionsWithHeap(inherited, heapMb) {
  const kept = String(inherited || '')
    .split(/\s+/)
    .filter((token) => token && !/^--max-old-space-size(?:=|$)/.test(token));
  return [...kept, `--max-old-space-size=${heapMb}`].join(' ');
}

module.exports = { nodeOptionsWithHeap };
