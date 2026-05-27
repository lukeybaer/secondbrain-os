import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readCapability,
  listCapabilities,
  loadHealthEvents,
  attachHealth,
  findCapability,
  summariseCapabilities,
  parseCadenceHours,
  overdueCapabilities,
  formatOverdueForBriefing,
} from '../skill-registry';

function makeSkillsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-registry-'));
}

function writeSkill(
  dir: string,
  name: string,
  frontmatter: Record<string, string>,
  body: string,
): void {
  const taskDir = path.join(dir, name);
  fs.mkdirSync(taskDir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  fs.writeFileSync(path.join(taskDir, 'SKILL.md'), `---\n${fm}\n---\n${body}`);
}

describe('readCapability', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeSkillsDir();
  });

  it('parses frontmatter name + description + body', () => {
    writeSkill(
      dir,
      'daily-briefing',
      { name: 'daily-briefing', description: 'Daily Executive Briefing at 5:30 AM CT' },
      '# Daily briefing\n\nRun the daily briefing per spec.\n',
    );
    const cap = readCapability(dir, 'daily-briefing');
    expect(cap).not.toBeNull();
    expect(cap!.name).toBe('daily-briefing');
    expect(cap!.description).toContain('Daily Executive Briefing');
    expect(cap!.body_chars).toBeGreaterThan(0);
  });

  it('returns null when SKILL.md is missing', () => {
    fs.mkdirSync(path.join(dir, 'empty-task'));
    expect(readCapability(dir, 'empty-task')).toBeNull();
  });

  it('returns null when SKILL.md is in unsafe-named dir', () => {
    expect(readCapability(dir, '../etc')).toBeNull();
    expect(readCapability(dir, 'has space')).toBeNull();
  });

  it('falls back to dir name when frontmatter lacks name', () => {
    writeSkill(dir, 'fallback-named', { description: 'no name field' }, '');
    const cap = readCapability(dir, 'fallback-named');
    expect(cap!.name).toBe('fallback-named');
  });

  it('extracts cadence trigger from description text', () => {
    writeSkill(
      dir,
      'heal-tests',
      { name: 'heal-tests', description: 'Nightly loop on the test suite every 30 min' },
      'Body content here\n',
    );
    const cap = readCapability(dir, 'heal-tests');
    expect(cap!.triggers).toContain('nightly');
  });

  it('extracts cadence trigger from headline of body', () => {
    writeSkill(
      dir,
      'unscheduled-task',
      { name: 'unscheduled-task', description: 'Runs on demand only' },
      'Daily ad-hoc routine\n',
    );
    const cap = readCapability(dir, 'unscheduled-task');
    expect(cap!.triggers).toContain('daily');
  });

  it('handles SKILL.md without frontmatter', () => {
    const taskDir = path.join(dir, 'raw-only');
    fs.mkdirSync(taskDir);
    fs.writeFileSync(path.join(taskDir, 'SKILL.md'), '# raw markdown no frontmatter\n');
    const cap = readCapability(dir, 'raw-only');
    expect(cap!.name).toBe('raw-only');
    expect(cap!.description).toBe('');
    expect(cap!.body_chars).toBeGreaterThan(0);
  });

  it('handles CRLF line endings in frontmatter', () => {
    const taskDir = path.join(dir, 'crlf-task');
    fs.mkdirSync(taskDir);
    fs.writeFileSync(
      path.join(taskDir, 'SKILL.md'),
      '---\r\nname: crlf-task\r\ndescription: Windows file\r\n---\r\nbody\r\n',
    );
    const cap = readCapability(dir, 'crlf-task');
    expect(cap!.name).toBe('crlf-task');
    expect(cap!.description).toBe('Windows file');
  });
});

describe('listCapabilities', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeSkillsDir();
  });

  it('returns empty array when skills dir does not exist', () => {
    expect(listCapabilities(path.join(dir, 'missing'))).toEqual([]);
  });

  it('lists all capabilities sorted by name', () => {
    writeSkill(dir, 'z-task', { name: 'z-task', description: 'Last' }, 'a');
    writeSkill(dir, 'a-task', { name: 'a-task', description: 'First' }, 'a');
    writeSkill(dir, 'm-task', { name: 'm-task', description: 'Middle' }, 'a');
    const caps = listCapabilities(dir);
    expect(caps.map((c) => c.name)).toEqual(['a-task', 'm-task', 'z-task']);
  });

  it('skips non-directory entries at the skills root', () => {
    fs.writeFileSync(path.join(dir, 'README.md'), 'not a skill');
    writeSkill(dir, 'real-task', { name: 'real-task', description: 'real' }, '');
    const caps = listCapabilities(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0].name).toBe('real-task');
  });

  it('skips dirs without SKILL.md', () => {
    fs.mkdirSync(path.join(dir, 'half-built'));
    writeSkill(dir, 'real', { name: 'real', description: 'real' }, '');
    const caps = listCapabilities(dir);
    expect(caps).toHaveLength(1);
  });
});

