#!/bin/sh
# scripts/peer-review.sh
#
# Defect 2 fix (two-bot adversarial-review gate hardening, 2026-08-24):
# `node scripts/codex-peer-review.js ...` resolves `node` from whatever PATH
# the calling shell happens to have. A background shell, a non-login shell, or
# a scheduled/detached invocation can have no `node` on PATH at all, which
# fails the invocation with a bare exit 127 and an EMPTY results file -- not a
# diagnosable "review failed" error, just silence. Measured live today: two
# review rounds silently became exit 127 this way and the calling agent
# believed a review had happened because it never re-checked the exit code.
#
# This wrapper resolves node ONCE, explicitly, before doing anything else, and
# `exec`s the real script, so no caller of this wrapper ever depends on
# ambient PATH again. If node truly cannot be found, it fails LOUD (a named
# error on stderr) instead of a bare, unexplained 127.
#
# Usage (identical args to the underlying script):
#   scripts/peer-review.sh --artifact-file <path> --gate <id> --title "<title>"
#
# POSIX sh, Git Bash compatible on Windows. Works from any cwd, including an
# isolated worktree, because it resolves its own location from $0 rather than
# assuming the caller's cwd is the repo root.
#
# Self-pass fallback (ExampleCo, 2026-09-03): "when the adversarial model is
# unreachable, the review falls back to an independent self-pass on the
# design, clearly labeled, never presented as a peer review." This wrapper
# does not implement that fallback itself -- codex-peer-review.js does, inside
# runReview(), because that is the one place that already knows BOTH
# automated Codex paths failed. This wrapper's own job (resolving node) is
# unchanged: a self-pass still needs node to run, same as a real review does.
# The resulting receipt is written with `reviewer: "claude-self-pass"`,
# `degraded: true`, and `codexFailure: <first line of the Codex failure>`;
# scripts/claude-hooks/two-bot-gate.mjs and
# scripts/claude-hooks/agent-spawn-supervise.mjs both require all three
# before trusting a degraded receipt, and both surface "degraded self-pass,
# not a peer review" when one unlocks a gate.
#
# Resolution order for node:
#   1. $NODE_BIN, if the caller already set it (repo convention -- see
#      scripts/ec2-*-run.sh, which all honor this same override).
#   2. `command -v node` -- the normal case, when PATH is actually set up.
#   3. Known install locations: the Windows default install path, then the
#      Linux/EC2 package default.
# Failing all three is a named, loud error, never a silent 127.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET="$SCRIPT_DIR/codex-peer-review.js"

resolve_node() {
  if [ -n "${NODE_BIN:-}" ] && [ -x "${NODE_BIN}" ]; then
    printf '%s\n' "$NODE_BIN"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in \
    "/c/Program Files/nodejs/node.exe" \
    "/usr/bin/node" \
    "/usr/local/bin/node"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if ! NODE_RESOLVED=$(resolve_node); then
  echo "[peer-review.sh] BLOCKED: no node executable found. Checked \$NODE_BIN," >&2
  echo "[peer-review.sh] 'command -v node' on PATH, and known install locations" >&2
  echo "[peer-review.sh] (/c/Program Files/nodejs/node.exe, /usr/bin/node," >&2
  echo "[peer-review.sh] /usr/local/bin/node). This is the exact ambient-PATH" >&2
  echo "[peer-review.sh] failure this wrapper exists to catch loudly instead of" >&2
  echo "[peer-review.sh] a bare, unexplained exit 127. Set NODE_BIN explicitly" >&2
  echo "[peer-review.sh] or fix PATH for this shell and retry." >&2
  exit 127
fi

exec "$NODE_RESOLVED" "$TARGET" "$@"
