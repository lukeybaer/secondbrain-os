'use strict';
// Test helper: pull top-level functions out of a big no-exports script
// (ec2-server.js, manual-briefing-v3.js) and evaluate them with stubbed
// dependencies, so a test can CALL the real code instead of reading its text.
// Top-level functions in these files start at column 0 and end at a column-0 "}".
const fs = require('node:fs');

function extractFunction(src, name) {
  const re = new RegExp('^(?:async )?function ' + name + '[ ]*[(]', 'm');
  const m = re.exec(src);
  if (!m) throw new Error('function not found in source: ' + name);
  const end = src.indexOf('\n}\n', m.index);
  if (end < 0) throw new Error('end of function not found: ' + name);
  return src.slice(m.index, end + 2);
}

// loadFunctions(file, names, stubs) -> { name: fn }. `stubs` are the free
// identifiers the functions use (other helpers, fs, path, constants).
function loadFunctions(file, names, stubs = {}) {
  const src = fs.readFileSync(file, 'utf8');
  const body = names.map((n) => extractFunction(src, n)).join('\n');
  const keys = Object.keys(stubs);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...keys, `${body}\nreturn { ${names.join(', ')} };`);
  return factory(...keys.map((k) => stubs[k]));
}

module.exports = { extractFunction, loadFunctions };

// loadWithAutoStubs(file, names, overrides) -> { name: fn }
// Like loadFunctions, but every free identifier the extracted code uses that is
// NOT a JS global and NOT in `overrides` resolves to a no-op stub returning
// undefined. Use for big functions (askAmy) whose collaborators the test does
// not care about. Sloppy-mode `with` scope; test code only.
function loadWithAutoStubs(file, names, overrides = {}) {
  const src = fs.readFileSync(file, 'utf8');
  const body = names.map((n) => extractFunction(src, n)).join('\n');
  const declared = new Set(names);
  const scope = new Proxy(
    {},
    {
      has: (_t, key) => typeof key === 'string' && !declared.has(key) && key !== 'arguments',
      get: (_t, key) => {
        if (key === Symbol.unscopables) return undefined;
        if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
        if (key in globalThis) return globalThis[key];
        return () => undefined;
      },
    },
  );
  // eslint-disable-next-line no-new-func
  const factory = new Function('__scope', `with (__scope) {\n${body}\nreturn { ${names.join(', ')} };\n}`);
  return factory(scope);
}

module.exports.loadWithAutoStubs = loadWithAutoStubs;
