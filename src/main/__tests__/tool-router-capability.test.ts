// Tests for the capability-metadata layer on tool-router-registry.
//
// Added 2026-05-16 (nightly run 64) as part of tool-registry-discovery.
// Locks the Composio-style discovery API: capability-aware filtering,
// registry stats for the briefing observability card, and deprecation
// pass-through via resolveActive().

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REGISTRY,
  discover,
  registryStats,
  resolveActive,
  descriptorByName,
} from '../tool-router-registry';
import { withCapabilityDefaults } from '../tool-router';

describe('withCapabilityDefaults', () => {
  it('defaults a bare descriptor to read / idempotent / no-approval / free', () => {
    const filled = withCapabilityDefaults({
      name: 't',
      description: 'A read tool exposing some data for testing only.',
    });
    expect(filled.side_effects).toBe('read');
    expect(filled.idempotent).toBe(true);
    expect(filled.approval).toBe('none');
    expect(filled.cost_class).toBe('free');
    expect(filled.deprecated).toBe(false);
  });

  it('defaults write tools to non-idempotent + review approval', () => {
    const filled = withCapabilityDefaults({
      name: 't',
      description: 'A write tool that sends a message somewhere external.',
      side_effects: 'write',
    });
    expect(filled.idempotent).toBe(false);
    expect(filled.approval).toBe('review');
  });

  it('defaults destructive tools to block approval', () => {
    const filled = withCapabilityDefaults({
      name: 't',
      description: 'A destructive tool that permanently mutates state.',
      side_effects: 'destructive',
    });
    expect(filled.approval).toBe('block');
    expect(filled.idempotent).toBe(false);
  });

  it('does not override explicit fields', () => {
    const filled = withCapabilityDefaults({
      name: 't',
      description: 'A write tool that the operator marked idempotent + auto-approved.',
      side_effects: 'write',
      idempotent: true,
      approval: 'none',
    });
    expect(filled.idempotent).toBe(true);
    expect(filled.approval).toBe('none');
  });
});

describe('discover', () => {
  it('returns every active tool when filter is empty', () => {
    const all = discover();
    const activeCount = DEFAULT_REGISTRY.filter((t) => !t.deprecated).length;
    expect(all.length).toBe(activeCount);
  });

  it('filters by surface', () => {
    const vapi = discover({ surface: 'vapi' });
    expect(vapi.length).toBeGreaterThan(0);
    for (const t of vapi) {
      expect(t.surfaces ?? []).toContain('vapi');
    }
  });

  it('filters by side_effects read-only', () => {
    const readOnly = discover({ side_effects: 'read' });
    for (const t of readOnly) {
      expect(t.side_effects).toBe('read');
    }
    // Sanity: gmail_send (write) and place_outbound_call (destructive) excluded.
    const names = new Set(readOnly.map((t) => t.name));
    expect(names.has('gmail_send')).toBe(false);
    expect(names.has('place_outbound_call')).toBe(false);
  });

  it('filters by side_effects array (read or write)', () => {
    const rw = discover({ side_effects: ['read', 'write'] });
    const names = new Set(rw.map((t) => t.name));
    expect(names.has('place_outbound_call')).toBe(false);
    expect(names.has('gmail_send')).toBe(true);
  });

  it('filters by approval gate', () => {
    const blocked = discover({ approval: 'block' });
    for (const t of blocked) {
      expect(t.approval).toBe('block');
    }
    // place_outbound_call is destructive and defaults to block
    expect(blocked.some((t) => t.name === 'place_outbound_call')).toBe(true);
  });

  it('filters by idempotency', () => {
    const idem = discover({ idempotent: true });
    for (const t of idem) {
      expect(t.idempotent).toBe(true);
    }
    const nonIdem = discover({ idempotent: false });
    for (const t of nonIdem) {
      expect(t.idempotent).toBe(false);
    }
  });

  it('filters by required input keys', () => {
    const wantPhone = discover({ requires_input: ['phone_number'] });
    expect(wantPhone.length).toBeGreaterThan(0);
    for (const t of wantPhone) {
      expect(t.input_keys ?? []).toContain('phone_number');
    }
  });

  it('filters by any-of tags (case insensitive)', () => {
    const tagged = discover({ tag_any: ['GMAIL', 'otter'] });
    expect(tagged.length).toBeGreaterThan(0);
    for (const t of tagged) {
      const lc = new Set((t.tags ?? []).map((x) => x.toLowerCase()));
      expect(lc.has('gmail') || lc.has('otter')).toBe(true);
    }
  });

  it('excludes deprecated by default', () => {
    // Inject a synthetic check: registry has no deprecated entries yet, so
    // we just assert the flag survives end-to-end via discover.
    const all = discover();
    for (const t of all) {
      expect(t.deprecated).toBe(false);
    }
  });

  it('combines filters with AND semantics', () => {
    const cliReadFree = discover({
      surface: 'cli',
      side_effects: 'read',
      cost_class: 'free',
    });
    for (const t of cliReadFree) {
      expect(t.surfaces ?? []).toContain('cli');
      expect(t.side_effects).toBe('read');
      expect(t.cost_class).toBe('free');
    }
  });
});

