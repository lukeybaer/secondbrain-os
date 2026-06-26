/**
 * 2026-05-25 ExampleCo #learn: short004 rebuilt twice with the new regen
 * interpreter but still shipped "HUMAN TASTE / THE SKILL SOFTWARE
 * CANNOT FAKE" as the opening tag overlay. Root cause: the EC2-deployed
 * version of src/main/empire/playwright_aurora_overlay.js still ExampleCod
 * the old hardcoded tag library that returns "HUMAN TASTE / CHECK THE
 * OUTPUT / ASK WHY / KEEP THE EDGE" for any AI-themed video, even
 * after apply_regen_overrides scrubbed the phrase from script + title.
 *
 * The local version of the renderer has already been refactored: tags
 * are scored from the actual script sentences via conceptLabels(), no
 * hardcoded library. This test pins the local source so a future
 * refactor cannot reintroduce the hardcoded library, and so EC2 drift
 * is caught at CI time.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..');
const RENDERER = path.join(REPO, 'src', 'main', 'empire', 'playwright_aurora_overlay.js');
const SRC = fs.readFileSync(RENDERER, 'utf8');

const FORBIDDEN_HARDCODED_TAGS = [
  'HUMAN TASTE',
  'CHECK THE OUTPUT',
  'ASK WHY',
  'KEEP THE EDGE',
  'FRICTION IS THE WORKOUT',
  'SIT WITH HARD PROBLEMS',
  'LOCAL MODEL',
  'PRIVATE STACK',
  'COPY THIS FLOW',
  'SHIP OFFLINE',
  'WONDER BEAT',
  'KID-SAFE WORLD',
  'TINY WIN',
  'LEVERAGE MAP',
  'BOT WORKFLOW',
  'CASH FLOW',
  'THE POINT',
  'PROOF BEAT',
  'DECISION MOMENT',
  'ACTION FRAME',
];

describe('playwright_aurora_overlay renderer is script-driven only', () => {
  it('does NOT contain any hardcoded tag library string', () => {
    for (const tag of FORBIDDEN_HARDCODED_TAGS) {
      expect(SRC, `renderer must not hardcode tag "${tag}"`).not.toContain(tag);
    }
  });

  it('does NOT contain a topic-based blob.includes tag selector', () => {
    // The old code branched on blob.includes("claude") || blob.includes("ai")
    // and returned a fixed array of cards. The new code scores sentences
    // from the actual script via conceptLabels(). The blob.includes
    // pattern paired with a return array is the marker we forbid.
    expect(SRC).not.toMatch(/blob\.includes\(['"]ai['"]\)[\s\S]{0,400}return\s*\[/);
    expect(SRC).not.toMatch(/blob\.includes\(['"]claude['"]\)[\s\S]{0,400}return\s*\[/);
  });

  it('exposes conceptLabels which builds cards from the script, not a library', () => {
    expect(SRC).toMatch(/function conceptLabels\(script, topic\)/);
    // conceptLabels must call sentenceToCard (script-derived), not return
    // a static literal array of [title, subtitle, icon] triples.
    expect(SRC).toMatch(/conceptLabels[\s\S]{0,600}sentenceToCard/);
  });
});
