/**
 * feedback-dispatch-to-claude.test.ts
 *
 * Locks the 2026-05-02 ExampleCo feature dispatch: "all feedback should go
 * through claude code sessions, not some videos only mode."
 *
 * Every rejection now spawns a Claude Code session (via
 * scripts/dispatch-feedback-to-claude.js) that reads the manifest +
 * rubric scores + recent rejection history and decides the right
 * workflow: build a new analyzer, raise a threshold, fix the build,
 * regen, promote. The session closes the loop in one go instead of
 * the prior log-and-exit pattern.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DISPATCH = path.join(REPO_ROOT, 'scripts', 'dispatch-feedback-to-claude.js');
const IPC = path.join(REPO_ROOT, 'src', 'main', 'ipc-handlers.ts');

describe('dispatch-feedback-to-claude -- structure', () => {
  it('script exists', () => {
    expect(fs.existsSync(DISPATCH)).toBe(true);
  });

  it('builds a video-rejection prompt that includes manifest state, rubric scores, and rejection history', () => {
    const src = fs.readFileSync(DISPATCH, 'utf8');
    expect(src).toMatch(/buildPromptForVideoRejection/);
    expect(src).toMatch(/Manifest state/);
    expect(src).toMatch(/Most recent rubric scores/);
    expect(src).toMatch(/Recent rejection history/);
    expect(src).toMatch(/Your job/);
  });

  it('points the spawned Claude session at the workflow rule (rejection_audit_must_build_the_analyzer)', () => {
    const src = fs.readFileSync(DISPATCH, 'utf8');
    expect(src).toMatch(/feedback_rejection_audit_must_build_the_analyzer\.md/);
  });

  it('spawns claude with --print + --permission-mode bypassPermissions (autonomous, no prompts to ExampleCo)', () => {
    const src = fs.readFileSync(DISPATCH, 'utf8');
    expect(src).toMatch(/--print/);
    expect(src).toMatch(/--permission-mode/);
    expect(src).toMatch(/bypassPermissions/);
  });

  it('logs Claude output to .tmp/diag/claude-dispatch-<id>-<ts>.log so we can audit what the session did', () => {
    const src = fs.readFileSync(DISPATCH, 'utf8');
    expect(src).toMatch(/claude-dispatch-/);
    expect(src).toMatch(/\.tmp.*diag/);
    // Detached + unref so the IPC handler returns instantly.
    expect(src).toMatch(/detached:\s*true/);
    expect(src).toMatch(/proc\.unref/);
  });

  it('--dry-run prints the prompt without spawning (so Amy can preview during development)', () => {
    const src = fs.readFileSync(DISPATCH, 'utf8');
    expect(src).toMatch(/dry-?run|dryRun/i);
  });

  it('exposes buildPromptForVideoRejection so the prompt shape can be unit-tested', () => {
    const src = fs.readFileSync(DISPATCH, 'utf8');
    expect(src).toMatch(/module\.exports\s*=\s*\{[^}]*buildPromptForVideoRejection/);
  });
});

describe('IPC integration', () => {
  it('empire:rejectVideo handler spawns dispatch-feedback-to-claude.js alongside the existing flows', () => {
    const src = fs.readFileSync(IPC, 'utf8');
    expect(src).toMatch(/dispatch-feedback-to-claude\.js/);
    // Detached + unref like the other rejection-spawned tasks.
    const dispatchBlock = src.match(
      /empire:rejectVideo[\s\S]*?dispatch-feedback-to-claude\.js[\s\S]*?proc\.unref/,
    );
    expect(dispatchBlock).toBeTruthy();
  });

  it('rejection-spawned auto-regen now logs to .tmp/diag/regen_<id>_<ts>.log instead of /dev/null', () => {
    const src = fs.readFileSync(IPC, 'utf8');
    // Yesterday's "did the rejection trigger regen?" question was
    // unanswerable because stdio was 'ignore'. Logging the spawn output
    // is the audit trail.
    const regenBlock = src.match(/empire:rejectVideo[\s\S]*?auto-regen-rejected-videos\.js[\s\S]*?stdio:\s*\[/);
    expect(regenBlock).toBeTruthy();
    expect(regenBlock![0]).toMatch(/regen_\$\{id\}_\$\{ts\}\.log|regen_\$\{id\}/);
  });
});
