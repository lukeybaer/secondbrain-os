// Tiny one-shot to fire addEpisode for a single memory file.
// Used by the #learn workflow to satisfy step 6 (Graphiti) without
// re-seeding the whole memory tree.
//
// Usage: npx tsx scripts/upsert-single-memory.ts <relative/path.md>
import * as fs from 'fs';
import * as path from 'path';
import { addEpisode, isGraphitiAvailable } from '../src/main/graphiti-client';

(async () => {
  const rel = process.argv[2];
  if (!rel) { console.error('usage: upsert-single-memory.ts <relative/path.md>'); process.exit(64); }
  const REPO = path.resolve(__dirname, '..');
  const full = path.join(REPO, rel);
  if (!fs.existsSync(full)) { console.error('FILE_MISSING ' + full); process.exit(2); }
  const avail = await isGraphitiAvailable().catch(() => false);
  if (!avail) { console.log('GRAPHITI_UNREACHABLE'); process.exit(3); }
  const content = fs.readFileSync(full, 'utf-8');
  const ok = await addEpisode({
    name: rel,
    episode_body: content,
    source_description: 'Memory file (one-shot upsert): ' + rel,
    reference_time: new Date().toISOString(),
  });
  console.log(ok ? ('INGESTED ' + rel) : ('INGEST_FAILED ' + rel));
  process.exit(ok ? 0 : 4);
})();
