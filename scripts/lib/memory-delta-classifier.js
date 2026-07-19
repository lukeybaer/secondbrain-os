'use strict';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function memoryPointerKey(line) {
  const text = String(line || '').trim();
  const bold = text.match(/\*\*([^*]+)\*\*/);
  if (bold) return `label:${bold[1].trim().toLowerCase().replace(/\s+/g, ' ')}`;
  const target = text.match(/\s(?:->|â†’|→)\s*`?([^`,\s]+\.md)`?/i);
  if (target) return `target:${target[1].trim().toLowerCase()}`;
  return '';
}

function diffContentLine(raw) {
  const line = String(raw || '');
  if (line.startsWith('+++') || line.startsWith('---')) return null;
  const kind = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'deleted' : null;
  if (!kind) return null;
  const text = line.slice(1).trim();
  if (!text || text === '---' || /^##\s/.test(text)) return null;
  return { kind, text };
}

function classifyMemoryLines(addedInput = [], deletedInput = [], options = {}) {
  const include =
    typeof options.shouldIncludeLine === 'function' ? options.shouldIncludeLine : () => true;
  const added = addedInput.map(String).filter((line) => line.trim() && include(line));
  const deleted = deletedInput.map(String).filter((line) => line.trim() && include(line));
  const additionsByKey = new Map();

  added.forEach((line, index) => {
    const key = memoryPointerKey(line);
    if (!key) return;
    if (!additionsByKey.has(key)) additionsByKey.set(key, []);
    additionsByKey.get(key).push(index);
  });

  const consumedAdds = new Set();
  const consumedDeletes = new Set();
  const updatedLines = [];
  deleted.forEach((before, deleteIndex) => {
    const key = memoryPointerKey(before);
    const candidates = key ? additionsByKey.get(key) || [] : [];
    const addIndex = candidates.find((index) => !consumedAdds.has(index));
    if (addIndex == null) return;
    consumedAdds.add(addIndex);
    consumedDeletes.add(deleteIndex);
    updatedLines.push({ before, after: added[addIndex] });
  });

  return {
    updatedLines,
    addedLines: added.filter((_, index) => !consumedAdds.has(index)),
    deletedLines: deleted.filter((_, index) => !consumedDeletes.has(index)),
  };
}

function classifyMemoryPatch(diff, options = {}) {
  const added = [];
  const deleted = [];
  for (const raw of String(diff || '').split(/\r?\n/)) {
    const parsed = diffContentLine(raw);
    if (!parsed) continue;
    if (parsed.kind === 'added') added.push(parsed.text);
    else deleted.push(parsed.text);
  }
  return classifyMemoryLines(added, deleted, options);
}

function memoryPatchForWindow(runGit, since) {
  const commits = String(
    runGit(['log', '--reverse', `--since=${since}`, '--format=%H', '--', 'memory/MEMORY.md']) || '',
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (commits.length === 0) return '';
  const parent = String(runGit(['rev-parse', `${commits[0]}^`]) || '').trim();
  const base = /^[0-9a-f]{40}$/i.test(parent) ? parent : EMPTY_TREE;
  return runGit([
    'diff',
    '--no-color',
    '--unified=0',
    base,
    'HEAD',
    '--',
    'memory/MEMORY.md',
  ]) || '';
}

function mergeMemoryChangeClassification(change = {}) {
  const legacy = classifyMemoryLines(change.addedLines || [], change.deletedLines || []);
  const explicitUpdates = Array.isArray(change.updatedLines) ? change.updatedLines : [];
  return {
    updatedLines: [...explicitUpdates, ...legacy.updatedLines],
    addedLines: legacy.addedLines,
    deletedLines: legacy.deletedLines,
  };
}

module.exports = {
  classifyMemoryLines,
  classifyMemoryPatch,
  memoryPatchForWindow,
  memoryPointerKey,
  mergeMemoryChangeClassification,
};
