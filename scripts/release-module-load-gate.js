#!/usr/bin/env node
'use strict';

// scripts/release-module-load-gate.js
//
// Pre-ship release gate (S-2, 2026-10-24 retrospective). Oct 23 night release
// c8c2647c failed because the public copy did not carry a module (the viral-clip
// duplicate guard) that a shipped file required. This gate walks every code file
// of a release tree (and optionally the public copy), checks syntax with
// `node --check`, resolves every static relative require()/import target to an
// existing file, and names each importing file plus the missing path.
// It never executes the scripts, so top-level side effects do not run.
//
// Usage: node scripts/release-module-load-gate.js [--root <dir>] [--public <dir>] [--with-tests] [--no-syntax] [--json]
// --with-tests also walks __tests__ (the Oct 23 public failure was a test requiring
// a module the scrub had dropped). Opt-in audit only: test files embed require
// strings in spawned -e snippets and source text, so this mode reports noise.
// Exit 0 clean, 1 on any unresolved require or syntax error.
// Intentionally optional requires: put `release-gate: optional` on the same line.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const SKIP_DIRS = new Set(['node_modules', '__tests__', 'fixtures', '.git']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs']);
const RESOLVE_EXT = ['', '.js', '.json', '.mjs', '.cjs', '.node'];

function walk(dir, out, withTests = false) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) && !(withTests && e.name === '__tests__')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, withTests);
    else if (CODE_EXT.has(path.extname(e.name))) out.push(full);
  }
  return out;
}

function collectFiles(root, withTests = false) {
  const files = walk(path.join(root, 'scripts'), [], withTests);
  for (const f of ['ec2-server.js', 'server.js']) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) files.push(p);
  }
  return files;
}

// Words after which a `/` starts a regex literal rather than a division.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);

// A `)` closing one of these headers ends a condition, so a `/` after it starts a statement.
const HEADER_WORDS = new Set(['if', 'while', 'for', 'with']);

// A `{` after one of these tokens opens a statement block (not an object
// literal), so a `/` after its closing `}` starts a statement ('blk}').
// `)` covers if/function bodies, `>` covers arrow bodies.
const BLOCK_OPENERS = new Set(['', ';', '{', '}', 'blk}', ')', 'hdr)', '>', 'else', 'do', 'try', 'finally']);

