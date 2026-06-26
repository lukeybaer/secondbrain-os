import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const studioSource = fs.readFileSync(path.join(REPO, 'src/main/studio.ts'), 'utf8');

describe('E4-R3 post-validation intact', () => {
  it('still prunes missing and tiny camera files after stopRecording', () => {
    expect(studioSource).toContain('const MIN_FILE_SIZE = 1024');
    expect(studioSource).toContain('!fs.existsSync(filePath)');
    expect(studioSource).toContain('delete activeRecording.files[position]');
    expect(studioSource).toContain('stat.size < MIN_FILE_SIZE');
  });

  it('remuxes only surviving MKV files after validation', () => {
    const validationIdx = studioSource.indexOf('Post-recording validation');
    const remuxIdx = studioSource.indexOf('Remux surviving MKV files');
    expect(remuxIdx).toBeGreaterThan(validationIdx);
    expect(studioSource).toContain('if (mkvPath.endsWith(\'.mkv\') && fs.existsSync(mkvPath))');
    expect(studioSource).toContain('await remuxToMp4(mkvPath)');
  });
});
