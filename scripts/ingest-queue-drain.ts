/**
 * ingest-queue-drain.ts
 *
 * CLI entry point that drains secondbrain/data/ingest-queue/pending/ in a
 * single batched pass. Intended to be invoked by a scheduled task (or from a
 * persistent drain loop) rather than by per-poll per-item `claude -p` spawns.
 *
 * Two invocation modes:
 *
 *   1) Inline mode (default) — this script calls the drain() function in-process
 *      using a handler that classifies the item by source/kind and delegates to
 *      the appropriate Tier 2 enrichment path. No claude subprocess is spawned.
 *      Use when the handlers are implemented directly in TS.
 *
 *   2) Spawn mode (`--spawn-claude`) — this script builds a single prompt that
 *      lists all pending items and asks a claude session (marked ingest mode
 *      via SECONDBRAIN_SESSION_MODE=ingest) to process the whole batch. Uses
 *      runClaudeCodeIngest from src/main/claude-runner.ts to get the stub
 *      SessionStart hook. Use when the handler logic is Claude-driven and you
 *      want the token savings from the stub hook.
 *
 * Usage:
 *   npx tsx scripts/ingest-queue-drain.ts              # inline mode, dry drain
 *   npx tsx scripts/ingest-queue-drain.ts --spawn-claude  # spawn one claude session
 *   npx tsx scripts/ingest-queue-drain.ts --max-items 20
 *
 * Exits non-zero on handler crash or queue-layout error so the caller (cron,
 * scheduled task, health check) can detect failure and alert.
 *
 * Run-frequency guidance: every 2-5 minutes is fine — each drain is cheap, and
 * leaving items sitting in pending/ longer than that defeats the point of the
 * 2-minute ingest cadence the pitch targeted.
 */

import * as path from 'path';
import {
  drain,
  queueCounts,
  listPending,
  type IngestItem,
  type DrainResult,
} from '../src/main/ingest-queue';

// ── Argument parsing (no dependency on a CLI lib) ─────────────────────────────

interface Args {
  spawnClaude: boolean;
  maxItems: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { spawnClaude: false, maxItems: 50, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--spawn-claude') args.spawnClaude = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--max-items') {
      const n = parseInt(argv[i + 1] ?? '50', 10);
      if (Number.isFinite(n) && n > 0) args.maxItems = n;
      i += 1;
    }
  }
  return args;
}

// ── Inline-mode handler ──────────────────────────────────────────────────────
//
// Minimal classifier: routes by source. Each branch delegates to the existing
// Tier 2 enrichment path for that source (when one exists). For sources that
// don't have an in-process handler yet, the item is escalated so a
// full-context session can pick it up safely.

async function inlineHandler(item: IngestItem): Promise<DrainResult> {
  try {
    switch (item.source) {
      case 'gmail':
      case 'otter':
      case 'whatsapp':
      case 'sms':
      case 'linkedin':
      case 'call':
      case 'briefing':
        // TODO wire per-source handlers as the migration from per-poll sessions
        // to queue enqueue lands. For now, escalate so nothing is silently dropped.
        return {
          outcome: 'escalated',
          reason: `no inline handler for source=${item.source} kind=${item.kind}; needs full-context session`,
        };
      case 'other':
      default:
        return {
          outcome: 'escalated',
          reason: `ExampleCo source=${item.source}; needs full-context session`,
        };
    }
  } catch (err) {
    return {
      outcome: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Spawn-mode handler ───────────────────────────────────────────────────────
//
// Builds one prompt that lists all pending items with their ids, sources,
// external ids, and rawRefs, then invokes runClaudeCodeIngest to process the
// whole batch in a single claude subprocess with SECONDBRAIN_SESSION_MODE=ingest.
// The stub SessionStart hook gives the session the drain protocol and rules.

async function spawnClaudeDrain(maxItems: number): Promise<number> {
  const pending = listPending().slice(0, maxItems);
  if (pending.length === 0) {
    console.log('[ingest-queue-drain] no pending items; nothing to do');
    return 0;
  }

  // Lazy import so the inline mode doesn't drag in Electron + claude-runner.
  const runnerPath = path.resolve(__dirname, '..', 'src', 'main', 'claude-runner');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runClaudeCodeIngest } = require(runnerPath) as {
    runClaudeCodeIngest: (prompt: string, opts?: { timeoutMs?: number }) => Promise<{ success: boolean; output: string; exitCode: number }>;
  };

  const header = [
    `You have ${pending.length} items to drain from the ingest queue.`,
    'Process each one in order. For each item:',
    '  1. Read the raw payload at rawRef.',
    '  2. Apply the appropriate Tier 2 enrichment (contact file update, Graphiti addEpisode, etc).',
    '  3. On success, move the item file from in-progress/ to done/.',
    '  4. On anomaly, move to escalated/ with a reason.',
    '  5. On terminal failure, move to failed/ with the error.',
    'Commit once at the end with message "chore(ingest): drain queue N items".',
    '',
    'Queue items:',
  ].join('\n');

  const body = pending
    .map(
      (it, i) =>
        `${i + 1}. id=${it.id} source=${it.source} kind=${it.kind} externalId=${it.externalId} rawRef=${it.rawRef}`,
    )
    .join('\n');

  const prompt = `${header}\n${body}\n\nBegin.`;

  const { success, output, exitCode } = await runClaudeCodeIngest(prompt, { timeoutMs: 15 * 60 * 1000 });
  if (!success) {
    console.error(`[ingest-queue-drain] claude session failed (exit ${exitCode}):\n${output.slice(0, 1000)}`);
    return exitCode === 0 ? 1 : exitCode;
  }
  console.log(`[ingest-queue-drain] claude session OK; output preview:\n${output.slice(0, 500)}`);
  return 0;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`[ingest-queue-drain] starting (spawnClaude=${args.spawnClaude} maxItems=${args.maxItems} dryRun=${args.dryRun})`);
  console.log('[ingest-queue-drain] initial queue counts:', queueCounts());

  if (args.dryRun) {
    const pending = listPending().slice(0, args.maxItems);
    console.log(`[ingest-queue-drain] dry run — would drain ${pending.length} items`);
    for (const it of pending) {
      console.log(`  - ${it.id} ${it.source} ${it.kind} ${it.externalId}`);
    }
    return 0;
  }

  if (args.spawnClaude) {
    return await spawnClaudeDrain(args.maxItems);
  }

  const report = await drain(inlineHandler, { maxItems: args.maxItems });
  console.log(
    `[ingest-queue-drain] drain complete: processed=${report.processed} done=${report.done} failed=${report.failed} escalated=${report.escalated} durationMs=${report.durationMs}`,
  );
  console.log('[ingest-queue-drain] final queue counts:', queueCounts());

  // Non-zero exit on any failures so the scheduler treats it as red.
  if (report.failed > 0) return 2;
  return 0;
}

// Only run when invoked directly, not when imported by tests.
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[ingest-queue-drain] fatal:', err);
      process.exit(1);
    });
}
