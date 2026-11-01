'use strict';
// Test helper: run a code block sliced out of ec2-server.js (a dashboard card
// branch inside the big render function, or a route branch inside the request
// handler) so a test can assert on what the real code outputs, not on its text.
// Free identifiers resolve from `scope` first, then JS globals, then a no-op
// stub returning undefined. Sloppy-mode `with` scope; test code only.
const fs = require('node:fs');
const path = require('node:path');

const EC2_PATH = path.resolve(__dirname, '..', '..', 'ec2-server.js');
let cached = null;
function ec2Source() {
  if (cached === null) cached = fs.readFileSync(EC2_PATH, 'utf8');
  return cached;
}

// The text from startMarker up to (not including) endMarker. `occurrence`
// picks the nth startMarker (1-based) for branches that appear twice (tile
// face, then detail drilldown).
function sliceBlock(startMarker, endMarker, occurrence = 1) {
  const src = ec2Source();
  let start = -1;
  for (let i = 0; i < occurrence; i += 1) {
    start = src.indexOf(startMarker, start + 1);
    if (start < 0) throw new Error(`marker not found (occurrence ${i + 1}): ${startMarker}`);
  }
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`end marker not found: ${endMarker}`);
  return src.slice(start, end);
}

function compileBlock(params, body, scope = {}, { async = false } = {}) {
  const proxy = new Proxy(
    {},
    {
      has: (_t, key) => typeof key === 'string' && !params.includes(key) && key !== 'arguments',
      get: (_t, key) => {
        if (key === Symbol.unscopables) return undefined;
        if (Object.prototype.hasOwnProperty.call(scope, key)) return scope[key];
        if (key in globalThis) return globalThis[key];
        return () => undefined;
      },
      // Assignments to module-level state (caches) land in `scope`.
      set: (_t, key, value) => {
        scope[key] = value;
        return true;
      },
    },
  );
  // eslint-disable-next-line no-new-func
  return new Function(
    '__scope',
    `with (__scope) { return ${async ? 'async ' : ''}function (${params.join(', ')}) {\n${body}\n}; }`,
  )(proxy);
}

// The real escapeHtml from ec2-server.js.
function escapeHtml() {
  const body = sliceBlock('function escapeHtml(s) {', '\n}\n') + '\n}\n';
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn escapeHtml;`)();
}

// Value of a top-level `const NAME = <literal>;` in ec2-server.js, evaluated.
function topLevelConst(name) {
  const m = new RegExp(`^const ${name} = ([^;]+);$`, 'm').exec(ec2Source());
  if (!m) throw new Error(`top-level const not found: ${name}`);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${m[1]});`)();
}

module.exports = { EC2_PATH, ec2Source, sliceBlock, compileBlock, escapeHtml, topLevelConst };
