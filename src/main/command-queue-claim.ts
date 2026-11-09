// command-queue-claim.ts
//
// Dependency-free claim-gating decision for the desktop-app command worker.
// Lives in its own file (no electron import) so it is unit-testable. The worker
// must execute a command ONLY when it actually won the claim. A 409 means the
// command is no longer pending: the always-on EC2 dispatch-processor forwarded
// it (atomic pending->forwarded) or another consumer claimed it. Executing on a
// failed claim runs the same command twice. Codex flagged this on 2026-06-01.
export function claimSucceeded(status: number): boolean {
  return status === 200;
}
