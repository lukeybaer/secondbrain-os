import { describe, expect, it } from 'vitest';
import { DEFAULT_REGISTRY, registryFor } from '../tool-router-registry';
import { buildRulesFromRegistry, rulesForSurface } from '../tool-rules-presets';

describe('tool-rules-presets', () => {
  it('derives approval and no-repeat rules from registry metadata', () => {
    const rules = buildRulesFromRegistry([
      {
        name: 'gmail_send',
        description: 'Send email',
        side_effects: 'write',
        approval: 'review',
      },
      {
        name: 'place_outbound_call',
        description: 'Dial a phone number',
        side_effects: 'destructive',
      },
    ]);

    expect(rules).toContainEqual({ type: 'requires_approval', tool: 'gmail_send' });
    expect(rules).toContainEqual({ type: 'requires_approval', tool: 'place_outbound_call' });
    expect(rules).toContainEqual({ type: 'max_count', tool: 'place_outbound_call', max: 1 });
  });

  it('never emits rules for tools outside the chosen surface registry', () => {
    const surface = 'vapi';
    const allowed = new Set(registryFor(surface).map((tool) => tool.name));
    const rules = rulesForSurface(surface);

    for (const rule of rules) {
      if ('tool' in rule) expect(allowed.has(rule.tool)).toBe(true);
      if ('parent' in rule) expect(allowed.has(rule.parent)).toBe(true);
      if ('children' in rule) {
        for (const child of rule.children) expect(allowed.has(child)).toBe(true);
      }
    }
  });

  it('derives at least one approval rule from the default registry when write tools exist', () => {
    const writeTools = DEFAULT_REGISTRY.filter((tool) =>
      ['write', 'destructive'].includes(tool.side_effects ?? 'read'),
    );
    const rules = buildRulesFromRegistry(DEFAULT_REGISTRY);

    if (writeTools.length > 0) {
      expect(rules.some((rule) => rule.type === 'requires_approval')).toBe(true);
    }
  });
});
