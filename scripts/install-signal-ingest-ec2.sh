#!/usr/bin/env bash
set -euo pipefail

SERVICE_USER="ec2-user"
CODE_ROOT="/opt/secondbrain"
STATE_ROOT="/opt/secondbrain-durable/signal-ingest"
SIGNAL_ROOT="/opt/secondbrain-durable/signal-cli"
ENV_FILE="/opt/secondbrain-durable/.env"
BUCKET="${SECONDBRAIN_DATA_BUCKET:-ExampleCo-secondbrain-backups}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

for required in \
  "${CODE_ROOT}/scripts/signal-ingest-amy.js" \
  "${CODE_ROOT}/scripts/signal-flow-healer-amy.js" \
  "${CODE_ROOT}/scripts/signal-people-project-amy.js" \
  "${CODE_ROOT}/scripts/signal-ingest-health.js" \
  "${CODE_ROOT}/scripts/signal-send-amy.js" \
  "/etc/systemd/system/signal-cli-amy.service"; do
  [[ -e "${required}" ]] || { echo "Missing required landed file: ${required}" >&2; exit 1; }
done

available_kb="$(df -Pk /opt | awk 'NR==2 {print $4}')"
if [[ -z "${available_kb}" || "${available_kb}" -lt 500000 ]]; then
  echo "At least 500 MB free under /opt is required before enabling attachment capture." >&2
  exit 1
fi

install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0700 \
  "${STATE_ROOT}" "${STATE_ROOT}/events" /home/ec2-user/sb-sessions
touch "${ENV_FILE}"
chown "${SERVICE_USER}:${SERVICE_USER}" "${ENV_FILE}"
chmod 0600 "${ENV_FILE}"
if ! grep -q '^SECONDBRAIN_DATA_BUCKET=' "${ENV_FILE}"; then
  printf '\nSECONDBRAIN_DATA_BUCKET=%s\n' "${BUCKET}" >>"${ENV_FILE}"
fi
if ! grep -q '^SIGNAL_INGEST_ROOT=' "${ENV_FILE}"; then
  printf 'SIGNAL_INGEST_ROOT=%s\n' "${STATE_ROOT}" >>"${ENV_FILE}"
fi
if ! grep -q '^SIGNAL_CLI_CONFIG=' "${ENV_FILE}"; then
  printf 'SIGNAL_CLI_CONFIG=%s\n' "${SIGNAL_ROOT}" >>"${ENV_FILE}"
fi

cat >/etc/systemd/system/signal-ingest-amy.service <<'UNIT'
[Unit]
Description=Amy Signal raw archive and Graphiti consumer
Wants=network-online.target
Requires=signal-cli-amy.service
After=network-online.target signal-cli-amy.service

[Service]
Type=simple
User=ec2-user
Group=ec2-user
EnvironmentFile=-/opt/secondbrain-durable/.env
Environment=GRAPHITI_URL=http://127.0.0.1:8000
ExecStart=/usr/bin/node /opt/secondbrain/scripts/signal-ingest-amy.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=read-only
ProtectSystem=strict
ReadWritePaths=/opt/secondbrain-durable/signal-ingest /opt/secondbrain-durable/signal-cli
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/signal-people-project-amy.service <<'UNIT'
[Unit]
Description=Project Signal interactions into Amy People files
Wants=network-online.target
After=network-online.target signal-ingest-amy.service

[Service]
Type=oneshot
User=ec2-user
Group=ec2-user
EnvironmentFile=-/opt/secondbrain-durable/.env
Environment=SECONDBRAIN_ROOT=/home/ec2-user/secondbrain-current
ExecStart=/usr/bin/node /opt/secondbrain/scripts/signal-people-project-amy.js
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
UMask=0077
TimeoutStartSec=12min
UNIT

cat >/etc/systemd/system/signal-people-project-amy.timer <<'UNIT'
[Unit]
Description=Stage Signal People events every five minutes and project them once per day at noon CT

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
RandomizedDelaySec=30s
Persistent=true
Unit=signal-people-project-amy.service

[Install]
WantedBy=timers.target
UNIT

