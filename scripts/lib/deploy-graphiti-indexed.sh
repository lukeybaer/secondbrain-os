#!/usr/bin/env bash

# paid-model-api-disabled:owner-policy-2026-08-05
# subscription-runtime-approved:owner-instruction-2026-08-11

graphiti_wait_for_health() {
  local timeout_seconds="${1:-180}"
  local started_at="$SECONDS"
  local deadline=$((SECONDS + timeout_seconds))
  local code="000"
  while [ "$SECONDS" -lt "$deadline" ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:8000/health || true)"
    code="${code:-000}"
    [ "$code" = "200" ] && return 0
    local remaining=$((deadline - SECONDS))
    [ "$remaining" -le 0 ] && break
    [ "$remaining" -lt 5 ] && sleep "$remaining" || sleep 5
  done
  local elapsed=$((SECONDS - started_at))
  echo "[graphiti-deploy] health proof timed out after ${elapsed}s (last HTTP ${code})" >&2
  docker ps -a --filter name=secondbrain-graphiti >&2 || true
  docker logs secondbrain-graphiti --tail 120 >&2 2>&1 || true
  return 1
}

graphiti_prove_subscription_factories() {
  local factory_proof=""
  if ! factory_proof="$(timeout 60 docker exec -i secondbrain-graphiti uv run --no-sync python - <<'PY'
import main_secondbrain
import re
from services.factories import EmbedderFactory, LLMClientFactory

llm = LLMClientFactory.create(None)
embedder = EmbedderFactory.create(None)
if not isinstance(llm, main_secondbrain.SubscriptionLLMClient):
    raise SystemExit(f"llm={llm.__class__.__name__}")
if not isinstance(embedder, main_secondbrain.LocalHashEmbedder):
    raise SystemExit(f"embedder={embedder.__class__.__name__}")
sensitive = re.compile(
    r"(?:^|_)(?:api_?key|access_token|bearer_token|secret|password)$",
    re.IGNORECASE,
)
surfaces = [getattr(llm, "__dict__", {})]
client = getattr(llm, "client", None)
if client is not None:
    surfaces.append(getattr(client, "__dict__", {}))
if any(sensitive.search(str(name)) and value for surface in surfaces for name, value in surface.items()):
    raise SystemExit("subscription client exposes a populated credential field")
print('{"status":"ok","llm":"SubscriptionLLMClient","embedder":"LocalHashEmbedder","credential_surfaces":"llm_and_immediate_client_dict"}')
PY
)"; then
    echo "[graphiti-deploy] subscription factory proof command failed" >&2
    return 1
  fi
  case "$factory_proof" in
    *'"status":"ok"'*'"llm":"SubscriptionLLMClient"'*'"embedder":"LocalHashEmbedder"'*)
      printf '%s\n' "$factory_proof"
      ;;
    *)
      echo "[graphiti-deploy] subscription factory proof produced no exact ok marker" >&2
      return 1
      ;;
  esac
}

# Sourcing exposes the two proof functions to executable regression tests. A
# direct invocation can never be turned into a successful no-op by environment.
if [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

# ERR must propagate through proof functions so the already-armed replacement
# rollback runs for both expected proof failures and unexpected command errors.
set -Eeuo pipefail

ROOT="${SECONDBRAIN_ROOT:-/opt/secondbrain}"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
SOCKET_DIR="/opt/secondbrain-durable/graphiti"
SOCKET_PATH="$SOCKET_DIR/subscription.sock"
DEPLOY_SENTINEL="$SOCKET_DIR/deploying.json"
GATEWAY="graphiti-subscription-gateway"
# /opt/secondbrain is an atomic-release symlink. Compose resolves that path to
# the immutable SHA directory when deriving a default project name, which makes
# every deploy look like a new stack and collide with the durable named
# containers. Pin one project identity so releases adopt the existing healthy
# Neo4j container and its secondbrain_neo4j_* volumes.
export COMPOSE_PROJECT_NAME="${GRAPHITI_COMPOSE_PROJECT_NAME:-secondbrain}"

cd "$ROOT"

# Graphiti is owner-disabled as a complete runtime, not merely as an
# ingestion writer.  Keep its durable Docker volumes untouched, but do not
# start a gateway, model canary, graph container, Neo4j, or recall proof while
# the policy fails closed.  This check intentionally runs before compose is
# even selected so a disabled deploy cannot activate a graph service as a
# deployment side effect.
if ! node "$ROOT/scripts/lib/graphiti-ingestion-policy.js" >/dev/null; then
  echo "[graphiti-deploy] recall and ingestion disabled by owner; preserving stored graph data without activation"
  if pm2 describe "$GATEWAY" >/dev/null 2>&1; then
    pm2 stop "$GATEWAY" >/dev/null || true
    pm2 save >/dev/null || true
  fi
  if docker inspect secondbrain-graphiti >/dev/null 2>&1; then
    docker update --restart=no secondbrain-graphiti >/dev/null 2>&1 || true
    docker stop secondbrain-graphiti >/dev/null 2>&1 || true
  fi
  if docker inspect secondbrain-neo4j >/dev/null 2>&1; then
    docker update --restart=no secondbrain-neo4j >/dev/null 2>&1 || true
    docker stop secondbrain-neo4j >/dev/null 2>&1 || true
  fi
  exit 0
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "[graphiti-deploy] docker compose is unavailable" >&2
  exit 1
fi

sudo install -d -o ec2-user -g ec2-user -m 0750 "$SOCKET_DIR"
printf '{"pid":%s,"created_at":"%s"}\n' "$$" "$(date -u +%FT%TZ)" > "$DEPLOY_SENTINEL"
cleanup_deploy_sentinel() {
  rm -f "$DEPLOY_SENTINEL"
}
trap cleanup_deploy_sentinel EXIT

echo "[graphiti-deploy] starting private Codex then Claude subscription gateway"
if pm2 describe "$GATEWAY" >/dev/null 2>&1; then
  GRAPHITI_SUBSCRIPTION_SOCKET="$SOCKET_PATH" \
  SECONDBRAIN_DATA_DIR="$DATA_DIR" \
    pm2 restart "$GATEWAY" --update-env >/dev/null
else
  GRAPHITI_SUBSCRIPTION_SOCKET="$SOCKET_PATH" \
  SECONDBRAIN_DATA_DIR="$DATA_DIR" \
    pm2 start "$ROOT/scripts/graphiti-subscription-gateway.js" \
      --name "$GATEWAY" --time -- --serve >/dev/null
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -S "$SOCKET_PATH" ] && curl --silent --fail --unix-socket "$SOCKET_PATH" \
    http://graphiti-subscription/health >/dev/null && break
  sleep 1
