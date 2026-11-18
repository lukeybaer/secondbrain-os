'use strict';
//
// wording-test-lint.js -- pure classifier for "wording-only" tests.
//
// A wording-only test reads a repository source or doc file as TEXT
// (fs.readFileSync of a .js/.md/.ts/... file), asserts on that text
// (toMatch / toContain / includes / regex.test), and never runs the code under
// test (no relative require/import of repo code, no spawned script). It proves
// nothing a person would notice: any tidy-up of the wording breaks it while
// nothing is actually wrong. The owner's S-8 decision (2026-10-28): a test proves
// behavior (input -> output); rules are enforced where they act; docs that list
// code facts are generated from code.
//
// Not wording-only (never flagged):
//   - the file requires/imports repo code (relative path) or spawns a script,
//     because it can call the code under test;
//   - the text it reads is a fixture or generated output (a temp dir, a path
//     the test wrote itself, a literal that names a fixture);
//   - it carries the explicit, rare opt-out comment
//         // wording-test-allowed: <reason>
//     for a genuine contract (public API docs and similar).
//
// Pure: classifyTestFile(text) takes the file text and returns a verdict.

const SOURCE_EXT = '(?:js|mjs|cjs|ts|tsx|jsx|md|sh|html|yml|yaml)';
const SOURCE_PATH_LITERAL = new RegExp(
  '^[^\\n]*\\.' + SOURCE_EXT + '$',
  'i',
);
const OPT_OUT = /(?:\/\/|\/\*)[ \t]*wording-test-allowed:[ \t]*(\S[^\n*]*)/;

const TEST_FILE_RE = /(^|\/)__tests__\/.*\.(?:test|spec)\.[cm]?[jt]sx?$|\.(?:test|spec)\.[cm]?[jt]sx?$/;

function isTestFile(rel) {
  const f = String(rel || '').replace(/\\/g, '/');
  if (/(^|\/)node_modules\//.test(f)) return false;
  return TEST_FILE_RE.test(f);
}

// Blank out comments so prose in comments never counts as code. Strings are
// left intact (the lexer is deliberately light; a `//` inside a string such as
// a URL is protected by requiring the previous char not be ':').
function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, (m, p1) => p1);
}

