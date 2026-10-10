'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildCodexAmyPrelude } = require('./codex-amy-prelude');
const { buildScopedExecutionContext, executionPhaseMetadata } = require('./briefing-model-context');

const AUTHORITY_SOURCES = Object.freeze([
  'memory/MEMORY.md', 'memory/AMY.md', 'memory/AMY_AUTHORIZATIONS.md',
  'memory/AMY_GRAVITY.md', 'memory/AMY_REQUIREMENTS.md',
  'memory/reference_operator_identity.json',
]);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function text(value, label, allowEmptyArray = false) {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value) && (allowEmptyArray || value.length) && value.every((v) => typeof v === 'string' && v.trim())) return [...value];
  throw new Error(`${label} requires text or an array of text`);
}

function noTranscript(value, label) {
  object(value, label);
  for (const [key, entry] of Object.entries(value)) {
    if (['transcript', 'history', 'messages', 'conversation', 'conversationHistory'].includes(key)) {
      throw new Error(`${label}.${key} is transcript replay; use a checkpoint and exact source paths`);
    }
    if (entry && typeof entry === 'object') {
      if (Array.isArray(entry)) entry.forEach((item, index) => { if (item && typeof item === 'object') noTranscript(item, `${label}.${key}[${index}]`); });
      else noTranscript(entry, `${label}.${key}`);
    }
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function readSource(repoRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.posix.isAbsolute(relativePath) ||
      path.win32.isAbsolute(relativePath) || relativePath.includes(':') || relativePath.includes('\0')) {
    throw new Error('source path must be a repository-relative file');
  }
  const normalized = relativePath.replace(/\\/g, '/');
  const file = path.resolve(repoRoot, normalized);
  if (!inside(repoRoot, file)) throw new Error(`source path escapes repository: ${relativePath}`);
  let resolved;
  try { resolved = fs.realpathSync(file); } catch { throw new Error(`required source missing: ${relativePath}`); }
  if (!inside(repoRoot, resolved)) throw new Error(`source symlink escapes repository: ${relativePath}`);
  if (!fs.statSync(resolved).isFile()) throw new Error(`required source is not a file: ${relativePath}`);
  const bytes = fs.readFileSync(resolved);
  return { path: normalized, absolutePath: resolved, sha256: sha256(bytes), bytes: bytes.length, content: bytes.toString('utf8') };
}

// An exact Markdown heading selects its entire subtree, including child headings.
// Missing or ambiguous headings fail instead of dropping a required rule.
function selectSections(content, headings, sourcePath) {
  if (headings === undefined) return content;
  if (!Array.isArray(headings) || !headings.length || headings.some((h) => typeof h !== 'string' || !/^#{1,6} /.test(h))) {
    throw new Error(`sections for ${sourcePath} require exact Markdown headings`);
  }
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let fence = null;
  const headingAt = lines.map((line) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return null;
    }
    return fence ? null : line.match(/^(#{1,6})\s+.+/);
  });
  const ranges = headings.map((heading) => {
    const matches = lines.flatMap((line, index) => headingAt[index] && line.trim() === heading.trim() ? [index] : []);
    if (matches.length !== 1) throw new Error(`required section missing or ambiguous in ${sourcePath}: ${heading}`);
    const start = matches[0];
    const level = headingAt[start][1].length;
    let end = start + 1;
    while (end < lines.length && (!headingAt[end] || headingAt[end][1].length > level)) end += 1;
    return { start, end };
  });
  // Deduplicate overlapping selections without truncating a subtree.
  return lines.filter((_, index) => ranges.some(({ start, end }) => index >= start && index < end)).join('\n');
}

function validatePhaseCheckpoint(checkpoint, { unitId, objective, requirements, scope, acceptance } = {}) {
  if (checkpoint == null) return null;
  noTranscript(checkpoint, 'priorCheckpoint');
  if (checkpoint.unitId !== unitId) throw new Error('prior checkpoint belongs to a different unit');
  const result = clone(checkpoint);
  if (!Object.hasOwn(result, 'unfinishedWork') && Object.hasOwn(result, 'remainingWork')) result.unfinishedWork = result.remainingWork;
  // An operation receipt can inherit immutable unit context from the plan; it may
  // never replace or omit that context in the generated continuation packet.
  result.objective = text(result.objective === undefined ? objective : result.objective, 'checkpoint objective');
  result.requirements = text(result.requirements === undefined ? requirements : result.requirements, 'checkpoint requirements');
  for (const [field, fallback] of Object.entries({ scope, acceptance })) {
    if (result[field] !== undefined || fallback !== undefined) result[field] = text(result[field] === undefined ? fallback : result[field], `checkpoint ${field}`);
  }
  for (const field of ['decisions', 'evidence', 'unfinishedWork']) result[field] = text(result[field], `checkpoint ${field}`, true);
  result.nextAction = text(result.nextAction, 'checkpoint nextAction');
  if (JSON.stringify(result.objective) !== JSON.stringify(objective)) throw new Error('prior checkpoint objective differs from this unit objective');
  return result;
}

/** Build once at phase admission. Callers persist this exact packet/manifest;
 * retries compare inputIdentity and never silently regenerate instructions.
 * Sources default to references; requirementSources inline complete selected rules.
 */
function buildExecutionPhasePacket({ plan, phase, priorCheckpoint, repoRoot } = {}) {
  noTranscript(plan, 'plan');
  if (!repoRoot || !path.isAbsolute(repoRoot)) throw new Error('phase packet requires an absolute repoRoot');
  const root = fs.realpathSync(repoRoot);
  let selected = phase;
  if (typeof phase === 'string') {
    if (Array.isArray(plan.phases)) {
      const exact = plan.phases.filter((item) => item.id === phase || item.name === phase);
      const matches = exact.length ? exact : plan.phases.filter((item) => item.phase === phase);
      if (matches.length > 1) throw new Error(`ambiguous phase in plan: ${phase}; select its unique id`);
      selected = matches[0];
    } else selected = plan.phases && plan.phases[phase];
    if (!selected) throw new Error(`phase not found in plan: ${phase}`);
  }
  noTranscript(selected, 'phase');
  const phaseName = selected.phase || selected.name || (typeof phase === 'string' ? phase : undefined);
  const unitId = text(plan.unitId, 'unitId');
  if (typeof unitId !== 'string') throw new Error('unitId requires text');
  const packet = { unitId, phase: phaseName, complexity: selected.complexity || plan.complexity || 'routine',
    complexityReason: selected.complexityReason || plan.complexityReason || '' };
  for (const field of ['objective', 'scope', 'acceptance']) packet[field] = text(selected[field] === undefined ? plan[field] : selected[field], field);
  // Phase requirements and evidence add to the unit's immutable constraints.
  const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
  packet.requirements = text([...list(plan.requirements), ...list(selected.requirements)], 'requirements');
  packet.currentEvidence = [...list(plan.currentEvidence), ...list(selected.currentEvidence)];
  if (plan.nonGoals !== undefined || selected.nonGoals !== undefined) packet.nonGoals = text([...list(plan.nonGoals), ...list(selected.nonGoals)], 'nonGoals');
  executionPhaseMetadata(packet);
  packet.priorCheckpoint = validatePhaseCheckpoint(priorCheckpoint, packet);
  const sourceManifest = [];
  const sourceCache = new Map();
  const source = (sourcePath) => {
    if (!sourceCache.has(sourcePath)) sourceCache.set(sourcePath, readSource(root, sourcePath));
    return sourceCache.get(sourcePath);
  };
  const register = (entry, kind, sections, selectedContent) => {
    const { content, ...manifest } = entry;
    sourceManifest.push({ ...manifest, kind, ...(sections ? { sections } : {}),
      ...(selectedContent !== undefined ? { selectedSha256: sha256(selectedContent) } : {}) });
  };
  for (const sourcePath of AUTHORITY_SOURCES) register(source(sourcePath), 'canonical-authority');
  const selections = (field, kind) => {
    const entries = [...list(plan[field]), ...list(selected[field])];
    const seen = new Set();
    for (const input of entries) {
      const spec = typeof input === 'string' ? { path: input } : input;
      object(spec, field);
      const selectionKey = JSON.stringify(spec);
      if (seen.has(selectionKey)) continue;
      seen.add(selectionKey);
      const entry = source(spec.path);
      const selectedContent = selectSections(entry.content, spec.sections, entry.path);
      if (spec.sha256 !== undefined && spec.sha256 !== entry.sha256) throw new Error(`source identity changed: ${entry.path}`);
      register(entry, kind, spec.sections, selectedContent);
      const reference = `${entry.path} (SHA-256 ${entry.sha256}; full source ${entry.absolutePath})`;
      if (kind === 'requirement') packet.requirements.push(`SOURCE ${reference}\n${selectedContent}`);
      else packet.currentEvidence.push(`SOURCE ${reference}${spec.inline === true ? `\n${selectedContent}` : '; retrieve the full required source before relying on it.'}`);
    }
  };
  selections('requirementSources', 'requirement');
  selections('sources', 'evidence');
  packet.currentEvidence = text(packet.currentEvidence, 'currentEvidence');
  // Stable prefix is independent of phase and evidence. The full Gravity source
  // remains a required, hashed canonical source for task-specific demand loading.
  const prelude = buildCodexAmyPrelude({ repoRoot: root });
  const sourceIdentity = sourceManifest.map(({ absolutePath, ...entry }) => entry);
  const inputIdentity = sha256(JSON.stringify({ schemaVersion: 1, packet, sourceManifest: sourceIdentity, preludeSha256: sha256(prelude) }));
  packet.sourceManifest = sourceManifest;
  packet.inputIdentity = inputIdentity;
  const context = buildScopedExecutionContext(packet);
  const prompt = `${prelude}\n\n=== TASK PROMPT ===\n${context.prompt}`;
  return { packet, context, prelude, prompt, sourceManifest, inputIdentity };
}

module.exports = { AUTHORITY_SOURCES, buildExecutionPhasePacket, validatePhaseCheckpoint, selectSections };