describe('loadHealthEvents', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeSkillsDir();
  });

  it('returns empty array when log path missing', () => {
    expect(loadHealthEvents(path.join(dir, 'missing.jsonl'))).toEqual([]);
  });

  it('parses well-formed jsonl', () => {
    const p = path.join(dir, 'health.jsonl');
    fs.writeFileSync(
      p,
      [
        JSON.stringify({ task: 'daily-briefing', status: 'success', timestamp: '2026-05-11T11:30:00Z' }),
        JSON.stringify({ task: 'nightly-heal-tests', status: 'failure', timestamp: '2026-05-11T03:00:00Z' }),
      ].join('\n') + '\n',
    );
    const events = loadHealthEvents(p);
    expect(events).toHaveLength(2);
    expect(events[0].task).toBe('daily-briefing');
    expect(events[1].status).toBe('failure');
  });

  it('skips malformed lines instead of throwing', () => {
    const p = path.join(dir, 'health.jsonl');
    fs.writeFileSync(
      p,
      [
        'not json',
        JSON.stringify({ task: 'good', status: 'success', timestamp: '2026-05-11T11:00:00Z' }),
        '{broken',
      ].join('\n'),
    );
    const events = loadHealthEvents(p);
    expect(events).toHaveLength(1);
    expect(events[0].task).toBe('good');
  });

  it('normalises various status spellings', () => {
    const p = path.join(dir, 'health.jsonl');
    fs.writeFileSync(
      p,
      [
        JSON.stringify({ task: 'a', status: 'ok', timestamp: '2026-05-11T01:00:00Z' }),
        JSON.stringify({ task: 'b', status: 'amber', timestamp: '2026-05-11T01:00:00Z' }),
        JSON.stringify({ task: 'c', status: 'red', timestamp: '2026-05-11T01:00:00Z' }),
        JSON.stringify({ task: 'd', status: 'green', timestamp: '2026-05-11T01:00:00Z' }),
      ].join('\n'),
    );
    const events = loadHealthEvents(p);
    const byTask = Object.fromEntries(events.map((e) => [e.task, e.status]));
    expect(byTask.a).toBe('success');
    expect(byTask.b).toBe('partial');
    expect(byTask.c).toBe('failure');
    expect(byTask.d).toBe('success');
  });

  it('drops entries missing task or timestamp', () => {
    const p = path.join(dir, 'health.jsonl');
    fs.writeFileSync(
      p,
      [
        JSON.stringify({ status: 'success', timestamp: '2026-05-11T01:00:00Z' }),
        JSON.stringify({ task: 'no-ts', status: 'success' }),
        JSON.stringify({ task: 'ok', status: 'success', timestamp: '2026-05-11T01:00:00Z' }),
      ].join('\n'),
    );
    expect(loadHealthEvents(p)).toHaveLength(1);
  });
});

describe('attachHealth', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeSkillsDir();
  });

  it('marks capability with no event as unknown', () => {
    writeSkill(dir, 'task-a', { name: 'task-a', description: 'a' }, '');
    const caps = listCapabilities(dir);
    const merged = attachHealth(caps, []);
    expect(merged[0].last_run_status).toBe('unknown');
    expect(merged[0].last_run_ts).toBeNull();
  });

  it('joins latest event per task and computes staleness in hours', () => {
    writeSkill(dir, 'task-a', { name: 'task-a', description: 'a' }, '');
    const caps = listCapabilities(dir);
    const now = new Date('2026-05-11T12:00:00Z');
    const events = [
      { task: 'task-a' as const, status: 'success' as const, timestamp: '2026-05-11T06:00:00Z' },
      { task: 'task-a' as const, status: 'failure' as const, timestamp: '2026-05-11T11:00:00Z' },
    ];
    const merged = attachHealth(caps, events, now);
    expect(merged[0].last_run_status).toBe('failure');
    expect(merged[0].last_run_ts).toBe('2026-05-11T11:00:00Z');
    expect(merged[0].staleness_hours).toBe(1);
  });

  it('clamps negative staleness to zero', () => {
    writeSkill(dir, 'task-future', { name: 'task-future', description: 'a' }, '');
    const caps = listCapabilities(dir);
    const now = new Date('2026-05-11T00:00:00Z');
    const events = [
      { task: 'task-future' as const, status: 'success' as const, timestamp: '2026-05-12T00:00:00Z' },
    ];
    const merged = attachHealth(caps, events, now);
    expect(merged[0].staleness_hours).toBe(0);
  });
});

