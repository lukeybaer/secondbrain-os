#!/usr/bin/env node
/**
 * Drift-lint for the Graphiti core component.
 *
 * Keeps dev-plans/core/graphiti.md equal to the code: every load-bearing entry
 * point the doc names must still exist, and the design invariants the doc
 * asserts (single MCP client, spool-on-failure durability, distinct source ids
 * per prompt action, voice-safe scope on recall) must still hold. If the code
 * moves and the doc does not, this fails loud so the doc gets fixed instead of
 * rotting into fiction.
 *
 * Scoped per review: the client/cascade/spool/recall entry points and the
 * invariants they encode -- NOT every Graphiti MCP tool call or Neo4j schema
 * detail.
 *
 * Zero deps (fs/path only) so it works in a fresh worktree.
 *   node scripts/verify-graphiti-drift.js
 * Exit 0 = in sync, 1 = drift. Importable as { checkDrift } for tests.
 */

const fs = require("fs");
const path = require("path");

const DOC = "dev-plans/core/graphiti.md";
const LESSONS = "dev-plans/core/graphiti.LESSONS.md";

// Load-bearing entry points the doc names. Each must exist (these are git-tracked).
const KEY_FILES = [
  "src/main/graphiti-client.ts",
  "src/main/index.ts",
  "src/main/memory-index.ts",
  "src/main/graphiti-retry-queue.ts",
  "src/main/agent-memory.ts",
  "scripts/lib/graphiti-source-scanner.js",
  "scripts/lib/graphiti-mcp.js",
  "scripts/lib/voice-cloud-runtime.js",
  "scripts/graphiti-live-health.js",
  "docker-compose.graphiti.yml",
  "ec2-server.js",
  "src/main/__tests__/amy-e2e-e5-graphiti-retry-queue.test.ts",
  "scripts/__tests__/voice-cloud-runtime.test.js",
];

// [file, token, why] -- the token must be present (an invariant the doc relies on).
const MUST_CONTAIN = [
  [
    "src/main/graphiti-client.ts",
    "export async function addEpisode",
    "the one write entry point episodes cascade through (never hand-rolled add_memory)",
  ],
  [
    "src/main/graphiti-client.ts",
    "export async function searchKnowledge",
    "the one recall entry point Electron uses",
  ],
  [
    "src/main/graphiti-client.ts",
    "export async function buildKnowledgeContext",
    "the recall formatter agent-memory.ts allocates context budget to",
  ],
  [
    "src/main/graphiti-client.ts",
    "export async function ingestCallTranscript",
    "the second (and only other) sanctioned write path, alongside memory-index upsertMemory",
  ],
  [
    "src/main/memory-index.ts",
    "fireGraphitiCascade",
    "upsertMemory cascades an episode in the same transaction as the Tier 2 write",
  ],
  [
    "src/main/graphiti-retry-queue.ts",
    "graphiti-spool.jsonl",
    "the durability layer: enqueue-on-failure spool, not a silent drop",
  ],
  [
    "src/main/agent-memory.ts",
    "buildKnowledgeContext",
    "agent-memory recall consumer wires the Graphiti client, not a second ranking layer",
  ],
  [
    "scripts/lib/graphiti-source-scanner.js",
    "itemRef",
    "repeated briefing-action prompts get distinct source ids by itemRef+kind+timestamp instead of collapsing",
  ],
  [
    "scripts/lib/voice-cloud-runtime.js",
    "graphiti_return_order",
    "live voice recall preserves Graphiti-returned fact order rather than re-sorting it",
  ],
  [
    "scripts/lib/voice-cloud-runtime.js",
    "'owner-ea'",
    "a live voice no-match states its Graphiti scope instead of treating one empty query as global truth",
  ],
  [
    "scripts/lib/graphiti-mcp.js",
    "search_memory_facts",
    "the shared EC2-safe client calls the same MCP search tool as the Electron client",
  ],
  [
    "ec2-server.js",
    "function searchGraphiti",
    "EC2 voice code has its own direct local search path and does not need the SSH tunnel",
  ],
];

// No pattern has been removed-for-a-documented-reason here yet: graphiti.LESSONS.md
// does not exist (per the doc's own LESSONS section, "create on the first lesson
// learned here"). Leaving these empty rather than inventing a ban with no lesson
// behind it -- a fabricated invariant creates false drift the moment someone
// legitimately touches the file it is pinned to.
const MUST_NOT_CONTAIN = [];
const MUST_NOT_EXIST = [];

function checkDrift(repoRoot) {
  const failures = [];
  const warnings = [];
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(repoRoot, rel), "utf8");
    } catch {
      return null;
    }
  };

  const doc = read(DOC);
  if (doc === null) failures.push(`missing core doc: ${DOC}`);

  const lessons = read(LESSONS);
  // graphiti.LESSONS.md does not exist yet as of this writing; the doc says so
  // explicitly. Only fail on its absence once the doc stops admitting that, i.e.
  // once the doc claims the LESSONS file exists.
  if (
    lessons === null &&
    doc &&
    /graphiti\.LESSONS\.md.*(has been created|now exists)/i.test(doc)
  ) {
    failures.push(`doc claims ${LESSONS} exists but it is missing`);
  }

  for (const rel of KEY_FILES) {
    if (read(rel) === null) failures.push(`missing load-bearing file: ${rel}`);
  }
  for (const rel of MUST_NOT_EXIST) {
    if (read(rel) !== null) failures.push(`file must stay deleted: ${rel}`);
  }
  for (const [rel, token, why] of MUST_CONTAIN) {
    const src = read(rel);
    if (src === null)
      failures.push(`cannot check invariant, file missing: ${rel}`);
    else if (!src.includes(token))
      failures.push(`invariant lost in ${rel}: expected "${token}" (${why})`);
  }
  for (const [rel, token, why] of MUST_NOT_CONTAIN) {
    const src = read(rel);
    if (src === null)
      failures.push(`cannot check invariant, file missing: ${rel}`);
    else if (src.includes(token))
      failures.push(
        `invariant broken in ${rel}: found "${token}" (${why}) -- update the doc if intentional`,
      );
  }

  // The doc must still name the single MCP endpoint and the durability fallback,
  // the two facts every extension rule in section 3 depends on.
  if (doc && !/127\.0\.0\.1:8000/.test(doc)) {
    failures.push(
      "doc no longer states the single Graphiti MCP endpoint (http://127.0.0.1:8000)",
    );
  }
  if (doc && !/graphiti-retry-queue\.ts/.test(doc)) {
    failures.push(
      "doc no longer names graphiti-retry-queue.ts as the durability/spool layer",
    );
  }
  if (doc && !/channel-health-monitor\.js/i.test(doc)) {
    failures.push(
      "doc no longer names the missing health-probe gap in scripts/lib/channel-health-monitor.js",
    );
  }

  return { failures, warnings };
}

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const { failures, warnings } = checkDrift(repoRoot);
  warnings.forEach((w) => console.warn(`WARN  ${w}`));
  if (failures.length) {
    console.error(
      `\nDRIFT: graphiti doc is out of sync with code (${failures.length}):`,
    );
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error(
      "\nFix the code or update dev-plans/core/graphiti.md, then re-run.",
    );
    process.exit(1);
  }
  console.log("OK: graphiti doc is in sync with the code.");
}

if (require.main === module) main();

module.exports = {
  checkDrift,
  KEY_FILES,
  MUST_CONTAIN,
  MUST_NOT_CONTAIN,
  MUST_NOT_EXIST,
};
