import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const studioSource = fs.readFileSync(path.join(REPO, 'src/main/studio.ts'), 'utf8');
const renderSource = fs.readFileSync(path.join(REPO, 'src/main/studio-render.ts'), 'utf8');

describe('E4-R5 remux and render intact', () => {
  it('keeps the MKV to MP4 remux path', () => {
    expect(studioSource).toContain('function remuxToMp4');
    expect(studioSource).toContain("'-c', 'copy'");
    expect(studioSource).toContain("const mp4Path = mkvPath.replace(/\\.mkv$/, '.mp4')");
    expect(studioSource).toContain('await remuxToMp4(mkvPath)');
  });

  it('keeps EDL rendering with subtitles, output maps, and both output formats', () => {
    expect(renderSource).toContain('export async function renderFromEDL');
    expect(renderSource).toContain('generateSRT(recording.transcript, srtPath)');
    expect(renderSource).toContain('output_linkedin.mp4');
    expect(renderSource).toContain('output_youtube.mp4');
    expect(renderSource).toContain('buildFilterComplex');
    expect(renderSource).toContain("args.push('-filter_complex', filterComplex)");
    expect(renderSource).toContain('outputMaps');
  });
});
