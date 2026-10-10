#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
SOURCE_ROOT="${SECONDBRAIN_WATCHER_SOURCE_ROOT:-/home/ec2-user/secondbrain-current}"
CONTROL_ROOT="${AMY_BRIEFING_CONTROL_ROOT:-/opt/amy-control}"
MODE_FILE="$CONTROL_ROOT/mode"
UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
WATCHER_DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
CONTROL_USER="${AMY_BRIEFING_CONTROL_USER:-ec2-user}"
CONTROL_GROUP="${AMY_BRIEFING_CONTROL_GROUP:-$CONTROL_USER}"
PASSWD_HOME="$(getent passwd "$CONTROL_USER" 2>/dev/null | cut -d: -f6 || true)"
CONTROL_HOME="${AMY_BRIEFING_CONTROL_HOME:-$PASSWD_HOME}"
[ -n "$CONTROL_HOME" ] || { echo "Cannot resolve home for $CONTROL_USER." >&2; exit 1; }
CONTROL_UID="$(id -u "$CONTROL_USER")"
CONTROL_RUNTIME_DIR="/run/user/$CONTROL_UID"
CONTROL_LOCK="${AMY_BRIEFING_CONTROL_LOCK:-/tmp/amy-briefing-cloud-control.lock}"

ensure_control_artifact_ownership() {
  sudo install -d -m 0755 "$CONTROL_ROOT"
  sudo install -d -o "$CONTROL_USER" -g "$CONTROL_GROUP" -m 0755 "$CONTROL_ROOT/state"
  sudo chown -R "$CONTROL_USER:$CONTROL_GROUP" "$CONTROL_ROOT/state"
  if [ -e "$MODE_FILE" ]; then
    sudo chown root:"$CONTROL_GROUP" "$MODE_FILE"
    sudo chmod 0640 "$MODE_FILE"
  fi
  if [ -e "$CONTROL_LOCK" ]; then
    sudo chown "$CONTROL_USER:$CONTROL_GROUP" "$CONTROL_LOCK"
  fi
}

ensure_control_user_manager() {
  # heal-executor intentionally puts each subscription worker in a user-scoped
  # cgroup. A system service running as ec2-user therefore needs the persistent
  # user manager and bus that an interactive SSH login normally supplies.
  local attempt
  sudo loginctl enable-linger "$CONTROL_USER"
  sudo systemctl start "user@$CONTROL_UID.service"
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if sudo -u "$CONTROL_USER" test -S "$CONTROL_RUNTIME_DIR/bus"; then
      return 0
    fi
    sleep 0.25
  done
  echo "Cloud watcher user bus is unavailable at $CONTROL_RUNTIME_DIR/bus." >&2
  exit 1
}

ensure_watcher_runtime_ownership() {
  local rel target runtime_file
  test -d "$WATCHER_DATA_DIR/agent" || {
    echo "Canonical watcher data parent is missing: $WATCHER_DATA_DIR/agent" >&2
    exit 1
  }
  for rel in overnight-report-events heal-sessions overnight-watcher-locks; do
    target="$WATCHER_DATA_DIR/agent/$rel"
    sudo install -d -o "$CONTROL_USER" -g "$CONTROL_GROUP" -m 0755 "$target"
    sudo chown -R "$CONTROL_USER:$CONTROL_GROUP" "$target"
  done
  for runtime_file in \
    "$WATCHER_DATA_DIR/agent/watcher-heartbeat.json" \
    "$WATCHER_DATA_DIR/agent"/overnight-watcher-lock-*.json; do
    if [ -e "$runtime_file" ] && [ "$(stat -c %U "$runtime_file")" = root ]; then
      sudo chown "$CONTROL_USER:$CONTROL_GROUP" "$runtime_file"
    fi
  done
}

