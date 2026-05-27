/**
 * 2026-05-25 Luke #gap: posted videos kept resurfacing in the Video
 * Approval Queue (the May 13 VLC clip showed as pending_approval 11
 * days after it was already live on YouTube). videoReadyForApproval
 * and videoNeedsReviewOrRegen must hard-exclude status='posted' so the
 * queue only ever shows work that still has a decision left.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..');
const EC2 = fs.readFileSync(path.join(REPO, 'ec2-server.js'), 'utf8');

function extractFnBody(src: string, fnName: string): string {
  const m = src.match(new RegExp(`function ${fnName}\\s*\\([^)]*\\)\\s*\\{`));
  if (!m) return '';
  const start = m.index! + m[0].length - 1;
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(m.index!, i + 1);
    }
  }
  return '';
}

describe('video approval filters exclude posted', () => {
  it('videoReadyForApproval explicitly rejects status === "posted"', () => {
    const body = extractFnBody(EC2, 'videoReadyForApproval');
    expect(body).not.toBe('');
    expect(body).toMatch(/['"]posted['"]/);
  });

  it('videoNeedsReviewOrRegen explicitly rejects status === "posted"', () => {
    const body = extractFnBody(EC2, 'videoNeedsReviewOrRegen');
    expect(body).not.toBe('');
    expect(body).toMatch(/['"]posted['"]/);
  });
});
