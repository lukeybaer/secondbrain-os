import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ToolDescriptor,
  tokenize,
  route,
  recordRoute,
  makeRouteFileWriter,
} from '../tool-router';

const TOOLS: ReadonlyArray<ToolDescriptor> = [
  {
    name: 'otter',
    description:
      'Otter transcripts of Luke\'s meetings and dictated conversations indexed by date.',
    tags: ['otter', 'transcript', 'meeting', 'dictation'],
    surfaces: ['vapi', 'cli'],
  },
  {
    name: 'gmail',
    description: 'Gmail messages, threads, and labels searchable by query.',
    tags: ['gmail', 'email', 'inbox', 'thread'],
    surfaces: ['cli'],
  },
  {
    name: 'web_search',
    description: 'External web search engine for news and documentation.',
    tags: ['web', 'search', 'external', 'news'],
    surfaces: ['cli'],
  },
];

describe('tokenize', () => {
  it('strips stopwords and short tokens', () => {
    const toks = tokenize('What is the meaning of a transcript today');
    expect(toks).not.toContain('what');
    expect(toks).not.toContain('is');
    expect(toks).not.toContain('the');
    expect(toks).not.toContain('a');
    expect(toks).toContain('meaning');
    expect(toks).toContain('transcript');
    expect(toks).toContain('today');
  });

  it('lowercases', () => {
    expect(tokenize('OTTER Transcript')).toEqual(['otter', 'transcript']);
  });

  it('returns empty for pure stopwords', () => {
    expect(tokenize('what is the a it on')).toEqual([]);
  });
});

describe('route', () => {
  it('selects the matching tool above threshold', () => {
    const result = route('show me my Otter transcripts from today', TOOLS);
    expect(result.selected).not.toBeNull();
    expect(result.selected!.tool.name).toBe('otter');
  });

  it('returns ranked candidates best-first', () => {
    const result = route('search gmail inbox messages', TOOLS, { top_k: 3 });
    expect(result.candidates[0].tool.name).toBe('gmail');
    expect(result.candidates[0].score).toBeGreaterThan(0);
    // candidates should be sorted descending
    for (let i = 1; i < result.candidates.length; i++) {
      expect(result.candidates[i - 1].score).toBeGreaterThanOrEqual(result.candidates[i].score);
    }
  });

  it('respects surface filter', () => {
    const result = route('search gmail', TOOLS, { surface: 'vapi' });
    // gmail is cli-only, so on vapi surface it must not be in the registry
    for (const c of result.candidates) {
      expect(c.tool.name).not.toBe('gmail');
    }
  });

  it('returns selected=null when nothing clears the threshold', () => {
    const result = route('quantum entanglement', TOOLS, { confidence_threshold: 0.5 });
    expect(result.selected).toBeNull();
  });

  it('honors top_k', () => {
    const result = route('something', TOOLS, { top_k: 2 });
    expect(result.candidates.length).toBeLessThanOrEqual(2);
  });

  it('applies bias to favored tools', () => {
    const biased: ReadonlyArray<ToolDescriptor> = [
      ...TOOLS,
      {
        name: 'biased_tool',
        description: 'A neutral tool with little match.',
        bias: 1.0,
      },
    ];
    const result = route('completely unrelated', biased);
    // biased_tool should bubble to the top thanks to +1 bias
    expect(result.candidates[0].tool.name).toBe('biased_tool');
  });
});

describe('recordRoute', () => {
  it('appends a JSON line to the writer', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-router-'));
    const file = path.join(tmp, 'routes.jsonl');
    const writer = makeRouteFileWriter(file);
    const result = route('show otter transcripts', TOOLS);
    const record = recordRoute(result, writer);
    expect(record.selected_tool).toBe('otter');
    const content = fs.readFileSync(file, 'utf8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.selected_tool).toBe('otter');
    expect(Array.isArray(parsed.candidates)).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writer captures candidate scores', () => {
    const calls: unknown[] = [];
    const writer = (r: unknown) => calls.push(r);
    const result = route('gmail email', TOOLS);
    recordRoute(result, writer);
    expect(calls.length).toBe(1);
    const r = calls[0] as { candidates: { name: string; score: number }[] };
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(typeof r.candidates[0].score).toBe('number');
  });

  it('record carries the excluded_deprecated count', () => {
    const calls: { excluded_deprecated: number }[] = [];
    const result = route('otter transcript', DEPRECATED_TOOLS);
    recordRoute(result, (r) => calls.push(r as { excluded_deprecated: number }));
    expect(calls[0].excluded_deprecated).toBe(1);
  });
});

const DEPRECATED_TOOLS: ReadonlyArray<ToolDescriptor> = [
  {
    name: 'otter_v1',
    description: 'Legacy otter transcript reader for meetings and dictation.',
    tags: ['otter', 'transcript', 'meeting'],
    deprecated: true,
    replaced_by: 'otter_v2',
  },
  {
    name: 'otter_v2',
    description: 'Otter transcript reader for meetings and dictated conversations.',
    tags: ['otter', 'transcript', 'meeting', 'dictation'],
  },
];

describe('route deprecation handling', () => {
  it('excludes deprecated tools from scoring by default', () => {
    const result = route('otter transcript', DEPRECATED_TOOLS);
    const names = result.candidates.map((c) => c.tool.name);
    expect(names).not.toContain('otter_v1');
    expect(result.selected?.tool.name).toBe('otter_v2');
    expect(result.excluded_deprecated).toBe(1);
  });

  it('never selects a deprecated tool even when it is the best lexical match', () => {
    const onlyDeprecated: ReadonlyArray<ToolDescriptor> = [
      { ...DEPRECATED_TOOLS[0] },
    ];
    const result = route('legacy otter transcript meeting', onlyDeprecated);
    expect(result.selected).toBeNull();
    expect(result.candidates).toHaveLength(0);
    expect(result.excluded_deprecated).toBe(1);
  });

  it('includes deprecated tools when include_deprecated is true', () => {
    const result = route('otter transcript', DEPRECATED_TOOLS, {
      include_deprecated: true,
    });
    const names = result.candidates.map((c) => c.tool.name);
    expect(names).toContain('otter_v1');
    expect(result.excluded_deprecated).toBe(0);
  });

  it('only counts deprecated tools that pass the surface filter', () => {
    const mixed: ReadonlyArray<ToolDescriptor> = [
      { name: 'a', description: 'alpha tool', deprecated: true, surfaces: ['cli'] },
      { name: 'b', description: 'beta tool', deprecated: true, surfaces: ['vapi'] },
      { name: 'c', description: 'gamma tool' },
    ];
    const result = route('alpha beta gamma', mixed, { surface: 'cli' });
    // only the cli-surfaced deprecated tool 'a' is counted
    expect(result.excluded_deprecated).toBe(1);
  });
});
