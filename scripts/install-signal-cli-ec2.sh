#!/usr/bin/env bash
set -euo pipefail

SIGNAL_CLI_VERSION="0.14.7"
SIGNAL_CLI_SHA256="0fe065294adcf35df4c249b635d0ce57de7765d4fec660bffaa2e7f0549d4e5f"
SIGNAL_CLI_ASSET="signal-cli-${SIGNAL_CLI_VERSION}-Linux-native.tar.gz"
SIGNAL_CLI_URL="https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/${SIGNAL_CLI_ASSET}"
INSTALL_DIR="/opt/signal-cli-${SIGNAL_CLI_VERSION}-native"
DATA_DIR="/opt/secondbrain-durable/signal-cli"
SERVICE_NAME="signal-cli-amy.service"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

if ! getent passwd ec2-user >/dev/null; then
  echo "Required service account ec2-user does not exist." >&2
  exit 1
fi

available_kb="$(df -Pk /opt | awk 'NR==2 {print $4}')"
if [[ -z "${available_kb}" || "${available_kb}" -lt 600000 ]]; then
  echo "At least 600 MB free under /opt is required for the verified install." >&2
  exit 1
fi

tmp_dir="$(mktemp -d /tmp/signal-cli-install.XXXXXX)"
archive="${tmp_dir}/${SIGNAL_CLI_ASSET}"
cleanup() {
  rm -f "${archive}"
  rmdir "${tmp_dir}" 2>/dev/null || true
}
trap cleanup EXIT

curl -fL --retry 3 --retry-delay 2 -o "${archive}" "${SIGNAL_CLI_URL}"
actual_sha="$(sha256sum "${archive}" | awk '{print $1}')"
if [[ "${actual_sha}" != "${SIGNAL_CLI_SHA256}" ]]; then
  echo "signal-cli SHA-256 mismatch: ${actual_sha}" >&2
  exit 1
fi

install -d -m 0755 "${INSTALL_DIR}"
tar -xzf "${archive}" -C "${INSTALL_DIR}"
chmod 0755 "${INSTALL_DIR}/signal-cli"
ln -sfn "${INSTALL_DIR}/signal-cli" /usr/local/bin/signal-cli

install -d -o ec2-user -g ec2-user -m 0700 "${DATA_DIR}"

cat >"${SERVICE_PATH}" <<'UNIT'
[Unit]
Description=Amy Signal linked-device daemon
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=ec2-user
Group=ec2-user
ExecStart=/usr/local/bin/signal-cli --scrub-log --config /opt/secondbrain-durable/signal-cli daemon --http=127.0.0.1:7584 --tcp=127.0.0.1:7583 --receive-mode=manual
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/opt/secondbrain-durable/signal-cli
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT

chmod 0644 "${SERVICE_PATH}"
systemctl daemon-reload

installed_version="$(/usr/local/bin/signal-cli --version)"
if [[ "${installed_version}" != "signal-cli ${SIGNAL_CLI_VERSION}" ]]; then
  echo "Unexpected installed version: ${installed_version}" >&2
  exit 1
fi

echo "Installed ${installed_version}."
echo "Data directory: ${DATA_DIR}"
echo "Service installed but intentionally not enabled or started until account linking and durable consumer readiness are both verified."