// `last` is the previous significant token. A `/` is division after a value:
// identifier, number, string, regex, template, `)`, `]`, an object literal's
// `}`, `++`, `--`.
// It starts a regex at the start of input, after an operator or opening
// punctuator, after a regex-taking keyword, or after a closed if/while/for/with
// header ('hdr)') or statement block ('blk}'). When unsure the lexer leans to division: reading a regex body
// as code over-reports, while reading division as a regex could hide a require.
function regexAllowed(last) {
  return last === '' || last === 'hdr)' || last === 'blk}' || /^[(,=:[!&|?{;+\-*%<>~^]$/.test(last) || REGEX_AFTER_WORD.has(last);
}

// Return a same-length copy of `src` where only executable code survives:
// comments, string and template-literal text, and regex-literal bodies become
// spaces. A template's ${} expression is real code and is scanned as code.
// Newlines and literal delimiters are kept, so line numbers hold and a require call's own string argument can be read back from `src`.
// A require-shaped phrase in a comment or a quoted message is not a dependency
// (2026-10-28 EC2 deploy refusal; 2026-10-29 public-mirror refusal over a
// quoted needle in verify-briefing-drift.js).
function maskNonCode(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => { for (let k = from; k < to && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
  const stack = []; // { type: 'tpl' } | { type: 'expr', depth }
  const parens = []; // true when the `(` opened an if/while/for/with header
  const braces = []; // true when the `{` opened a statement block
  let last = '';
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i];
    if (top && top.type === 'tpl') {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === '`') { stack.pop(); i++; last = '`'; continue; }
      if (c === '$' && src[i + 1] === '{') { blank(i, i + 2); stack.push({ type: 'expr', depth: 0 }); i += 2; last = '{'; continue; }
      blank(i, i + 1); i++; continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? n : e;
      blank(i, end); i = end; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end); i = end; continue;
    }
    if (c === '\'' || c === '"') {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== '\n') k += src[k] === '\\' ? (src[k + 1] === '\r' ? 3 : 2) : 1;
      blank(i + 1, k);
      i = k + 1; last = 'str'; continue;
    }
    if (c === '`') { stack.push({ type: 'tpl' }); i++; continue; }
    if (c === '/' && regexAllowed(last)) {
      let k = i + 1;
      let inClass = false;
      while (k < n && src[k] !== '\n') {
        if (src[k] === '\\') { k += 2; continue; }
        if (src[k] === '[') inClass = true;
        else if (src[k] === ']') inClass = false;
        else if (src[k] === '/' && !inClass) break;
        k++;
      }
      if (k < n && src[k] === '/') { // no closing slash on the line: it was division
        blank(i + 1, k);
        k++;
        while (k < n && /[a-z]/i.test(src[k])) k++;
        i = k; last = 're'; continue;
      }
    }
    if (top && top.type === 'expr') {
      if (c === '{') top.depth++;
      else if (c === '}') {
        if (top.depth === 0) { stack.pop(); blank(i, i + 1); i++; continue; }
        top.depth--;
      }
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let k = i;
      while (k < n && /[A-Za-z0-9_$]/.test(src[k])) k++;
      last = last === '.' ? 'id' : src.slice(i, k); // obj.return is a property, not a keyword
      i = k; continue;
    }
    if ((c === '+' || c === '-') && src[i + 1] === c) { last = '++'; i += 2; continue; }
    if (c === '(') { parens.push(HEADER_WORDS.has(last)); last = '('; i++; continue; }
    if (c === ')') { last = parens.pop() ? 'hdr)' : ')'; i++; continue; }
    if (c === '{') { braces.push(BLOCK_OPENERS.has(last)); last = '{'; i++; continue; }
    if (c === '}') { last = braces.pop() ? 'blk}' : '}'; i++; continue; }
    if (!/\s/.test(c)) last = c;
    i++;
  }
  const masked = out.join('');
  if (masked.length !== n) throw new Error('mask length drifted');
  return masked;
}

