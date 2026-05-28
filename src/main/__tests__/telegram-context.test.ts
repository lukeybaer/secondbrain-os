import { describe, it, expect } from 'vitest';
import {
  matchMessageContext,
  type ContextSources,
} from '../telegram-context';

const sources: ContextSources = {
  tasks: [
    {
      id: 'task-dentist',
      title: 'Find dentist in McKinney without X-rays',
      prompt: 'Research dentists near McKinney and call them about a cleaning.',
      status: 'running',
    },
    {
      id: 'task-old',
      title: 'Archive last quarter receipts',
      prompt: 'Move old receipt PDFs into the archive folder.',
      status: 'done',
    },
  ],
  projects: [
    { id: 'proj-pixseat', name: 'PixSeat Stadium Launch' },
    { id: 'proj-itm', name: 'ITM Recovery App' },
  ],
  sessions: [
    { id: 'sess-fargate', summary: 'AWS Fargate vCPU quota request investigation' },
    { id: 'sess-briefing', summary: 'Daily briefing dashboard card refresh work' },
  ],
};

describe('matchMessageContext', () => {
  it('matches the replied-to thread using reply text', () => {
    const result = matchMessageContext(
      {
        text: 'Yes go ahead with that',
        replyToMessageId: 42,
        replyToText: 'Should I request the AWS Fargate vCPU quota increase?',
      },
      sources,
    );
    expect(result.kind).toBe('session');
    expect(result.ref).toBe('sess-fargate');
    expect(result.confidence).toBeGreaterThan(0.34);
  });

  it('matches a project named in the message', () => {
    const result = matchMessageContext(
      { text: 'How is the PixSeat stadium launch going?' },
      sources,
    );
    expect(result.kind).toBe('project');
    expect(result.ref).toBe('proj-pixseat');
  });

  it('matches an in-flight task named in the message', () => {
    const result = matchMessageContext(
      { text: 'Any update on the dentist in McKinney?' },
      sources,
    );
    expect(result.kind).toBe('task');
    expect(result.ref).toBe('task-dentist');
  });

  it('returns kind none for an ambiguous message', () => {
    const result = matchMessageContext(
      { text: 'Sounds good, thanks' },
      sources,
    );
    expect(result.kind).toBe('none');
    expect(result.ref).toBe('');
    expect(result.confidence).toBe(0);
  });
});
