// module-wiring-audit.ts
//
// Detect orphaned src/main modules: exported TypeScript modules that no
// non-test runtime file ever imports. These are "built but never wired"
// modules - real code, with passing tests, that nothing in the running
// app actually calls.
//
// Why this matters for Amy: the nightly enhancement cycle has a measured
// failure mode. It ships well-tested pure modules (memory-archival-
// recommender, agent-reflection, and others) that score as "done" on the
// strength of green tests, yet zero runtime files import them. They are
// dead weight: they grow the codebase, slow type-checking, and create the
// illusion of capability that does not actually run. Run 76's LESSONS,
// "All items already at ceiling," is partly an artifact of this. A module
// is only a capability once something invokes it.
//
// This module is the observability half: it builds the import graph for
// src/main, classifies each module as wired / orphan-tested / orphan-
// untested, and folds the result into an executive digest the nightly
// cycle (and the briefing system-health card) can read to hold itself
// accountable: "you shipped N modules last week, M are still orphaned."
//
// Pattern source: dependency-cruiser's "orphan" rule (sverweij/dependency-
// cruiser) and ts-prune (nadeesha/ts-prune), distilled to the one signal
// that matters here - a module-level reachability check from the runtime
// entrypoints - without pulling in a 200kB AST dependency. Lexical import
// scanning is sufficient at this repo's scale.
//
// Distinct from:
//   - preflight-validator.ts: validates tool-call ARGS before execution.
//     This validates the codebase's own wiring.
//   - skill-registry.ts: tracks scheduled SKILL coverage, not TS modules.
//   - startup-checks.ts: runtime environment checks, not static reachability.
//
// The pure core (auditModuleWiring) takes plain objects and is unit-tested
// with no filesystem. scanSrcDir / buildWiringDigest read the tree so the
// module is also directly runnable.

import * as fs from 'fs';
import * as path from 'path';

// Types

export interface ModuleNode {
  // Module basename without extension, e.g. 'agent-reflection'.
  name: string;
  lineCount: number;
  // Non-test runtime files that import this module (basenames).
  runtimeImporters: string[];
  // Whether a matching __tests__/<name>.test.ts exists.
  hasTest: boolean;
}

export type WiringStatus = 'wired' | 'orphan-tested' | 'orphan-untested' | 'entrypoint';

export interface ModuleFinding {
  name: string;
  status: WiringStatus;
  lineCount: number;
  hasTest: boolean;
  importerCount: number;
  rationale: string;
}

export interface WiringAudit {
  totalModules: number;
  wiredModules: number;
  orphanModules: number;
  entrypointModules: number;
  // Sum of line counts across all orphan modules - the dead-weight estimate.
  deadWeightLines: number;
  // Orphans only, worst (largest) first. The actionable list.
  orphans: ModuleFinding[];
  // Every module, for callers that want the full picture.
  all: ModuleFinding[];
}

export interface AuditOptions {
  // Module basenames that are runtime roots (nothing is expected to import
  // them). Defaults cover Electron / server entrypoints.
  entryPoints?: string[];
}

// Electron main + EC2 server entrypoints are reachability roots: the OS / PM2
// invokes them, no TS file imports them, so absence of importers is expected.
const DEFAULT_ENTRYPOINTS = ['index', 'main', 'server', 'ec2-server', 'preload', 'ipc-handlers'];

// Pure core

export function auditModuleWiring(nodes: ModuleNode[], opts: AuditOptions = {}): WiringAudit {
  const entry = new Set(opts.entryPoints ?? DEFAULT_ENTRYPOINTS);

  const all: ModuleFinding[] = nodes.map((n) => {
    if (entry.has(n.name)) {
      return {
        name: n.name,
        status: 'entrypoint',
        lineCount: n.lineCount,
        hasTest: n.hasTest,
        importerCount: n.runtimeImporters.length,
        rationale: 'runtime entrypoint; not expected to be imported',
      };
    }
    const importerCount = n.runtimeImporters.length;
    if (importerCount > 0) {
      return {
        name: n.name,
        status: 'wired',
        lineCount: n.lineCount,
        hasTest: n.hasTest,
        importerCount,
        rationale: `imported by ${importerCount} runtime file(s)`,
      };
    }
    // No runtime importers => orphan. Tested orphans are the classic
    // "shipped on green tests but never wired" case and are the higher
    // signal because they masquerade as delivered capability.
    return {
      name: n.name,
      status: n.hasTest ? 'orphan-tested' : 'orphan-untested',
      lineCount: n.lineCount,
      hasTest: n.hasTest,
      importerCount: 0,
      rationale: n.hasTest
        ? 'tests pass but no runtime file imports it; capability does not run'
        : 'no runtime importers and no tests; dead weight',
    };
  });

  const orphans = all
    .filter((f) => f.status === 'orphan-tested' || f.status === 'orphan-untested')
    .sort((a, b) => b.lineCount - a.lineCount);

  return {
    totalModules: nodes.length,
    wiredModules: all.filter((f) => f.status === 'wired').length,
    orphanModules: orphans.length,
    entrypointModules: all.filter((f) => f.status === 'entrypoint').length,
    deadWeightLines: orphans.reduce((s, f) => s + f.lineCount, 0),
    orphans,
    all,
  };
}

