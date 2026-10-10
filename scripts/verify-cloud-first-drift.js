#!/usr/bin/env node
'use strict';
//
// verify-cloud-first-drift.js -- the BLOCKING rung for cloud-first.
//
// scripts/claude-hooks/cloud-first-guard.mjs warns at design time. This lint
// refuses the LAND when a production producer path acquires a dependency on
// ExampleCo's PC that no owner-approved allowlist entry covers.
//
// WHAT "PRODUCTION PRODUCER PATH" MEANS HERE. Not guesswork, and not a
// hand-kept list that rots: it is the cloud-deployed set the release itself
// audits. dev-plans/core/devops-release.md calls LIVE_DEPS "the audited
// closure", and scripts/deploy-ec2-server.sh ships exactly that plus the EC2
// server entry points. Two layers:
//   1. EVERY LIVE_DEPS entry is scanned directly, whatever its language.
//      Codex review 2e070e3c1b13 caught the first cut filtering to .js and
//      thereby skipping 10 Python and 27 shell producers, including
//      scripts/ec2-build-from-queue.py, the video build pipeline, which is the
//      exact subsystem of the incident this lint exists to prevent.
//   2. The JS/MJS entries are expanded through their static require AND import
//      closure, so a lib pulled in by a producer is covered too.
// That yields briefing card producers, System Health metric producers, the
// video build/publish pipeline, the scheduled runners, and the EC2 routes by
// construction, and a NEW producer enters scope the moment it is deployed.
//
// WHAT COUNTS AS A PC DEPENDENCY (category, not the 2026-08-24 literal):
//   1. requiring/importing the desktop-capability relay / worker / http-auth
//   2. reading a desktop relay URL, secret, or env file (the module name never
//      has to appear for the dependency to be real)
//   3. a Windows-only absolute path that FLOWS INTO the filesystem or a spawned
//      process, directly or through a local binding (a Windows path inside an
//      operator-facing message is the sanctioned honest-blocker surface, not a
//      dependency)
//   4. an SSH invocation targeting the desktop host
// The patterns live in scripts/lib/cloud-first-policy.js, shared with the hook,
// so there is ONE definition of a PC dependency and not two that drift.
//
// WHAT IS NOT BANNED: the relay is a SANCTIONED cross-host capability
// (devops-release.md invariant 12). config/cloud-first-allowlist.json keeps
// those legal, but each entry is scoped to EXACT VIOLATION FINGERPRINTS, not
// to a whole file. Codex: a file-level exemption means a NEW PC dependency
// added to an already-allowlisted file lands green forever. Entries also carry
// an owner-approval record and a cloud-fallback claim, stale entries are
// rejected, and any entry declaring an `openGap` is echoed as a WARNING on
// every land so a known-incomplete fallback stays visible instead of buried.
//
// It also keeps the DELIVERY rung honest: the verbatim invariants the hook
// injects must still resolve in their core docs, and the hook must still be
// registered for Agent spawns AT A PATH THAT EXISTS.
//
// Run: npm run verify:cloud-first-drift. Runs on every land via
// scripts/__tests__/core.test.js.
// Companion test: scripts/__tests__/verify-cloud-first-drift.test.js
//
// Exit 0 clean; exit 1 drift.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { parseLiveDeps } = require('./lib/live-deps-parser.js');
const { readActiveHookEntries } = require('./lib/hook-delivery.js');

const {
  readAnchoredInvariants,
  DESKTOP_MODULE_RE,
  DESKTOP_ENV_RE,
  WINDOWS_PATH_RE,
  APPDATA_RE,
  DESKTOP_SSH_RE,
  PATH_OPERAND_CALL_RE,
  WINDOWS_PATH_BINDING_RE,
} = require('./lib/cloud-first-policy.js');

const REPO = path.resolve(__dirname, '..');

const ALLOWLIST_REL = 'config/cloud-first-allowlist.json';
const HOOK_NAME = 'cloud-first-guard.mjs';
const REQUIRED_ALLOWLIST_FIELDS = [
  'path',
  'fingerprints',
  'reason',
  'approvedBy',
  'date',
  'cloudFallback',
];

const SCANNABLE_EXT = /\.(js|cjs|mjs|py|sh|ps1|ts)$/;

