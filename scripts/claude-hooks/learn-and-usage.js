#!/usr/bin/env node
/**
 * Combined UserPromptSubmit hook: usage tracker + #learn instructions
 * Outputs JSON to stdout. Does NOT read stdin (Windows bug workaround).
 * Called via: echo "$(node this-script.js)"
 */
const { execSync } = require('child_process');

let usage = '';
try {
  const raw = execSync(
    'node ${USERPROFILE:-~}/secondbrain/scripts/claude-hooks/usage-tracker.js --hook --project-dir ${USERPROFILE:-~}/.claude/projects/C--Users-USER-secondbrain',
    { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const parsed = JSON.parse(raw);
  usage = parsed.systemMessage || '';
} catch (e) {
  /* usage tracker failed, continue without it */
}

const learn = `The user typed #learn. This triggers the memory-save workflow:

1. IDENTIFY what the user said or what you just learned that should be persisted.
2. DETERMINE the memory type (user, feedback, project, reference).
3. CHECK existing indexes before creating new files: read C:\\Users\\USER\\.claude\\memory\\RULES_INDEX.md and C:\\Users\\USER\\.claude\\memory\\MEMORY.md to see if a file already covers this topic. Update existing files when possible.
4. SAVE: Create or update the memory file with proper frontmatter (name, description, type).
   - DEFAULT: Save to C:\\Users\\USER\\.claude\\memory\\ (global memory). Most learnings are global.
   - EXCEPTION: Save to the current project memory ONLY if the learning is specifically about the current repo codebase, tooling, or infrastructure.
5. UPDATE the appropriate index: MEMORY.md or RULES_INDEX.md for global, project MEMORY.md for project-specific.
6. If the learning is about code behavior, also write or update a test to prevent regression.
7. EXEC SUMMARY (REQUIRED): Bullet list of every file created/updated/deleted (full path), one-line description of each change. Then explain architecturally what was saved, where, and why that location was chosen.

Do NOT ask permission -- save and report.`;

const msg = usage ? usage + '\n\n' + learn : learn;
process.stdout.write(JSON.stringify({ systemMessage: msg }));
