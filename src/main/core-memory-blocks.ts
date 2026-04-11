// core-memory-blocks.ts
//
// Letta/MemGPT inspired structured "core memory" blocks. The existing
// memory-index.ts handles Tier 2 topic files; this module gives Amy a
// small set of *always-loaded* named blocks (persona, human, scratchpad)
// with a fixed byte budget so the working context stays predictable.
//
// Unlike Tier 2, core blocks:
//   - have a name, a content string, and a hard byte limit
//   - are edited atomically with typed functions
//   - are serialised as simple markdown files under memory/core-blocks/
//
// This is a pure module — callers pass the block directory explicitly so
// tests can use a tmp dir without touching Electron's userData path.

import * as fs from 'fs';
import * as path from 'path';

export interface CoreBlock {
  name: string;
  content: string;
  limit: number;
  updated_at: string;
}

export const DEFAULT_BLOCK_LIMIT = 2000;

const SAFE_NAME = /^[a-z0-9_-]+$/i;

function blockFile(dir: string, name: string): string {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`invalid core block name: ${name}`);
  }
  return path.join(dir, `${name}.md`);
}

export function readBlock(dir: string, name: string): CoreBlock | null {
  const file = blockFile(dir, name);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  // Frontmatter format: --- \n limit: N \n updated_at: ISO \n --- \n body
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return {
      name,
      content: raw,
      limit: DEFAULT_BLOCK_LIMIT,
      updated_at: new Date(0).toISOString(),
    };
  }
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return {
    name,
    content: match[2],
    limit: Number(meta.limit) || DEFAULT_BLOCK_LIMIT,
    updated_at: meta.updated_at || new Date(0).toISOString(),
  };
}

export function writeBlock(
  dir: string,
  name: string,
  content: string,
  limit: number = DEFAULT_BLOCK_LIMIT,
): CoreBlock {
  if (content.length > limit) {
    throw new Error(`core block "${name}" exceeds limit: ${content.length} > ${limit}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const block: CoreBlock = {
    name,
    content,
    limit,
    updated_at: new Date().toISOString(),
  };
  const body = `---\nlimit: ${limit}\nupdated_at: ${block.updated_at}\n---\n${content}`;
  fs.writeFileSync(blockFile(dir, name), body);
  return block;
}

export function appendBlock(dir: string, name: string, line: string): CoreBlock {
  const existing = readBlock(dir, name);
  const next = existing ? existing.content.replace(/\s+$/, '') + '\n' + line : line;
  const limit = existing?.limit ?? DEFAULT_BLOCK_LIMIT;
  return writeBlock(dir, name, next, limit);
}

export function listBlocks(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}