/** Replace comments with whitespace: prose about a rule is not the rule. */
function stripComments(src, rel, repoRoot) {
  const text = String(src || '');
  if (/\.(py|sh|ps1)$/.test(rel)) {
    // Shell and Python: strip whole-line and trailing # comments, but never a
    // shebang and never a # inside a quoted string (approximated by requiring
    // whitespace or line start before the #).
    return text.replace(/(^|\s)#(?!!)[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  }
  // JavaScript comments come from the SAME lexical scan the edge extractor
  // uses, so the two cannot disagree. Codex review round 7: the old regex pass
  // removed a `//` that appeared INSIDE an ordinary string, which deleted that
  // string's closing quote and desynchronised everything after it.
  const viaAcorn = parseWithAcorn(text, rel, repoRoot);
  if (viaAcorn) {
    const chars = text.split('');
    for (const [start, end] of viaAcorn.comments) {
      for (let i = start; i < end && i < chars.length; i += 1) {
        if (chars[i] !== '\n') chars[i] = ' ';
      }
    }
    return chars.join('');
  }
  // Unparseable JavaScript: return the source unchanged. The caller reports
  // the file as unscannable, so nothing downstream trusts this result.
  return text;
}
/**
 * Acorn's PARSER, when it is resolvable.
 *
 * Codex review round 8 prescribed a parser after the hand-written scanner's
 * regex-versus-division and template-brace heuristics both failed. Round 9 then
 * showed that a TOKENIZER is not enough either: `acorn.tokenizer()` tokenizes
 * but does not parse statements, so ASI shapes such as
 *   export const x = 1
 *   from
 *   './fake.js'
 * invented a static edge. Statement structure is a parser's job, so this walks
 * the AST and reads the exact nodes:
 *   ImportDeclaration.source            import x from './a'  /  import './c'
 *   ExportNamedDeclaration.source       export { y } from './d'
 *   ExportAllDeclaration.source         export * from './e'
 *   CallExpression require('./f')       including a no-substitution template
 * ImportExpression (dynamic `import()`) is deliberately NOT a static edge; it
 * is one of the residual holes named in g26.
 *
 * ONE PATH, FAIL CLOSED (round 11). There used to be a hand-written fallback
 * scanner for the case where acorn does not resolve, and across rounds 7 to 10
 * every version of it disagreed with the parser on some valid input, so the
 * guard's answer depended on which engine ran. It is deleted. acorn is a
 * TRANSITIVE dependency here (this repo forbids `npm install` against the
 * shared node_modules), so if it is unavailable, or a deployed file will not
 * parse, this returns null and the caller reports that file UNSCANNABLE and
 * fails the land. Unknown is not clean.
 *
 * @returns {{specs: string[], comments: Array<[number, number]>}|null}
 */
/**
 * The `"type"` of the nearest package.json above `rel`, or null when none
 * declares one. Node's rule for `.js` and `.ts`; `.mjs` and `.cjs` never
 * consult it.
 */
function packageTypeFor(repoRoot, rel) {
  if (!repoRoot || !rel) return null;
  let dir = path.dirname(path.resolve(repoRoot, rel));
  const stop = path.resolve(repoRoot);
  for (let guard = 0; guard < 64; guard += 1) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg && typeof pkg.type === 'string') return pkg.type;
      // A package.json WITHOUT "type" is the controlling one, but it does not
      // decide: Node 24 treats a typeless `.js` as AMBIGUOUS and applies syntax
      // detection. Codex review round 14 caught this forcing CommonJS, which
      // made a valid static `import` in this typeless repo report UNSCANNABLE,
      // a false land failure. null means ambiguous, so both modes are tried,
      // which is exactly what syntax detection does.
      return null;
    } catch {
      /* keep walking up */
    }
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parseWithAcorn(text, rel, repoRoot) {
  let acorn;
  try {
    // eslint-disable-next-line global-require
    acorn = require('acorn');
  } catch {
    return null;
  }
  // The source mode is decided by the EXTENSION where the extension decides it,
  // and each mode is parsed under its own real grammar.
  //
  // Codex review round 11: unconditional module-then-script with permissive
  // cross-mode options accepted files that are invalid under their actual mode.
  // `allowImportExportEverywhere` in particular let `import` through in script
  // mode, so a genuinely broken `.mjs` could be accepted as sloppy script and
  // escape the UNSCANNABLE failure. Now `.mjs` is module and `.cjs` is script,
  // because those two extensions DO decide the mode. `.js` and `.ts` do not:
  // Node resolves both from the nearest package.json `type` or from syntax
  // detection, so `.ts` is not inherently ESM (Codex review round 12 caught
  // this as a regression I introduced in round 11: a script-mode `.ts` with
  // sloppy duplicate declarations was reported UNSCANNABLE, a false land
  // failure). Ambiguous extensions therefore try both. Real CommonJS in this
  // repo needs script mode (ec2-server.js declares escapeHtml twice,
  // briefing-source-contracts.js declares previousIsoDate twice, both legal
  // only in sloppy mode).
  const ext = String(rel || '').toLowerCase();
  let modes;
  if (ext.endsWith('.mjs')) modes = ['module'];
  else if (ext.endsWith('.cjs')) modes = ['script'];
  else {
    // `.js` and `.ts` are decided by the nearest package.json "type" (Codex
    // review round 13). Trying both modes unconditionally reopened round 11's
    // cross-mode false-clean: a "type":"module" file rejected by module grammar
    // would pass as script, and a "type":"commonjs" file containing `import`
    // would pass as module. Syntax detection is used ONLY when no controlling
    // package.json declares a type, which is the genuinely ambiguous case.
    const declared = packageTypeFor(repoRoot, rel);
    if (declared === 'module') modes = ['module'];
    else if (declared === 'commonjs') modes = ['script'];
    else modes = ['module', 'script'];
  }

  let ast = null;
  let comments = [];
  for (const sourceType of modes) {
    const acc = [];
    try {
      ast = acorn.parse(text, {
        ecmaVersion: 'latest',
        sourceType,
        allowHashBang: true,
        // Top-level await is module-only; top-level return is script-only.
        // Neither is granted across modes, so the wrong grammar cannot pass.
        allowAwaitOutsideFunction: sourceType === 'module',
        allowReturnOutsideFunction: sourceType === 'script',
        onComment: (block, textVal, start, end) => acc.push([start, end]),
      });
      comments = acc;
      break;
    } catch {
      ast = null;
    }
  }
  // Genuinely unparseable: the caller reports the file UNSCANNABLE rather than
  // treating it as edge-free.
  if (!ast) return null;

  const specs = [];
  const addRelative = (value) => {
    if (typeof value === 'string' && value.startsWith('.')) specs.push(value);
  };
  /** A string literal, or a template with no interpolation, as a static value. */
  const staticStringValue = (node) => {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
      return node.quasis.map((q) => q.value.cooked).join('');
    }
    return null;
  };

  // ---- DATA spans: source ranges that are PATTERN DATA about a dependency,
  // never a runtime USE of one. Consumed by pcDependenciesIn to mask the four
  // lexical scanners (Codex review, 2026-08-25): a blanket per-FILE exemption
  // silenced real violations anywhere in an exempted file, which contradicts
  // the fingerprint-scoped design this whole lint is built on. Two AST shapes
  // only, both general and not tied to any filename:
  //   1. A REGEX LITERAL's source text (e.g. `/AMY_DESKTOP_RELAY_URL/`) is a
  //      pattern DEFINITION, not code that reads an env var.
  //   2. A string/template-literal ARGUMENT of a call to a bare identifier
  //      named `push` (never `x.push(...)`, which is the ubiquitous
  //      Array#push and stays fully scanned) is this lint's own local
  //      diagnostic-message idiom (`push(kind, discriminator, detail,
  //      evidence)`), describing a finding in English, not executing one.
  const dataSpans = [];

  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node.type === 'string') {
      if (
        node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration'
      ) {
        addRelative(staticStringValue(node.source));
      } else if (
        node.type === 'CallExpression' &&
        node.callee &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments.length >= 1
      ) {
        addRelative(staticStringValue(node.arguments[0]));
      }
      // ImportExpression is intentionally skipped: dynamic import is not static.
      if (node.type === 'Literal' && node.regex) {
        dataSpans.push([node.start, node.end]);
      }
      if (
        node.type === 'CallExpression' &&
        node.callee &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'push'
      ) {
        for (const arg of node.arguments || []) {
          if (!arg) continue;
          if (arg.type === 'Literal' && typeof arg.value === 'string') {
            // A plain string literal has no interpolation, so its ENTIRE span
            // is static prose -- always safe to mask wholesale.
            dataSpans.push([arg.start, arg.end]);
          } else if (arg.type === 'TemplateLiteral') {
            // Codex review round 2: masking a TemplateLiteral's WHOLE span
            // (quasis AND expressions) hid a genuine dependency the instant it
            // was interpolated in, e.g. push(`${process.env.AMY_DESKTOP_RELAY_URL}`)
            // -- a repository-wide false negative, not a narrow fix. Mask only
            // the QUASI (literal-text) segments between `${` and `}`; every
            // embedded EXPRESSION span stays fully exposed to the four lexical
            // scanners, so an interpolated real dependency is never hidden.
            for (const quasi of arg.quasis || []) {
              dataSpans.push([quasi.start, quasi.end]);
            }
          }
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      walk(node[key]);
    }
  };
  walk(ast);
  return { specs, comments, dataSpans };
}

