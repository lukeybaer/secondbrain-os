#!/usr/bin/env node
'use strict';
/**
 * generate-hook-catalog.js
 *
 * Task 10 (ExampleCo 2026-09-24, instruction-audit): writes
 * scripts/claude-hooks/HOOKS.md, one table row per hook registration in
 * scripts/claude-hooks/hook-boundary-manifest.json (both the `global` and
 * `project` scopes), so the catalog is DERIVED from the live manifest
 * instead of hand-maintained (scripts/claude-hooks/README.md's old "Files"
 * list drifted from the real registrations more than once -- see task 3's
 * retirements, which that hand list never caught).
 *
 * Each row: scope (global/project), event, matcher (blank = unconditional),
 * script (the basename actually invoked), and a one-line purpose taken from
 * the script's own header comment (the first substantive `//` or `#` line
 * after the shebang, with a leading "<basename> -- "/"<basename>:" echo
 * stripped). A command with no resolvable script file on disk (an inline
 * `node -e "..."` command, or a registration whose target does not exist in
 * this checkout) is marked accordingly rather than silently dropped, so the
 * catalog stays a complete audit trail of what actually runs.
 *
 * USAGE:  node scripts/generate-hook-catalog.js           (writes HOOKS.md)
 *         node scripts/generate-hook-catalog.js --check    (exit 1 if stale)
 *         npm run verify:hooks-catalog-drift (once wired; not added by this
 *         packet -- package.json is out of this task's declared scope)
 *
 * buildCatalogRows/renderCatalogMarkdown are exported pure (injectable
 * repoRoot) so the regression test (scripts/__tests__/generate-hook-catalog.test.js)
 * can both exercise the parsing logic directly and assert HOOKS.md matches
 * a fresh render of the real manifest (the staleness check).
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'claude-hooks', 'hook-boundary-manifest.json');
const OUTPUT_PATH = path.join(REPO_ROOT, 'scripts', 'claude-hooks', 'HOOKS.md');

const SCRIPT_TOKEN_RE = /([A-Za-z0-9._-]+\.(?:mjs|cjs|js|sh))\b/;

// Directories a bare script basename is resolved against, in order, so the
// catalog reads the REAL file in THIS checkout even though manifest commands
// reference the production sb-runtime/amy-code path or the ~/.claude/hooks/
// junction path, neither of which exists inside a worktree.
function candidatePaths(repoRoot, basename) {
  return [
    path.join(repoRoot, 'scripts', 'claude-hooks', basename),
    path.join(repoRoot, 'scripts', 'claude-hooks', 'lib', basename),
    path.join(repoRoot, 'scripts', basename),
    path.join(repoRoot, 'scripts', 'lib', basename),
  ];
}

/**
 * Resolve a manifest `command` string to {basename, absolutePath|null}.
 * absolutePath is null when the command names no recognizable script file
 * (an inline `node -e ...`) or the named file does not exist in this
 * checkout.
 */
function resolveScript(command, repoRoot) {
  const match = SCRIPT_TOKEN_RE.exec(String(command || ''));
  if (!match) return { basename: null, absolutePath: null };
  const basename = match[1];
  const found = candidatePaths(repoRoot, basename).find((p) => fs.existsSync(p));
  return { basename, absolutePath: found || null };
}

/**
 * The catalog's "purpose" column: the first substantive header-comment line
 * of a script, with a leading bare-filename echo stripped. Never throws;
 * missing/unreadable/uncommented files get an explicit placeholder so a
 * blank cell is never mistaken for "checked, nothing found".
 */