// Filesystem scanner (best-effort lexical import graph)

const IMPORT_RE =
  /(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function importedBasenames(source: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source)) != null) {
    const spec = m[1] ?? m[2];
    if (!spec) continue;
    // Strip any path, keep the final segment, drop extension.
    const base = path.basename(spec).replace(/\.(ts|tsx|js|mjs|cjs)$/, '');
    out.push(base);
  }
  return out;
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  return source.split('\n').length;
}

// Scan a directory of .ts modules and build the wiring graph. Files under a
// __tests__ subdirectory are treated as tests (their imports do NOT count as
// runtime wiring, and they mark hasTest for the module they target).
export function scanSrcDir(srcDir: string): ModuleNode[] {
  const entries = fs
    .readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name));

  const moduleNames: string[] = entries.map((e) => e.name.replace(/\.tsx?$/, ''));

  // Collect test files (from a sibling __tests__ dir if present).
  const testsDir = path.join(srcDir, '__tests__');
  const testFiles: string[] = fs.existsSync(testsDir)
    ? fs.readdirSync(testsDir).filter((n) => /\.(test|spec)\.tsx?$/.test(n))
    : [];

  // A module hasTest if a test file basename starts with its name.
  const testedModules = new Set<string>();
  for (const t of testFiles) {
    const stem = t.replace(/\.(test|spec)\.tsx?$/, '');
    // <name>.test.ts and <name>-foo.test.ts both count for <name>.
    for (const mod of moduleNames) {
      if (stem === mod || stem.startsWith(mod + '-') || stem.startsWith(mod + '.')) {
        testedModules.add(mod);
      }
    }
  }

  // Read each file once: record its line count and who it imports.
  const importersOf = new Map<string, Set<string>>();
  const lineCountOf = new Map<string, number>();
  for (const mod of moduleNames) importersOf.set(mod, new Set());

  for (const e of entries) {
    const src = fs.readFileSync(path.join(srcDir, e.name), 'utf8');
    const fromName = e.name.replace(/\.tsx?$/, '');
    lineCountOf.set(fromName, countLines(src));
    for (const imp of importedBasenames(src)) {
      if (importersOf.has(imp) && imp !== fromName) {
        importersOf.get(imp)!.add(fromName);
      }
    }
  }

  return moduleNames.map((name) => ({
    name,
    lineCount: lineCountOf.get(name) ?? 0,
    runtimeImporters: Array.from(importersOf.get(name) ?? []).sort(),
    hasTest: testedModules.has(name),
  }));
}

export function buildWiringDigest(srcDir: string, opts: AuditOptions = {}): WiringAudit {
  return auditModuleWiring(scanSrcDir(srcDir), opts);
}

// Ratchet enforcement
//
// The audit above is observability: it COUNTS orphans at every boot and even
// raises a soft self-health warning past a threshold. But a warning in a boot
// log is not a gate - the measured failure mode (run 107: 71 orphans; this
// capture: 66) is that the nightly cycle keeps shipping tested-but-unwired
// modules and nothing turns red. WIRING_BASELINE + checkWiringRatchet turn the
// soft warning into a hard, self-tightening ratchet enforced by a live test
// (module-wiring-ratchet.test.ts) that run-tests-before-pr.sh runs on every
// push. The rule is one-directional: a push may only keep the count equal or
// LOWER it. To wire an orphan and lower the baseline, edit the two numbers
// here in the same commit. Enforces feedback_nightly_runs_must_wire_not_orphan.
//
// Captured 2026-06-10 against src/main (run 117), lowered 2026-06-11 (run 118)
// after wiring three orphans into self-health-digest (skill-registry,
// agent-reflection, agent-decision-log): 66->63 modules, 17639->16731 lines.
// Lowered again 2026-06-13 (run 119) after wiring three more orphans into
// self-health-digest (token-budget-governor, memory-archival-recommender,
// ingest-queue): 63->61 modules, 16731->15717 lines.
// Lower-only; never raise.
export const WIRING_BASELINE = {
  orphanModules: 61,
  deadWeightLines: 15717,
} as const;