/**
 * Static module edges for one JavaScript source, or null when the file cannot
 * be parsed at all.
 *
 * ONE PATH, FAIL CLOSED. Codex review round 10 took the first of its three
 * suggested remedies. There used to be a hand-written fallback scanner, and
 * across rounds 7 through 10 every version of it disagreed with the parser on
 * some valid input: `require(\`./x\`)`, `(require)('./x')`, `require?.('./x')`,
 * `loader.require('./x')`, and ASI shapes like `export function f(){}` followed
 * by a bare `from`. A guard whose answer depends on which of two engines ran is
 * not a guard, and no finite parity table can close that gap. So there is now
 * exactly one extraction path, and when it is unavailable the affected files
 * are reported UNSCANNABLE and the land fails, exactly like a deployed producer
 * in a language this lint cannot read. Unknown is not clean.
 *
 * @returns {string[]|null} null means "could not parse", never "no edges"
 */
function moduleSpecs(src, rel, repoRoot) {
  const parsed = parseWithAcorn(String(src || ''), rel, repoRoot);
  return parsed ? parsed.specs : null;
}

/**
 * PATTERN-DATA spans for one JavaScript source: regex-literal bodies and the
 * string/template arguments of a bare `push(...)` call. See the `dataSpans`
 * collection in parseWithAcorn's walk() for what these mean and why. Reuses
 * the SAME parse `stripComments` already ran (offsets are stable across that
 * call because comment stripping only blanks characters to spaces, never
 * shifts positions), so this never disagrees with what was actually parsed.
 *
 * @returns {Array<[number, number]>} empty when unparseable; the caller
 *   already reports an unparseable file UNSCANNABLE elsewhere, so an empty
 *   mask here never hides that failure.
 */
function dataSpansIn(src, rel, repoRoot) {
  const parsed = parseWithAcorn(String(src || ''), rel, repoRoot);
  return parsed ? parsed.dataSpans : [];
}

/** Is the JavaScript parser available at all? */
function jsParserAvailable() {
  try {
    require('acorn');
    return true;
  } catch {
    return false;
  }
}