// If the lexer throws, scan that file's unmasked source instead: over-reporting
// a dependency is safer than hiding one. The returned array carries
// `lexerFallback` so the caller can say so.
function extractSpecifiers(src, opts = {}) {
  let text;
  let lexerFallback = null;
  try { text = (opts.mask || maskNonCode)(src); } catch (err) {
    text = src;
    lexerFallback = String((err && err.message) || err);
  }
  const srcLines = src.split('\n');
  const specs = [];
  // Each pattern ends at the opening quote of the specifier; the literal is
  // read back from the original source because the mask blanks its contents.
  const patterns = [
    { re: /\brequire\s*\(\s*(['"`])/g, call: true },
    { re: /\bimport\s*\(\s*(['"`])/g, call: true },
    { re: /^\s*(?:import|export)\s[^'"`;\n]*?\sfrom\s*(['"`])/gm, call: false },
    { re: /^\s*import\s*(['"`])/gm, call: false },
  ];
  for (const { re, call } of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const open = m.index + m[0].length - 1;
      const close = text.indexOf(m[1], open + 1);
      if (close < 0) continue;
      const spec = src.slice(open + 1, close);
      if (!spec || /[\n$\\]/.test(spec)) continue; // dynamic or not a plain path
      if (call && !/^\s*\)/.test(text.slice(close + 1))) continue;
      const line = text.slice(0, m.index).split('\n').length;
      if (/release-gate:\s*optional/.test(srcLines[line - 1] || '')) continue;
      // require inside a try block is an intentional optional dependency.
      const before = text.slice(Math.max(0, m.index - 400), m.index);
      if (/\btry\s*\{[^}]*$/.test(before) && !/\}\s*catch/.test(before.slice(before.lastIndexOf('try')))) continue;
      specs.push({ spec, line });
    }
  }
  if (lexerFallback) specs.lexerFallback = lexerFallback;
  return specs;
}

function resolves(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const ext of RESOLVE_EXT) {
    try { if (fs.statSync(base + ext).isFile()) return true; } catch { /* next */ }
  }
  for (const idx of ['index.js', 'index.mjs', 'index.cjs', 'index.json']) {
    try { if (fs.statSync(path.join(base, idx)).isFile()) return true; } catch { /* next */ }
  }
  return false;
}

// Fast in-process parse for CommonJS; fall back to `node --check` (authoritative)
// only when the cheap parse fails or the file is an ES module.
function syntaxError(file, src) {
  if (path.extname(file) !== '.mjs') {
    try {
      new vm.Script('(function(exports,require,module,__filename,__dirname){' + src + '\n})', { filename: file });
      return null;
    } catch { /* confirm with node --check */ }
  }
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return r.status === 0 ? null : String(r.stderr || '').split('\n').slice(0, 4).join(' | ');
}

function checkTree(root, label, opts = {}) {
  const problems = [];
  const notes = [];
  const files = collectFiles(root, opts.withTests === true);
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch (err) {
      problems.push({ tree: label, file: rel, kind: 'unreadable', detail: err.message });
      continue;
    }
    if (src.charCodeAt(0) === 0x23) src = '//' + src; // shebang
    const specs = extractSpecifiers(src);
    if (specs.lexerFallback) notes.push({ tree: label, file: rel, detail: `lexer failed (${specs.lexerFallback}); scanned unmasked source` });
    for (const { spec, line } of specs) {
      if (!spec.startsWith('.') ) continue; // builtins and npm packages are not part of the tree
      if (!resolves(file, spec)) {
        const missing = path.relative(root, path.resolve(path.dirname(file), spec)).split(path.sep).join('/');
        problems.push({ tree: label, file: rel, line, kind: 'unresolved', missing, spec });
      }
    }
    if (opts.syntax !== false) {
      const err = syntaxError(file, src);
      if (err) problems.push({ tree: label, file: rel, kind: 'syntax', detail: err });
    }
  }
  return { files: files.length, problems, notes };
}

function runGate({ root, publicRoot, syntax = true, withTests = false } = {}) {
  const trees = [{ label: 'release', root: path.resolve(root) }];
  if (publicRoot) trees.push({ label: 'public', root: path.resolve(publicRoot) });
  const problems = [];
  const notes = [];
  let files = 0;
  for (const t of trees) {
    const r = checkTree(t.root, t.label, { syntax, withTests });
    files += r.files;
    problems.push(...r.problems);
    notes.push(...r.notes);
  }
  return { ok: problems.length === 0, files, problems, notes };
}

function main(argv) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const root = arg('--root') || path.resolve(__dirname, '..');
  const result = runGate({ root, publicRoot: arg('--public'), syntax: !argv.includes('--no-syntax'), withTests: argv.includes('--with-tests') });
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  for (const nt of result.notes) console.error(`[release-module-gate] ${nt.tree}: ${nt.file} ${nt.detail}`);
  for (const p of result.problems) {
    if (p.kind === 'unresolved') console.error(`[release-module-gate] ${p.tree}: ${p.file}:${p.line} requires missing module ${p.missing} (${p.spec})`);
    else console.error(`[release-module-gate] ${p.tree}: ${p.file} ${p.kind}: ${p.detail}`);
  }
  console.log(`[release-module-gate] ${result.ok ? 'PASS' : 'FAIL'}: ${result.files} files checked, ${result.problems.length} problem(s)`);
  return result.ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { runGate, checkTree, extractSpecifiers, maskNonCode, resolves };
