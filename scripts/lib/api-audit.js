'use strict';

// Paid-provider API audit core. Shared by the overnight healer
// (probeApiAudit in scripts/health-self-heal.js) and the land gate
// (scripts/land.js) so a new unjustified reference fails at land time instead
// of turning the System Health card red overnight (2026-10-31, d3f6a3a25).

const fs = require('fs');
const path = require('path');

// Strips // and /* */ comment bodies from JS/TS source while respecting
// string literals, so a token mentioned only in a comment never counts as
// usage. Comment characters become spaces and newlines survive, keeping the
// downstream per-line matching line-accurate. String-aware on purpose:
// 'https://api.openai.com' must NOT be eaten as a // comment.
function stripJsComments(source) {
  let out = '';
  let i = 0;
  let state = 'code'; // code | line | block | single | double | template
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      out += ch;
      i++;
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out += ch;
      } else {
        out += ' ';
      }
      i++;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
    // string states: keep content verbatim, honor escapes
    if (ch === '\\') {
      out += ch + (next || '');
      i += 2;
      continue;
    }
    if (
      (state === 'single' && ch === "'") ||
      (state === 'double' && ch === '"') ||
      (state === 'template' && ch === '`') ||
      ((state === 'single' || state === 'double') && ch === '\n')
    ) {
      state = 'code';
    }
    out += ch;
    i++;
    continue;
  }
  return out;
}

// Removes the constructs that REMOVE a paid-provider token from an
// environment rather than consume it: `delete env.X` / `delete
// process.env.X` (dot or bracket access), `env.X = undefined|null|''`, and
// `Reflect.deleteProperty(obj, 'X')`. Category rule (2026-07-18 defect
// report, section 5): scrub/deletion constructs are security hardening, not
// usage, and flagging them inverts the audit. The scrub construct is cut out
// of the line so any surviving mention on the same line still counts.
function stripScrubConstructs(line, pattern) {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const member = `(?:\\.${esc}\\b|\\[\\s*['"\`]${esc}['"\`]\\s*\\])`;
  const target = `[\\w$][\\w$.]*${member}`;
  const scrubs = [
    new RegExp(`\\bdelete\\s+${target}`, 'g'),
    new RegExp(`${target}\\s*=\\s*(?:undefined\\b|null\\b|''|""|\`\`)`, 'g'),
    new RegExp(`\\bReflect\\.deleteProperty\\s*\\([^)]*['"\`]${esc}['"\`][^)]*\\)`, 'g'),
  ];
  let out = line;
  for (const re of scrubs) out = out.replace(re, ' ');
  return out;
}

// A hardening loop may enumerate forbidden credential names, then delete each
// one through the loop variable. The literal token is on the iterable line,
// while the deletion is on another line, so the per-line scrub recognizer
// cannot connect them. Remove only loops whose complete body is one dynamic
// delete against that exact iterator. Any read, call, assignment, or second
// statement prevents the match and leaves the credential literal auditable.
function stripDynamicScrubLoops(body) {
  return String(body || '').replace(
    /\bfor\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s*(\[[\s\S]*?\])\s*\)\s*\{\s*delete\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\[\s*\1\s*\]\s*;?\s*\}/g,
    ' ',
  );
}