/** Resolve one module specifier from one file, or null. */
function resolveSpec(repoRoot, fromRel, spec) {
  const base = path.resolve(path.dirname(path.join(repoRoot, fromRel)), spec);
  // .ts is scannable and traversed, so it must also RESOLVE, or a TypeScript
  // hop silently ends the walk (Codex review round 3: ec2-server.js -> root.ts
  // -> './lib/deep' left deep.ts and its desktop dependency unscanned).
  const candidates = [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
    `${base}.ts`,
    `${base}.json`,
    path.join(base, 'index.js'),
    path.join(base, 'index.cjs'),
    path.join(base, 'index.mjs'),
    path.join(base, 'index.ts'),
  ];
  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        return path.relative(repoRoot, cand).replace(/\\/g, '/');
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Every file in the cloud-deployed production producer path.
 *
 * ONE queue, expanded to a fixed point over BOTH require and import edges
 * (Codex review caaa8e9cad31). Running the CommonJS and ESM walkers separately
 * left a real hole: an ESM root importing a CommonJS helper that requires a
 * third module never reached that third module. Directory imports and index
 * resolution are handled by resolveSpec.
 *
 * Unscannable declared roots FAIL CLOSED rather than being silently dropped:
 * a deployed producer in a language this lint cannot read is an unknown, and
 * an unknown must not read as clean.
 *
 * @returns {{files:string[], roots:string[], warnings:string[], failures:string[]}}
 */
function productionProducerPaths(repoRoot) {
  const warnings = [];
  const failures = [];
  const declared = [];
  for (const entry of ['ec2-server.js', 'server.js']) {
    if (fs.existsSync(path.join(repoRoot, entry))) declared.push(entry);
  }
  const deployScript = path.join(repoRoot, 'scripts', 'deploy-ec2-server.sh');
  if (fs.existsSync(deployScript)) {
    for (const dep of parseLiveDeps(fs.readFileSync(deployScript, 'utf8'))) {
      if (fs.existsSync(path.join(repoRoot, dep))) declared.push(dep);
    }
  } else {
    warnings.push(
      'scripts/deploy-ec2-server.sh missing: the LIVE_DEPS half of the production closure could not be read',
    );
  }
  if (declared.length === 0) return { files: [], roots: [], warnings, failures };

  const unscannable = [...new Set(declared)].filter((f) => !SCANNABLE_EXT.test(f));
  for (const f of unscannable) {
    failures.push(
      `deployed production entry "${f}" is in a form this lint cannot scan, so its PC dependencies are UNKNOWN. Unknown is not clean: add support for the extension in SCANNABLE_EXT, or remove it from the deployed set.`,
    );
  }

  // Tests are not production and are excluded UP FRONT, not just from the
  // output: they are written as ESM `.js` for vitest while the repo's
  // package.json declares no "type", so parsing them under the controlling
  // CommonJS mode would produce false UNSCANNABLE failures for files that are
  // not part of any producer path anyway.
  const isTest = (f) => /(^|\/)__tests__\//.test(f) || /\.(test|spec)\.[cm]?[jt]s$/.test(f);
  const files = new Set();
  const queue = [...new Set(declared.filter((f) => SCANNABLE_EXT.test(f) && !isTest(f)))];
  while (queue.length) {
    const rel = queue.shift();
    if (files.has(rel)) continue;
    files.add(rel);
    if (!/\.(js|cjs|mjs|ts)$/.test(rel)) continue; // only JS-family files have edges we follow
    let src;
    try {
      src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    // BOTH edge kinds, from every file, in the same queue. A CommonJS helper
    // reached through an ESM import keeps expanding, and vice versa.
    //
    // Comments are stripped FIRST. Codex review round 5: the import extractor
    // ran on raw source, so a commented-out `// import './leaf.js';` pulled
    // that leaf into the production closure. If the leaf carried a desktop
    // signal, an honest land was blocked over an edge that does not exist at
    // runtime. Prose about an import is not an import.
    const specs = moduleSpecs(src, rel, repoRoot);
    if (specs === null) {
      // FAIL CLOSED. One extraction path, and it could not read this file, so
      // its edges and its PC dependencies are UNKNOWN. Unknown is not clean.
      failures.push(
        `deployed production entry "${rel}" could not be parsed as JavaScript, so its module edges and PC dependencies are UNKNOWN. Fix the syntax, or remove it from the deployed set. If the parser itself is unavailable this will say so once, above.`,
      );
      continue;
    }
    for (const spec of specs) {
      const resolved = resolveSpec(repoRoot, rel, spec);
      if (resolved && !files.has(resolved) && /\.(js|cjs|mjs|ts)$/.test(resolved)) {
        queue.push(resolved);
      }
    }
  }

  // Tests are not production. A test may legitimately exercise the relay.
  const out = [...files].filter((f) => !isTest(f));
  return { files: out.sort(), roots: [...new Set(declared)], warnings, failures };
}

/**
 * A stable, COLLISION-RESISTANT id for one violation.
 *
 * Codex review caaa8e9cad31 showed the readable form was lossy in three ways
 * at once: import fingerprints ran through path.basename() and so ignored the
 * directory, env fingerprints collapsed every use of the same variable onto one
 * id (two AMY_DESKTOP_RELAY_URL uses in outbound-call-control.js shared a
 * single approval), and line fingerprints truncated at 120 characters. Each is
 * a way for a NEW dependency to inherit an old approval.
 *
 * So: the discriminator is the COMPLETE normalized text plus the occurrence
 * line, hashed. Nothing is truncated before hashing, and two different
 * statements cannot collide by sharing a prefix, a basename, or a token.
 */
function fingerprintFor(kind, discriminator) {
  // EXACT bytes. Codex review round 3: collapsing whitespace changed string
  // LITERAL values, so 'C:\Users\ExampleCo\My  Data\x' and 'C:\Users\ExampleCo\My
  // Data\x' on the same source line hashed identically and the second, a
  // genuinely different path, inherited the first's approval. Only a trailing
  // CR is stripped, because that is a checkout artifact and not content.
  const exact = String(discriminator).replace(/\r+$/, '');
  const digest = crypto.createHash('sha256').update(`${kind}\u0001${exact}`).digest('hex');
  return `${kind}:${digest.slice(0, 16)}`;
}

/**
 * Find every PC dependency in one file.
 * @returns {Array<{file:string, kind:string, fingerprint:string, detail:string}>}
 */
function pcDependenciesIn(repoRoot, rel) {
  const out = [];
  let raw;
  try {
    raw = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  } catch {
    return out;
  }
  const src = stripComments(raw, rel, repoRoot);
  const push = (kind, discriminator, detail, evidence) =>
    out.push({
      file: rel,
      kind,
      fingerprint: fingerprintFor(kind, discriminator),
      detail,
      evidence: String(evidence || discriminator)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160),
    });

  if (/\.(js|cjs|mjs|ts)$/.test(rel)) {
    // null means the parser could not read the file; productionProducerPaths
    // has already reported it UNSCANNABLE, so this does not silently pass.
    for (const spec of moduleSpecs(src, rel, repoRoot) || []) {
      if (DESKTOP_MODULE_RE.test(spec)) {
        // FULL specifier, not the basename: a same-named module in a different
        // directory is a different dependency (Codex review caaa8e9cad31).
        push('desktop-relay-require', spec, `imports the desktop execution module "${spec}"`, spec);
      }
    }
  }
  if (DESKTOP_MODULE_RE.test(rel)) {
    push(
      'desktop-relay-module',
      rel,
      'is itself a desktop execution module shipped in the cloud closure',
      rel,
    );
  }

  const lines = src.split('\n');

  /**
   * PATTERN-DATA spans (Codex review, 2026-08-25): regex-literal bodies and
   * the string/template arguments of a bare `push(...)` call, from
   * dataSpansIn() above. A match for one of the four LEXICAL scanners below
   * that falls inside one of these spans is the scanner's own pattern
   * DEFINITION or its own diagnostic PROSE describing a finding, not code
   * that reaches an env var, a shell, or a filesystem -- so it is excluded
   * from every one of the four checks, not just the two that first surfaced
   * this (cloud-first-policy.js's DESKTOP_ENV_RE definition and this file's
   * "an ssh invocation targets the desktop host" message). This is scoped by
   * AST SHAPE, not by file path: it applies uniformly to every scanned file,
   * so it cannot silence an unrelated real violation the way a per-file
   * exemption did (the defect a prior version of this fix had, per Codex
   * review). A genuine dependency -- an actual `process.env.AMY_DESKTOP_RELAY_URL`
   * read, an actual `exec('ssh ...')`, an actual hardcoded Windows path used
   * as a filesystem operand -- is never inside a regex literal or a `push(...)`
   * argument, so it is never masked. Test coverage:
   * scripts/__tests__/verify-cloud-first-drift.test.js ("the detector does
   * not self-trigger on its own pattern vocabulary").
   */
  const spans = /\.(js|cjs|mjs|ts)$/.test(rel) ? dataSpansIn(src, rel, repoRoot) : [];
  const lineStarts = [0];
  for (let k = 0; k < src.length; k += 1) {
    if (src[k] === '\n') lineStarts.push(k + 1);
  }
  const inDataSpan = (lineIndex, col) => {
    const abs = lineStarts[lineIndex] + col;
    return spans.some(([s, e]) => abs >= s && abs < e);
  };

  /**
   * Windows-path bindings, tracked with ORDER, SCOPE, and REASSIGNMENT.
   *
   * Codex review caaa8e9cad31 produced the false positive that forced this:
   *   function note(){ const workspace = 'C:\\Users\\ExampleCo'; }
   *   function load(workspace){ fs.readFileSync(workspace); }
   * The second `workspace` is an unrelated parameter, and flagging it would
   * block honest lands, which is its own failure mode.
   *
   * Not a full AST, and deliberately biased toward NOT firing: an identifier
   * that is ever a function parameter, or is ever reassigned to something that
   * is not a Windows path, is dropped entirely.
   */
  // NOT scope-aware. Scope is APPROXIMATED by disqualifying, file-wide, any
  // identifier that ever appears as a function parameter. That trades false
  // positives for FALSE NEGATIVES on purpose: a real dependency held in a
  // variable whose name is also a parameter somewhere in the file is missed.
  // Only an AST closes this, and g26 hole (d) says so in those words.
  const paramNames = new Set();
  const PARAM_RE = /(?:function\s+[\w$]*\s*\(([^)]*)\)|\(([^)]*)\)\s*=>|catch\s*\(([^)]*)\))/g;
  for (const line of lines) {
    PARAM_RE.lastIndex = 0;
    let pm;
    while ((pm = PARAM_RE.exec(line))) {
      for (const raw of String(pm[1] || pm[2] || pm[3] || '').split(',')) {
        const name = raw
          .trim()
          .split(/[\s=:]/)[0]
          .replace(/[{}[\].]/g, '');
        if (name) paramNames.add(name);
      }
    }
  }

  // Live binding state, updated IN ORDER as the walk proceeds. Codex review
  // round 3: collecting reassignments file-wide before evaluating any use let
  // a LATER non-Windows reassignment retroactively hide an EARLIER real
  // filesystem use. State must be temporal, so uses are evaluated against the
  // state as of that line, and only then is the line's own effect applied.
  const liveBinding = new Map(); // name -> line index where it took a Windows path

  /**
   * Track whether we are inside the argument region of an open path/fs/exec
   * call, so a literal counts only when it is genuinely an ARGUMENT.
   *
   * This replaces the previous-line heuristic, which had a false positive (a
   * Windows literal merely sitting beside an unrelated `path.join('/opt',...)`)
   * and a false negative (a literal separated from a multiline `path.join(` by
   * another argument line). Both were named in round 3.
   */
  let operandDepth = 0;
  let operandCarryLines = 0;
  const operandStack = [];
  const MAX_OPERAND_CARRY_LINES = 6;
  const CALL_RE = PATH_OPERAND_CALL_RE;

  /**
   * Per-CHARACTER mask of "inside the argument region of a path/fs/exec call".
   *
   * Codex review round 4 defeated the previous first-call/first-literal cut
   * both ways on a single line:
   *   FALSE NEGATIVE  log('Open C:\\Users\\...', fs.readFileSync('C:\\Users\\...secret'))
   *                   the first literal was outside the first call, so the
   *                   second literal, genuinely an argument, was never judged.
   *   FALSE POSITIVE  path.join('/opt','x'); log('Open C:\\Users\\...')
   *                   the first call opened a region that swallowed the rest of
   *                   the line, including an unrelated operator message.
   * So EVERY balanced call interval is tracked and EVERY candidate literal or
   * identifier on the line is checked against it, rather than the first of each.
   *
   * @returns {{mask: boolean[], depthOut: number}}
   */
  function operandMask(line, carryDepth, stack) {
    // Columns where an operand call's "(" sits. The pattern carries a leading
    // boundary group, so the "(" is the last character of the match.
    const callParens = new Set();
    CALL_RE.lastIndex = 0;
    let cm;
    while ((cm = CALL_RE.exec(line))) callParens.add(cm.index + cm[0].length - 1);

    const mask = new Array(line.length).fill(false);
    let depth = carryDepth;
    let quote = null;
    for (let k = 0; k < line.length; k += 1) {
      const c = line[k];
      if (quote) {
        mask[k] = depth > 0;
        if (c === '\\') {
          k += 1;
          if (k < line.length) mask[k] = depth > 0;
        } else if (c === quote) {
          quote = null;
        }
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        mask[k] = depth > 0;
        continue;
      }
      if (c === '(') {
        const isOperand = callParens.has(k);
        stack.push(isOperand);
        if (isOperand) depth += 1;
        mask[k] = depth > 0;
        continue;
      }
      if (c === ')') {
        mask[k] = depth > 0;
        const wasOperand = stack.pop();
        if (wasOperand) depth = Math.max(0, depth - 1);
        continue;
      }
      mask[k] = depth > 0;
    }
    return { mask, depthOut: depth };
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const at = `${rel}:${i + 1}`;
    // The paren stack is carried ACROSS lines, not rebuilt per line. Codex
    // review round 5: a fresh stack meant a closing ")" on a later line popped
    // undefined and never reduced the carried depth, so a valid multiline
    // path.join(...) kept the region open and falsely flagged the operator
    // message on the next line until the six-line timeout expired.
    const { mask, depthOut } = operandMask(line, operandDepth, operandStack);
    const inOperandRegion = (index) => Boolean(mask[index]);

    // EVERY candidate on the line, not just the first of each kind.
    let flagged = false;
    for (const [re, label] of [
      [
        new RegExp(WINDOWS_PATH_RE.source, 'g'),
        `a hardcoded Windows-only path (C:\\Users...) is used as a filesystem operand`,
      ],
      [
        new RegExp(APPDATA_RE.source, 'gi'),
        `a %APPDATA% literal is used as a filesystem operand (it only expands on Windows)`,
      ],
    ]) {
      let lm;
      while ((lm = re.exec(line))) {
        if (!inOperandRegion(lm.index) || inDataSpan(i, lm.index)) continue;
        push(
          'windows-only-path',
          `${at}:${lm.index} ${line}`,
          `line ${i + 1}, column ${lm.index + 1}: ${label}`,
          line,
        );
        flagged = true;
      }
    }

    if (!flagged) {
      for (const [name, boundAt] of liveBinding) {
        if (i <= boundAt) continue; // ORDER: only a use AFTER the binding
        const escaped = name.replace(/[$]/g, '\\$');
        const useRe = new RegExp(`\\b${escaped}\\b`, 'g');
        let use;
        while ((use = useRe.exec(line))) {
          // OPERAND: the identifier must sit inside a call's argument region,
          // not merely on the same line.
          if (!inOperandRegion(use.index) || inDataSpan(i, use.index)) continue;
          push(
            'windows-only-path',
            `${at}:${use.index} ${line}`,
            `line ${i + 1}: "${name}" holds a Windows-only path (bound at line ${boundAt + 1}) and is used as a filesystem operand here`,
            line,
          );
          flagged = true;
          break;
        }
        if (flagged) break;
      }
    }

    {
      // Global clone so every candidate match position on the line can be
      // checked against inDataSpan individually, mirroring the Windows-path
      // loop above. DESKTOP_SSH_RE itself stays the single shared pattern
      // (scripts/lib/cloud-first-policy.js); only the flags change here.
      const sshRe = new RegExp(DESKTOP_SSH_RE.source, `${DESKTOP_SSH_RE.flags}g`);
      let sm;
      while ((sm = sshRe.exec(line))) {
        if (inDataSpan(i, sm.index)) continue;
        push(
          'desktop-ssh',
          `${at} ${line}`,
          `line ${i + 1}: an ssh invocation targets the desktop host`,
          line,
        );
        break; // preserve the existing one-finding-per-line behavior
      }
    }
    {
      // Per-OCCURRENCE, not per-token: two uses of the same env name are two
      // dependencies and each needs its own approval (Codex caaa8e9cad31).
      const envRe = new RegExp(DESKTOP_ENV_RE.source, `${DESKTOP_ENV_RE.flags}g`);
      let em;
      while ((em = envRe.exec(line))) {
        if (inDataSpan(i, em.index)) continue;
        push(
          'desktop-endpoint-config',
          `${at} ${line}`,
          `line ${i + 1}: reads a desktop relay endpoint, secret, or env file (${em[0]}), which points execution at ExampleCo's machine`,
          line,
        );
        break; // preserve the existing one-finding-per-line behavior
      }
    }

    // ---- apply THIS line's effect on state, only after judging its uses ----
    const bind = WINDOWS_PATH_BINDING_RE.exec(line);
    if (bind && bind[1]) {
      if (!paramNames.has(bind[1])) liveBinding.set(bind[1], i);
    } else {
      // A reassignment to something that is not a Windows path kills the
      // binding FROM HERE ON, never retroactively.
      const reassign = /^\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*(.+)$/.exec(line);
      if (reassign && liveBinding.has(reassign[1])) liveBinding.delete(reassign[1]);
    }
    // Carry an OPEN operand call across lines, but only for a BOUNDED span.
    //
    // A regex scanner cannot tokenize JavaScript perfectly (template literals,
    // regex literals, nested quoting), so an unbounded carry can drift positive
    // and then mask the whole rest of the file as "inside an operand". That is
    // not hypothetical: it flagged four operator-facing messages in
    // ec2-server.js and cloud-morning-briefing.js when the carry was unbounded.
    // A real multiline path call spans a few lines, so the carry does too, and
    // anything longer is a stated false negative rather than a false alarm.
    if (depthOut > 0) {
      operandCarryLines += 1;
      operandDepth = operandCarryLines <= MAX_OPERAND_CARRY_LINES ? depthOut : 0;
      if (operandDepth === 0) operandCarryLines = 0;
    } else {
      operandDepth = 0;
      operandCarryLines = 0;
    }
    if (operandDepth === 0) operandStack.length = 0;
  }
  return out;
}