// Is there a relative (repo code) module reference? a relative require of ../x,
// import x from './y', import('../z'). vi.mock paths do not count: mocking is
// not calling.
function referencesRepoCode(code) {
  const re = /(?:require\s*\(\s*|from\s+|import\s*\(\s*|import\s+)(['"`])(\.{1,2}\/[^'"`]*|\.{1,2})\1/g;
  let m;
  while ((m = re.exec(code))) {
    const spec = m[2];
    // Importing data/fixtures/test-helpers is not "the code under test".
    if (/fixtures?\b/i.test(spec)) continue;
    if (/\.json$/.test(spec)) continue;
    return true;
  }
  // A non-literal require(X) / import(X) / createRequire loads repo code by a
  // computed path (require(MODULE_PATH), require(path.join(...))).
  if (/\brequire\s*\(\s*(?!['"`])[A-Za-z_$]/.test(code)) return true;
  if (/\bimport\s*\(\s*(?!['"`])[A-Za-z_$]/.test(code)) return true;
  if (/\bcreateRequire\s*\(/.test(code)) return true;
  return false;
}

// Does the test execute anything? Spawned node/shell scripts count as calling
// the code under test.
function spawnsCode(code) {
  return /\b(?:spawnSync|execFileSync|execSync|spawn|execFile|fork)\s*\(/.test(code)
    || /\bexec\s*\(\s*['"`]/.test(code)
    // Extracting a function from source text and evaluating it IS running the
    // code under test, even though the text came from a file.
    || /\bnew\s+Function\s*\(|\beval\s*\(|\bvm\s*\.\s*\w+\s*\(|\brunIn(?:New|This)Context\s*\(/.test(code);
}

// Names of helper functions whose body reads a file (const read = (p) => fs.readFileSync(...)).
function readHelperNames(code) {
  const names = new Set(['readFileSync', 'readFile', 'readFileAsync']);
  const defs = [
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=)]*\)?\s*=>\s*[^;\n]*\b(?:readFileSync|readFile)\b/g,
    /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{[^}]*\b(?:readFileSync|readFile)\b/g,
  ];
  for (const re of defs) {
    let m;
    while ((m = re.exec(code))) names.add(m[1]);
  }
  return names;
}

// Balanced-paren argument text starting right after an opening paren index.
function argText(code, openIdx) {
  let depth = 1;
  let i = openIdx;
  while (i < code.length && depth > 0) {
    const c = code[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    i += 1;
  }
  return code.slice(openIdx, i - 1);
}

function stringLiterals(s) {
  const out = [];
  const re = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  let m;
  while ((m = re.exec(s))) out.push(m[2]);
  return out;
}

// Literal path strings the test itself writes (so a later read is a fixture).
function writtenLiterals(code) {
  const out = new Set();
  const re = /\b(?:writeFileSync|writeFile|appendFileSync|copyFileSync|cpSync|renameSync)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    for (const lit of stringLiterals(argText(code, m.index + m[0].length))) out.add(lit);
  }
  return out;
}

const FIXTURE_HINT = /fixture|tmpdir|mkdtemp|\btmp\b|\btemp\b|os\.tmp/i;

// Find reads of repo source/doc files. Returns the list of source-ish path
// literals read (empty when none).
function findSourceReads(code) {
  const helpers = readHelperNames(code);
  const written = writtenLiterals(code);
  const reads = [];
  // Path constants: const X = path.join(..., 'a/b.js')  (read later by name)
  const constPaths = new Map();
  const constRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g;
  let cm;
  while ((cm = constRe.exec(code))) {
    const lits = stringLiterals(cm[2]).filter((l) => SOURCE_PATH_LITERAL.test(l));
    if (lits.length && !FIXTURE_HINT.test(cm[2])) constPaths.set(cm[1], lits);
  }
  const namePattern = Array.from(helpers).map((n) => n.replace(/\$/g, '\\$')).join('|');
  const callRe = new RegExp('\\b(?:' + namePattern + ')\\s*\\(', 'g');
  let m;
  while ((m = callRe.exec(code))) {
    // Skip the helper definition itself (preceded by "function " or "const x =").
    const before = code.slice(Math.max(0, m.index - 12), m.index);
    if (/function\s+$/.test(before)) continue;
    const args = argText(code, m.index + m[0].length);
    if (FIXTURE_HINT.test(args)) continue;
    const lits = stringLiterals(args).filter((l) => SOURCE_PATH_LITERAL.test(l));
    let hit = lits.filter((l) => !written.has(l));
    if (!hit.length) {
      for (const id of args.match(/[A-Za-z_$][\w$]*/g) || []) {
        if (constPaths.has(id)) hit = hit.concat(constPaths.get(id).filter((l) => !written.has(l)));
      }
    }
    // Directory walks and dynamic names: a read of a path assembled from a
    // loop variable over a source directory is still a source read when the
    // file mentions source extensions in a filter.
    if (hit.length) reads.push(...hit);
  }
  return reads;
}

// Is any assertion made over TEXT (substring or regex checks)?
function assertsOnText(code) {
  return /\.(?:toMatch|toContain|toContainEqual|toMatchInlineSnapshot|toMatchSnapshot)\s*\(/.test(code)
    || /\bassert\s*\.\s*(?:match|doesNotMatch)\s*\(/.test(code)
    || /\bassert(?:\.ok|\.strict)?\s*\([^;]*?\.(?:includes|match|test|startsWith|endsWith|indexOf)\s*\(/.test(code)
    || /\bexpect\s*\([^;]*?\.(?:includes|match|test|indexOf)\s*\(/.test(code)
    || /\bexpect\s*\([^;]*?\)\s*\.(?:to|not\.to)\.(?:include|match|contain)/.test(code)
    || /\bassert\s*\.\s*(?:notStrictEqual|doesNotMatch)\s*\(/.test(code);
}

function classifyTestFile(text) {
  const raw = String(text == null ? '' : text);
  const opt = OPT_OUT.exec(raw);
  if (opt) return { verdict: 'allowed', reasons: ['opt-out: ' + opt[1].trim()], reads: [] };
  const code = stripComments(raw);
  const reads = findSourceReads(code);
  if (!reads.length) return { verdict: 'behavior', reasons: ['reads no repository source or doc text'], reads: [] };
  if (!assertsOnText(code)) return { verdict: 'behavior', reasons: ['no text assertion over the read'], reads };
  if (referencesRepoCode(code)) return { verdict: 'behavior', reasons: ['loads repository code (can call the code under test)'], reads };
  if (spawnsCode(code)) return { verdict: 'behavior', reasons: ['spawns a process (can run the code under test)'], reads };
  return {
    verdict: 'wording-only',
    reasons: ['asserts on text read from ' + Array.from(new Set(reads)).slice(0, 3).join(', ') + ' and never calls the code under test'],
    reads: Array.from(new Set(reads)),
  };
}

// Lint a list of repo-relative paths. readFile(rel) -> text or null (deleted).
function lintFiles(files, readFile) {
  const violations = [];
  for (const rel of files || []) {
    if (!isTestFile(rel)) continue;
    let text = null;
    try { text = readFile(rel); } catch { text = null; }
    if (text == null) continue;
    const result = classifyTestFile(text);
    if (result.verdict === 'wording-only') violations.push({ file: String(rel).replace(/\\/g, '/'), ...result });
  }
  return violations;
}

function formatViolations(violations) {
  return violations
    .map((v) => `  ${v.file}: ${v.reasons.join('; ')}`)
    .join('\n');
}

const REMEDY =
  'A test must prove behavior (input -> output a person would notice). Call the code and assert its result; ' +
  'do not grep source or docs for wording. For a genuine contract (public API docs), add ' +
  '"// wording-test-allowed: <reason>" to the test.';

module.exports = {
  classifyTestFile,
  lintFiles,
  formatViolations,
  isTestFile,
  stripComments,
  REMEDY,
};
