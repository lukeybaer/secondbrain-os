import { describe, it, expect, beforeEach } from 'vitest';
import {
  openOutput,
  recordInput,
  recordSibling,
  lineage,
  whyContains,
  impactedOutputs,
  dependencySummary,
  InMemoryProvenanceStore,
} from '../output-provenance-graph';

const fixedNow = () => new Date('2026-05-14T06:00:00.000Z');

describe('output-provenance-graph: openOutput', () => {
  it('creates an output node and stores it', () => {
    const store = new InMemoryProvenanceStore();
    const n = openOutput(store, {
      surface: 'briefing',
      label: 'news section',
      ref: 'briefing-2026-05-14:news',
      now: fixedNow,
    });
    expect(n.kind).toBe('output');
    expect(n.surface).toBe('briefing');
    const loaded = store.getNode(n.id);
    expect(loaded?.label).toBe('news section');
  });

  it('is idempotent on (kind, label, ref)', () => {
    const store = new InMemoryProvenanceStore();
    const a = openOutput(store, {
      surface: 'briefing',
      label: 'news',
      ref: 'briefing:news',
    });
    const b = openOutput(store, {
      surface: 'briefing',
      label: 'news',
      ref: 'briefing:news',
    });
    expect(a.id).toBe(b.id);
    expect(store.size().nodes).toBe(1);
  });
});

describe('output-provenance-graph: recordInput', () => {
  it('records an input edge with default weight 1.0', () => {
    const store = new InMemoryProvenanceStore();
    const out = openOutput(store, { surface: 'briefing', label: 'news' });
    recordInput(store, {
      output_id: out.id,
      kind: 'tool_call',
      label: 'fetch-news',
      ref: 'tool:fetch-news#42',
    });
    const inbound = store.inboundEdges(out.id);
    expect(inbound.length).toBe(1);
    expect(inbound[0].weight).toBe(1.0);
  });

  it('clamps out-of-range weights to 0..1', () => {
    const store = new InMemoryProvenanceStore();
    const out = openOutput(store, { surface: 'briefing', label: 'news' });
    recordInput(store, {
      output_id: out.id,
      kind: 'memory_read',
      label: 'user_companies.md',
      weight: 5,
    });
    recordInput(store, {
      output_id: out.id,
      kind: 'memory_read',
      label: 'user_wife_family.md',
      weight: -1,
    });
    const edges = store.inboundEdges(out.id);
    expect(edges.find((e) => e.note === undefined)).toBeDefined();
    expect(edges.every((e) => e.weight >= 0 && e.weight <= 1)).toBe(true);
  });

  it('is idempotent on input (kind, label, ref) - merges weight', () => {
    const store = new InMemoryProvenanceStore();
    const out = openOutput(store, { surface: 'briefing', label: 'news' });
    recordInput(store, {
      output_id: out.id,
      kind: 'memory_read',
      label: 'user_companies.md',
      ref: 'memory/user_companies.md',
      weight: 0.3,
    });
    recordInput(store, {
      output_id: out.id,
      kind: 'memory_read',
      label: 'user_companies.md',
      ref: 'memory/user_companies.md',
      weight: 0.7,
    });
    // Same input, same output -> single edge, max weight kept.
    const edges = store.inboundEdges(out.id);
    expect(edges.length).toBe(1);
    expect(edges[0].weight).toBe(0.7);
  });
});

describe('output-provenance-graph: lineage', () => {
  let store: InMemoryProvenanceStore;
  beforeEach(() => {
    store = new InMemoryProvenanceStore();
  });

  it('walks upstream from an output and returns nodes + edges', async () => {
    const out = openOutput(store, { surface: 'briefing', label: 'news' });
    recordInput(store, {
      output_id: out.id,
      kind: 'tool_call',
      label: 'fetch-news',
      ref: 'tool:fetch-news#42',
    });
    recordInput(store, {
      output_id: out.id,
      kind: 'memory_read',
      label: 'user_companies.md',
      ref: 'memory/user_companies.md',
    });
    const slice = await lineage(store, out.id);
    expect(slice.root.id).toBe(out.id);
    expect(slice.nodes.length).toBe(2);
    expect(slice.edges.length).toBe(2);
    expect(slice.truncated).toBe(false);
  });

  it('walks transitive chains across sibling outputs', async () => {
    // News section reuses a sub-output (mortgage-rates) which itself has
    // its own tool call. lineage(news, depth=4) should reach that
    // grand-parent tool call.
    const news = openOutput(store, { surface: 'briefing', label: 'news' });
    const mortgage = openOutput(store, {
      surface: 'briefing',
      label: 'mortgage-rates',
    });
    recordSibling(store, news.id, mortgage.id, 0.8);
    recordInput(store, {
      output_id: mortgage.id,
      kind: 'tool_call',
      label: 'fetch-rates',
      ref: 'tool:fetch-rates#7',
    });
    const slice = await lineage(store, news.id, { depth: 4 });
    const labels = slice.nodes.map((n) => n.label);
    expect(labels).toContain('mortgage-rates');
    expect(labels).toContain('fetch-rates');
  });

  it('truncates when max_nodes is hit', async () => {
    const out = openOutput(store, { surface: 'briefing', label: 'news' });
    for (let i = 0; i < 10; i++) {
      recordInput(store, {
        output_id: out.id,
        kind: 'tool_call',
        label: `tool-${i}`,
        ref: `tool:${i}`,
      });
    }
    const slice = await lineage(store, out.id, { max_nodes: 5 });
    expect(slice.nodes.length).toBeLessThanOrEqual(5);
    expect(slice.truncated).toBe(true);
  });

  it('throws when the root output does not exist', async () => {
    await expect(lineage(store, 'nonexistent')).rejects.toThrow(
      /output node not found/
    );
  });
});

