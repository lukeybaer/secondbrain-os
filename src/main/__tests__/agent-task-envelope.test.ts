import { describe, it, expect } from 'vitest';
import {
  createTask,
  transitionTask,
  appendMessage,
  addArtifact,
  summariseTask,
  isTerminal,
  canTransition,
  TaskEnvelopeError,
  TERMINAL_STATES,
} from '../agent-task-envelope';
import type { Message, Artifact, TaskState } from '../agent-task-envelope';

const luke = 'luke' as const;
const claude = 'claude-code' as const;
const codex = 'codex' as const;

describe('createTask', () => {
  it('creates a submitted task with status_history seeded', () => {
    const env = createTask(
      { id: 't1', kind: 'review', from: luke, to: claude },
      new Date('2026-05-11T12:00:00Z'),
    );
    expect(env.state).toBe('submitted');
    expect(env.status_history).toHaveLength(1);
    expect(env.status_history[0].state).toBe('submitted');
    expect(env.status_history[0].by).toBe('luke');
    expect(env.created_at).toBe('2026-05-11T12:00:00.000Z');
    expect(env.updated_at).toBe('2026-05-11T12:00:00.000Z');
    expect(env.history).toEqual([]);
    expect(env.artifacts).toEqual([]);
  });

  it('includes initial message if provided', () => {
    const msg: Message = {
      role: 'user',
      parts: [{ kind: 'text', text: 'review this PR' }],
      ts: '2026-05-11T12:00:00Z',
      from: luke,
    };
    const env = createTask({
      id: 't2',
      kind: 'review',
      from: luke,
      to: claude,
      initial_message: msg,
    });
    expect(env.history).toHaveLength(1);
    expect((env.history[0].parts[0] as any).text).toBe('review this PR');
  });

  it('rejects invalid task id', () => {
    expect(() =>
      createTask({ id: 'has space', kind: 'k', from: luke, to: claude }),
    ).toThrow(TaskEnvelopeError);
    expect(() =>
      createTask({ id: '../etc/passwd', kind: 'k', from: luke, to: claude }),
    ).toThrow(/invalid_id/);
  });

  it('rejects invalid parent_id', () => {
    expect(() =>
      createTask({
        id: 't3',
        kind: 'k',
        from: luke,
        to: claude,
        parent_id: 'bad parent',
      }),
    ).toThrow(/invalid_parent_id/);
  });

  it('rejects empty or too-long kind', () => {
    expect(() => createTask({ id: 't4', kind: '', from: luke, to: claude })).toThrow(/invalid_kind/);
    const long = 'x'.repeat(65);
    expect(() => createTask({ id: 't5', kind: long, from: luke, to: claude })).toThrow(/invalid_kind/);
  });

  it('accepts parent_id for sub-tasks', () => {
    const env = createTask({
      id: 'sub1',
      parent_id: 'parent1',
      kind: 'subtask',
      from: claude,
      to: codex,
    });
    expect(env.parent_id).toBe('parent1');
  });
});

describe('transitionTask', () => {
  function fresh(): ReturnType<typeof createTask> {
    return createTask(
      { id: 't1', kind: 'review', from: luke, to: claude },
      new Date('2026-05-11T12:00:00Z'),
    );
  }

  it('allows submitted -> working', () => {
    const next = transitionTask(fresh(), 'working', claude, {
      now: new Date('2026-05-11T12:01:00Z'),
      note: 'claimed',
    });
    expect(next.state).toBe('working');
    expect(next.status_history).toHaveLength(2);
    expect(next.status_history[1].note).toBe('claimed');
    expect(next.updated_at).toBe('2026-05-11T12:01:00.000Z');
  });

  it('rejects illegal transitions', () => {
    expect(() => transitionTask(fresh(), 'completed', claude)).toThrow(/invalid_transition/);
    expect(() => transitionTask(fresh(), 'input-required', claude)).toThrow(/invalid_transition/);
  });

  it('rejects any transition out of a terminal state', () => {
    let env = transitionTask(fresh(), 'working', claude);
    env = transitionTask(env, 'completed', claude);
    expect(() => transitionTask(env, 'working', claude)).toThrow(/terminal_state/);
    expect(() => transitionTask(env, 'failed', claude)).toThrow(/terminal_state/);
  });

  it('allows working -> input-required -> working round trip', () => {
    let env = transitionTask(fresh(), 'working', claude);
    env = transitionTask(env, 'input-required', claude);
    expect(env.state).toBe('input-required');
    env = transitionTask(env, 'working', claude);
    expect(env.state).toBe('working');
  });

  it('allows submitted -> rejected (peer refuses)', () => {
    const next = transitionTask(fresh(), 'rejected', claude, { note: 'out of scope' });
    expect(next.state).toBe('rejected');
    expect(isTerminal(next.state)).toBe(true);
  });

  it('does not mutate the input envelope', () => {
    const env = fresh();
    const before = JSON.stringify(env);
    transitionTask(env, 'working', claude);
    expect(JSON.stringify(env)).toBe(before);
  });
});