install_service_unit() {
  local service_tmp
  service_tmp="$(mktemp)"
  cat >"$service_tmp" <<EOF
[Unit]
Description=Amy briefing cloud control
After=network-online.target

[Service]
Type=oneshot
User=$CONTROL_USER
Group=$CONTROL_GROUP
Environment=HOME=$CONTROL_HOME
Environment=USER=$CONTROL_USER
Environment=LOGNAME=$CONTROL_USER
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=XDG_RUNTIME_DIR=$CONTROL_RUNTIME_DIR
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=$CONTROL_RUNTIME_DIR/bus
Environment=SECONDBRAIN_DATA_DIR=$WATCHER_DATA_DIR
# The wrapper preflight proves its configured source checkout and the active
# immutable runtime resolve to the same commit before the installed controller
# may launch that release.
UnsetEnvironment=ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY
ExecStartPre=+/bin/bash -c 'mode=\$(cat $MODE_FILE); hour=\$(TZ=America/Chicago date +%%H); if [ "\$mode" = active ] && { [ "\$hour" = 22 ] || [ "\$hour" = 23 ]; }; then exec /bin/bash /opt/secondbrain/scripts/briefing-storage-reserve-run.sh; fi'
ExecStartPre=/bin/bash -c 'mode=\$(cat $MODE_FILE); hour=\$(TZ=America/Chicago date +%%H); if [ "\$mode" = active ] && { [ "\$hour" = 22 ] || [ "\$hour" = 23 ]; }; then exec /bin/bash $SOURCE_ROOT/scripts/ec2-overnight-watcher-run.sh --preflight; fi'
ExecStart=/usr/bin/flock -n $CONTROL_LOCK /bin/bash -c 'mode=\$(cat $MODE_FILE); hour=\$(TZ=America/Chicago date +%%H); if [ "\$mode" = active ] && { [ "\$hour" = 22 ] || [ "\$hour" = 23 ]; }; then exec /usr/bin/node $CONTROL_ROOT/briefing-cloud-control.js --active; elif [ "\$mode" = shadow ]; then exec /usr/bin/node $CONTROL_ROOT/briefing-cloud-control.js --shadow; else exec /usr/bin/node $CONTROL_ROOT/briefing-cloud-control.js --status; fi'
ExecStopPost=-/bin/bash $CONTROL_ROOT/stop-watcher-scopes.sh
KillMode=control-group
EOF
  if ! sudo install -m 0644 "$service_tmp" "$UNIT_DIR/amy-briefing-control.service"; then
    rm -f "$service_tmp"
    return 1
  fi
  rm -f "$service_tmp"
  sudo systemctl daemon-reload
}

verify_control_user_runtime() {
  sudo -u "$CONTROL_USER" env \
    -u ANTHROPIC_API_KEY \
    -u ANTHROPIC_AUTH_TOKEN \
    -u OPENAI_API_KEY \
    HOME="$CONTROL_HOME" \
    PATH=/usr/local/bin:/usr/bin:/bin \
    XDG_RUNTIME_DIR="$CONTROL_RUNTIME_DIR" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$CONTROL_RUNTIME_DIR/bus" \
    SECONDBRAIN_DATA_DIR="$WATCHER_DATA_DIR" \
    SECONDBRAIN_WATCHER_SOURCE_ROOT="$SOURCE_ROOT" \
    /bin/bash -lc '
      set -euo pipefail
      test -d "$HOME/.claude"
      test -d "$HOME/.codex"
      command -v git >/dev/null
      command -v claude >/dev/null
      command -v codex >/dev/null
      test -S "$XDG_RUNTIME_DIR/bus"
      test -s "$HOME/.claude-oauth-token"
      test -s "$HOME/.codex/auth.json"
      test -z "${ANTHROPIC_API_KEY:-}"
      test -z "${ANTHROPIC_AUTH_TOKEN:-}"
      test -z "${OPENAI_API_KEY:-}"
      claude --version >/dev/null
      codex --version >/dev/null
      git -C "$SECONDBRAIN_WATCHER_SOURCE_ROOT" status --porcelain >/dev/null
      test "$(stat -c %U "$SECONDBRAIN_WATCHER_SOURCE_ROOT")" = "$(id -un)"
      if find "$HOME/.claude" "$HOME/.codex" -xdev -user root -print -quit 2>/dev/null | grep -q .; then
        echo "Cloud watcher runtime has root-owned residue in its user state." >&2
        exit 1
      fi
    '
}

case "$MODE" in
  --shadow|--activate|--rollback|--refresh-active) ;;
  *) echo "Usage: $0 --shadow|--activate|--rollback|--refresh-active" >&2; exit 2 ;;
esac