cat >/etc/systemd/system/signal-flow-healer-amy.service <<'UNIT'
[Unit]
Description=Heal Signal message completeness, capture, archive, linked-context, Graphiti, and People stages
Wants=network-online.target
After=network-online.target signal-ingest-amy.service

[Service]
Type=oneshot
User=ec2-user
Group=ec2-user
EnvironmentFile=-/opt/secondbrain-durable/.env
Environment=SECONDBRAIN_ROOT=/home/ec2-user/secondbrain-current
ExecStart=/usr/bin/node /opt/secondbrain/scripts/signal-flow-healer-amy.js
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/secondbrain-durable/signal-ingest
UMask=0077
TimeoutStartSec=25min
UNIT

cat >/etc/systemd/system/signal-flow-healer-amy.timer <<'UNIT'
[Unit]
Description=Run the bounded Signal exact-stage healer every minute

[Timer]
OnBootSec=45s
OnUnitActiveSec=1min
RandomizedDelaySec=10s
Persistent=true
Unit=signal-flow-healer-amy.service

[Install]
WantedBy=timers.target
UNIT

chmod 0644 \
  /etc/systemd/system/signal-ingest-amy.service \
  /etc/systemd/system/signal-people-project-amy.service \
  /etc/systemd/system/signal-people-project-amy.timer \
  /etc/systemd/system/signal-flow-healer-amy.service \
  /etc/systemd/system/signal-flow-healer-amy.timer
systemctl daemon-reload
if ! systemctl cat signal-cli-amy.service | grep -q -- '--receive-mode=manual'; then
  echo "signal-cli-amy.service must use --receive-mode=manual; rerun install-signal-cli-ec2.sh first." >&2
  exit 1
fi
systemctl enable signal-cli-amy.service
systemctl restart signal-cli-amy.service
systemctl enable signal-ingest-amy.service
systemctl restart signal-ingest-amy.service
systemctl disable --now signal-people-project-amy.timer >/dev/null 2>&1 || true
systemctl enable --now signal-flow-healer-amy.timer

for _ in $(seq 1 45); do
  if curl -fsS http://127.0.0.1:7584/api/v1/check >/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:7584/api/v1/check >/dev/null
if ! grep -q '^SIGNAL_ACCOUNT=' "${ENV_FILE}"; then
  account="$(curl -fsS -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"listAccounts","id":"installer"}' \
    http://127.0.0.1:7584/api/v1/rpc | /usr/bin/node -e '
      let raw=""; process.stdin.on("data", c => raw += c); process.stdin.on("end", () => {
        const row=JSON.parse(raw); const first=Array.isArray(row.result) ? row.result[0] : null;
        process.stdout.write(typeof first === "string" ? first : String(first?.number || first?.account || ""));
      });
    ' || true)"
  if [[ -n "${account}" ]]; then
    printf 'SIGNAL_ACCOUNT=%s\n' "${account}" >>"${ENV_FILE}"
  else
    echo "Could not resolve the linked Signal account for outbound JSON-RPC." >&2
    exit 1
  fi
fi
systemctl is-active --quiet signal-cli-amy.service
systemctl is-active --quiet signal-ingest-amy.service
systemctl is-active --quiet signal-flow-healer-amy.timer
systemctl start signal-flow-healer-amy.service
activation_health="$(mktemp /tmp/signal-ingest-activation-health.XXXXXX)"
activation_ready=0
trap 'rm -f "${activation_health:-}"' EXIT
for _ in $(seq 1 20); do
  if /usr/bin/node "${CODE_ROOT}/scripts/signal-ingest-health.js" --allow-coverage-building >"${activation_health}"; then
    activation_ready=1
    break
  fi
  sleep 1
done
cat "${activation_health}"
if [[ "${activation_ready}" -ne 1 ]]; then
  echo "Signal ingestion did not reach live manual-subscription readiness." >&2
  exit 1
fi
rm -f "${activation_health}"
trap - EXIT

echo "Signal capture is enabled at boot. The healer retries receiver-journal admission, archive, linked context, Graphiti, and People projection every minute."