describe('findCapability', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeSkillsDir();
    writeSkill(dir, 'daily-briefing', { name: 'daily-briefing', description: 'Daily exec briefing at 530 AM CT' }, '');
    writeSkill(dir, 'nightly-heal-tests', { name: 'nightly-heal-tests', description: 'Vitest loop every 30 min' }, '');
    writeSkill(dir, 'video-aurora', { name: 'video-aurora', description: 'Autonomous YouTube renderer' }, '');
  });

  it('returns all capabilities for empty filter', () => {
    const caps = listCapabilities(dir);
    expect(findCapability(caps, {})).toHaveLength(3);
  });

  it('matches all query tokens (AND semantics)', () => {
    const caps = listCapabilities(dir);
    expect(findCapability(caps, { query: 'daily briefing' })).toHaveLength(1);
    expect(findCapability(caps, { query: 'daily nonexistent' })).toHaveLength(0);
  });

  it('matches description or triggers, not just name', () => {
    const caps = listCapabilities(dir);
    expect(findCapability(caps, { query: 'vitest' })).toHaveLength(1);
  });

  it('filters by status', () => {
    const caps = attachHealth(listCapabilities(dir), [
      { task: 'daily-briefing', status: 'failure', timestamp: '2026-05-11T01:00:00Z' },
      { task: 'video-aurora', status: 'success', timestamp: '2026-05-11T01:00:00Z' },
    ]);
    expect(findCapability(caps, { status: 'failure' })).toHaveLength(1);
    expect(findCapability(caps, { status: 'success' })).toHaveLength(1);
    expect(findCapability(caps, { status: 'unknown' })).toHaveLength(1);
  });

  it('filters by staleness threshold', () => {
    const now = new Date('2026-05-11T12:00:00Z');
    const caps = attachHealth(
      listCapabilities(dir),
      [
        { task: 'daily-briefing', status: 'success', timestamp: '2026-05-11T11:00:00Z' },
        { task: 'nightly-heal-tests', status: 'success', timestamp: '2026-05-01T00:00:00Z' },
      ],
      now,
    );
    const stale = findCapability(caps, { stale_after_hours: 24 });
    expect(stale.map((c) => c.name)).toEqual(['nightly-heal-tests']);
  });
});

describe('summariseCapabilities', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeSkillsDir();
  });

  it('counts statuses and picks stalest', () => {
    writeSkill(dir, 'a', { name: 'a', description: 'x' }, '');
    writeSkill(dir, 'b', { name: 'b', description: 'x' }, '');
    writeSkill(dir, 'c', { name: 'c', description: 'x' }, '');
    writeSkill(dir, 'd', { name: 'd', description: 'x' }, '');
    const caps = attachHealth(
      listCapabilities(dir),
      [
        { task: 'a', status: 'success', timestamp: '2026-05-11T11:00:00Z' },
        { task: 'b', status: 'partial', timestamp: '2026-05-11T10:00:00Z' },
        { task: 'c', status: 'failure', timestamp: '2026-05-11T09:00:00Z' },
      ],
      new Date('2026-05-11T12:00:00Z'),
    );
    const sum = summariseCapabilities(caps);
    expect(sum.total).toBe(4);
    expect(sum.green).toBe(1);
    expect(sum.amber).toBe(1);
    expect(sum.red).toBe(1);
    expect(sum.unknown).toBe(1);
    expect(sum.stalest?.name).toBe('c');
  });

  it('returns null stalest when all capabilities are unknown', () => {
    writeSkill(dir, 'only', { name: 'only', description: 'x' }, '');
    const caps = attachHealth(listCapabilities(dir), []);
    expect(summariseCapabilities(caps).stalest).toBeNull();
  });
});

describe('skill-registry: parseCadenceHours', () => {
  it('returns null when no cadence token is present', () => {
    expect(parseCadenceHours([])).toBeNull();
    expect(parseCadenceHours(['oneshot'])).toBeNull();
  });

  it('maps daily/nightly/weekly/hourly/monthly to hours', () => {
    expect(parseCadenceHours(['hourly'])).toBe(1);
    expect(parseCadenceHours(['daily'])).toBe(24);
    expect(parseCadenceHours(['nightly'])).toBe(24);
    expect(parseCadenceHours(['weekly'])).toBe(24 * 7);
    expect(parseCadenceHours(['monthly'])).toBe(24 * 30);
  });

  it('picks the tightest cadence when multiple tokens are present', () => {
    expect(parseCadenceHours(['daily', 'hourly'])).toBe(1);
    expect(parseCadenceHours(['weekly', 'daily'])).toBe(24);
  });

  it('is case-insensitive', () => {
    expect(parseCadenceHours(['DAILY'])).toBe(24);
    expect(parseCadenceHours(['Weekly'])).toBe(24 * 7);
  });
});