// A frozen list of credential NAMES is not credential consumption when every
// local use is deletion, a presence-only diagnostic, or a shorthand export.
// Unknown uses retain the literals. Exports also remain auditable whenever
// another production source mentions the binding, including aliased imports.
// A `new Set([...])` list (literal names plus spreads of other lists) is the
// same construct; its `.has(key)` use counts only inside a loop over
// Object.keys(obj) whose whole body is `if (<key-name tests>) { delete obj[key]; }`.
function stripNamedScrubLists(body, pattern, bindingUsedElsewhere) {
  let out = String(body || '');
  const declarations = [...out.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:Object\.freeze|new\s+Set)\(\s*\[([\s\S]*?)\]\s*\)\s*;/g,
  )];
  const identifier = '[A-Za-z_$][\\w$]*';
  const objectPath = `${identifier}(?:\\.${identifier})*`;
  for (const declaration of declarations) {
    const [, binding, values] = declaration;
    if (!values.includes(pattern) ||
        values
          .replace(/(['"])[A-Z_][A-Z0-9_]*\1/g, '')
          .replace(/\.\.\.[A-Za-z_$][\w$]*/g, '')
          .replace(/[,\s]/g, '') ||
        bindingUsedElsewhere(binding)) continue;
    const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let remaining = out.replace(declaration[0], ' ');
    let deletions = 0;
    const loops = new RegExp(`\\bfor\\s*\\(\\s*const\\s+(${identifier})\\s+of\\s+${escaped}\\s*\\)\\s*(?:\\{([^{}]*)\\}|([^;{}]*;))`, 'g');
    remaining = remaining.replace(loops, (whole, iterator, block, statement) => {
      const key = iterator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const deletion = new RegExp(`^\\s*(?:if\\s*\\(\\s*${key}\\s*!==\\s*(['"])([^'"]+)\\1\\s*\\)\\s*)?delete\\s+${objectPath}\\[\\s*${key}\\s*\\]\\s*;?\\s*$`);
      const match = String(block ?? statement).match(deletion);
      if (!match || match[2] === pattern) return whole;
      deletions += 1;
      return ' ';
    });
    const keyLoops = new RegExp(`\\bfor\\s*\\(\\s*const\\s+(${identifier})\\s+of\\s+Object\\.keys\\(\\s*(${objectPath})\\s*\\)\\s*\\)\\s*\\{\\s*if\\s*\\(([^{};]*)\\)\\s*\\{\\s*delete\\s+(${objectPath})\\[\\s*\\1\\s*\\]\\s*;?\\s*\\}\\s*\\}`, 'g');
    remaining = remaining.replace(keyLoops, (whole, iterator, source, condition, target) => {
      const key = iterator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const membership = new RegExp(`\\b${escaped}\\.has\\(\\s*${key}\\s*\\)`, 'g');
      if (target !== source || !membership.test(condition)) return whole;
      const residue = condition
        .replace(membership, ' ')
        .replace(new RegExp(`\\/(?:\\\\.|[^/\\\\\\n])+\\/[a-z]*\\.test\\(\\s*${key}\\s*\\)`, 'g'), ' ')
        .replace(/\|\||&&|[()!\s]/g, '');
      if (residue) return whole;
      deletions += 1;
      return ' ';
    });
    const presenceChecks = new RegExp(`\\b${escaped}(?:\\.filter\\(\\s*\\((${identifier})\\)\\s*=>\\s*\\1\\s*!==\\s*(['"])[^'"]+\\2\\s*\\)\\s*)?\\.filter\\(\\s*\\((${identifier})\\)\\s*=>\\s*Object\\.prototype\\.hasOwnProperty\\.call\\(\\s*${objectPath}\\s*,\\s*\\3\\s*\\)\\s*\\)`, 'g');
    remaining = remaining.replace(presenceChecks, ' ');
    remaining = remaining.replace(/\bmodule\.exports\s*=\s*\{([^{}]*)\}/g, (whole, fields) =>
      whole.replace(fields, fields.replace(new RegExp(`(^|,)\\s*${escaped}\\s*(?=,|$)`, 'g'), '$1')));
    const reference = new RegExp(`(^|[^\\w$])${escaped}(?=$|[^\\w$])`);
    if (deletions && !reference.test(remaining)) out = out.replace(declaration[0], ' ');
  }
  return out;
}

// True when `body` genuinely USES `pattern` (reads the key, targets the API
// host, or carries a key literal), as opposed to mentioning it in a comment
// or scrubbing it out of an env. Per-line so a scrub on one line never
// excuses a real read elsewhere in the same file.
function apiPatternIsUsed(body, pattern, bindingUsedElsewhere = () => true) {
  const uncommented = stripDynamicScrubLoops(stripJsComments(body));
  const stripped = uncommented.includes(pattern)
    ? stripNamedScrubLists(uncommented, pattern, bindingUsedElsewhere)
    : uncommented;
  if (!stripped.includes(pattern)) return false;
  return stripped
    .split('\n')
    .some(
      (line) => line.includes(pattern) && stripScrubConstructs(line, pattern).includes(pattern),
    );
}

const AUDIT_PATTERNS = ['OPENAI_API_KEY', 'GROQ_API_KEY', 'api.openai.com', 'api.groq.com'];
const AUDIT_EXCLUSIONS = [
  'node_modules',
  '.git',
  'dist',
  '__tests__',
  '.test.',
  '.spec.',
  'manual-briefing-v3.js', // briefing uses Claude CLI subprocess, not direct API
  'health-self-heal.js', // the healer itself
  'lib/api-audit.js', // the audit core (holds the pattern constants)
  'pre-briefing-diagnostic.js',
];

// Walks src/ and scripts/ under `root` and returns every file that genuinely
// uses a paid-provider pattern and is not in `allowlist` (the exemptions map,
// repo-relative path -> justification). Exclusions match the root-relative
// path so the checkout location never excludes the whole tree.
function findPaidApiHits({ root, allowlist = {} } = {}) {
  const codeFiles = [];
  function walkCode(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (AUDIT_EXCLUSIONS.some((ex) => rel.includes(ex))) continue;
      if (entry.isDirectory()) {
        walkCode(full);
      } else if (/\.(ts|js)$/.test(entry.name)) {
        codeFiles.push(full);
      }
    }
  }
  walkCode(path.join(root, 'src'));
  walkCode(path.join(root, 'scripts'));
  const allowedFiles = new Set(Object.keys(allowlist).map((p) => p.replace(/\\/g, '/')));
  const hits = [];
  for (const file of codeFiles) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (allowedFiles.has(rel)) continue;
    let body = '';
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch {
      /* ignore unreadable source file */
      continue;
    }
    const externalBindings = new Map();
    const bindingUsedElsewhere = (binding) => {
      if (!externalBindings.has(binding)) {
        externalBindings.set(binding, codeFiles.some((other) => {
          if (other === file) return false;
          try { return stripJsComments(fs.readFileSync(other, 'utf8')).includes(binding); }
          catch { return true; }
        }));
      }
      return externalBindings.get(binding);
    };
    for (const pattern of AUDIT_PATTERNS) {
      if (apiPatternIsUsed(body, pattern, bindingUsedElsewhere)) {
        hits.push({ file: rel, pattern });
      }
    }
  }
  return { hits, allowedFiles };
}

function readAllowlistFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!parsed || typeof parsed.exemptions !== 'object' || parsed.exemptions === null) {
    throw new Error('missing "exemptions" object');
  }
  return parsed.exemptions;
}

// Land-gate entry point. The tracked allowlist (config/api-audit-allowlist.json,
// the file a land can change) is REQUIRED; the runtime allowlist is merged in
// when present, and a runtime file that exists but cannot be parsed is an
// error too. Any read failure fails closed: ok=false with a message, never a
// silent pass and never a silent audit-everything.
function landGateApiAudit({ root, trackedFile, runtimeFile } = {}) {
  const tracked = trackedFile || path.join(root, 'config', 'api-audit-allowlist.json');
  let allowlist = {};
  try {
    allowlist = { ...readAllowlistFile(tracked) };
  } catch (err) {
    return { ok: false, hits: [], error: `paid-API allowlist unreadable (${tracked}): ${String(err && err.message).slice(0, 160)}` };
  }
  if (runtimeFile && fs.existsSync(runtimeFile)) {
    try {
      allowlist = { ...readAllowlistFile(runtimeFile), ...allowlist };
    } catch (err) {
      return { ok: false, hits: [], error: `paid-API runtime allowlist unreadable (${runtimeFile}): ${String(err && err.message).slice(0, 160)}` };
    }
  }
  const { hits } = findPaidApiHits({ root, allowlist });
  return { ok: hits.length === 0, hits, error: null };
}

function formatApiAuditViolation(result) {
  if (result.error) return `paid-API audit gate blocked the land: ${result.error}. Fix the allowlist file, then re-run.`;
  return (
    'paid-API audit gate blocked the land: new paid-provider reference(s): ' +
    result.hits.map((h) => `${h.file} (${h.pattern})`).join(', ') +
    '. Either migrate to the Claude Max plan, or add a named exemption with a one-line justification to ' +
    'config/api-audit-allowlist.json (then run node scripts/api-audit-allowlist-parity.js --write).'
  );
}

module.exports = {
  AUDIT_PATTERNS,
  AUDIT_EXCLUSIONS,
  stripJsComments,
  stripScrubConstructs,
  stripDynamicScrubLoops,
  stripNamedScrubLists,
  apiPatternIsUsed,
  findPaidApiHits,
  landGateApiAudit,
  formatApiAuditViolation,
};
