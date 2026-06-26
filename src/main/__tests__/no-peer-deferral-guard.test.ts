/**
 * Regression test: no-peer-deferral-guard.mjs Stop hook detects when an
 * assistant turn uses a peer agent (Codex / Claude Code) risk-flag as
 * cover to defer scope ExampleCo explicitly asked for.
 *
 * Background: 2026-05-23 #gap. ExampleCo asked Amy to fix the root cause of
 * the overnight self-heal window. Codex flagged ONE specific approach
 * (moving Tests into runOnePass at 3 AM) for CPU contention. Amy marked
 * task #5 "DEFERRED per Codex" and shipped task #6 instead, treating the
 * peer's flag as a veto over ExampleCo's scope. The session-coordination
 * protocol is explicit: "ExampleCo latest intent is the only authority.
 * Claude Code and Codex are peers." Peers raise concerns; peers do not
 * override ExampleCo.
 *
 * Test strategy: spawn the hook as a subprocess with a synthetic
 * transcript jsonl containing the last assistant message, send a Stop
 * payload on stdin, and assert exit code + stderr content.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'scripts', 'claude-hooks', 'no-peer-deferral-guard.mjs');

let scratchDir: string;

beforeAll(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-peer-deferral-test-'));
});

afterAll(() => {
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function writeTranscript(text: string): string {
  const transcriptPath = path.join(scratchDir, `transcript-${Math.random().toString(36).slice(2)}.jsonl`);
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
  fs.writeFileSync(transcriptPath, line + '\n');
  return transcriptPath;
}

function runHook(text: string): { code: number; stderr: string } {
  const transcriptPath = writeTranscript(text);
  const payload = JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath });
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: payload,
    encoding: 'utf8',
    timeout: 10000,
  });
  return { code: result.status ?? -1, stderr: result.stderr || '' };
}

describe('no-peer-deferral-guard hook end-to-end', () => {
  it('exits 2 and emits the rule pointer when the assistant says "DEFERRED per Codex"', () => {
    const msg = 'I shipped the test fixes and the LinkedIn enrichment. The self-heal refactor was DEFERRED per Codex review because of CPU contention risk; we will revisit in a future session. The rest landed cleanly and is locked by tests.';
    const r = runHook(msg);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Peer-deferral phrase detected/);
    expect(r.stderr).toMatch(/feedback_never_defer_ExampleCo_scope\.md/);
  });

  it('exits 2 on lowercase "deferred per Codex"', () => {
    const msg = 'Self-heal refactor deferred per Codex per the risk review; will revisit next session. Token usage and video regen both shipped clean and the briefing is verified live.';
    const r = runHook(msg);
    expect(r.code).toBe(2);
  });

  it('exits 2 on "Codex flagged so I deferred"', () => {
    const msg = 'Codex flagged the approach for cascading contention so I deferred the broader refactor and only shipped the smaller test fix. The work is sound but the scope is reduced; will pick up the rest next session.';
    const r = runHook(msg);
    expect(r.code).toBe(2);
  });

  it('exits 2 on "blocked by Codex"', () => {
    const msg = 'The scheduling work is blocked by Codex review pending their second-opinion pass; will pick it up next session. The rest of the task list is green and the briefing card is updated to reflect the partial-ship state.';
    const r = runHook(msg);
    expect(r.code).toBe(2);
  });

  it('exits 0 on the legitimate "Codex flagged X, switching approach" pattern (no deferral)', () => {
    const msg = 'A peer agent raised concern about moving Tests into runOnePass for CPU contention, so I switched approach to a no-progress early exit that addresses the same root cause without touching runOnePass. Shipped, locked, live.';
    const r = runHook(msg);
    expect(r.code).toBe(0);
  });

  it('exits 0 on unrelated uses of "deferred" (deferred field render, deferred tax)', () => {
    const msg = 'The deferred field renders only when the contact has no recent activity. A peer reviewer signed off. Shipped behind a feature flag for the next briefing build, locked by two new regression tests.';
    const r = runHook(msg);
    expect(r.code).toBe(0);
  });

  it('exits 0 on a clean ship message with a peer mention but no deferral coupling', () => {
    const msg = 'Got a peer second-opinion pass on the migration plan, incorporated three of the four risks they raised, shipped. The fourth was about a hypothetical that does not apply here. No scope was reduced; the briefing card reflects the full intent.';
    const r = runHook(msg);
    expect(r.code).toBe(0);
  });
});
