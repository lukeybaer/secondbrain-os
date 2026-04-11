#!/bin/bash
# verify-foundation.sh
#
# Fast foundation invariant check. Runs the tier1-discipline suite which
# includes the State locations table contract tests. Used by:
#   - pre-push hook (already runs full npm test)
#   - daily 4:13 AM CT health check (adds a "foundation" line to output)
#   - nightly enhancement loop (asserts foundation green before any work)
#
# Exit 0 = foundation invariants hold
# Exit non-zero = State table has drifted from reality or a row is lying
#
# Reference: plans/dazzling-rolling-moler.md #gap workflow, commit 6.

set -e

cd "$(dirname "$0")/.."

npx vitest run src/main/__tests__/tier1-discipline.test.ts --reporter=dot
