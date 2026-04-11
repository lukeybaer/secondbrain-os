#!/usr/bin/env tsx
// seed-graphiti.ts
//
// One-shot ingestion pass that loads every memory file + contact + past
// briefing + nightly enhancement run log into Graphiti as episodes, so
// the semantic-search layer actually has content to search.
//
// Pre-requisite: the SSH tunnel to EC2 Graphiti must be up.
//   ssh -fNL 8000:localhost:8000 ec2-user@98.80.164.16
//
// Usage (from secondbrain repo root):
//   npx tsx scripts/seed-graphiti.ts
//
// Expected runtime: ~5-8 minutes for ~400 episodes at ~1s each.
//
// Safe to re-run — Graphiti dedupes by content hash + name.

import * as fs from 'fs';
import * as path from 'path';
import { addEpisode, isGraphitiAvailable } from '../src/main/graphiti-client';

const REPO = path.resolve(__dirname, '..');

type Walk = { full: string; rel: string; ext: string; mtime: Date };

function walkDir(dir: string, filter: (p: string) => boolean, results: Walk[] = []): Walk[] {
  if (!fs.existsSync(dir)) return results;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    if (filter(dir)) {
      results.push({
        full: dir,
        rel: path.relative(REPO, dir).replace(/\\/g, '/'),
        ext: path.extname(dir),
        mtime: stat.mtime,
      });
    }
    return results;
  }
  if (!stat.isDirectory()) return results;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      walkDir(full, filter, results);
    }
  } catch {
    /* unreadable */
  }
  return results;
}

async function seedMemoryFiles(): Promise<number> {
  const memoryDir = path.join(REPO, 'memory');
  const files = walkDir(memoryDir, (p) => p.endsWith('.md') && !p.includes('archive'));
  console.log(`[seed-graphiti] Found ${files.length} memory files`);

  let ingested = 0;
  for (const file of files) {
    const content = fs.readFileSync(file.full, 'utf-8');
    if (content.length < 50) continue; // skip empty stubs

    const ok = await addEpisode({
      name: file.rel,
      episode_body: content,
      source_description: `Memory file: ${file.rel}`,
      reference_time: file.mtime.toISOString(),
    });
    if (ok) {
      ingested++;
      if (ingested % 10 === 0) console.log(`[seed-graphiti] ingested ${ingested}/${files.length}`);
    } else {
      console.warn(`[seed-graphiti] failed to ingest ${file.rel}`);
    }
  }
  return ingested;
}

async function seedContactFiles(): Promise<number> {
  const contactsDir = path.join(REPO, 'memory', 'contacts');
  const files = walkDir(contactsDir, (p) => p.endsWith('.md') && !path.basename(p).startsWith('_'));
  console.log(`[seed-graphiti] Found ${files.length} contact files`);

  let ingested = 0;
  for (const file of files) {
    const content = fs.readFileSync(file.full, 'utf-8');
    if (content.length < 50) continue;

    const slug = path.basename(file.rel, '.md');
    const ok = await addEpisode({
      name: `contact:${slug}`,
      episode_body: content,
      source_description: `Contact: ${slug}`,
      reference_time: file.mtime.toISOString(),
    });
    if (ok) {
      ingested++;
      if (ingested % 20 === 0) console.log(`[seed-graphiti] contacts ${ingested}/${files.length}`);
    }
  }
  return ingested;
}

async function seedPastBriefings(): Promise<number> {
  const briefingsDir = path.join(REPO, 'data', 'briefings');
  if (!fs.existsSync(briefingsDir)) return 0;
  const files = walkDir(briefingsDir, (p) => p.endsWith('.md'));
  console.log(`[seed-graphiti] Found ${files.length} past briefings`);

  let ingested = 0;
  for (const file of files) {
    const content = fs.readFileSync(file.full, 'utf-8');
    const ok = await addEpisode({
      name: path.basename(file.rel),
      episode_body: content.slice(0, 8000), // cap large briefings
      source_description: `Past briefing: ${file.rel}`,
      reference_time: file.mtime.toISOString(),
    });
    if (ok) ingested++;
  }
  return ingested;
}

async function seedNightlyEnhancements(): Promise<number> {
  const logPath = path.join(REPO, 'data', 'agent', 'nightly-enhancements.jsonl');
  if (!fs.existsSync(logPath)) return 0;

  const lines = fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  console.log(`[seed-graphiti] Found ${lines.length} nightly enhancement runs`);

  let ingested = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const ok = await addEpisode({
        name: `nightly-${entry.task || 'unknown'}-run${entry.run_number || 0}`,
        episode_body: JSON.stringify(entry, null, 2),
        source_description: `Nightly ${entry.task} run #${entry.run_number}`,
        reference_time: entry.timestamp,
      });
      if (ok) ingested++;
    } catch {
      /* malformed line */
    }
  }
  return ingested;
}

async function main() {
  console.log('[seed-graphiti] Checking Graphiti availability...');
  const available = await isGraphitiAvailable();
  if (!available) {
    console.error('[seed-graphiti] Graphiti is not reachable at http://127.0.0.1:8000');
    console.error(
      '[seed-graphiti] Is the SSH tunnel up? Run: ssh -fNL 8000:localhost:8000 ec2-user@98.80.164.16',
    );
    process.exit(1);
  }
  console.log('[seed-graphiti] Graphiti available, starting ingestion...');

  const start = Date.now();
  const memoryCount = await seedMemoryFiles();
  const contactCount = await seedContactFiles();
  const briefingCount = await seedPastBriefings();
  const enhancementCount = await seedNightlyEnhancements();

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log('');
  console.log('[seed-graphiti] === Ingestion complete ===');
  console.log(`[seed-graphiti] Memory files:          ${memoryCount}`);
  console.log(`[seed-graphiti] Contact files:         ${contactCount}`);
  console.log(`[seed-graphiti] Past briefings:        ${briefingCount}`);
  console.log(`[seed-graphiti] Nightly enhancements:  ${enhancementCount}`);
  console.log(
    `[seed-graphiti] Total episodes:        ${memoryCount + contactCount + briefingCount + enhancementCount}`,
  );
  console.log(`[seed-graphiti] Elapsed:               ${elapsed}s`);
}

main().catch((err) => {
  console.error('[seed-graphiti] fatal:', err);
  process.exit(1);
});
