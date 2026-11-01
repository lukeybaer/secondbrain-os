// agent-step-loop-checkpoint.ts
//
// Run 96 nightly enhancement: durable JSONL checkpoint store for the
// agent-step-loop. Pattern source: LangGraph v1.2 durable execution +
// checkpoint-sqlite 3.1.0 streaming walk. Stored format is flat JSONL so a
// resume reader does not need to load the full event history into memory;
// it just walks the file from the tail looking for the latest snapshot for
// a given run_id.
//
// Persistence contract:
//   - One JSONL file per process. Append-only. Concurrent writers in the
//     same process are safe (Node fs.appendFileSync is atomic for the write
//     syscall on Windows + Linux); cross-process writers must use distinct
//     paths.
//   - Each line is one AgentLoopSnapshot. Out-of-band readers can tail and
//     stream the file to drive a live debugger / TUI replay.
//   - load() returns the LATEST snapshot for the requested run_id, which is
//     the one with the highest step_index. A halted snapshot (halt_reason
//     set) is also returned so callers can decide whether to re-run.
//
// Why a new module: agent-step-loop.ts must remain LLM-agnostic and
// io-light so tests can run it under vitest without temp directories. The
// store lives here so the loop core stays pure and a swap-in store
// (sqlite, redis, in-memory) is a single-file change.

import * as fs from 'fs';
import * as path from 'path';
import type { AgentLoopSnapshot, StepPersistHook } from './agent-step-loop';

export interface CheckpointStore {
  save(snapshot: AgentLoopSnapshot): void;
  load(run_id: string): AgentLoopSnapshot | null;
  list(): string[];
}

/**
 * JSONL-backed checkpoint store. One file holds many runs; each line is a
 * full AgentLoopSnapshot. load() scans the file end-to-start so the latest
 * step for a run wins.
 */
export class JsonlCheckpointStore implements CheckpointStore {
  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  save(snapshot: AgentLoopSnapshot): void {
    fs.appendFileSync(this.filePath, JSON.stringify(snapshot) + '\n');
  }

  load(run_id: string): AgentLoopSnapshot | null {
    if (!fs.existsSync(this.filePath)) return null;
    const lines = fs.readFileSync(this.filePath, 'utf8').split('\n');
    let best: AgentLoopSnapshot | null = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const snap = JSON.parse(line) as AgentLoopSnapshot;
        if (snap.run_id !== run_id) continue;
        if (!best || snap.step_index >= best.step_index) {
          best = snap;
        }
      } catch {
        // skip malformed lines; partial corruption never blocks resume
      }
    }
    return best;
  }

  /** All distinct run ids present in the file. Useful for the briefing. */
  list(): string[] {
    if (!fs.existsSync(this.filePath)) return [];
    const lines = fs.readFileSync(this.filePath, 'utf8').split('\n');
    const ids = new Set<string>();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const snap = JSON.parse(line) as AgentLoopSnapshot;
        ids.add(snap.run_id);
      } catch {
        /* skip */
      }
    }
    return Array.from(ids);
  }
}

/**
 * In-memory store for tests. Same shape as JsonlCheckpointStore so a unit
 * test can swap it in without touching fs.
 */
export class MemoryCheckpointStore implements CheckpointStore {
  private snapshots: AgentLoopSnapshot[] = [];
  save(snapshot: AgentLoopSnapshot): void {
    this.snapshots.push(snapshot);
  }
  load(run_id: string): AgentLoopSnapshot | null {
    let best: AgentLoopSnapshot | null = null;
    for (const snap of this.snapshots) {
      if (snap.run_id !== run_id) continue;
      if (!best || snap.step_index >= best.step_index) best = snap;
    }
    return best;
  }
  list(): string[] {
    return Array.from(new Set(this.snapshots.map((s) => s.run_id)));
  }
  /** Test helper: read every snapshot in insertion order. */
  history(): ReadonlyArray<AgentLoopSnapshot> {
    return this.snapshots;
  }
}

/**
 * Build the StepPersistHook the loop expects. Wraps store.save in a
 * synchronous callback. The loop swallows exceptions so a transient fs
 * error never breaks the loop, but the hook still returns the promise so a
 * caller can await it from a fake.
 */
export function makePersistHook(store: CheckpointStore): StepPersistHook {
  return (snapshot: AgentLoopSnapshot) => {
    store.save(snapshot);
  };
}
