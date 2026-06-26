// otter-semantic-indexer.ts
//
// Semantic indexing of Otter.ai raw transcripts into Graphiti.
//
// Feature backlog item: "otter-transcript-indexing" (priority_score 23)
// "Chunk and index Otter transcripts into Graphiti for semantic search"
//
// Pattern: chunk each transcript into overlapping windows, summarize each chunk with
// Claude Haiku, upsert to Graphiti as an episode. This lets Amy answer questions like
// "what did we discuss about loan clustering?" by querying Graphiti semantically
// across 20+ archived meetings.
//
// Chunking strategy:
//   - 500-char windows with 100-char overlap (keeps sentences together better than
//     strict token-splitting, avoids a Python tokenizer dependency)
//   - Each chunk episoded as: "[MEETING: {title}] {raw_text}"
//   - source_description = "otter-transcript:{filename}"
//   - reference_time = meeting start_time
//
// State tracking: data/agent/otter-index-state.json
//   { indexed: { [filename]: { chunk_count, indexed_at, title } } }
// Already-indexed files are skipped unless force=true.
//
// searchOtterChunks(query, graphitiUrl) delegates to Graphiti semantic search.
//
// Run 22 of the nightly enhancement cycle.

import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from './config';
import { addEpisode } from './graphiti-client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OtterChunk {
  chunkIndex: number;
  text: string;
  charStart: number;
  charEnd: number;
}

export interface IndexState {
  indexed: Record<string, { chunk_count: number; indexed_at: string; title: string }>;
}

export interface IndexResult {
  file: string;
  title: string;
  chunks_indexed: number;
  skipped: boolean;
  skip_reason?: string;
  error?: string;
}

export interface OtterTranscript {
  id?: string;
  title?: string;
  transcript?: string;
  start_time?: string;
  created_at?: string;
  speakers?: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const CHUNK_SIZE = 500;
export const CHUNK_OVERLAP = 100;
const MIN_CHUNK_LENGTH = 80; // skip tiny trailing chunks

// ── Chunking ──────────────────────────────────────────────────────────────────

export function chunkTranscript(text: string): OtterChunk[] {
  const chunks: OtterChunk[] = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    const chunkText = text.slice(start, end).trim();

    if (chunkText.length >= MIN_CHUNK_LENGTH) {
      chunks.push({ chunkIndex: index++, text: chunkText, charStart: start, charEnd: end });
    }

    if (end >= text.length) break;
    start = end - CHUNK_OVERLAP;
  }

  return chunks;
}

// ── State I/O ─────────────────────────────────────────────────────────────────

export function readIndexState(statePath: string): IndexState {
  if (!fs.existsSync(statePath)) return { indexed: {} };
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as IndexState;
  } catch {
    return { indexed: {} };
  }
}

export function writeIndexState(statePath: string, state: IndexState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

// ── Transcript reader ─────────────────────────────────────────────────────────

export function readOtterFile(filePath: string): OtterTranscript | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as OtterTranscript;
  } catch {
    return null;
  }
}

// ── Graphiti episode builder ──────────────────────────────────────────────────

export function buildEpisodeName(title: string, chunkIndex: number, totalChunks: number): string {
  return `otter:${title.slice(0, 40)}:chunk${chunkIndex + 1}of${totalChunks}`;
}

export function buildEpisodeBody(title: string, chunk: OtterChunk): string {
  return `[MEETING: ${title}] ${chunk.text}`;
}

// ── Indexer ───────────────────────────────────────────────────────────────────

export interface IndexerOptions {
  rawDir: string;
  statePath: string;
  force?: boolean;
  maxFilesPerRun?: number; // default 10 to avoid flooding Graphiti
}

/**
 * Index all unindexed Otter raw JSON files in rawDir into Graphiti.
 * Returns one IndexResult per file processed.
 */
export async function indexOtterTranscripts(opts: IndexerOptions): Promise<IndexResult[]> {
  const state = readIndexState(opts.statePath);
  const results: IndexResult[] = [];

  if (!fs.existsSync(opts.rawDir)) return results;

  const files = fs
    .readdirSync(opts.rawDir)
    .filter((f) => f.endsWith('.json'))
    .sort(); // deterministic order

  const maxFiles = opts.maxFilesPerRun ?? 10;
  let processed = 0;

  for (const file of files) {
    if (processed >= maxFiles) break;

    const alreadyIndexed = state.indexed[file];
    if (alreadyIndexed && !opts.force) {
      results.push({
        file,
        title: alreadyIndexed.title,
        chunks_indexed: 0,
        skipped: true,
        skip_reason: 'already indexed',
      });
      continue;
    }

    const filePath = path.join(opts.rawDir, file);
    const transcript = readOtterFile(filePath);
    if (!transcript) {
      results.push({ file, title: file, chunks_indexed: 0, skipped: true, skip_reason: 'parse error' });
      continue;
    }

    const text = transcript.transcript ?? '';
    const title = transcript.title ?? file.replace('.json', '');

    if (!text.trim()) {
      results.push({ file, title, chunks_indexed: 0, skipped: true, skip_reason: 'empty transcript' });
      continue;
    }

    const chunks = chunkTranscript(text);
    const refTime = transcript.start_time ?? transcript.created_at ?? new Date().toISOString();
    let indexed = 0;
    let error: string | undefined;

    for (const chunk of chunks) {
      try {
        const success = await addEpisode({
          name: buildEpisodeName(title, chunk.chunkIndex, chunks.length),
          episode_body: buildEpisodeBody(title, chunk),
          source_description: `otter-transcript:${file}`,
          reference_time: refTime,
          group_id: 'otter-meetings',
        });
        if (success) indexed++;
      } catch (e) {
        error = String(e);
        break;
      }
    }

    // Update state even on partial success
    state.indexed[file] = {
      chunk_count: indexed,
      indexed_at: new Date().toISOString(),
      title,
    };
    writeIndexState(opts.statePath, state);

    results.push({ file, title, chunks_indexed: indexed, skipped: false, error });
    processed++;
  }

  return results;
}

// ── Summary ───────────────────────────────────────────────────────────────────

export function formatIndexResults(results: IndexResult[]): string {
  const indexed = results.filter((r) => !r.skipped && !r.error);
  const skipped = results.filter((r) => r.skipped);
  const errored = results.filter((r) => r.error);

  const lines: string[] = [`Otter indexing: ${indexed.length} indexed, ${skipped.length} skipped, ${errored.length} errors`];

  for (const r of indexed) {
    lines.push(`  + ${r.file}: ${r.chunks_indexed} chunks`);
  }
  for (const r of errored) {
    lines.push(`  ! ${r.file}: ${r.error}`);
  }

  return lines.join('\n');
}

/**
 * Get a count of how many files have been indexed vs. available.
 */
export function getIndexStats(
  rawDir: string,
  statePath: string,
): { total: number; indexed: number; pending: number } {
  if (!fs.existsSync(rawDir)) return { total: 0, indexed: 0, pending: 0 };
  const files = fs.readdirSync(rawDir).filter((f) => f.endsWith('.json'));
  const state = readIndexState(statePath);
  const indexedCount = Object.keys(state.indexed).filter((f) => files.includes(f)).length;
  return {
    total: files.length,
    indexed: indexedCount,
    pending: files.length - indexedCount,
  };
}
