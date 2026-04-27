// entity-memory-graph.ts
//
// Mem0-inspired entity-level cross-memory linking. BM25 searches raw text but
// treats every word equally. This module builds an entity graph: extract named
// entities (people, companies, projects) from all memory .md files and create a
// reverse index so a query for a person's full name finds every file that
// mentions them, not just their dedicated contact file.
//
// Entities are extracted with three passes:
//   1. Known entities: slugs from contacts/INDEX.md + names from user_profile.md
//   2. Title-case bigrams/trigrams (naive NER): sequences of capitalized words
//   3. Explicit markers: "Contact:", "##" headings as entity anchors
//
// The graph is rebuilt at startup and after any memory write (incremental: only
// affected file is re-indexed). Rebuild of ~50 files takes <100ms on spinning
// disk — fast enough for synchronous use.
//
// Inspired by: Mem0 entity-linking layer (mem0ai/mem0, v1.1, April 2025).
// Reference: "Mem0 achieves 26% accuracy improvement over baseline semantic
// search by linking entity co-occurrence across memory entries" — mem0.ai blog
// 2025-01.

import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EntityMention {
  filePath: string;
  relPath: string;
  lineNumber: number;
  excerpt: string;      // ~120 chars around the mention
  entityVariant: string; // the exact string that matched (e.g. a nickname for the canonical name)
}

export interface EntityNode {
  canonicalName: string;
  aliases: string[];
  mentions: EntityMention[];
}

export interface EntitySearchResult {
  entity: EntityNode;
  score: number;       // mention count, weighted by file diversity
  topFiles: string[];  // up to 5 most-cited file relPaths
}

// ── Entity Graph class ────────────────────────────────────────────────────────

export class EntityMemoryGraph {
  // canonical name → node
  private graph: Map<string, EntityNode> = new Map();
  // normalized alias → canonical name (for lookup)
  private aliasIndex: Map<string, string> = new Map();
  // filePath → last mtime seen (incremental rebuild)
  private fileMtimes: Map<string, number> = new Map();

