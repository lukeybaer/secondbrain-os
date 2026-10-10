/**
 * 2026-05-25 ExampleCo #learn: "always queued videos should show in Video
 * Approval Queue." The tile renderer used to split the manifest into
 * `items` (ready) and `stuck` (needs-regen / unresolved rejection
 * feedback). Only `items` got rendered as rows; `stuck` only contributed
 * to the count. A pending_approval video that failed the rejection
 * gate was invisible -- ExampleCo saw a tile that said "4" with 3 rows.
 *
 * Contract: every entry with status=pending_approval renders a row.
 * Stuck entries get a disabled state + a one-line reason; they do NOT
 * get hidden.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..');
const EC2 = fs.readFileSync(path.join(REPO, 'ec2-server.js'), 'utf8');

describe('video approval queue tile: all queued videos visible', () => {
  // Extract the videoApprovals branch by scanning from the opening
  // brace through balanced braces, not a fragile non-greedy regex.
  const extractVideoApprovalsBlock = (src: string): string => {
    const startMatch = src.match(/if \(d\.kind === ['"]videoApprovals['"]\)\s*\{/);
    if (!startMatch) return '';
    const startIx = startMatch.index! + startMatch[0].length - 1; // on the {
    let depth = 0;
    for (let i = startIx; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(startMatch.index!, i + 1);
      }
    }
    return '';
  };
  const BLOCK = extractVideoApprovalsBlock(EC2);

  it('the videoApprovals tile render reads BOTH d.items AND d.stuck for the row map', () => {
    expect(BLOCK).not.toBe('');
    // The render must build the rows from a combined set, not items alone.
    expect(BLOCK).toMatch(/\[\s*\.\.\.\s*items[\s\S]{0,200}\.\.\.\s*stuck|allQueued/);
  });

  it('stuck rows render with a disabled approve button or a "stuck" reason badge', () => {
    expect(BLOCK).toMatch(/data-stuck|stuck-row|disabled|aria-disabled/);
  });

  it('the tile-metric count equals items.length + stuck.length (no math mismatch)', () => {
    expect(BLOCK).toMatch(/tile-metric[\s\S]{0,300}(items\.length\s*\+\s*stuck\.length|allQueued\.length|totalSurface)/);
  });
});
