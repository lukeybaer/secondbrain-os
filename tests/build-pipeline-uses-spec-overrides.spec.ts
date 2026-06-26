/**
 * 2026-05-25 ExampleCo #learn: regen produced identical content for 8+ cycles
 * because build_video() did not consult the rejection note. The fix
 * routes the note through interpret-rejection-into-spec-overrides.js,
 * which stamps regen_overrides on the spec, and ec2-build-from-queue.py
 * apply_regen_overrides() then translates those overrides into concrete
 * spec mutations BEFORE the build runs.
 *
 * This contract test pins the Python-side wiring by reading the source.
 * The full apply_regen_overrides happy-path is covered end-to-end in
 * tests/regen-feedback-loop-integration.spec.ts (next session) which
 * runs the actual python and checks the produced artifact.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..');
const PY = fs.readFileSync(path.join(REPO, 'scripts', 'ec2-build-from-queue.py'), 'utf8');

describe('ec2-build-from-queue.py wires regen_overrides', () => {
  it('defines apply_regen_overrides and calls it from build_video', () => {
    expect(PY).toMatch(/def apply_regen_overrides\(spec\):/);
    expect(PY).toMatch(/spec = apply_regen_overrides\(spec\)/);
  });

  it('apply_regen_overrides strips banned_phrases from script and title', () => {
    expect(PY).toMatch(/apply_regen_overrides[\s\S]{0,2500}banned_phrases/);
    expect(PY).toMatch(/apply_regen_overrides[\s\S]{0,2500}re\.escape\(phrase\)/);
  });

  it('apply_regen_overrides honors hook_phrase by rewriting the opening sentence', () => {
    expect(PY).toMatch(/apply_regen_overrides[\s\S]{0,2500}hook_phrase/);
  });

  it('apply_regen_overrides routes voice_id_override / stock_query_override / animation_density onto the spec', () => {
    expect(PY).toMatch(/voice_id_override[\s\S]{0,200}spec\["voice_id"\]/);
    expect(PY).toMatch(/stock_query_override[\s\S]{0,200}spec\["stock_query"\]/);
    expect(PY).toMatch(/animation_density[\s\S]{0,200}spec\["animation_density"\]/);
  });

  it('does NOT carry an opening_tag_override slot (tags are script-derived, not slot-replaced)', () => {
    // 2026-05-25 ExampleCo: tags are crafted from the actual script sentences
    // by the playwright overlay renderer (conceptLabels in
    // src/main/empire/playwright_aurora_overlay.js). A rejected tag is
    // expressed as a banned_phrase + required_directive, never as a
    // direct override. The pipeline must not assign spec["opening_tag_override"].
    expect(PY).not.toMatch(/spec\["opening_tag_override"\]\s*=/);
  });

  it('generate_voice accepts voice_id_override and uses it in the ElevenLabs URL', () => {
    expect(PY).toMatch(/def generate_voice\([^)]*voice_id_override/);
    expect(PY).toMatch(/text-to-speech\/\{voice_id\}/);
  });

  it('the script-length validation runs AFTER apply_regen_overrides so banned phrases cannot leak via title copy', () => {
    const overrideIx = PY.indexOf('spec = apply_regen_overrides(spec)');
    const validateIx = PY.indexOf('script missing or too short');
    expect(overrideIx).toBeGreaterThan(0);
    expect(validateIx).toBeGreaterThan(overrideIx);
  });
});