/**
 * Validate a hook registration command at the ARGV level.
 *
 * Codex review round 3: stripping every quote and collapsing all whitespace
 * meant an unmatched quote or an embedded newline normalized INTO the
 * canonical form while producing a dead or multi-command shell invocation. So
 * this parses instead of normalizing: exactly two balanced tokens, no shell
 * metacharacters, no CR/LF.
 *
 * @returns {string|null} a problem description, or null when the command is exactly canonical
 */
function registrationCommandProblem(command, canonical) {
  const raw = String(command || '');
  // RAW EQUALITY, byte for byte. Codex review round 4: tokenizing still let a
  // NBSP through, because JavaScript treats U+00A0 as whitespace while the
  // shell passes it into the argument and Node then exits MODULE_NOT_FOUND.
  // Any normalization step is a place where "looks canonical" and "executes
  // the reviewed file" can come apart, so there is no normalization step.
  if (raw === canonical) return null;
  if (/[\r\n]/.test(raw)) return 'contains a newline';
  if (/[;&|><`$(){}]/.test(raw)) return 'contains a shell metacharacter';
  if (/[^\x20-\x7e]/.test(raw)) return 'contains a non-ASCII character (for example a NBSP)';
  if (raw.trim() === canonical) return 'has leading or trailing whitespace';
  if (raw.replace(/\s+/g, ' ') === canonical) return 'has non-single-space whitespace';
  return 'is not byte-for-byte the canonical invocation';
}

/** Load the allowlist. Unreadable or malformed => fail CLOSED (no entries). */
function loadAllowlist(repoRoot) {
  const file = path.join(repoRoot, ALLOWLIST_REL);
  if (!fs.existsSync(file)) {
    return {
      entries: [],
      problems: [`${ALLOWLIST_REL} is missing; every cross-host use fails closed`],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return {
      entries: [],
      problems: [
        `${ALLOWLIST_REL} is unreadable or not valid JSON (${err.message}); the allowlist fails CLOSED, so every cross-host use below is unapproved`,
      ],
    };
  }
  const raw = Array.isArray(parsed) ? parsed : parsed && parsed.entries;
  if (!Array.isArray(raw)) {
    return {
      entries: [],
      problems: [`${ALLOWLIST_REL} has no "entries" array; the allowlist fails CLOSED`],
    };
  }
  const entries = [];
  const problems = [];
  for (const entry of raw) {
    const where = `${ALLOWLIST_REL} entry "${(entry && entry.path) || '(no path)'}"`;
    const missing = REQUIRED_ALLOWLIST_FIELDS.filter((f) => {
      if (!entry) return true;
      if (f === 'fingerprints') return !Array.isArray(entry[f]) || entry[f].length === 0;
      return typeof entry[f] !== 'string' || !entry[f].trim();
    });
    if (missing.length) {
      problems.push(
        `${where}: missing or empty required field(s) ${missing.join(', ')}. Every sanctioned cross-host capability records WHICH exact dependencies are allowed (fingerprints), WHO approved it, WHEN, WHY, and what the cloud does when the PC is off. An entry without those is a mute button, not an approval.`,
      );
      continue;
    }
    entries.push({
      ...entry,
      path: entry.path.replace(/\\/g, '/'),
      fingerprints: entry.fingerprints.map((f) => String(f).trim()),
    });
  }
  return { entries, problems };
}

/**
 * Lint a repo tree.
 * @returns {{failures:string[], warnings:string[], violations:object[]}}
 */
function checkCloudFirstDrift(repoRoot = REPO) {
  const failures = [];
  const warnings = [];

  // ---- 1. PC dependencies inside the production producer path -------------
  const {
    files,
    roots,
    warnings: scanWarnings,
    failures: scanFailures,
  } = productionProducerPaths(repoRoot);
  warnings.push(...scanWarnings);
  failures.push(...scanFailures);
  if (roots.length === 0) {
    failures.push(
      'no cloud production entry points found (ec2-server.js / server.js / LIVE_DEPS); the scan would pass vacuously, which is worse than no lint',
    );
  }

  const violations = [];
  for (const rel of files) violations.push(...pcDependenciesIn(repoRoot, rel));

  const { entries, problems } = loadAllowlist(repoRoot);
  for (const p of problems) failures.push(p);

  // Fingerprint-scoped, NOT file-scoped (Codex review 2e070e3c1b13): an
  // allowlisted file must not become a permanently exempt file.
  const allowed = new Map();
  for (const entry of entries) {
    for (const fp of entry.fingerprints) allowed.set(`${entry.path}::${fp}`, entry);
  }
  const usedKeys = new Set();

  for (const v of violations) {
    const key = `${v.file}::${v.fingerprint}`;
    if (allowed.has(key)) {
      usedKeys.add(key);
      continue;
    }
    const fileIsAllowlisted = entries.some((e) => e.path === v.file);
    failures.push(
      `PC dependency in a production producer path: ${v.file} ${v.detail}. ` +
        'dev-plans/core/self-heal.md invariant 11: "Receipt-backed cards require Windows/cloud parity; no producer is PC-only." ' +
        'dev-plans/core/devops-release.md invariant 12: "Cross-host capabilities require both hosts and receipts." ' +
        (fileIsAllowlisted
          ? `This file HAS an allowlist entry, but this is a NEW dependency it does not cover. Exceptions are per-dependency, never per-file. `
          : '') +
        `Build it on the cloud, or record an owner-approved entry in ${ALLOWLIST_REL} whose fingerprints include "${v.fingerprint}" (evidence: ${v.evidence}).`,
    );
  }

  // A stale entry is how an allowlist quietly becomes a blanket exemption.
  for (const entry of entries) {
    const stale = entry.fingerprints.filter((fp) => !usedKeys.has(`${entry.path}::${fp}`));
    if (stale.length === entry.fingerprints.length) {
      failures.push(
        `${ALLOWLIST_REL} entry "${entry.path}" is stale: none of its fingerprints match a detected PC dependency (the file may no longer be deployed, or the dependency is gone). Remove it so the allowlist keeps meaning something.`,
      );
    } else if (stale.length) {
      failures.push(
        `${ALLOWLIST_REL} entry "${entry.path}" has stale fingerprint(s) ${stale.join(', ')} that no longer match anything. Remove them so the exception stays exactly as wide as the real dependency.`,
      );
    }
    // A known-incomplete fallback stays LOUD on every land rather than being
    // buried in a config file nobody rereads (Codex found two such claims
    // overstated on the first cut).
    if (entry.openGap) {
      warnings.push(
        `${ALLOWLIST_REL} "${entry.path}" declares an OPEN GAP in its cloud fallback: ${entry.openGap}`,
      );
    }
    if (entry.grandfathered) {
      warnings.push(
        `${ALLOWLIST_REL} "${entry.path}" is GRANDFATHERED, not individually owner-approved: ${entry.approvedBy}`,
      );
    }
  }

  // ---- 2. the delivery rung stays honest ----------------------------------
  for (const anchor of readAnchoredInvariants(repoRoot)) {
    if (!anchor.text) {
      failures.push(
        `canonical invariant no longer resolves in ${anchor.doc}: ${anchor.label}. scripts/claude-hooks/${HOOK_NAME} quotes it VERBATIM, so the guard would inject a paraphrase of a rule that has moved. Update the anchor in scripts/lib/cloud-first-policy.js or restore the text.`,
      );
    }
  }

  const activeHooks = readActiveHookEntries(repoRoot);
  if (!activeHooks.project) {
    failures.push(
      `.claude/settings.json missing or unparseable, so the ${HOOK_NAME} registration cannot be verified`,
    );
  } else {
    const covers = (matcher, tool) => {
      const m = matcher == null ? '' : String(matcher);
      if (m === '' || m === '*') return true;
      return m.split('|').some((seg) => seg === tool || seg.startsWith(tool + '('));
    };
    const registrations = activeHooks.project
      .filter((entry) => entry.event === 'PreToolUse' && String(entry.command || '').includes(HOOK_NAME));
    for (const tool of ['Agent', 'Task']) {
      if (!registrations.some((r) => covers(r.matcher, tool))) {
        failures.push(
          `scripts/claude-hooks/${HOOK_NAME} is NOT registered on a PreToolUse matcher covering ${tool} in .claude/settings.json. Registration IS the delivery rung (law g0); without it the rule reaches nobody, which is the exact hole this lint exists to keep closed.`,
        );
      }
    }
    // REGISTERED-TARGET PARITY (Codex review 2e070e3c1b13). Checking only the
    // basename proved nothing about the path Claude Code actually executes: an
    // absolute shared-checkout command can point at a tree that does not carry
    // the reviewed bytes. A repo-relative command resolves against the session
    // cwd, so the target IS the tree under test, and this asserts exactly that.
    //
    // The command must be EXACTLY the canonical repo-relative invocation.
    // Codex review caaa8e9cad31: checking only the hook token let
    //   cd C:/Users/ExampleCo/secondbrain && node scripts/claude-hooks/...
    // pass while runtime executed a different checkout. Any shell operator or
    // cwd change reopens the parity hole, so the whole command is pinned.
    for (const reg of registrations) {
      const canonical = `node scripts/claude-hooks/${HOOK_NAME}`;
      const problem = registrationCommandProblem(reg.command, canonical);
      if (problem) {
        failures.push(
          `the ${HOOK_NAME} registration must be EXACTLY "${canonical}" but is "${reg.command}" (${problem}). A land can only prove the bytes in THIS tree; an absolute path, a "cd", a shell operator, an embedded newline, or an unbalanced quote lets runtime execute a different, staler copy or nothing at all, so the registered target and the reviewed target would not be the same file.`,
        );
      } else if (!fs.existsSync(path.join(repoRoot, 'scripts', 'claude-hooks', HOOK_NAME))) {
        failures.push(
          `the ${HOOK_NAME} registration points at a script that does not exist in this tree; a hook that cannot start enforces nothing`,
        );
      }
    }
  }

  return { failures, warnings, violations };
}

function main() {
  const { failures, warnings } = checkCloudFirstDrift(REPO);
  warnings.forEach((w) => console.warn(`WARN  ${w}`));
  if (failures.length) {
    console.error(`\n[verify-cloud-first-drift] DRIFT: ${failures.length} violation(s):`);
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error(
      '\nCloud-first: production producers are cloud-resident and no receipt-backed producer is PC-only. Fix the producer, or record the owner-approved cross-host exception.',
    );
    process.exit(1);
  }
  console.log(
    '[verify-cloud-first-drift] CLEAN: no unapproved PC dependency in the production producer path, canonical invariants resolve, and the Agent-spawn guard is registered at a real repo-relative path.',
  );
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  checkCloudFirstDrift,
  productionProducerPaths,
  pcDependenciesIn,
  loadAllowlist,
  fingerprintFor,
  moduleSpecs,
  dataSpansIn,
  resolveSpec,
  jsParserAvailable,
  REQUIRED_ALLOWLIST_FIELDS,
  ALLOWLIST_REL,
};
