#!/usr/bin/env bash
# setup-hyperframes.sh , bootstrap the HeyGen HyperFrames repo locally for
# thumbnail + B-roll generation. Idempotent. Not committed to git (tools/ is
# gitignored) because the repo is ~220MB after lfs filter.
#
# Rationale: HyperFrames is the rendering engine behind scripts/hyperframes-*.js.
# We clone it, build once, then agent scripts invoke its producer/ package to
# render HTML compositions to MP4 without leaving the repo.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="$REPO_ROOT/tools/hyperframes"

if [ ! -d "$TOOLS_DIR/.git" ]; then
  echo "[hyperframes] cloning heygen-com/hyperframes..."
  git clone --depth 1 https://github.com/heygen-com/hyperframes.git "$TOOLS_DIR"
else
  echo "[hyperframes] already cloned at $TOOLS_DIR, pulling latest..."
  git -C "$TOOLS_DIR" pull --ff-only || echo "  (pull skipped , continuing with current checkout)"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "[hyperframes] NOTE: 'bun' is not on PATH. HyperFrames uses bun for workspace resolution."
  echo "            Install: https://bun.sh , then re-run this script to build."
  exit 0
fi

echo "[hyperframes] installing dependencies (bun install)..."
(cd "$TOOLS_DIR" && bun install)

if [ -z "${HYPERFRAMES_SKIP_BUILD:-}" ]; then
  echo "[hyperframes] building packages (bun run build)..."
  (cd "$TOOLS_DIR" && bun run build)
fi

echo "[hyperframes] ready. CLI: (cd $TOOLS_DIR && bunx hyperframes --help)"
