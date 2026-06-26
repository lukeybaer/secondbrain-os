/**
 * video-quality-tools-v13-run93.test.ts
 *
 * Regression test for run 93 (2026-05-27): verifies that the three v13 wrappers
 * for the next-oldest v12 tools (voice_clarity, emotional_arc, scene_variety)
 * exist, expose analyze(), self-identify, and that the orchestrator + rubric
 * point at v13 or newer, not v12. Encodes the category, not a frozen tool
 * version: future advances must keep a dedicated versioned wrapper and chain
 * back to the previous version instead of regressing below the run-93 floor.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TOOLS_DIR = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video-quality-tools');
const RUBRIC_PATH = path.join(REPO_ROOT, 'data', 'agent', 'video-quality-rubric.json');
const MIRROR_RUBRIC_PATH = path.join(REPO_ROOT, 'content-review', 'video-quality-rubric.json');
const RUNNER_PATH = path.join(TOOLS_DIR, 'run-quality-check.py');

function readRubric(p: string): any {
  const buf = fs.readFileSync(p);
  // UTF-16 LE BOM = 0xFF 0xFE; UTF-8 BOM = 0xEF 0xBB 0xBF
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return JSON.parse(buf.toString('utf16le').replace(/^﻿/, ''));
  }
  return JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
}

const v13Tools = [
  'analyze-voice-clarity-v13.py',
  'analyze-emotional-arc-v13.py',
  'analyze-scene-variety-v13.py',
];

describe('run 93 v13 wrappers exist on disk', () => {
  for (const tool of v13Tools) {
    it(`${tool} exists`, () => {
      expect(fs.existsSync(path.join(TOOLS_DIR, tool))).toBe(true);
    });

    it(`${tool} has analyze() function`, () => {
      const src = fs.readFileSync(path.join(TOOLS_DIR, tool), 'utf8');
      expect(src).toContain('def analyze(');
    });

    it(`${tool} self-identifies with TOOL_VERSION 13.0.0`, () => {
      const src = fs.readFileSync(path.join(TOOLS_DIR, tool), 'utf8');
      expect(src).toMatch(/TOOL_VERSION\s*=\s*["']13\.0\.0["']/);
    });

    it(`${tool} stamps its tool name into the output dict`, () => {
      const src = fs.readFileSync(path.join(TOOLS_DIR, tool), 'utf8');
      const toolName = tool.replace('.py', '');
      // Python-side assignment style: result["tool"] = "analyze-X-v13" or
      // a literal "tool": "analyze-X-v13" in a dict literal. Either form
      // means the wrapper labels its output as v13 (and not as the wrapped v12).
      const hasAssignment = new RegExp(
        `\\[["']tool["']\\]\\s*=\\s*["']${toolName}["']`
      ).test(src);
      const hasLiteral = src.includes(`"tool": "${toolName}"`);
      expect(hasAssignment || hasLiteral).toBe(true);
    });

    it(`${tool} wraps its v12 predecessor via importlib`, () => {
      const src = fs.readFileSync(path.join(TOOLS_DIR, tool), 'utf8');
      const v12Name = tool.replace('-v13.py', '-v12');
      expect(src).toContain(`importlib.import_module("${v12Name}")`);
    });
  }
});

const run93RubricTools = [
  {
    label: 'audio.voice_clarity',
    category: 'audio',
    subcriterion: 'voice_clarity',
    criterion: 'voice-clarity',
    minMajor: 13,
  },
  {
    label: 'content.emotional_arc',
    category: 'content',
    subcriterion: 'emotional_arc',
    criterion: 'emotional-arc',
    minMajor: 13,
  },
  {
    label: 'production.scene_variety',
    category: 'production',
    subcriterion: 'scene_variety',
    criterion: 'scene-variety',
    minMajor: 13,
  },
] as const;

function expectDedicatedVersionAtOrAboveFloor(rubric: any, spec: typeof run93RubricTools[number]) {
  const sub = rubric.categories[spec.category].subcriteria[spec.subcriterion];
  const match = String(sub.tool).match(new RegExp(`^analyze-${spec.criterion}-v(\\d+)\\.py$`));
  expect(match).not.toBeNull();
  const major = Number(match![1]);
  expect(major).toBeGreaterThanOrEqual(spec.minMajor);
  expect(fs.existsSync(path.join(TOOLS_DIR, sub.tool))).toBe(true);
  expect(sub.version).toBe(`${major}.0.0`);

  if (major > spec.minMajor) {
    const src = fs.readFileSync(path.join(TOOLS_DIR, sub.tool), 'utf8');
    expect(src).toContain(`importlib.import_module("analyze-${spec.criterion}-v${major - 1}")`);
  }
}

describe('rubric keeps run 93 tools at v13 or newer (both copies)', () => {
  for (const [label, p] of [
    ['canonical', RUBRIC_PATH],
    ['content-review mirror', MIRROR_RUBRIC_PATH],
  ] as const) {
    for (const spec of run93RubricTools) {
      it(`${label}: ${spec.label} uses a v${spec.minMajor}+ dedicated wrapper`, () => {
        const rubric = readRubric(p);
        expectDedicatedVersionAtOrAboveFloor(rubric, spec);
      });
    }
  }
});

describe('rubric automation summary stays 100% and version bumps', () => {
  it('canonical rubric automation_summary remains 26/26 automated', () => {
    const rubric = readRubric(RUBRIC_PATH);
    expect(rubric.automation_summary.total_criteria).toBeGreaterThanOrEqual(26);
    expect(rubric.automation_summary.automated).toBeGreaterThanOrEqual(26);
    expect(rubric.automation_summary.manual).toBe(0);
  });

  it('canonical rubric version is at or above v93', () => {
    const rubric = readRubric(RUBRIC_PATH);
    const n = parseInt(String(rubric.version).replace(/^v/i, ''), 10);
    expect(n).toBeGreaterThanOrEqual(93);
  });
});

describe('orchestrator wires v13 modules', () => {
  it('run-quality-check.py imports v13 modules for the three tools', () => {
    const src = fs.readFileSync(RUNNER_PATH, 'utf8');
    expect(src).toContain('analyze-voice-clarity-v13');
    expect(src).toContain('analyze-emotional-arc-v13');
    expect(src).toContain('analyze-scene-variety-v13');
  });
});
