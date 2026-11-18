#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isActiveMemoryContent } = require('./memory-active-filter.js');

const REPO = path.resolve(__dirname, '..', '..');

function normalizeRel(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.startsWith('memory/') || normalized.startsWith('memory/archive/')) {
    throw new Error(`memory lifecycle target is outside active memory: ${relPath}`);
  }
  if (normalized.includes('../')) throw new Error(`memory lifecycle target escapes repo: ${relPath}`);
  return normalized;
}

function parseFrontmatter(raw) {
  const match = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error('memory file has no frontmatter');
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const scalar = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (scalar) values[scalar[1]] = scalar[2];
    const nestedType = line.match(/^\s+type:\s*(.*?)\s*$/);
    if (!values.type && nestedType) values.type = nestedType[1];
  }
  for (const required of ['name', 'description', 'type']) {
    if (!values[required]) throw new Error(`memory file is missing ${required}`);
  }
  return { values, body: match[2] };
}

function scalar(value) {
  const text = String(value || '').trim();
  if (/^[A-Za-z0-9_./ -]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function appendDecision(repoRoot, row) {
  const file = path.join(repoRoot, 'data', 'agent', 'big-decisions.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

function archiveAndStub(opts = {}) {
  const repoRoot = path.resolve(opts.repoRoot || REPO);
  const relPath = normalizeRel(opts.relPath);
  const targets = (opts.canonicalTargets || []).map((target) => String(target).replace(/\\/g, '/'));
  if (!targets.length) throw new Error(`no canonical target supplied for ${relPath}`);
  const source = path.resolve(repoRoot, relPath);
  if (!source.startsWith(`${repoRoot}${path.sep}`)) throw new Error(`target escapes repo: ${relPath}`);
  const raw = fs.readFileSync(source, 'utf8');
  if (!isActiveMemoryContent(raw)) return { skipped: true, relPath };
  const { values } = parseFrontmatter(raw);
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const nowIso = opts.nowIso || new Date().toISOString();
  const archiveRel = `memory/archive/${date}_${path.basename(relPath)}`;
  const archive = path.resolve(repoRoot, archiveRel);
  if (!archive.startsWith(`${path.resolve(repoRoot, 'memory', 'archive')}${path.sep}`)) {
    throw new Error(`archive target escapes memory/archive: ${archiveRel}`);
  }
  if (fs.existsSync(archive)) throw new Error(`archive target already exists: ${archiveRel}`);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.copyFileSync(source, archive, fs.constants.COPYFILE_EXCL);

  const targetScalar = targets.join(', ');
  const links = targets.map((target) => `[[${target.replace(/\.md$/i, '')}]]`).join(', ');
  const stub = [
    '---',
    `name: ${values.name}`,
    `description: ${values.description}`,
    `type: ${values.type}`,
    'status: superseded',
    `superseded_by: ${scalar(targetScalar)}`,
    `superseded_date: ${date}`,
    'stub: true',
    '---',
    '',
    `> SUPERSEDED. Canonical: ${links}. Full historical body preserved at ${archiveRel}.`,
    '',
  ].join('\n');
  fs.writeFileSync(source, stub);

  appendDecision(repoRoot, {
    ts: nowIso,
    date,
    decidedBy: 'memory-consolidation',
    category: 'memory-supersession',
    decision: opts.reason || `Retired ${relPath} into its current canonical source.`,
    superseded: relPath,
    canonical: targetScalar,
    archive: archiveRel,
  });
  return { relPath, archive: archiveRel, canonicalTargets: targets, skipped: false };
}

function repairAbsorbedPointers(opts = {}) {
  const repoRoot = path.resolve(opts.repoRoot || REPO);
  const memoryDir = path.join(repoRoot, 'memory');
  const entries = fs.readdirSync(memoryDir, { withFileTypes: true });
  const actions = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const relPath = `memory/${entry.name}`;
    const raw = fs.readFileSync(path.join(memoryDir, entry.name), 'utf8');
    if (!isActiveMemoryContent(raw)) continue;
    if (!/this file is a pointer, not an authority/i.test(raw)) continue;
    actions.push(
      archiveAndStub({
        repoRoot,
        relPath,
        canonicalTargets: ['dev-plans/core/briefing.md'],
        date: opts.date,
        nowIso: opts.nowIso,
        reason:
          'The briefing method had already been absorbed into the briefing core document, but the pointer was still active and polluting retrieval.',
      }),
    );
  }
  return actions;
}

function mergeMemoryIntoCanonical(opts = {}) {
  const repoRoot = path.resolve(opts.repoRoot || REPO);
  const sourceRelPath = normalizeRel(opts.sourceRelPath);
  const targetRelPath = normalizeRel(opts.targetRelPath);
  if (sourceRelPath === targetRelPath) throw new Error('source and target must differ');
  const sourcePath = path.resolve(repoRoot, sourceRelPath);
  const targetPath = path.resolve(repoRoot, targetRelPath);
  const sourceRaw = fs.readFileSync(sourcePath, 'utf8');
  const targetRaw = fs.readFileSync(targetPath, 'utf8');
  if (!isActiveMemoryContent(sourceRaw)) return { skipped: true, relPath: sourceRelPath };
  if (!isActiveMemoryContent(targetRaw)) throw new Error(`canonical target is inactive: ${targetRelPath}`);
  const marker = `<!-- memory-consolidation-merge:${sourceRelPath} -->`;
  if (targetRaw.includes(marker)) throw new Error(`canonical target already contains ${sourceRelPath}`);
  const { body: sourceBody } = parseFrontmatter(sourceRaw);
  const normalizedBody = sourceBody
    .trim()
    .replace(/^### /gm, '#### ')
    .replace(/^## /gm, '### ')
    .replace(/^# /gm, '### ');
  const mergedBlock = [
    marker,
    `## Curated context merged from ${path.basename(sourceRelPath)}`,
    '',
    normalizedBody,
    '',
  ].join('\n');
  const insertBefore = String(opts.insertBefore || '<!-- otter-speaker-intelligence:start -->');
  const at = targetRaw.indexOf(insertBefore);
  const merged = at >= 0
    ? `${targetRaw.slice(0, at).trimEnd()}\n\n${mergedBlock}${targetRaw.slice(at)}`
    : `${targetRaw.trimEnd()}\n\n${mergedBlock}`;
  fs.writeFileSync(targetPath, merged);
  return archiveAndStub({
    repoRoot,
    relPath: sourceRelPath,
    canonicalTargets: [targetRelPath],
    date: opts.date,
    nowIso: opts.nowIso,
    reason: opts.reason || `Merged ${sourceRelPath} into ${targetRelPath} after identity proof.`,
  });
}

module.exports = { archiveAndStub, mergeMemoryIntoCanonical, repairAbsorbedPointers };

if (require.main === module) {
  const actions = repairAbsorbedPointers();
  process.stdout.write(`memory-lifecycle-repair: ${actions.length} absorbed pointer(s) retired\n`);
}