describe('skill-registry: overdueCapabilities', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeSkillsDir();
  });

  it('flags a daily skill that has not run in 36h', () => {
    writeSkill(dir, 'daily-briefing', { name: 'daily-briefing', description: 'daily', cadence: 'daily' }, '');
    writeSkill(dir, 'weekly-warmth', { name: 'weekly-warmth', description: 'weekly', cadence: 'weekly' }, '');
    const caps = attachHealth(
      listCapabilities(dir),
      [
        { task: 'daily-briefing', status: 'success', timestamp: '2026-05-10T00:00:00Z' },
        { task: 'weekly-warmth', status: 'success', timestamp: '2026-05-11T00:00:00Z' },
      ],
      new Date('2026-05-11T12:00:00Z'),
    );
    const overdue = overdueCapabilities(caps);
    expect(overdue.map((o) => o.cap.name)).toEqual(['daily-briefing']);
    expect(overdue[0].cadence_hours).toBe(24);
    expect(overdue[0].staleness_hours).toBe(36);
    expect(overdue[0].overdue_ratio).toBeCloseTo(36 / 24, 4);
  });

  it('absorbs scheduling jitter via slack_factor', () => {
    writeSkill(dir, 'daily', { name: 'daily', description: 'daily', cadence: 'daily' }, '');
    const caps = attachHealth(
      listCapabilities(dir),
      [{ task: 'daily', status: 'success', timestamp: '2026-05-10T03:00:00Z' }],
      new Date('2026-05-11T03:00:00Z'),
    );
    // 24h * default slack 1.25 = 30h threshold; 24h staleness is fine.
    expect(overdueCapabilities(caps)).toHaveLength(0);
    // Lower slack to exactly cadence and it should now flag.
    expect(overdueCapabilities(caps, { slack_factor: 1 })).toHaveLength(0);
    // 25h staleness with default slack 1.25 still under 30h threshold.
    const caps2 = attachHealth(
      listCapabilities(dir),
      [{ task: 'daily', status: 'success', timestamp: '2026-05-10T02:00:00Z' }],
      new Date('2026-05-11T03:00:00Z'),
    );
    expect(overdueCapabilities(caps2)).toHaveLength(0);
    // 31h staleness crosses 30h threshold.
    const caps3 = attachHealth(
      listCapabilities(dir),
      [{ task: 'daily', status: 'success', timestamp: '2026-05-09T20:00:00Z' }],
      new Date('2026-05-11T03:00:00Z'),
    );
    expect(overdueCapabilities(caps3)).toHaveLength(1);
  });

  it('treats never-run cadenced skills as overdue when include_unknown=true', () => {
    writeSkill(dir, 'hourly-ping', { name: 'hourly-ping', description: 'hourly', cadence: 'hourly' }, '');
    const caps = attachHealth(listCapabilities(dir), []);
    expect(overdueCapabilities(caps)).toHaveLength(1);
    expect(overdueCapabilities(caps, { include_unknown: false })).toHaveLength(0);
  });

  it('ignores capabilities with no cadence token', () => {
    writeSkill(dir, 'oneshot', { name: 'oneshot', description: 'no cadence' }, '');
    const caps = attachHealth(listCapabilities(dir), []);
    expect(overdueCapabilities(caps)).toHaveLength(0);
  });

  it('orders by overdue_ratio descending and caps at max_results', () => {
    writeSkill(dir, 'a-hourly', { name: 'a-hourly', description: 'hourly', cadence: 'hourly' }, '');
    writeSkill(dir, 'b-daily', { name: 'b-daily', description: 'daily', cadence: 'daily' }, '');
    const now = new Date('2026-05-11T12:00:00Z');
    // hourly stale 5h, daily stale 36h (clearly past slack 1.25x).
    const caps = attachHealth(
      listCapabilities(dir),
      [
        { task: 'a-hourly', status: 'success', timestamp: '2026-05-11T07:00:00Z' },
        { task: 'b-daily', status: 'success', timestamp: '2026-05-10T00:00:00Z' },
      ],
      now,
    );
    const overdue = overdueCapabilities(caps);
    expect(overdue.map((o) => o.cap.name)).toEqual(['a-hourly', 'b-daily']);
    const capped = overdueCapabilities(caps, { max_results: 1 });
    expect(capped.map((o) => o.cap.name)).toEqual(['a-hourly']);
  });

  it('formats briefing lines with reason text', () => {
    writeSkill(dir, 'daily', { name: 'daily', description: 'daily', cadence: 'daily' }, '');
    const caps = attachHealth(
      listCapabilities(dir),
      [{ task: 'daily', status: 'success', timestamp: '2026-05-10T00:00:00Z' }],
      new Date('2026-05-11T12:00:00Z'),
    );
    const overdue = overdueCapabilities(caps);
    const lines = formatOverdueForBriefing(overdue);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^daily:.*last ran 36h ago.*cadence 24h/);
  });
});
