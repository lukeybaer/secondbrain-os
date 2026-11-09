/**
 * Regression guard: 2026-04-20, rejected videos must remain visible in the UI
 * even after they transition to regen_queued (the regen loop status) or
 * trashed. ContentPipeline.tsx's rejected filter used to match only
 * video_rejected | thumbnail_rejected | rejected, so the Rejected section
 * disappeared and five rejections were invisible to the owner.
 *
 * The real `const rejected = videos.filter(...)` statement is lifted out of
 * the component, type-stripped, and run over videos of every status.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// node:module stripTypeScriptTypes needs Node 22.13+; EC2 runs Node 20.
const ts = require('typescript');

function loadRejectedFilter(): (videos: Array<{ id: string; status: string }>) => Array<{ id: string; status: string }> {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'pages', 'ContentPipeline.tsx'), 'utf8');
  const m = src.match(/const\s+rejected\s*=\s*videos\.filter\([\s\S]*?\)\s*;/);
  if (!m) throw new Error('rejected filter statement not found in ContentPipeline.tsx');
  const stripped = ts.transpileModule(m[0].replace(/^const\s+rejected\s*=\s*/, 'const __r = '), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const js = stripped + '\nreturn __r;';
  // eslint-disable-next-line no-new-func
  return new Function('videos', js) as any;
}

describe('ContentPipeline rejected filter visibility (2026-04-20)', () => {
  const statuses = [
    'pending_approval',
    'approved',
    'posted',
    'video_rejected',
    'thumbnail_rejected',
    'rejected',
    'regen_queued',
    'trashed',
  ];
  const videos = statuses.map((status, i) => ({ id: 'v' + i, status }));

  it('keeps every rejection-loop status in the Rejected list, including in-flight regens and trashed', () => {
    const out = loadRejectedFilter()(videos).map((v) => v.status).sort();
    expect(out).toEqual(['regen_queued', 'rejected', 'thumbnail_rejected', 'trashed', 'video_rejected']);
  });

  it('leaves live-queue and published videos out of the Rejected list', () => {
    const out = loadRejectedFilter()(videos).map((v) => v.status);
    for (const s of ['pending_approval', 'approved', 'posted']) expect(out).not.toContain(s);
  });
});
