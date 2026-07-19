#!/usr/bin/env bash
set -euo pipefail

ROOT="${SB_GRAPHITI_RELEASE_ROOT:-/opt/secondbrain}"
cd "$ROOT"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "[graphiti-deploy] neither docker compose nor docker-compose is available" >&2
  exit 1
fi

OLD_GRAPHITI_IMAGE="$(docker inspect secondbrain-graphiti --format='{{.Image}}' 2>/dev/null || true)"
REPLACEMENT_STARTED=0
ACCEPTED=0

wait_for_health() {
  local ready=0
  for _ in $(seq 1 45); do
    if curl -fsS --max-time 3 http://127.0.0.1:8000/health >/dev/null; then
      ready=1
      break
    fi
    sleep 2
  done
  [ "$ready" -eq 1 ]
}

restore_prior_image() {
  [ -n "$OLD_GRAPHITI_IMAGE" ] || {
    echo "[graphiti-deploy] no prior Graphiti image is available for rollback" >&2
    return 1
  }
  echo "[graphiti-deploy] restoring prior Graphiti image $OLD_GRAPHITI_IMAGE" >&2
  [ -f "$ROOT/.env" ] || {
    echo "[graphiti-deploy] rollback refused because $ROOT/.env does not resolve" >&2
    return 1
  }
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
  [ -n "${OPENAI_API_KEY:-}" ] || {
    echo "[graphiti-deploy] rollback refused because OPENAI_API_KEY is unavailable" >&2
    return 1
  }
  docker rm -f secondbrain-graphiti >/dev/null 2>&1 || true
  docker run -d \
    --name secondbrain-graphiti \
    --restart unless-stopped \
    --network secondbrain_default \
    -p 8000:8000 \
    -e NEO4J_URI=bolt://neo4j:7687 \
    -e NEO4J_USER=neo4j \
    -e NEO4J_PASSWORD=secondbrain_neo4j_pass \
    -e OPENAI_API_KEY \
    -e GRAPHITI_GROUP_ID=secondbrain \
    -e SEMAPHORE_LIMIT=10 \
    "$OLD_GRAPHITI_IMAGE" \
    uv run --no-sync main.py --config config/config-docker-neo4j.yaml >/dev/null
  wait_for_health
}

on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$REPLACEMENT_STARTED" -eq 1 ] && [ "$ACCEPTED" -ne 1 ]; then
    set +e
    restore_prior_image
    local rollback_status=$?
    set -e
    if [ "$rollback_status" -ne 0 ]; then
      echo "[graphiti-deploy] prior-image rollback failed" >&2
    fi
  fi
  return "$status"
}
trap on_exit EXIT

[ -f "$ROOT/.env" ] || {
  echo "[graphiti-deploy] $ROOT/.env does not resolve" >&2
  exit 1
}
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a
[ -n "${OPENAI_API_KEY:-}" ] || {
  echo "[graphiti-deploy] OPENAI_API_KEY is unavailable" >&2
  exit 1
}

"${COMPOSE[@]}" -f docker-compose.graphiti.yml build graphiti
REPLACEMENT_STARTED=1
# A prior emergency rollback may have recreated this container directly with
# `docker run`, so Compose cannot assume it owns the existing name. The new
# image is built before this removal, and rollback is armed before it happens.
docker rm -f secondbrain-graphiti >/dev/null 2>&1 || true
"${COMPOSE[@]}" -f docker-compose.graphiti.yml up -d --no-deps graphiti
wait_for_health

timeout 65s node <<'NODE'
const { searchFacts } = require('./scripts/lib/graphiti-mcp');

searchFacts('ExampleCo current preferences and SecondBrain project decisions', {
  groupId: 'owner-ea',
  limit: 1,
  timeoutMs: 60000,
})
  .then((facts) => {
    if (!facts.length) throw new Error('indexed Graphiti prewarm returned no facts');
    console.log(`indexed Graphiti prewarm: ${facts.length} fact(s)`);
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
NODE

ACCEPTED=1
echo "[graphiti-deploy] indexed Graphiti runtime accepted"
