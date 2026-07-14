/**
 * video-regen-rejection-note.test.ts
 *
 * Regression guard for ITEM 8 - video regeneration with ExampleCo's feedback.
 *
 * The regressions these tests prevent:
 *  (a) A rejected video was re-built without its rejection note ever reaching
 *      the builder, so the regenerated video repeated the same mistake.
 *  (b) Intro / overlay card text said things the script never contained
 *      (e.g. a card said "human taste" when no narration mentioned it).
 *  (c) Animation / B-roll shot prompts were generic and not derived from the
 *      actual video script.
 *
 * These are source-contract + behavioural tests. The behavioural half runs the
 * real Python helper functions (no network) so the wiring is verified, not just
 * the presence of a string.
 */

import { describe, it, expect } from 'vitest';

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');
const QUEUE_BUILDER = path.join(SCRIPTS_DIR, 'ec2-build-from-queue.py');
const TOPIC_GEN = path.join(SCRIPTS_DIR, 'daily-video-topic-gen.js');
const AUTO_REGEN = path.join(SCRIPTS_DIR, 'auto-regen-rejected-videos.js');
const SEEDANCE = path.join(SCRIPTS_DIR, 'seedance-broll.py');

function pythonBin(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** Quick smoke check: can we run Python at all? */
let _pythonOk: boolean | undefined;
function pythonAvailable(): boolean {
  if (_pythonOk !== undefined) return _pythonOk;
  try {
    execFileSync(pythonBin(), ['--version'], { timeout: 5000, encoding: 'utf8' });
    _pythonOk = true;
  } catch {
    _pythonOk = false;
  }
  return _pythonOk;
}

/** Run a small Python snippet against a script's module and return stdout. */
function runPySnippet(scriptPath: string, snippet: string): string {
  const dir = path.dirname(scriptPath);
  const mod = path.basename(scriptPath, '.py').replace(/-/g, '_');
  // Import the script as a module by file path so its helpers are callable.
  // The script is imported under its real module name (not "__main__"), so its
  // `if __name__ == "__main__"` block never runs during the test.
  const harness = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location(${JSON.stringify(mod)}, ${JSON.stringify(
    scriptPath,
  )})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
${snippet}
`;
  return execFileSync(pythonBin(), ['-c', harness], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30000,
  }).trim();
}

// -- (a) Rejection feedback is read into regeneration ------------------------

describe('(a) ec2-build-from-queue.py ingests the rejection note', () => {
  let src: string;
  it('source exists', () => {
    expect(fs.existsSync(QUEUE_BUILDER)).toBe(true);
    src = fs.readFileSync(QUEUE_BUILDER, 'utf8');
  });

  it('has a get_rejection_note helper', () => {
    src = fs.readFileSync(QUEUE_BUILDER, 'utf8');
    expect(src).toContain('def get_rejection_note(');
  });

  it('forces a rebuild when a re-queued video ExampleCos a rejection note', () => {
    src = fs.readFileSync(QUEUE_BUILDER, 'utf8');
    // The stale-final.mp4 skip must NOT trigger when a rejection note exists.
    expect(src).toMatch(/and not spec_rejection/);
    expect(src).toContain('rejected video re-queued, rebuilding from feedback');
  });

  it.skipIf(!pythonAvailable())('get_rejection_note reads the rejection_note field from a spec', { timeout: 45000 }, () => {
    const out = runPySnippet(
      QUEUE_BUILDER,
      `print(m.get_rejection_note({"rejection_note": "intro card said human taste, not in script"}))`,
    );
    expect(out).toBe('intro card said human taste, not in script');
  });

  it.skipIf(!pythonAvailable())('get_rejection_note also honors the legacy video_rejection_note field', { timeout: 45000 }, () => {
    const out = runPySnippet(
      QUEUE_BUILDER,
      `print(m.get_rejection_note({"video_rejection_note": "voice changed, restore original"}))`,
    );
    expect(out).toBe('voice changed, restore original');
  });

  it.skipIf(!pythonAvailable())('get_rejection_note returns empty string when there is no feedback', { timeout: 45000 }, () => {
    const out = runPySnippet(
      QUEUE_BUILDER,
      `print(repr(m.get_rejection_note({"title": "x"})))`,
    );
    expect(out).toBe("''");
  });

  it('records regenerated_from_rejection on the build manifest', () => {
    src = fs.readFileSync(QUEUE_BUILDER, 'utf8');
    expect(src).toContain('regenerated_from_rejection');
  });

  it.skipIf(!pythonAvailable())('hydrates missing queue scripts from the original shorts proposal', { timeout: 45000 }, () => {
    const out = runPySnippet(
      QUEUE_BUILDER,
      `
import json, tempfile
from pathlib import Path
tmp = Path(tempfile.mkdtemp())
(tmp / "2026-05-10.json").write_text(json.dumps({
  "proposals": [{
    "id": "short004_research",
    "script": "Use Perplexity for research. Use ChatGPT for synthesis. Use Claude for analysis. Follow for more.",
    "stock_queries": ["research desk", "AI browser"]
  }]
}))
m.PROPOSALS_DIR_LOCAL = tmp
hydrated = m.hydrate_spec_from_proposal({"id": "short004_research", "script": "", "title": "T"})
print(json.dumps({"script": hydrated["script"], "stock_queries": hydrated["stock_queries"]}))
`,
    );
    const hydrated = JSON.parse(out);
    expect(hydrated.script).toContain('Use Perplexity');
    expect(hydrated.stock_queries).toEqual(['research desk', 'AI browser']);
  });

  it('refuses to build near-empty approval artifacts', () => {
    src = fs.readFileSync(QUEUE_BUILDER, 'utf8');
    expect(src).toContain('script missing or too short');
    expect(src).toContain('near-empty approval artifact');
  });
});

// -- Rejected-video regen ownership -----------------------------------------

describe('(a) rejected-video regen stays feedback-aware after the daily re-gate', () => {
  let src: string;
  it('daily-video-topic-gen.js does not own rejected-video regeneration', () => {
    src = fs.readFileSync(TOPIC_GEN, 'utf8');
    expect(src).toContain('Rejected-video regeneration is owned by auto-regen-rejected-videos.js');
    expect(src).toContain('NEVER touches ec2-build-queue.json');
    expect(src).not.toContain('collectRejectedForRegen(existingIds)');
  });

  it('auto-regen ExampleCos the video rejection note into the rebuild handoff', () => {
    src = fs.readFileSync(AUTO_REGEN, 'utf8');
    expect(src).toContain('function buildRegenFeedbackPayload');
    expect(src).toContain("rejection_note: v.video_rejection_note || ''");
    expect(src).toContain('v.video_rejection_note ||');
  });

  it('auto-regen forces the rebuild path instead of reusing stale output', () => {
    src = fs.readFileSync(AUTO_REGEN, 'utf8');
    expect(src).toContain('FORCE_REBUILD=1');
    expect(src).toContain('ec2-build-from-queue.py --id <id>');
  });
});

// -- (b) Intro / overlay cards derived from the script -----------------------

describe('(b) card text is derived strictly from the script', () => {
  it('has a card_text_from_script helper', () => {
    const src = fs.readFileSync(QUEUE_BUILDER, 'utf8');
    expect(src).toContain('def card_text_from_script(');
  });

  it.skipIf(!pythonAvailable())('keeps a title whose words all appear in the script', { timeout: 45000 }, () => {
    const out = runPySnippet(
      QUEUE_BUILDER,
      `print(m.card_text_from_script("Free AI tools doubled her income", "Sarah used free AI tools. Her income doubled. Follow for more."))`,
    );
    expect(out).toBe('Free AI tools doubled her income');
  });

  it.skipIf(!pythonAvailable())('rejects a title with wording the script never says', { timeout: 45000 }, () => {
    // "human taste" is the exact invented-card bug ExampleCo flagged.
    const out = runPySnippet(
      QUEUE_BUILDER,
      `print(m.card_text_from_script("AI cannot replace human taste", "AI writes code fast. It ships features. Follow for tools."))`,
    );
    expect(out).not.toContain('human taste');
    // Falls back to the script's own opening sentence.
    expect(out).toContain('AI writes code fast');
  });
});

// -- (c) Animation shot prompts derived from the script ----------------------

describe('(c) seedance-broll.py derives shots from the actual script', () => {
  it('has a script_beats helper', () => {
    const src = fs.readFileSync(SEEDANCE, 'utf8');
    expect(src).toContain('def script_beats(');
  });

  it.skipIf(!pythonAvailable())('build_shot_prompts uses real script sentences as shot subjects', { timeout: 45000 }, () => {
    const out = runPySnippet(
      SEEDANCE,
      `shots = m.build_shot_prompts({"title": "T", "script": "A neural network learns fast. The model ships features. Follow for tools."})\n` +
        `import json; print(json.dumps(shots))`,
    );
    const shots: string[] = JSON.parse(out);
    expect(shots.length).toBeGreaterThanOrEqual(4);
    // At least one shot must quote a real sentence from the script.
    expect(shots.some((s) => s.includes('A neural network learns fast'))).toBe(true);
    expect(shots.some((s) => s.includes('The model ships features'))).toBe(true);
  });

  it.skipIf(!pythonAvailable())('falls back to the title only when no script is present (never invents)', { timeout: 45000 }, () => {
    const out = runPySnippet(
      SEEDANCE,
      `shots = m.build_shot_prompts({"title": "Quiet Title", "script": ""})\n` +
        `import json; print(json.dumps(shots))`,
    );
    const shots: string[] = JSON.parse(out);
    expect(shots.length).toBeGreaterThanOrEqual(4);
    expect(shots.every((s) => s.includes('Quiet Title'))).toBe(true);
  });
});
