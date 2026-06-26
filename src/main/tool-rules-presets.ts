// tool-rules-presets.ts
//
// Wires the generic tool-rules-solver.ts to SecondBrain's ACTUAL tool
// registry so the solver is used, not orphaned (feedback_nightly_runs_
// must_wire_not_orphan.md). tool-rules-solver.ts is a pure engine that
// knows nothing about Amy's tools; this module derives a concrete rule set
// from the capability metadata already declared on every ToolDescriptor in
// tool-router-registry.ts.
//
// The derivation reuses fields the registry already ExampleCos (added run 64):
//   - approval: 'review' | 'block'  -> a requires_approval rule
//   - side_effects: 'destructive'   -> a max_count rule (cap 1)
//
// So `gmail_send` (approval 'review') becomes gated, `place_outbound_call`
// (destructive, approval 'block') becomes BOTH gated and no-redial, and no
// rule references a tool that does not exist in the registry. The locked
// memory rules this realizes mechanically:
//
//   - feedback_amy_no_redial.md / no_redial         -> max_count cap 1 on dials
//   - feedback_briefing_publish_requires_explicit_publish_flag.md,
//     declarative-approval-inbox backlog item        -> requires_approval gating
//
// Pure module: imports the registry constant and the rule types only. No
// fs, no network. Deterministic output for a given registry.

import { DEFAULT_REGISTRY, registryFor } from './tool-router-registry';
import type { ToolDescriptor, ApprovalGate, SideEffectClass } from './tool-router';
import type { ToolRule } from './tool-rules-solver';

/**
 * Effective approval gate for a descriptor, applying the registry's
 * defaults (read -> none, write -> review, destructive -> block) when the
 * descriptor omits an explicit approval. Kept local so this module does not
 * depend on withCapabilityDefaults' wider return shape.
 */
function effectiveApproval(t: ToolDescriptor): ApprovalGate {
  if (t.approval) return t.approval;
  const side: SideEffectClass = t.side_effects ?? 'read';
  if (side === 'destructive') return 'block';
  if (side === 'write') return 'review';
  return 'none';
}

/**
 * Derive a tool-rules set from a registry. Every descriptor that gates on
 * approval ('review' or 'block') yields a requires_approval rule; every
 * destructive descriptor yields a max_count cap of 1 (irreversible actions
 * are never auto-repeated). Deprecated descriptors are skipped so retired
 * tools do not constrain live routing.
 */
export function buildRulesFromRegistry(registry: ReadonlyArray<ToolDescriptor>): ToolRule[] {
  const rules: ToolRule[] = [];
  for (const t of registry) {
    if (t.deprecated) continue;
    const approval = effectiveApproval(t);
    if (approval === 'review' || approval === 'block') {
      rules.push({ type: 'requires_approval', tool: t.name });
    }
    if ((t.side_effects ?? 'read') === 'destructive') {
      rules.push({ type: 'max_count', tool: t.name, max: 1 });
    }
  }
  return rules;
}

/**
 * The rule set for the full default registry. This is what agent-step-loop
 * and the Vapi prompt assembler pass to solveToolRules() to gate the tool
 * list they offer the model. Built once at module load; the registry is a
 * frozen const so the result is stable for the process lifetime.
 */
export const SECONDBRAIN_TOOL_RULES: ReadonlyArray<ToolRule> =
  buildRulesFromRegistry(DEFAULT_REGISTRY);

/**
 * Surface-scoped rules: derive from only the slice of the registry a given
 * surface (e.g. 'vapi', 'briefing', 'cli') can call, so a Vapi call is not
 * gated by tools it could never reach.
 */
export function rulesForSurface(surface: string): ToolRule[] {
  return buildRulesFromRegistry(registryFor(surface));
}