export interface RatchetResult {
  ok: boolean;
  orphanModules: number;
  deadWeightLines: number;
  baselineOrphans: number;
  baselineLines: number;
  // Human-readable verdict; on failure it names which dimension regressed and
  // tells the contributor exactly what to do (wire it, or lower the baseline).
  message: string;
}

// Pure: compare an audit against the committed baseline. ok=true when the live
// counts are <= baseline on BOTH dimensions. A drop is allowed (and the message
// invites lowering the baseline to lock the win in); an increase fails.
export function checkWiringRatchet(
  audit: WiringAudit,
  baseline: { orphanModules: number; deadWeightLines: number } = WIRING_BASELINE,
): RatchetResult {
  const orphanOk = audit.orphanModules <= baseline.orphanModules;
  const lineOk = audit.deadWeightLines <= baseline.deadWeightLines;
  const ok = orphanOk && lineOk;

  let message: string;
  if (ok) {
    const droppedModules = baseline.orphanModules - audit.orphanModules;
    const droppedLines = baseline.deadWeightLines - audit.deadWeightLines;
    if (droppedModules > 0 || droppedLines > 0) {
      message =
        `Wiring ratchet OK and IMPROVED: orphans ${audit.orphanModules} (baseline ` +
        `${baseline.orphanModules}, -${droppedModules}), dead-weight lines ` +
        `${audit.deadWeightLines} (baseline ${baseline.deadWeightLines}, -${droppedLines}). ` +
        `Lower WIRING_BASELINE in module-wiring-audit.ts to ` +
        `{ orphanModules: ${audit.orphanModules}, deadWeightLines: ${audit.deadWeightLines} } ` +
        `to lock in the reduction.`;
    } else {
      message =
        `Wiring ratchet OK: ${audit.orphanModules} orphan(s), ` +
        `${audit.deadWeightLines} dead-weight lines, at baseline.`;
    }
  } else {
    const parts: string[] = [];
    if (!orphanOk) {
      parts.push(
        `orphan modules rose to ${audit.orphanModules} (baseline ${baseline.orphanModules}, ` +
          `+${audit.orphanModules - baseline.orphanModules})`,
      );
    }
    if (!lineOk) {
      parts.push(
        `dead-weight lines rose to ${audit.deadWeightLines} (baseline ${baseline.deadWeightLines}, ` +
          `+${audit.deadWeightLines - baseline.deadWeightLines})`,
      );
    }
    message =
      `Wiring ratchet REGRESSION: ${parts.join('; ')}. You shipped a module nothing ` +
      `imports. Wire it into a runtime importer (see feedback_nightly_runs_must_wire_not_orphan), ` +
      `or remove it. Do NOT raise WIRING_BASELINE. Top orphans: ` +
      audit.orphans
        .slice(0, 5)
        .map((o) => o.name)
        .join(', ') +
      '.';
  }

  return {
    ok,
    orphanModules: audit.orphanModules,
    deadWeightLines: audit.deadWeightLines,
    baselineOrphans: baseline.orphanModules,
    baselineLines: baseline.deadWeightLines,
    message,
  };
}

// Render a short executive line for the briefing / nightly log.
export function renderWiringHeadline(audit: WiringAudit): string {
  if (audit.orphanModules === 0) {
    return `Module wiring clean: ${audit.wiredModules}/${audit.totalModules} modules wired, 0 orphans.`;
  }
  const tested = audit.orphans.filter((o) => o.hasTest).length;
  return (
    `${audit.orphanModules} orphaned module(s) (~${audit.deadWeightLines} lines dead weight), ` +
    `${tested} of them tested-but-unwired. Top: ${audit.orphans
      .slice(0, 3)
      .map((o) => o.name)
      .join(', ')}.`
  );
}