describe('appendMessage', () => {
  function workingTask() {
    let env = createTask({ id: 't1', kind: 'k', from: luke, to: claude });
    env = transitionTask(env, 'working', claude);
    return env;
  }

  it('appends to history and bumps updated_at', () => {
    const env = workingTask();
    const msg: Message = {
      role: 'agent',
      parts: [{ kind: 'text', text: 'on it' }],
      ts: '2026-05-11T12:05:00Z',
      from: claude,
    };
    const next = appendMessage(env, msg);
    expect(next.history).toHaveLength(1);
    expect(next.updated_at).toBe('2026-05-11T12:05:00Z');
  });

  it('rejects append to terminal state', () => {
    let env = workingTask();
    env = transitionTask(env, 'completed', claude);
    expect(() =>
      appendMessage(env, {
        role: 'agent',
        parts: [{ kind: 'text', text: 'late' }],
        ts: '2026-05-11T12:10:00Z',
      }),
    ).toThrow(/terminal_state/);
  });

  it('rejects message with zero parts', () => {
    expect(() =>
      appendMessage(workingTask(), {
        role: 'agent',
        parts: [],
        ts: '2026-05-11T12:05:00Z',
      }),
    ).toThrow(/empty_parts/);
  });

  it('rejects file part without uri or mime', () => {
    expect(() =>
      appendMessage(workingTask(), {
        role: 'agent',
        parts: [{ kind: 'file', uri: '', mime: 'application/pdf' } as any],
        ts: '2026-05-11T12:05:00Z',
      }),
    ).toThrow(/invalid_part/);
    expect(() =>
      appendMessage(workingTask(), {
        role: 'agent',
        parts: [{ kind: 'file', uri: 'file:///x', mime: '' } as any],
        ts: '2026-05-11T12:05:00Z',
      }),
    ).toThrow(/invalid_part/);
  });

  it('accepts data, text, and file parts in one message', () => {
    const next = appendMessage(workingTask(), {
      role: 'agent',
      parts: [
        { kind: 'text', text: 'see attached' },
        { kind: 'data', data: { score: 0.9 } },
        { kind: 'file', uri: 'file:///tmp/x.pdf', mime: 'application/pdf', bytes: 1024 },
      ],
      ts: '2026-05-11T12:05:00Z',
    });
    expect(next.history[0].parts).toHaveLength(3);
  });
});

describe('addArtifact', () => {
  function workingTask() {
    let env = createTask({ id: 't1', kind: 'k', from: luke, to: claude });
    env = transitionTask(env, 'working', claude);
    return env;
  }

  it('appends artifact to artifacts list', () => {
    const art: Artifact = {
      name: 'review.md',
      parts: [{ kind: 'text', text: 'LGTM' }],
      ts: '2026-05-11T12:08:00Z',
    };
    const next = addArtifact(workingTask(), art);
    expect(next.artifacts).toHaveLength(1);
    expect(next.artifacts[0].name).toBe('review.md');
  });

  it('rejects artifact with zero parts', () => {
    expect(() =>
      addArtifact(workingTask(), {
        name: 'empty',
        parts: [],
        ts: '2026-05-11T12:08:00Z',
      }),
    ).toThrow(/empty_artifact/);
  });

  it('allows artifact even when state has gone to completed afterwards', () => {
    let env = workingTask();
    env = addArtifact(env, {
      name: 'r.md',
      parts: [{ kind: 'text', text: 'ok' }],
      ts: '2026-05-11T12:08:00Z',
    });
    env = transitionTask(env, 'completed', claude);
    expect(env.artifacts).toHaveLength(1);
    expect(env.state).toBe('completed');
  });
});

describe('summariseTask', () => {
  it('counts participants from from/to/history/status', () => {
    let env = createTask({ id: 't1', kind: 'k', from: luke, to: claude });
    env = transitionTask(env, 'working', claude);
    env = appendMessage(env, {
      role: 'agent',
      parts: [{ kind: 'text', text: 'asking codex' }],
      ts: '2026-05-11T12:05:00Z',
      from: claude,
    });
    env = appendMessage(env, {
      role: 'agent',
      parts: [{ kind: 'text', text: 'codex says' }],
      ts: '2026-05-11T12:06:00Z',
      from: codex,
    });
    const sum = summariseTask(env);
    expect(sum.participants.sort()).toEqual(['claude-code', 'codex', 'luke']);
    expect(sum.messages).toBe(2);
    expect(sum.artifacts).toBe(0);
    expect(sum.terminal).toBe(false);
  });

  it('computes non-negative age_ms even if updated < created', () => {
    const env = createTask(
      { id: 't1', kind: 'k', from: luke, to: claude },
      new Date('2026-05-11T12:00:00Z'),
    );
    const corrupted = { ...env, updated_at: '2026-05-11T11:00:00Z' };
    expect(summariseTask(corrupted).age_ms).toBe(0);
  });

  it('flags terminal state', () => {
    let env = createTask({ id: 't1', kind: 'k', from: luke, to: claude });
    env = transitionTask(env, 'working', claude);
    env = transitionTask(env, 'failed', claude, { note: 'crashed' });
    expect(summariseTask(env).terminal).toBe(true);
  });
});

describe('isTerminal + canTransition', () => {
  it('isTerminal recognises all four terminal states', () => {
    for (const s of ['completed', 'failed', 'canceled', 'rejected'] as TaskState[]) {
      expect(isTerminal(s)).toBe(true);
      expect(TERMINAL_STATES.has(s)).toBe(true);
    }
    for (const s of ['submitted', 'working', 'input-required'] as TaskState[]) {
      expect(isTerminal(s)).toBe(false);
    }
  });

  it('canTransition matches transitionTask behaviour', () => {
    expect(canTransition('submitted', 'working')).toBe(true);
    expect(canTransition('submitted', 'completed')).toBe(false);
    expect(canTransition('working', 'input-required')).toBe(true);
    expect(canTransition('completed', 'working')).toBe(false);
    expect(canTransition('input-required', 'working')).toBe(true);
    expect(canTransition('input-required', 'completed')).toBe(false);
  });
});