if [ "$MODE" = "--rollback" ]; then
  sudo systemctl disable --now amy-briefing-control.timer || true
  echo shadow | sudo tee "$MODE_FILE" >/dev/null
  echo "Briefing cloud control disabled. The prior watcher schedule was not changed."
  exit 0
fi

if [ "$MODE" = "--refresh-active" ]; then
  ensure_control_artifact_ownership
  [ -r "$MODE_FILE" ] && [ "$(tr -d '[:space:]' <"$MODE_FILE")" = "active" ] || {
    echo "Refresh refused: cloud control mode is not active." >&2
    exit 1
  }
  sudo systemctl is-enabled --quiet amy-briefing-control.timer &&
    sudo systemctl is-active --quiet amy-briefing-control.timer || {
      echo "Refresh refused: cloud control timer is not enabled and active." >&2
      exit 1
    }
  ensure_control_user_manager
  ensure_watcher_runtime_ownership
  sudo install -m 0755 "$SOURCE_ROOT/scripts/briefing-cloud-control.js" "$CONTROL_ROOT/briefing-cloud-control.js"
  sudo install -m 0755 "$SOURCE_ROOT/scripts/stop-watcher-scopes.sh" "$CONTROL_ROOT/stop-watcher-scopes.sh"
  install_service_unit
  verify_control_user_runtime
  sudo -u "$CONTROL_USER" env HOME="$CONTROL_HOME" /usr/bin/node "$CONTROL_ROOT/briefing-cloud-control.js" --status >/dev/null
  echo "Refreshed active briefing cloud control code and reinstalled its $CONTROL_USER service identity without changing mode, timer ownership, or cron."
  exit 0
fi

ensure_control_artifact_ownership
ensure_control_user_manager
ensure_watcher_runtime_ownership
sudo install -m 0755 "$SOURCE_ROOT/scripts/briefing-cloud-control.js" "$CONTROL_ROOT/briefing-cloud-control.js"
sudo install -m 0755 "$SOURCE_ROOT/scripts/stop-watcher-scopes.sh" "$CONTROL_ROOT/stop-watcher-scopes.sh"
verify_control_user_runtime
sudo -u "$CONTROL_USER" env HOME="$CONTROL_HOME" /usr/bin/node "$CONTROL_ROOT/briefing-cloud-control.js" --status >/dev/null

if [ "$MODE" = "--activate" ]; then
  latest_outcome="$(sudo env CTRL_RECEIPT="$CONTROL_ROOT/state/latest.json" /usr/bin/node -e "const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.env.CTRL_RECEIPT));process.stdout.write(x.mode==='shadow'&&x.phase==='close'&&x.outcome==='cleared'?'cleared':'not-cleared')")"
  [ "$latest_outcome" = "cleared" ] || { echo "Activation refused: no clean closed shadow-night receipt." >&2; exit 1; }
  next_mode=active
else
  next_mode=shadow
fi
echo "$next_mode" | sudo tee "$MODE_FILE" >/dev/null
ensure_control_artifact_ownership

timer_tmp="$(mktemp)"
trap 'rm -f "$timer_tmp"' EXIT
cat >"$timer_tmp" <<EOF
[Unit]
Description=Run Amy briefing cloud control independently of the mutable repo

[Timer]
OnCalendar=*-*-* 22:45:00 America/Chicago
OnCalendar=*-*-* 22:55:00 America/Chicago
OnCalendar=*-*-* 23:05:00 America/Chicago
OnCalendar=*-*-* 05:45:00 America/Chicago
Persistent=true
Unit=amy-briefing-control.service

[Install]
WantedBy=timers.target
EOF
install_service_unit
sudo install -m 0644 "$timer_tmp" "$UNIT_DIR/amy-briefing-control.timer"
sudo systemctl daemon-reload
sudo systemctl enable --now amy-briefing-control.timer

if [ "$MODE" = "--activate" ]; then
  "$SOURCE_ROOT/scripts/install-ec2-overnight-watcher-cron.sh" --rollback
  echo "Activated independent briefing cloud control after a clean shadow night; retired only the legacy briefing watcher cron."
else
  echo "Installed briefing cloud control in shadow mode; the legacy watcher remains authoritative for this proof night."
fi