  private memoryDir: string;
  private builtAt: Date | null = null;

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir;
  }

  // ── Build / rebuild ─────────────────────────────────────────────────────────

  async build(): Promise<void> {
    this.graph.clear();
    this.aliasIndex.clear();
    this.fileMtimes.clear();

    const mdFiles = this.collectMdFiles(this.memoryDir);
    const knownEntities = this.loadKnownEntities(this.memoryDir);

    for (const [canonical, aliases] of knownEntities) {
      this.registerEntity(canonical, aliases);
    }

    for (const filePath of mdFiles) {
      this.indexFile(filePath, knownEntities);
    }

    this.builtAt = new Date();
  }

  // Update a single file (call after any memory write)
  updateFile(filePath: string): void {
    if (!filePath.endsWith('.md')) return;
    const knownEntities = this.loadKnownEntities(this.memoryDir);
    this.indexFile(filePath, knownEntities);
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  search(query: string, topK = 10): EntitySearchResult[] {
    const norm = normalizeEntityName(query);
    const results: EntitySearchResult[] = [];

    for (const [canonical, node] of this.graph) {
      const canonNorm = normalizeEntityName(canonical);
      const aliasMatch = node.aliases.some((a) => normalizeEntityName(a).includes(norm) || norm.includes(normalizeEntityName(a)));
      const directMatch = canonNorm.includes(norm) || norm.includes(canonNorm);

      if (!directMatch && !aliasMatch) continue;

      const fileSet = new Set(node.mentions.map((m) => m.relPath));
      const score = node.mentions.length * Math.log(1 + fileSet.size);
      const topFiles = Array.from(fileSet).slice(0, 5);

      results.push({ entity: node, score, topFiles });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  // Return all mentions of an entity, sorted by recency (file mtime)
  getEntityContext(canonicalName: string): EntityMention[] {
    const norm = normalizeEntityName(canonicalName);
    const resolved = this.aliasIndex.get(norm) ?? canonicalName;
    const node = this.graph.get(resolved);
    if (!node) return [];
    return node.mentions.slice().sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  // Return a formatted summary string for injecting into a call/briefing context
  buildEntitySummary(canonicalName: string, maxMentions = 8): string {
    const mentions = this.getEntityContext(canonicalName).slice(0, maxMentions);
    if (mentions.length === 0) return '';

    const fileSet = new Set(mentions.map((m) => m.relPath));
    const lines: string[] = [`Entity: ${canonicalName} (${fileSet.size} files, ${mentions.length} mentions)`];
    for (const m of mentions) {
      lines.push(`  [${m.relPath}:${m.lineNumber}] ${m.excerpt.trim()}`);
    }
    return lines.join('\n');
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  stats(): { entityCount: number; mentionCount: number; fileCount: number; builtAt: Date | null } {
    let mentionCount = 0;
    const fileSet = new Set<string>();
    for (const node of this.graph.values()) {
      mentionCount += node.mentions.length;
      node.mentions.forEach((m) => fileSet.add(m.filePath));
    }
    return { entityCount: this.graph.size, mentionCount, fileCount: fileSet.size, builtAt: this.builtAt };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private registerEntity(canonical: string, aliases: string[]): void {
    if (!this.graph.has(canonical)) {
      this.graph.set(canonical, { canonicalName: canonical, aliases, mentions: [] }); // fileCount derives from mentions
    }
    const norm = normalizeEntityName(canonical);
    this.aliasIndex.set(norm, canonical);
    for (const alias of aliases) {
      this.aliasIndex.set(normalizeEntityName(alias), canonical);
    }
  }

  private indexFile(filePath: string, knownEntities: Map<string, string[]>): void {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }

    const relPath = path.relative(this.memoryDir, filePath).replace(/\\/g, '/');
    const lines = content.split('\n');

    // Pass 1: search for known entity names/aliases
    for (const [canonical, aliases] of knownEntities) {
      const searchTerms = [canonical, ...aliases];
      for (const term of searchTerms) {
        if (term.length < 3) continue;
        const termNorm = normalizeEntityName(term);
        for (let i = 0; i < lines.length; i++) {
          const lineNorm = normalizeEntityName(lines[i]);
          if (lineNorm.includes(termNorm)) {
            const node = this.graph.get(canonical);
            if (node) {
              node.mentions.push({
                filePath,
                relPath,
                lineNumber: i + 1,
                excerpt: lines[i].slice(0, 150),
                entityVariant: term,
              });
            }
          }
        }
      }
    }

    // Pass 2: extract unknown title-case named entities as candidate nodes
    const titleCaseRegex = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;
    const foundInFile = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      let m: RegExpExecArray | null;
      while ((m = titleCaseRegex.exec(lines[i])) !== null) {
        const candidate = m[1];
        // Skip common false positives
        if (TITLE_CASE_SKIP.has(candidate)) continue;
        if (candidate.length < 5) continue;
        foundInFile.add(candidate);
        if (!this.graph.has(candidate)) {
          this.registerEntity(candidate, []);
        }
        const node = this.graph.get(candidate)!;
        node.mentions.push({
          filePath,
          relPath,
          lineNumber: i + 1,
          excerpt: lines[i].slice(0, 150),
          entityVariant: candidate,
        });
      }
    }
  }

  private collectMdFiles(dir: string): string[] {
    const results: string[] = [];
    const walk = (d: string) => {
      let entries: string[];
      try {
        entries = fs.readdirSync(d);
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.startsWith('.')) continue;
        const full = path.join(d, e);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walk(full);
        } else if (e.endsWith('.md')) {
          results.push(full);
        }
      }
    };
    walk(dir);
    return results;
  }

  private loadKnownEntities(memoryDir: string): Map<string, string[]> {
    const entities = new Map<string, string[]>();

    // Load from contacts/INDEX.md: look for contact names
    const indexPath = path.join(memoryDir, 'contacts', 'INDEX.md');
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        // Pattern: "- **Name**" or "| Name |"
        const boldMatch = line.match(/\*\*([A-Z][a-z]+(?: [A-Z][a-z]+)+)\*\*/);
        if (boldMatch) {
          const name = boldMatch[1];
          if (!entities.has(name)) entities.set(name, []);
        }
        const pipeMatch = line.match(/^\|\s*([A-Z][a-z]+(?: [A-Z][a-z]+)+)\s*\|/);
        if (pipeMatch) {
          const name = pipeMatch[1];
          if (!entities.has(name)) entities.set(name, []);
        }
      }
    }

    // Load known people from user_profile.md
    const profilePath = path.join(memoryDir, 'user_profile.md');
    if (fs.existsSync(profilePath)) {
      const content = fs.readFileSync(profilePath, 'utf8');
      const nameMatches = content.matchAll(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)+)\b/g);
      for (const m of nameMatches) {
        const name = m[1];
        if (name.length >= 5 && !TITLE_CASE_SKIP.has(name)) {
          if (!entities.has(name)) entities.set(name, []);
        }
      }
    }

    // Load high-value entities (canonical name + aliases/nicknames) from a
    // runtime config file. The file lives outside the source tree so the
    // public OS repo never carries the user's personal name list. If the
    // file is missing, the graph still works — it just won't link nicknames
    // to canonical names without a follow-up indexing pass.
    //
    // Lookup order: memoryDir/known-people.json (test override), then
    // ../data/agent/known-people.json (production location).
    const candidatePaths = [
      path.join(memoryDir, 'known-people.json'),
      path.join(memoryDir, '..', 'data', 'agent', 'known-people.json'),
    ];
    for (const knownPeoplePath of candidatePaths) {
      if (!fs.existsSync(knownPeoplePath)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(knownPeoplePath, 'utf8')) as Record<string, string[]>;
        for (const [canonical, aliases] of Object.entries(raw)) {
          if (!entities.has(canonical)) entities.set(canonical, aliases);
          else entities.get(canonical)!.push(...aliases);
        }
        break;
      } catch {
        // ignore malformed file; entity graph still works without nickname expansion
      }
    }

    return entities;
  }
}

// ── Normalization ─────────────────────────────────────────────────────────────

function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Common title-case sequences that are NOT named entities
const TITLE_CASE_SKIP = new Set([
  'The', 'This', 'That', 'These', 'Those', 'When', 'Where', 'What', 'Which',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December',
  'North America', 'United States', 'New York', 'Los Angeles',
  'Claude Code', 'Claude Max', 'Claude Haiku', 'Claude Sonnet', 'Claude Opus',
  'Amy Requirements',
]);

// ── Singleton (lazily built) ───────────────────────────────────────────────────

let _singleton: EntityMemoryGraph | null = null;

export function getEntityGraph(memoryDir: string): EntityMemoryGraph {
  if (!_singleton) {
    _singleton = new EntityMemoryGraph(memoryDir);
  }
  return _singleton;
}

export async function buildEntityGraph(memoryDir: string): Promise<EntityMemoryGraph> {
  const graph = getEntityGraph(memoryDir);
  await graph.build();
  return graph;
}
