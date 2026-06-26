import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildSelfHealthDigest } from '../self-health-digest';

// Run 145: wires the previously-orphaned task-archive sweep into the
// self-health digest as a DRY-RUN spine-hygiene fold. These lock the category:
// stale active-status tasks are counted and warned, fresh/terminal tasks are
// ignored, the fold NEVER mutates a task or writes a journal (read-only at
// boot), and it stays null/silent when no spine dir is supplied.

const NOW = Date.parse('2026-06-23T06:00:00Z');
const STALE_TS = '2026-05-01T00:00:00Z'; // ~53 days before NOW
const FRESH_TS = '2026-06-23T05:00:00Z'; // 1h before NOW

let srcDir: string;
let tasksDir: string;

function writeTask(name: string, obj: Record<string, ExampleCo>) {
  fs.writeFileSync(path.join(tasksDir, name), JSON.stringify(obj, null, 2));
}

beforeEach(() => {
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-src-'));
  tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-tasks-'));
});

afterEach(() => {
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(tasksDir, { recursive: true, force: true });
});

describe('task-archive spine-hygiene fold', () => {
  it('counts stale active-status tasks and warns at/above the threshold', () => {
    writeTask('a.json', { id: 'a', status: 'running', updatedAt: STALE_TS });
    writeTask('b.json', { id: 'b', status: 'queued', updatedAt: STALE_TS });
    writeTask('c.json', { id: 'c', status: 'awaiting-review', createdAt: STALE_TS });
    writeTask('fresh.json', { id: 'fresh', status: 'running', updatedAt: FRESH_TS });
    writeTask('done.json', { id: 'done', status: 'done', updatedAt: STALE_TS });

    const digest = buildSelfHealthDigest(
      { srcDir, indexContent: 'tiny', taskSweepDir: tasksDir },
      { now: NOW },
    );

    expect(digest.staleTasks).not.toBeNull();
    expect(digest.staleTasks!.scanned).toBe(5);
    expect(digest.staleTasks!.archived).toBe(3); // 3 stale-active; fresh + done excluded
    expect(digest.staleTaskLine).toContain('3 stale active');
    expect(digest.headline).toContain('stale active');
    const warned = digest.warnings.some(
      (w) => w.includes('stale') && w.toLowerCase().includes('zombie'),
    );
    expect(warned).toBe(true);
  });

  it('is DRY-RUN: never mutates a task file or writes a journal', () => {
    writeTask('a.json', { id: 'a', status: 'running', updatedAt: STALE_TS });
    writeTask('b.json', { id: 'b', status: 'queued', updatedAt: STALE_TS });
    writeTask('c.json', { id: 'c', status: 'awaiting-review', updatedAt: STALE_TS });

    buildSelfHealthDigest({ srcDir, indexContent: 'tiny', taskSweepDir: tasksDir }, { now: NOW });

    // task files keep their original status; no 'archived' rewrite happened
    const a = JSON.parse(fs.readFileSync(path.join(tasksDir, 'a.json'), 'utf8'));
    expect(a.status).toBe('running');
    expect(a.archivedAt).toBeUndefined();
    // dry-run journal must not exist
    expect(fs.existsSync(path.join(tasksDir, '.archive-journal-dryrun.jsonl'))).toBe(false);
  });

  it('surfaces the count line without a warning when below the threshold', () => {
    writeTask('a.json', { id: 'a', status: 'running', updatedAt: STALE_TS });
    const digest = buildSelfHealthDigest(
      { srcDir, indexContent: 'tiny', taskSweepDir: tasksDir, staleTaskWarnAt: 99 },
      { now: NOW },
    );
    expect(digest.staleTaskLine).toContain('1 stale active');
    const warned = digest.warnings.some((w) => w.toLowerCase().includes('zombie'));
    expect(warned).toBe(false);
  });

  it('ignores fresh and terminal tasks entirely', () => {
    writeTask('fresh.json', { id: 'fresh', status: 'running', updatedAt: FRESH_TS });
    writeTask('done.json', { id: 'done', status: 'done', updatedAt: STALE_TS });
    writeTask('failed.json', { id: 'failed', status: 'failed', updatedAt: STALE_TS });
    const digest = buildSelfHealthDigest(
      { srcDir, indexContent: 'tiny', taskSweepDir: tasksDir },
      { now: NOW },
    );
    expect(digest.staleTasks!.archived).toBe(0);
    expect(digest.warnings.some((w) => w.toLowerCase().includes('zombie'))).toBe(false);
  });

  it('stays null and silent when no spine dir is supplied', () => {
    const digest = buildSelfHealthDigest({ srcDir, indexContent: 'tiny' }, { now: NOW });
    expect(digest.staleTasks).toBeNull();
    expect(digest.staleTaskLine).toBeNull();
  });

  it('stays null when the spine dir path does not exist', () => {
    const digest = buildSelfHealthDigest(
      {
        srcDir,
        indexContent: 'tiny',
        taskSweepDir: path.join(os.tmpdir(), 'sb-no-such-spine-xyz'),
      },
      { now: NOW },
    );
    expect(digest.staleTasks).toBeNull();
  });
});