function purposeFromHeader(absolutePath, basename) {
  if (!absolutePath) return '(inline command, no separate script file)';
  let text;
  try {
    text = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return '(script unreadable)';
  }
  const escapedBase = String(basename || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bareNameRe = escapedBase
    ? new RegExp('^' + escapedBase + '\\b\\s*(?:\\(.*?\\))?\\s*(?:--|-|:)?\\s*')
    : null;
  const stripBareName = (raw) => {
    let content = raw.trim();
    if (bareNameRe && bareNameRe.test(content)) {
      content = content.replace(bareNameRe, '').trim();
    }
    return content;
  };
  const lines = text.split(/\r?\n/).slice(0, 60);
  let inBlockComment = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#!/.test(trimmed)) continue; // shebang
    if (/^["']use strict["'];?$/.test(trimmed)) continue; // 'use strict', pass through
    if (!trimmed) {
      if (inBlockComment) continue; // blank line INSIDE a /** */ block
      continue; // blank line before any comment started yet
    }
    if (inBlockComment) {
      if (/^\*\//.test(trimmed)) {
        inBlockComment = false;
        continue;
      }
      const content = stripBareName(trimmed.replace(/^\*\s?/, ''));
      if (content) return content.length > 160 ? content.slice(0, 157) + '...' : content;
      continue;
    }
    if (/^\/\*\*?/.test(trimmed)) {
      // Opening of a /** ... */ or /* ... */ block. Content may start on
      // this same line (e.g. "/** description */" or "/** description")
      // or on following lines.
      const closesOnSameLine = /\*\//.test(trimmed);
      const sameLine = trimmed.replace(/^\/\*\*?/, '').replace(/\*\/\s*$/, '').trim();
      const content = stripBareName(sameLine);
      if (content) return content.length > 160 ? content.slice(0, 157) + '...' : content;
      if (!closesOnSameLine) inBlockComment = true;
      continue;
    }
    const lineCommentMatch = trimmed.match(/^(?:\/\/|#)\s?(.*)$/);
    if (!lineCommentMatch) break; // real code: header block is over
    const content = stripBareName(lineCommentMatch[1]);
    if (!content) continue; // blank `//`/`#` line, keep scanning
    return content.length > 160 ? content.slice(0, 157) + '...' : content;
  }
  return '(no header comment)';
}

/**
 * One row per {scope, event, matcher, hook} in the manifest, in manifest
 * iteration order (global before project; events in the manifest's own key
 * order; matcher groups and hooks within a group in array order).
 */
function buildCatalogRows({ repoRoot = REPO_ROOT, manifestPath = MANIFEST_PATH } = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const rows = [];
  for (const scope of ['global', 'project']) {
    const events = manifest[scope] || {};
    for (const [event, groups] of Object.entries(events)) {
      for (const group of groups || []) {
        const matcher = group.matcher || '';
        for (const hook of group.hooks || []) {
          const command = hook.command || '';
          const { basename, absolutePath } = resolveScript(command, repoRoot);
          rows.push({
            scope,
            event,
            matcher,
            script: basename || '(inline command)',
            purpose: purposeFromHeader(absolutePath, basename),
          });
        }
      }
    }
  }
  return rows;
}

// CLAUDE.md global rule: no em dashes (or en dashes) in any output. Purpose
// text is quoted verbatim from each script's own header comment, which may
// predate that rule, so normalize on the way into the generated file rather
// than assume every source header already complies. Built from character
// codes, not literal dash glyphs in source, so this file never trips the
// same rule it enforces.
const DASH_CODEPOINTS = [0x2014, 0x2013];
function stripLongDashes(text) {
  let out = String(text ?? '');
  for (const code of DASH_CODEPOINTS) out = out.split(" " + String.fromCharCode(code) + " ").join(", ").split(String.fromCharCode(code)).join(",");
  return out;
}

function escapeCell(value) {
  const withoutDashes = stripLongDashes(String(value == null ? '' : value));
  const withoutPipes = withoutDashes.split('|').join('\\|');
  const noCR = withoutPipes.split('\r').join('');
  return noCR.split('\n').join(' ');
}

function renderCatalogMarkdown(rows) {
  const header = [
    '<!-- GENERATED FILE. Do not hand-edit. Run: node scripts/generate-hook-catalog.js -->',
    '<!-- Source of truth: scripts/claude-hooks/hook-boundary-manifest.json -->',
    '',
    '# Claude Hooks catalog',
    '',
    'One row per hook registration in `hook-boundary-manifest.json` (both the',
    '`global` and `project` scopes), expanded by `hook-boundary-dispatcher.mjs`',
    'at runtime. Regenerate after any manifest change:',
    '',
    '```',
    'node scripts/generate-hook-catalog.js',
    '```',
    '',
    '| Scope | Event | Matcher | Script | Purpose |',
    '| --- | --- | --- | --- | --- |',
  ];
  const body = rows.map(
    (r) =>
      `| ${escapeCell(r.scope)} | ${escapeCell(r.event)} | ${escapeCell(r.matcher) || '(any)'} | ${escapeCell(r.script)} | ${escapeCell(r.purpose)} |`,
  );
  return header.concat(body).join('\n') + '\n';
}

function currentCatalogMarkdown(opts) {
  return renderCatalogMarkdown(buildCatalogRows(opts));
}

function writeCatalog(opts) {
  const markdown = currentCatalogMarkdown(opts);
  fs.writeFileSync((opts && opts.outputPath) || OUTPUT_PATH, markdown);
  return markdown;
}

/** True when the on-disk HOOKS.md matches a fresh render (not stale). */
function catalogIsFresh(opts) {
  const outputPath = (opts && opts.outputPath) || OUTPUT_PATH;
  let onDisk;
  try {
    onDisk = fs.readFileSync(outputPath, 'utf8');
  } catch {
    return false;
  }
  return onDisk === currentCatalogMarkdown(opts);
}

module.exports = {
  REPO_ROOT,
  MANIFEST_PATH,
  OUTPUT_PATH,
  resolveScript,
  purposeFromHeader,
  buildCatalogRows,
  renderCatalogMarkdown,
  currentCatalogMarkdown,
  writeCatalog,
  catalogIsFresh,
};

if (require.main === module) {
  const checkOnly = process.argv.includes('--check');
  if (checkOnly) {
    const fresh = catalogIsFresh();
    if (!fresh) {
      process.stderr.write(
        'scripts/claude-hooks/HOOKS.md is stale. Run: node scripts/generate-hook-catalog.js\n',
      );
    }
    process.exitCode = fresh ? 0 : 1;
  } else {
    writeCatalog();
    // eslint-disable-next-line no-console
    console.log(`wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
  }
}
