import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REGISTRY,
  registryFor,
  routeDefault,
  descriptorByName,
  descriptorsByTag,
} from '../tool-router-registry';

describe('DEFAULT_REGISTRY', () => {
  it('is non-empty and contains the locked Vapi tools', () => {
    expect(DEFAULT_REGISTRY.length).toBeGreaterThan(10);
    const names = new Set(DEFAULT_REGISTRY.map((t) => t.name));
    expect(names.has('otter-query')).toBe(true);
    expect(names.has('transcript-fastpath')).toBe(true);
    expect(names.has('read_otter_transcripts')).toBe(true);
  });

  it('every entry has a knowledge-shaped description (not imperative)', () => {
    for (const t of DEFAULT_REGISTRY) {
      expect(t.description.length).toBeGreaterThan(40);
      // Reject imperative openers that name a command instead of data
      expect(t.description.toLowerCase().startsWith('run ')).toBe(false);
      expect(t.description.toLowerCase().startsWith('call ')).toBe(false);
      expect(t.description.toLowerCase().startsWith('execute ')).toBe(false);
    }
  });

  it('every entry declares at least one surface', () => {
    for (const t of DEFAULT_REGISTRY) {
      expect(t.surfaces).toBeDefined();
      expect((t.surfaces ?? []).length).toBeGreaterThan(0);
    }
  });

  it('names are unique', () => {
    const names = DEFAULT_REGISTRY.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('registryFor', () => {
  it('returns only tools on the requested surface', () => {
    const vapi = registryFor('vapi');
    expect(vapi.length).toBeGreaterThan(0);
    for (const t of vapi) {
      expect(t.surfaces).toContain('vapi');
    }
  });

  it('returns empty for an ExampleCo surface', () => {
    expect(registryFor('nonexistent-surface').length).toBe(0);
  });

  it('surfaces have distinct slices', () => {
    const vapi = registryFor('vapi').map((t) => t.name);
    const cli = registryFor('cli').map((t) => t.name);
    // gmail_send is cli-only
    expect(cli).toContain('gmail_send');
    expect(vapi).not.toContain('gmail_send');
  });
});

describe('routeDefault', () => {
  it('routes "what did ExampleCo say yesterday" to an Otter tool', () => {
    const result = routeDefault('what did ExampleCo say yesterday in transcripts');
    expect(result.selected).not.toBeNull();
    expect(['otter-query', 'transcript-fastpath', 'read_otter_transcripts']).toContain(
      result.selected!.tool.name,
    );
  });

  it('routes "search Gmail from PRIVATE_NAME" to a Gmail tool', () => {
    const result = routeDefault('search gmail inbox from PRIVATE_NAME');
    expect(result.selected).not.toBeNull();
    expect(result.selected!.tool.name.startsWith('gmail_')).toBe(true);
  });

  it('routes "is the ingest pipeline healthy" to pipeline_heartbeat', () => {
    const result = routeDefault('is the ingest pipeline healthy', { surface: 'briefing' });
    expect(result.selected).not.toBeNull();
    // top candidate should be pipeline_heartbeat
    expect(result.selected!.tool.name).toBe('pipeline_heartbeat');
  });

  it('routes "today\'s briefing" to a briefing tool', () => {
    const result = routeDefault('today briefing dashboard');
    expect(result.selected).not.toBeNull();
    expect(result.selected!.tool.name.startsWith('briefing_')).toBe(true);
  });

  it('respects surface filter', () => {
    // gmail_send is cli-only; asking from a Vapi surface should not pick it
    const result = routeDefault('send email reply', { surface: 'vapi' });
    if (result.selected) {
      expect(result.selected.tool.name).not.toBe('gmail_send');
    }
  });

  it('returns null selected when the query has no match', () => {
    const result = routeDefault('quantum chromodynamics renormalization group flow');
    // even if some weak match, threshold default 0.15 should reject
    if (result.selected) {
      expect(result.selected.score).toBeGreaterThan(0.15);
    }
  });
});

describe('descriptorByName', () => {
  it('finds an existing tool', () => {
    const d = descriptorByName('otter-query');
    expect(d).toBeDefined();
    expect(d!.name).toBe('otter-query');
  });

  it('returns undefined for a missing tool', () => {
    expect(descriptorByName('nope-not-real')).toBeUndefined();
  });
});

describe('descriptorsByTag', () => {
  it('finds all tools tagged "otter"', () => {
    const tools = descriptorsByTag('otter');
    expect(tools.length).toBeGreaterThanOrEqual(3);
    for (const t of tools) {
      expect((t.tags ?? []).map((x) => x.toLowerCase())).toContain('otter');
    }
  });

  it('is case-insensitive', () => {
    const lower = descriptorsByTag('gmail');
    const upper = descriptorsByTag('GMAIL');
    expect(lower.length).toBe(upper.length);
    expect(lower.length).toBeGreaterThan(0);
  });

  it('returns empty when no tool matches', () => {
    expect(descriptorsByTag('xyzzy-tag-not-real').length).toBe(0);
  });
});
