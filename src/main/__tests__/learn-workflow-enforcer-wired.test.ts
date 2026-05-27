/**
 * Luke 2026-04-29 #gap (the meta-#gap): "when I say #learn there is a
 * specific protocol you must follow which you did not."
 *
 * Root cause: the UserPromptSubmit hook (learn-and-usage.js) injected the
 * canonical 9-step workflow as a systemMessage, but a systemMessage is
 * context, not a constraint. There was no Stop-hook enforcer for #learn
 * the way gap-workflow-enforcer.sh exists for #gap. Result: I read the
 * 9-step workflow and skipped step 6 (Graphiti addEpisode) without the
 * harness rejecting my response.
 *
 * This test locks two invariants:
 *
 *   1. learn-workflow-enforcer.sh + .mjs exist on disk and are wired in
 *      the Stop hook chain in secondbrain/claude-config/settings.json.
 *   2. The mjs enforcer asserts every load-bearing marker from the
 *      canonical workflow (memory file + index + Graphiti + test +
 *      commit + structured exec summary).
 *
 * If a future settings refactor drops the wiring, this test fails before
 * the change ships.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const REPO = path.join(__dirname, '..', '..', '..');
const HOOK_DIR = path.join(REPO, 'scripts', 'claude-hooks');
const SETTINGS = path.join(REPO, 'claude-config', 'settings.json');

describe("#learn workflow Stop-hook enforcer (Luke 2026-04-29 #gap)", () => {
  it("learn-workflow-enforcer.mjs exists and is the actual enforcer (not a stub)", () => {
    const f = path.join(HOOK_DIR, 'learn-workflow-enforcer.mjs');
    expect(fs.existsSync(f)).toBe(true);
    const src = fs.readFileSync(f, 'utf8');
    // Must check the user message for #learn, not just always run.
    expect(src).toMatch(/userMentionsLearn/);
    // Must export the markers list so tests + downstream can introspect.
    expect(src).toMatch(/export\s+\{/);
  });

  it("learn-workflow-enforcer.sh wraps the .mjs (delegating, not duplicating logic)", () => {
    const f = path.join(HOOK_DIR, 'learn-workflow-enforcer.sh');
    expect(fs.existsSync(f)).toBe(true);
    const src = fs.readFileSync(f, 'utf8');
    expect(src).toMatch(/learn-workflow-enforcer\.mjs/);
  });

  it("settings.json wires learn-workflow-enforcer.sh as a Stop hook", () => {
    const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    const stopHooks = (settings.hooks?.Stop || [])
      .flatMap((g: any) => g.hooks || [])
      .map((h: any) => h.command || '');
    expect(stopHooks.some((c) => /learn-workflow-enforcer/.test(c))).toBe(true);
    // gap enforcer must also still be wired -- we don't want to drop one
    // when adding the other.
    expect(stopHooks.some((c) => /gap-workflow-enforcer/.test(c))).toBe(true);
  });

  it("enforcer exits 0 on empty stdin (no-op when there's no transcript)", () => {
    // Pass an empty stdin via execSync's `input` (cross-platform; the
    // `< /dev/null` shell redirect doesn't work the same on Windows).
    const out = execSync(
      `node "${path.join(HOOK_DIR, 'learn-workflow-enforcer.mjs')}"`,
      { input: '', encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    expect(out).toBe('');
  });

  it("enforcer rejects (exit 2) when user said #learn but assistant skipped Graphiti + commit", () => {
    const enforcer = path.join(HOOK_DIR, 'learn-workflow-enforcer.mjs');
    const payload = JSON.stringify({
      messages: [
        { role: 'user', content: '#learn that all-green claims must be verified in the artifact' },
        { role: 'assistant', content: 'Saved feedback_test.md and updated MEMORY.md. Free-form summary.' },
      ],
    });
    let exitCode = 0;
    try {
      execSync(`node "${enforcer}"`, {
        input: payload,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      exitCode = e.status || 0;
    }
    expect(exitCode).toBe(2);
  });

  it("enforcer accepts a complete response (memory + index + graphiti + test + commit + summary)", () => {
    const enforcer = path.join(HOOK_DIR, 'learn-workflow-enforcer.mjs');
    const payload = JSON.stringify({
      messages: [
        { role: 'user', content: '#learn always verify in the artifact' },
        {
          role: 'assistant',
          content:
            'Saved memory/feedback_verify_in_artifact.md. ' +
            'Updated MEMORY.md index entry under "Where to find what." ' +
            'Fired addEpisode() via fire-graphiti-episode.mjs: GRAPHITI_OK feedback_verify_in_artifact. ' +
            'Added vitest at src/main/__tests__/snapshot-people-aggregator-filter.test.ts. ' +
            'Committed as commit d8fa383 and pushed. ' +
            'EXEC SUMMARY: bullet list of files updated above.',
        },
      ],
    });
    const out = execSync(`node "${enforcer}"`, {
      input: payload,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // exit 0 = the enforcer was satisfied
    expect(out).toBe('');
  });

  it("enforcer rejects 5/6 responses (the exact pattern that slipped Luke 2026-05-23)", () => {
    // 2026-05-23 #gap: shipped a #learn response that hit 5 of 6 markers
    // but silently skipped Graphiti. MIN_MARKERS was 5, so the enforcer
    // passed me. Bumped MIN_MARKERS to REQUIRED_MARKERS.length. This test
    // freezes the bump: a response that satisfies every step EXCEPT
    // Graphiti must be rejected.
    const enforcer = path.join(HOOK_DIR, 'learn-workflow-enforcer.mjs');
    const payload = JSON.stringify({
      messages: [
        { role: 'user', content: '#learn never let popups happen again' },
        {
          role: 'assistant',
          content:
            'Saved memory/feedback_scheduled_tasks_must_be_silent.md. ' +
            'Updated MEMORY.md index. ' +
            'Added regression test scripts/__tests__/scheduled-tasks-silent-launcher.test.js. ' +
            'Committed as commit 89ed3b8a and pushed. ' +
            'EXEC SUMMARY with table of files changed. ' +
            '(NO graphiti line at all -- silent skip)',
        },
      ],
    });
    let exitCode = 0;
    try {
      execSync(`node "${enforcer}"`, {
        input: payload,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      exitCode = e.status || 0;
    }
    expect(exitCode).toBe(2);
  });

  it("enforcer rejects prose mention of addEpisode without the GRAPHITI_OK token", () => {
    // The pre-2026-05-23 marker accepted any sentence containing
    // "addEpisode" or "upsertMemory". That let me CLAIM the cascade ran
    // without running it. The tightened marker now requires the literal
    // GRAPHITI_OK <name> or GRAPHITI_UNREACHABLE <reason> token printed
    // by scripts/fire-graphiti-episode.mjs.
    const enforcer = path.join(HOOK_DIR, 'learn-workflow-enforcer.mjs');
    const payload = JSON.stringify({
      messages: [
        { role: 'user', content: '#learn enforce graphiti for real' },
        {
          role: 'assistant',
          content:
            'Saved memory/feedback_x.md. Updated MEMORY.md. ' +
            'Fired addEpisode() into Graphiti (prose claim only). ' +
            'Added vitest. Committed d8fa383. EXEC SUMMARY: files changed.',
        },
      ],
    });
    let exitCode = 0;
    try {
      execSync(`node "${enforcer}"`, {
        input: payload,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      exitCode = e.status || 0;
    }
    expect(exitCode).toBe(2);
  });
});
