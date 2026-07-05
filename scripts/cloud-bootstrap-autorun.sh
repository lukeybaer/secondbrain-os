#!/usr/bin/env bash
# Amy mobile cloud-session bootstrap autorun (v1).
#
# Wired as a repo-level SessionStart hook via .claude/settings.json so
# scripts/cloud-bootstrap.sh runs automatically inside the claude.ai cloud
# sandbox, without relying on the pre-session "setup script" phase (which has
# no env vars and no git auth available).
#
# Gate: only runs cloud-bootstrap.sh when ALL of the following are true:
#   - uname -s reports Linux
#   - id -un reports root
#   - $HOME is /root
#   - scripts/cloud-bootstrap.sh exists relative to the repo root
#
# On the Windows desktop (ExampleCod) and the EC2 box (ec2-user) this gate is
# false, so the hook exits 0 silently with no output, i.e. a harmless no-op.
#
# This script must NEVER fail the SessionStart hook: the invocation of
# cloud-bootstrap.sh is wrapped so its exit code never propagates, but its
# stdout/stderr are still shown.
set +e

is_sandbox() {
  [ "$(uname -s 2>/dev/null)" = "Linux" ] || return 1
  [ "$(id -un 2>/dev/null)" = "root" ] || return 1
  [ "${HOME:-}" = "/root" ] || return 1
  return 0
}

if ! is_sandbox; then
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
  # Not inside a git repo: nothing to bootstrap, silent no-op.
  exit 0
fi

BOOTSTRAP="$REPO_ROOT/scripts/cloud-bootstrap.sh"
if [ ! -f "$BOOTSTRAP" ]; then
  exit 0
fi

# In a secondbrain session the repo checkout IS secondbrain and lives at the
# session working dir, not $HOME/secondbrain. cloud-bootstrap.sh honors
# SECONDBRAIN_DIR, so point it at this checkout when it looks like secondbrain
# (memory/ present alongside the bootstrap script).
if [ -d "$REPO_ROOT/memory" ]; then
  export SECONDBRAIN_DIR="$REPO_ROOT"
fi

# Run the real bootstrap, show its output, but never let its exit code fail
# this hook.
bash "$BOOTSTRAP"
exit 0
