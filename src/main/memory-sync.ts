// memory-sync.ts
// Unified memory synchronization — bridges Claude Code markdown files,
// Graphiti knowledge graph, and the EC2 backend into one canonical system.
//
// Canonical store: git-tracked markdown files (Claude Code memory dir + repo memory/).
// Graphiti: query/search layer on top — ingests markdown as episodes.
// EC2: pulls from git to stay in sync.
//
// Flow:
//   Claude Code writes markdown → git push → EC2 pulls → Graphiti indexes
//   Amy call learns fact → writes to markdown → git push → Graphiti indexes

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { addEpisode } from './graphiti-client';

// ── Path resolution ──────────────────────────────────────────────────────────

/** Claude Code session memory (the 169-file canonical store). */
function claudeMemoryDir(): string {
  return path.join(
    app.getPath('home'),
    '.claude',
    'projects',
    'C--Users-luked-secondbrain',
    'memory',
  );
}

/** Repo-local memory dir (subset synced into git for EC2). */
function repoMemoryDir(): string {
  const contentRoot =
    process.env.SECONDBRAIN_ROOT ??
    (app.isPackaged ? 'C:/Users/luked/secondbrain' : path.resolve(app.getAppPath()));
  return path.join(contentRoot, 'memory');
}

// ── Markdown parsing ─────────────────────────────────────────────────────────

interface MemoryFile {
  filePath: string;
  relativePath: string;
  name: string;
  description: string;
  type: string; // user, feedback, project, reference
  body: string;
  modifiedAt: Date;
}

function parseMemoryFile(filePath: string, relativePath: string): MemoryFile | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');

    // Parse YAML frontmatter
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) {
      // No frontmatter — treat as raw content (e.g., INDEX.md, MEMORY.md)
      return {
        filePath,
        relativePath,
        name: path.basename(filePath, '.md'),
        description: '',
        type: 'reference',
        body: raw.trim(),
        modifiedAt: fs.statSync(filePath).mtime,
      };
    }

    const frontmatter = fmMatch[1];
    const body = fmMatch[2].trim();

    const getName = (fm: string) => fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const getDesc = (fm: string) => fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const getType = (fm: string) => fm.match(/^type:\s*(.+)$/m)?.[1]?.trim() ?? 'reference';

    return {
      filePath,
      relativePath,
      name: getName(frontmatter),
      description: getDesc(frontmatter),
      type: getType(frontmatter),
      body,
      modifiedAt: fs.statSync(filePath).mtime,
    };
  } catch {
    return null;
  }
}

// ── File discovery ───────────────────────────────────────────────────────────

function discoverMemoryFiles(dir: string, prefix = ''): MemoryFile[] {
  const results: MemoryFile[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      // Recurse into subdirectories (contacts/, etc.)
      results.push(...discoverMemoryFiles(fullPath, relPath));
    } else if (entry.name.endsWith('.md') && entry.name !== 'MEMORY.md') {
      const parsed = parseMemoryFile(fullPath, relPath);
      if (parsed) results.push(parsed);
    }
  }

  return results;
}

// ── Graphiti ingestion ───────────────────────────────────────────────────────

/** Ingest a single memory file as a Graphiti episode. */
async function ingestMemoryFile(file: MemoryFile): Promise<boolean> {
  const episodeBody = [
    file.description ? `Description: ${file.description}` : '',
    file.body.slice(0, 3000), // Graphiti has content limits
  ]
    .filter(Boolean)
    .join('\n\n');

  return addEpisode({
    name: file.name || file.relativePath,
    episode_body: episodeBody,
    source_description: `memory-file:${file.relativePath}`,
    reference_time: file.modifiedAt.toISOString(),
    group_id: 'luke-ea',
  });
}

/**
 * Full seed — ingest ALL markdown files into Graphiti.
 * Run once to populate an empty graph, then use incrementalSync for updates.
 */
export async function fullGraphitiSeed(): Promise<{
  total: number;
  ingested: number;
  failed: number;
}> {
  const files = discoverMemoryFiles(claudeMemoryDir());
  console.log(`[memory-sync] Full seed: found ${files.length} memory files`);

  let ingested = 0;
  let failed = 0;

  for (const file of files) {
    const ok = await ingestMemoryFile(file);
    if (ok) {
      ingested++;
    } else {
      failed++;
    }

    // Rate-limit to avoid overwhelming Graphiti
    if (ingested % 10 === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(
    `[memory-sync] Seed complete — total:${files.length} ingested:${ingested} failed:${failed}`,
  );
  return { total: files.length, ingested, failed };
}

/**
 * Incremental sync — only ingest files modified since lastSyncTime.
 * Tracks sync state in a JSON file.
 */
export async function incrementalGraphitiSync(): Promise<{
  checked: number;
  ingested: number;
  failed: number;
}> {
  const stateFile = path.join(app.getPath('userData'), 'data', 'memory-sync-state.json');
  let lastSync = new Date(0);

  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    lastSync = new Date(state.lastSync);
  } catch {
    // No state file — first incremental run, treat as seed
  }

  const files = discoverMemoryFiles(claudeMemoryDir());
  const changed = files.filter((f) => f.modifiedAt > lastSync);

  let ingested = 0;
  let failed = 0;

  for (const file of changed) {
    const ok = await ingestMemoryFile(file);
    if (ok) ingested++;
    else failed++;
  }

  // Update sync state
  const dir = path.dirname(stateFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      lastSync: new Date().toISOString(),
      filesChecked: files.length,
      filesIngested: ingested,
    }),
  );

  if (changed.length > 0) {
    console.log(
      `[memory-sync] Incremental sync — checked:${files.length} changed:${changed.length} ingested:${ingested} failed:${failed}`,
    );
  }

  return { checked: files.length, ingested, failed };
}

// ── Unified memory reader (for prompt building) ─────────────────────────────

/**
 * Read all memory files and return structured content for system prompt injection.
 * This replaces the old EA_MEMORY.md flat file approach.
 */
export function readCanonicalMemory(opts?: { types?: string[]; maxChars?: number }): string {
  const types = opts?.types ?? ['user', 'feedback', 'project', 'reference'];
  const maxChars = opts?.maxChars ?? 4000;
  const files = discoverMemoryFiles(claudeMemoryDir());

  const filtered = files.filter((f) => types.includes(f.type));

  // Sort: user > feedback > project > reference
  const priority: Record<string, number> = { user: 0, feedback: 1, project: 2, reference: 3 };
  filtered.sort((a, b) => (priority[a.type] ?? 9) - (priority[b.type] ?? 9));

  const sections: string[] = [];
  let totalChars = 0;

  for (const file of filtered) {
    const section = `### ${file.name} (${file.type})\n${file.body.slice(0, 500)}`;
    if (totalChars + section.length > maxChars) break;
    sections.push(section);
    totalChars += section.length;
  }

  return sections.join('\n\n');
}

/**
 * Read a specific contact's memory file by name slug.
 */
export function readContactMemory(slug: string): MemoryFile | null {
  const contactDir = path.join(claudeMemoryDir(), 'contacts');
  const filePath = path.join(contactDir, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;
  return parseMemoryFile(filePath, `contacts/${slug}.md`);
}

/**
 * Search memory files by content (simple substring match).
 * For semantic search, use Graphiti's searchKnowledge instead.
 */
export function searchMemoryFiles(query: string, maxResults = 10): MemoryFile[] {
  const files = discoverMemoryFiles(claudeMemoryDir());
  const q = query.toLowerCase();

  return files
    .filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q) ||
        f.body.toLowerCase().includes(q),
    )
    .slice(0, maxResults);
}
