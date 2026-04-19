#!/usr/bin/env node
/**
 * Global PreToolUse hook on Bash. Blocks `git commit` when staged
 * production-code changes have no matching test changes.
 *
 * The rule lives in secondbrain/memory/feedback_always_write_tests.md:
 * "every code change ships with tests. No exceptions." Before this hook
 * the rule was memory-file-only — the weakest layer in the hierarchy
 * (test > hook > npm script > CLAUDE.md > memory). This hook enforces
 * it mechanically, repo-wide, so skipping tests requires a conscious
 * override instead of a missed habit.
 *
 * Escape hatch: put `no-test-justification: <one-line reason>` in the
 * commit message. Use it only for pure CSS, docs, config, generated
 * files, or refactors whose behavior is already covered.
 *
 * Registered in ~/.claude/settings.json PreToolUse matcher "Bash".
 */

import { execSync } from "node:child_process";

const stdin = await readStdin();
let payload;
try {
  payload = JSON.parse(stdin);
} catch {
  process.exit(0);
}

if (payload.tool_name !== "Bash") process.exit(0);

const command = payload.tool_input?.command ?? "";

// Only guard actual new commits. Skip:
//   - non-commit commands
//   - --amend (replays an already-reviewed commit)
//   - explicit override phrase in the message
if (!/\bgit\s+commit\b/.test(command)) process.exit(0);
if (/\s--amend\b/.test(command)) process.exit(0);
if (/\bno-test-justification\b/i.test(command)) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

let stagedFiles;
try {
  stagedFiles = execSync(
    "git diff --cached --name-only --diff-filter=ACMR",
    { encoding: "utf8", cwd: projectDir }
  )
    .trim()
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
} catch {
  process.exit(0); // not a git repo or git failure — don't block
}

const prodChanged = stagedFiles.filter(isProductionCode);
const testsChanged = stagedFiles.filter(isTestFile);

if (prodChanged.length > 0 && testsChanged.length === 0) {
  process.stderr.write(
    "\n[test-coverage-guard] Production code staged without matching test changes:\n" +
      prodChanged.map((f) => "  " + f).join("\n") +
      "\n\n" +
      "Rule (secondbrain/memory/feedback_always_write_tests.md):\n" +
      "  every code change ships with tests. No exceptions.\n\n" +
      "Options:\n" +
      "  1. Add or modify a test that exercises the change, re-stage, retry.\n" +
      "  2. If a test is genuinely not applicable (pure CSS, docs, config, generated\n" +
      "     code, or a refactor covered by existing tests), add to the commit message:\n" +
      "         no-test-justification: <one-line reason>\n"
  );
  process.exit(2);
}

process.exit(0);

// ─── Helpers ────────────────────────────────────────────────────────────────

function isTestFile(path) {
  return (
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path) ||
    /_test\.(py|go|rs|java|kt)$/i.test(path) ||
    /(^|\/)test_[^/]+\.py$/i.test(path) ||
    /(^|\/)tests?(\/|$)/i.test(path) ||
    /(^|\/)__tests__(\/|$)/i.test(path) ||
    /(^|\/)spec(\/|$)/i.test(path) ||
    /(^|\/)e2e(\/|$)/i.test(path)
  );
}

function isProductionCode(path) {
  if (isTestFile(path)) return false;
  if (path.endsWith(".d.ts")) return false;

  // Paths we don't try to enforce tests on — either not behavior code,
  // or hard to unit-test without heavier infra than a pre-commit hook
  // should assume. Adjust per-repo by editing this list.
  const ignorePatterns = [
    /^node_modules\//,
    /^dist\//,
    /^build\//,
    /^coverage\//,
    /^out\//,
    /^\.next\//,
    /^public\//,
    /^assets\//,
    /^android\//, // native Android — Espresso setup out of scope
    /^ios\//, // native iOS — XCUITest setup out of scope
    /^\.github\//,
    /^\.claude\//,
    /^\.githooks\//,
    /^scripts\//, // ops/maintenance scripts
    /^migrations?\//,
    /^prisma\/migrations\//,
    /\.config\.(ts|js|mjs|cjs)$/i,
    /\.d\.ts$/,
  ];
  if (ignorePatterns.some((p) => p.test(path))) return false;

  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i.test(path);
}

async function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}
