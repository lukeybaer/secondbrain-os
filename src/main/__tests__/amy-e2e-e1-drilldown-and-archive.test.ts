// E1-K5 (Amy E2E overhaul manifest): drilldown levels + archive sweep.
// Archive half (landed Phase 0 quick win): the sweep marks stale non-running
// tasks archived with a rollback journal, never touches fresh or terminal
// tasks, and the journal restores exactly what it changed. Category: bulk
// state mutations on the spine must be journaled and reversible.
// Drilldown half is added in Phase 1 (about -> 3 ExampleCoraphs -> full history).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shouldArchiveTask, sweepArchive, rollbackSweep } from '../task-archive';
import { buildAmyProjectsView, buildTaskDrilldown } from '../amy-projects';

const NOW = Date.parse('2026-06-11T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86400000).toISOString();

let dir: string;
let journal: string;

function writeTask(id: string, task: Record<string, ExampleCo>) {
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, ...task }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-sweep-'));
  journal = path.join(dir, 'journal.jsonl');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('E1-K5 archive sweep (journaled, reversible)', () => {
  it('archives only stale active-ish tasks; terminal and fresh tasks untouched', () => {
    expect(shouldArchiveTask({ status: 'queued', updatedAt: daysAgo(30) }, NOW).archive).toBe(true);
    expect(shouldArchiveTask({ status: 'running', updatedAt: daysAgo(10) }, NOW).archive).toBe(
      true,
    );
    expect(
      shouldArchiveTask({ status: 'awaiting-review', createdAt: daysAgo(8) }, NOW).archive,
    ).toBe(true);
    // fresh active task (live session heartbeat) stays
    expect(shouldArchiveTask({ status: 'running', updatedAt: daysAgo(0.5) }, NOW).archive).toBe(
      false,
    );
    // terminal history stays terminal, never rewritten
    for (const status of ['done', 'failed', 'cancelled', 'removed_non_actionable', 'archived']) {
      expect(shouldArchiveTask({ status, updatedAt: daysAgo(100) }, NOW).archive).toBe(false);
    }
    // garbage in, no archive out
    expect(shouldArchiveTask({ status: 'queued' }, NOW).archive).toBe(false);
  });

  it('sweep journals every change and rollback restores exactly the prior statuses', () => {
    writeTask('stale-q', { status: 'queued', updatedAt: daysAgo(40) });
    writeTask('stale-r', { status: 'running', updatedAt: daysAgo(12) });
    writeTask('fresh-q', { status: 'queued', updatedAt: daysAgo(1) });
    writeTask('done-old', { status: 'done', updatedAt: daysAgo(90) });

    const dry = sweepArchive(dir, NOW, journal, { dryRun: true });
    expect(dry.archived).toBe(2);
    expect(fs.existsSync(journal)).toBe(false); // dry run mutates nothing
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'stale-q.json'), 'utf8')).status).toBe(
      'queued',
    );

    const real = sweepArchive(dir, NOW, journal);
    expect(real.archived).toBe(2);
    expect(real.archivedIds.sort()).toEqual(['stale-q', 'stale-r']);
    const archived = JSON.parse(fs.readFileSync(path.join(dir, 'stale-q.json'), 'utf8'));
    expect(archived.status).toBe('archived');
    expect(archived.archivedFrom).toBe('queued');
    expect(archived.archiveReason).toMatch(/stale-\d+d-queued/);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'fresh-q.json'), 'utf8')).status).toBe(
      'queued',
    );
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'done-old.json'), 'utf8')).status).toBe(
      'done',
    );

    // second sweep is idempotent (archived is not active)
    expect(sweepArchive(dir, NOW, journal).archived).toBe(0);

    const restored = rollbackSweep(dir, journal);
    expect(restored).toBe(2);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'stale-q.json'), 'utf8')).status).toBe(
      'queued',
    );
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'stale-r.json'), 'utf8')).status).toBe(
      'running',
    );
  });
});

describe('E1-K5 Amy Projects drilldown', () => {
  it('serves one-line, three-ExampleCoraph, and full-history views with active count from the spine', () => {
    const task = {
      id: 'drilldown-1',
      kind: 'action',
      origin: 'telegram',
      prompt: 'Find the three best options and report back.',
      title: 'Find best options',
      status: 'awaiting-review',
      createdAt: '2026-06-12T12:00:00.000Z',
      updatedAt: '2026-06-12T12:03:00.000Z',
      resultSummary: 'TLDR: option B is strongest.',
      history: [
        { status: 'queued', ts: '2026-06-12T12:00:00.000Z' },
        { status: 'running', ts: '2026-06-12T12:01:00.000Z' },
        { status: 'awaiting-review', ts: '2026-06-12T12:03:00.000Z', note: 'ExampleCo review pending' },
      ],
    } as any;

    const drilldown = buildTaskDrilldown(task);
    expect(drilldown.oneLine).toBe('TLDR: option B is strongest.');
    expect(drilldown.ExampleCoraphs).toHaveLength(3);
    expect(drilldown.ExampleCoraphs[0]).toContain('Awaiting review');
    expect(drilldown.fullHistory).toHaveLength(3);
    expect(drilldown.fullHistory[2]).toContain('ExampleCo review pending');

    const view = buildAmyProjectsView([task]);
    expect(view.activeCount).toBe(1);
    expect(view.rows[0].visibleStatusLabel).toBe('Awaiting review');
  });
});
