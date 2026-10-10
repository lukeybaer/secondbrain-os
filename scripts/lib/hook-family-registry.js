'use strict';

// Outer registrations name nine boundaries; their manifest owns child
// matching. In particular both prompt boundaries must have empty outer
// matchers, so their explicit command argument identifies the family.
const HOOK_FAMILIES = Object.freeze([
  'startup-integrity',
  'explicit-prompt-dispatch',
  'prompt-authority-and-coordination',
  'tool-action-boundary',
  'failure-recovery',
  'post-action-recording',
  'terminal-quality-closure',
  'owner-attention',
  'pre-compaction-handoff',
]);

function hookFamily(event, matcher = '') {
  const match = String(matcher || '');
  switch (String(event || '')) {
    case 'SessionStart': return 'startup-integrity';
    case 'UserPromptSubmit': return match ? 'explicit-prompt-dispatch' : 'prompt-authority-and-coordination';
    case 'PreToolUse': return 'tool-action-boundary';
    case 'PostToolUseFailure': return 'failure-recovery';
    case 'PostToolUse': return 'post-action-recording';
    case 'Stop': return 'terminal-quality-closure';
    case 'Notification': return 'owner-attention';
    case 'PreCompact': return 'pre-compaction-handoff';
    default: return null;
  }
}

function registeredHookFamilies(settings) {
  const rows = [];
  for (const [event, groups] of Object.entries(settings?.hooks || {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of group?.hooks || []) {
        if (hook?.type !== 'command' || typeof hook.command !== 'string') continue;
        const named = hook.command.match(/hook-boundary-dispatcher\.mjs["']?\s+([a-z-]+)\s*$/)?.[1];
        const defaultFamily = hookFamily(event, group.matcher);
        const compatible = named === defaultFamily || (event === 'UserPromptSubmit' && ['explicit-prompt-dispatch', 'prompt-authority-and-coordination'].includes(named));
        const family = named ? (HOOK_FAMILIES.includes(named) && compatible ? named : null) : defaultFamily;
        rows.push({ event, matcher: group.matcher || '', command: hook.command, family });
      }
    }
  }
  return rows;
}

module.exports = { HOOK_FAMILIES, hookFamily, registeredHookFamilies };
