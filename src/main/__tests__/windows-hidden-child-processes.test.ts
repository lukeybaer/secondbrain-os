import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('Windows child process windows stay hidden', () => {
  it('hides the detached workers spawned by content rejection', () => {
    const src = read('src/main/ipc-handlers.ts');

    expect(src).toMatch(
      /spawn\('node', \[scriptPath, '--id', id\], \{[\s\S]*?detached:\s*true[\s\S]*?windowsHide:\s*true/,
    );
    expect(src).toMatch(
      /spawn\('node', \[[\s\S]*?dispatchScript[\s\S]*?\], \{[\s\S]*?detached:\s*true[\s\S]*?windowsHide:\s*true/,
    );
    expect(src).toMatch(
      /spawn\('node', \[rubricScript, '--id', id\], \{[\s\S]*?detached:\s*true[\s\S]*?windowsHide:\s*true/,
    );
  });

  it('hides the video regen Python and quality-gate subprocesses', () => {
    const src = read('src/main/video-pipeline.ts');

    expect(src).toMatch(/spawn\(python, \[scriptPath, \.\.\.args\], \{[\s\S]*?windowsHide:\s*true/);
    expect(src).toMatch(/spawnSync\(bin, \[script, artifactPath\], \{[\s\S]*?windowsHide:\s*true/);
  });

  it('hides nested rejection feedback and auto-regen subprocesses', () => {
    const dispatch = read('scripts/dispatch-feedback-to-claude.js');
    const regen = read('scripts/auto-regen-rejected-videos.js');

    expect(dispatch).toMatch(
      /spawn\('claude', \[[\s\S]*?\], \{[\s\S]*?detached:\s*true[\s\S]*?windowsHide:\s*true/,
    );
    expect(regen).toContain(
      "const HIDDEN_PROCESS = process.platform === 'win32' ? { windowsHide: true } : {};",
    );
    expect(regen).toMatch(
      /spawnSync\(bin, \[gatePath, artifactPath\], \{[\s\S]*?\.\.\.HIDDEN_PROCESS/,
    );
    expect(regen).toMatch(/spawnSync\(\s*'ssh',\s*\[[\s\S]*?\],\s*\{[\s\S]*?\.\.\.HIDDEN_PROCESS/);
    expect(regen).toMatch(/execSync\([\s\S]*?scp[\s\S]*?\{[\s\S]*?\.\.\.HIDDEN_PROCESS/);
  });

  it('stores rejection feedback as text for dashboard rendering', () => {
    const regen = read('scripts/auto-regen-rejected-videos.js');

    // The rejection feedback the dashboard renders must be a plain TEXT
    // string, normalized through the rejectionText() helper -- never a raw
    // rejection object. The rejection value is held in `latestRejection`.
    expect(regen).toContain('function rejectionText(rejection');
    expect(regen).toMatch(/v\.previous_feedback\s*=\s*rejectionText\(latestRejection\)/);
    expect(regen).toMatch(/note:\s*rejectionText\(latestRejection\)/);
    // Anti-pattern guard: the raw rejection object must never be stored.
    expect(regen).not.toMatch(/v\.previous_feedback\s*=\s*latestRejection\s*;/);
    expect(regen).not.toMatch(/note:\s*latestRejection\s*,/);
  });

  it('runs scheduled Vitest health probes without a visible shell', () => {
    const heal = read('scripts/heal-tests.js');
    const briefing = read('scripts/manual-briefing-v3.js');

    // 2026-05-08 fix: heal-tests.js now spawns node directly via process.execPath
    // + vitest.mjs (not npx.cmd which caused EINVAL on Windows scheduled tasks).
    // The test verifies the actual pattern used rather than the old npx.cmd approach.
    expect(heal).toMatch(/spawnSync\(process\.execPath, spawnArgs, \{[\s\S]*?windowsHide:\s*true/);
    expect(heal).not.toMatch(/execSync\(cmd/);
    expect(briefing).not.toMatch(/execSync\(testCmd/);
  });
});