describe('output-provenance-graph: whyContains', () => {
  it('finds inputs by label substring', async () => {
    const store = new InMemoryProvenanceStore();
    const out = openOutput(store, { surface: 'briefing', label: 'news' });
    recordInput(store, {
      output_id: out.id,
      kind: 'memory_read',
      label: 'user_companies.md',
      ref: 'memory/user_companies.md',
    });
    recordInput(store, {
      output_id: out.id,
      kind: 'memory_read',
      label: 'user_wife_family.md',
      ref: 'memory/user_wife_family.md',
    });
    const matches = await whyContains(store, out.id, 'companies');
    expect(matches.length).toBe(1);
    expect(matches[0].label).toContain('companies');
  });

  it('searches across ref and string meta fields', async () => {
    const store = new InMemoryProvenanceStore();
    const out = openOutput(store, { surface: 'briefing', label: 'news' });
    recordInput(store, {
      output_id: out.id,
      kind: 'evidence',
      label: 'gmail thread',
      ref: 'gmail:thread-12345',
      meta: { topic: 'quarterly-revenue-review' },
    });
    const matches = await whyContains(store, out.id, 'revenue');
    expect(matches.length).toBe(1);
  });
});

describe('output-provenance-graph: impactedOutputs', () => {
  it('returns outputs reachable forward from an input', async () => {
    const store = new InMemoryProvenanceStore();
    const newsId = openOutput(store, { surface: 'briefing', label: 'news' }).id;
    const callId = openOutput(store, { surface: 'call', label: 'dentist-3' }).id;
    const memoryId = recordInput(store, {
      output_id: newsId,
      kind: 'memory_read',
      label: 'user_companies.md',
      ref: 'memory/user_companies.md',
    });
    // Same memory file feeds another output.
    recordInput(store, {
      output_id: callId,
      kind: 'memory_read',
      label: 'user_companies.md',
      ref: 'memory/user_companies.md',
    });
    const impacted = await impactedOutputs(store, memoryId);
    const labels = impacted.map((n) => n.label).sort();
    expect(labels).toEqual(['dentist-3', 'news']);
  });

  it('bounds traversal by depth', async () => {
    const store = new InMemoryProvenanceStore();
    // chain: A -> B -> C -> D (D is the output)
    const d = openOutput(store, { surface: 'briefing', label: 'D' });
    const c = openOutput(store, { surface: 'briefing', label: 'C' });
    const b = openOutput(store, { surface: 'briefing', label: 'B' });
    const a = openOutput(store, { surface: 'briefing', label: 'A' });
    recordSibling(store, d.id, c.id);
    recordSibling(store, c.id, b.id);
    recordSibling(store, b.id, a.id);
    const shallow = await impactedOutputs(store, a.id, { depth: 1 });
    expect(shallow.map((n) => n.label)).toEqual(['B']);
    const deep = await impactedOutputs(store, a.id, { depth: 3 });
    expect(deep.map((n) => n.label).sort()).toEqual(['B', 'C', 'D']);
  });
});

describe('output-provenance-graph: dependencySummary', () => {
  it('ranks inputs by total edge weight', async () => {
    const store = new InMemoryProvenanceStore();
    const out = openOutput(store, { surface: 'briefing', label: 'news' });
    recordInput(store, {
      output_id: out.id,
      kind: 'memory_read',
      label: 'A',
      weight: 0.2,
    });
    recordInput(store, {
      output_id: out.id,
      kind: 'memory_read',
      label: 'B',
      weight: 0.9,
    });
    recordInput(store, {
      output_id: out.id,
      kind: 'memory_read',
      label: 'C',
      weight: 0.5,
    });
    const summary = await dependencySummary(store, out.id);
    expect(summary.map((s) => s.node.label)).toEqual(['B', 'C', 'A']);
  });
});

describe('output-provenance-graph: InMemoryProvenanceStore', () => {
  it('listOutputs filters by surface', () => {
    const store = new InMemoryProvenanceStore();
    openOutput(store, { surface: 'briefing', label: 'news' });
    openOutput(store, { surface: 'briefing', label: 'mortgage' });
    openOutput(store, { surface: 'call', label: 'dentist-1' });
    expect(store.listOutputs({ surface: 'briefing' }).length).toBe(2);
    expect(store.listOutputs({ surface: 'call' }).length).toBe(1);
    expect(store.listOutputs().length).toBe(3);
  });

  it('returns defensive copies on getNode', () => {
    const store = new InMemoryProvenanceStore();
    const n = openOutput(store, { surface: 'briefing', label: 'news' });
    const a = store.getNode(n.id);
    if (a) a.label = 'tampered';
    const b = store.getNode(n.id);
    expect(b?.label).toBe('news');
  });
});