done
[ -S "$SOCKET_PATH" ]
curl --silent --fail --unix-socket "$SOCKET_PATH" \
  http://graphiti-subscription/health >/dev/null

echo "[graphiti-deploy] proving subscription authentication with a structured --canary"
GRAPHITI_SUBSCRIPTION_SOCKET="$SOCKET_PATH" \
SECONDBRAIN_DATA_DIR="$DATA_DIR" \
  node "$ROOT/scripts/graphiti-subscription-gateway.js" --canary

OLD_GRAPHITI_IMAGE=""
if docker inspect secondbrain-graphiti >/dev/null 2>&1; then
  OLD_GRAPHITI_IMAGE="$(docker inspect secondbrain-graphiti --format='{{.Image}}')"
fi
REPLACEMENT_STARTED=0

rollback() {
  code=$?
  if [ "$REPLACEMENT_STARTED" -eq 1 ]; then
    echo "[graphiti-deploy] replacement failed; removing the unproved MCP container" >&2
    docker update --restart=no secondbrain-graphiti >/dev/null 2>&1 || true
    docker rm -f secondbrain-graphiti >/dev/null 2>&1 || true
    if [ -n "$OLD_GRAPHITI_IMAGE" ]; then
      docker tag "$OLD_GRAPHITI_IMAGE" secondbrain/graphiti-mcp:indexed-v1 >/dev/null 2>&1 || true
      echo "[graphiti-deploy] prior image tag restored but not started without proof" >&2
    fi
  fi
  exit "$code"
}
trap rollback ERR

"${COMPOSE[@]}" -f docker-compose.graphiti.yml up -d neo4j
"${COMPOSE[@]}" -f docker-compose.graphiti.yml build graphiti
REPLACEMENT_STARTED=1
docker rm -f secondbrain-graphiti >/dev/null 2>&1 || true
# A Graphiti writer can observe the intentional replacement gap and otherwise
# create an EC2-to-itself port-8000 tunnel. The live-PID sentinel above makes
# new callers fail soft; drain only that exact legacy tunnel before rebinding.
mapfile -t SELF_TUNNEL_PIDS < <(
  pgrep -f '^ssh .* -N -L 127\.0\.0\.1:8000:localhost:8000( |$)' || true
)
if [ "${#SELF_TUNNEL_PIDS[@]}" -gt 0 ]; then
  echo "[graphiti-deploy] draining ${#SELF_TUNNEL_PIDS[@]} EC2 self-tunnel(s) before port-8000 bind"
  kill "${SELF_TUNNEL_PIDS[@]}" 2>/dev/null || true
fi
"${COMPOSE[@]}" -f docker-compose.graphiti.yml up -d graphiti

# Neo4j index verification plus the MCP import path exceeded one minute on the
# first observed production cold restart. Give the real chain a measured,
# bounded three-minute deadline before rolling back the candidate.
graphiti_wait_for_health 180

echo "[graphiti-deploy] proving the running image installed subscription-only factories"
graphiti_prove_subscription_factories

echo "[graphiti-deploy] proving a live owner-scope fact query"
SECONDBRAIN_DATA_DIR="$DATA_DIR" node <<'NODE'
const { searchFacts } = require('/opt/secondbrain/scripts/lib/graphiti-mcp.js');
(async () => {
  const facts = await searchFacts('ExampleCo', {
    groupId: 'owner-ea',
    maxFacts: 3,
    timeoutMs: 60000,
  });
  if (!Array.isArray(facts) || facts.length === 0) {
    throw new Error('subscription Graphiti query proof returned no facts');
  }
  console.log(JSON.stringify({ status: 'ok', factCount: facts.length }));
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
NODE

REPLACEMENT_STARTED=0
trap - ERR
cleanup_deploy_sentinel
trap - EXIT
echo "[graphiti-deploy] subscription Graphiti live: Codex then Claude, no paid model credential"