describe('registryStats', () => {
  it('totals match the registry shape', () => {
    const s = registryStats();
    expect(s.total).toBe(DEFAULT_REGISTRY.length);
    expect(s.active + s.deprecated).toBe(s.total);
  });

  it('tracks every surface that any tool declares', () => {
    const s = registryStats();
    const allSurfaces = new Set<string>();
    for (const t of DEFAULT_REGISTRY) for (const x of t.surfaces ?? []) allSurfaces.add(x);
    for (const surf of allSurfaces) {
      expect(s.by_surface[surf]).toBeGreaterThan(0);
    }
  });

  it('side_effects buckets sum to total', () => {
    const s = registryStats();
    const sum = s.by_side_effects.read + s.by_side_effects.write + s.by_side_effects.destructive;
    expect(sum).toBe(s.total);
  });

  it('approval buckets sum to total', () => {
    const s = registryStats();
    const sum = s.by_approval.none + s.by_approval.review + s.by_approval.block;
    expect(sum).toBe(s.total);
  });

  it('unanchored is a subset of registry names', () => {
    const s = registryStats();
    const names = new Set(DEFAULT_REGISTRY.map((t) => t.name));
    for (const n of s.unanchored) expect(names.has(n)).toBe(true);
  });
});

describe('resolveActive', () => {
  it('returns the entry directly when not deprecated', () => {
    const r = resolveActive('otter-query');
    expect(r).toBeDefined();
    expect(r!.name).toBe('otter-query');
  });

  it('returns undefined for ExampleCo name', () => {
    expect(resolveActive('not-a-real-tool')).toBeUndefined();
  });

  it('every locked tool resolves', () => {
    // Locked surface set: if any of these regress on rename, the test fails.
    const locked = [
      'otter-query',
      'transcript-fastpath',
      'memory_search',
      'graphiti_search',
      'gmail_send',
      'telegram_send',
      'place_outbound_call',
      'pipeline_heartbeat',
    ];
    for (const name of locked) {
      const r = resolveActive(name);
      expect(r, `locked tool ${name} disappeared from registry`).toBeDefined();
    }
  });
});

describe('outbound call gating (locks the destructive default)', () => {
  it('place_outbound_call is destructive + blocked + paid', () => {
    const t = withCapabilityDefaults(descriptorByName('place_outbound_call')!);
    expect(t.side_effects).toBe('destructive');
    expect(t.approval).toBe('block');
    expect(t.cost_class).toBe('paid');
    expect(t.idempotent).toBe(false);
  });

  it('gmail_send is write + review approval', () => {
    const t = withCapabilityDefaults(descriptorByName('gmail_send')!);
    expect(t.side_effects).toBe('write');
    expect(t.approval).toBe('review');
  });
});
