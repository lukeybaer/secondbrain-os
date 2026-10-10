#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="${SECONDBRAIN_CONTROLLER_ROOT:-/opt/secondbrain}"
ROOT="$(readlink -f "$ROOT")"
DATA_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}"
BACKUP="$DATA_DIR/agent/amy-night-owner-migration"
MODE="${1:---verify}"
TIMERS=(amy-briefing-control.timer secondbrain-storage-pressure-maintenance.timer amy-night-run.timer)
restore_timers() {
  local timer present enabled active failed=0
  while IFS='|' read -r timer present enabled active; do
    [ "$present" = yes ] || continue
    if [ "$enabled" = yes ]; then sudo systemctl enable "$timer" || failed=1; else sudo systemctl disable "$timer" || failed=1; fi
    if [ "$active" = yes ]; then sudo systemctl start "$timer" || failed=1; else sudo systemctl stop "$timer" || failed=1; fi
  done < "$1"
  return "$failed"
}
rollback_failed_apply() {
  local code=$?
  trap - ERR
  set +e
  sudo systemctl disable --now amy-night-run.timer
  if sudo systemctl is-active --quiet amy-night-run.service; then
    echo 'Cutover verification failed after the new owner started; retaining its run and leaving old schedules retired. No competing owner was started.' >&2
  else
    if crontab "$BACKUP/crontab.latest" && restore_timers "$BACKUP/timers.latest"; then
      echo 'Cutover failed; restored the exact pre-apply cron and timer state.' >&2
    else
      echo 'Cutover and rollback failed; inspect saved cron/timer state before restarting any owner.' >&2
    fi
  fi
  exit "$code"
}
case "$MODE" in --apply|--verify|--rollback) ;; *) echo 'Use --apply, --verify or --rollback' >&2; exit 2;; esac
if [ "$MODE" != --verify ]; then
  exec 9>"${AMY_CRONTAB_MUTATION_LOCK:-/tmp/amy-crontab-mutation.lock}"
  flock -w 30 9 || { echo 'Another cron mutation is active; retry after it finishes' >&2; exit 3; }
fi
if [ "$MODE" = --rollback ]; then
  test -e "$BACKUP/crontab.before"
  if sudo systemctl is-active --quiet amy-night-run.service; then
    echo 'Current night owner is active; rollback waits for terminal closure' >&2; exit 3
  fi
  crontab -l > "$BACKUP/crontab.rollback-current" 2>/dev/null || true
  node -e 'const fs=require("fs"),m=require(process.argv[1]),current=fs.readFileSync(process.argv[2],"utf8"),before=fs.readFileSync(process.argv[3],"utf8"),installed=fs.existsSync(process.argv[5])?fs.readFileSync(process.argv[5],"utf8"):null;fs.writeFileSync(process.argv[4],current===installed?before:m.restoreLegacyOwners(current,before))' "$ROOT/scripts/lib/night-owner-cron.js" "$BACKUP/crontab.rollback-current" "$BACKUP/crontab.before" "$BACKUP/crontab.rollback" "$BACKUP/crontab.single-owner"
  crontab -l > "$BACKUP/crontab.rollback-recheck" 2>/dev/null || true
  cmp -s "$BACKUP/crontab.rollback-current" "$BACKUP/crontab.rollback-recheck" || { echo 'Cron changed during rollback preparation; no schedules changed' >&2; exit 3; }
  sudo systemctl disable --now amy-night-run.timer
  crontab "$BACKUP/crontab.rollback"
  sudo systemctl daemon-reload
  rm -f "$DATA_DIR/agent/amy-night-owner.active"
  restore_timers "$BACKUP/timers.before"
  exit 0
fi
if [ "$MODE" = --apply ]; then
  # A live old owner drains before cutover. Never kill an active night.
  if sudo systemctl is-active --quiet amy-briefing-control.service; then
    echo 'Prior night owner is still active; retain it until its run closes' >&2
    exit 3
  fi
  node "$ROOT/scripts/lib/night-owner-cutover.js" --active
  mkdir -p "$BACKUP"
  if [ ! -e "$BACKUP/crontab.before" ]; then crontab -l > "$BACKUP/crontab.before" 2>/dev/null || true; fi
  crontab -l > "$BACKUP/crontab.latest" 2>/dev/null || true
  : > "$BACKUP/timers.latest"
  for timer in "${TIMERS[@]}"; do
    present=no; enabled=no; active=no
    if sudo systemctl cat "$timer" >/dev/null 2>&1; then present=yes; fi
    if sudo systemctl is-enabled --quiet "$timer"; then enabled=yes; fi
    if sudo systemctl is-active --quiet "$timer"; then active=yes; fi
    printf '%s|%s|%s|%s\n' "$timer" "$present" "$enabled" "$active" >> "$BACKUP/timers.latest"
  done
  if [ ! -e "$BACKUP/timers.before" ]; then cp "$BACKUP/timers.latest" "$BACKUP/timers.before"; fi
  # Remove redundant briefing owners and restore the fleet's approved Central
  # Time window. Session replication, Otter and unrelated jobs stay unchanged.
  node -e 'const fs=require("fs"),m=require(process.argv[1]);fs.writeFileSync(process.argv[3],m.repairFleetCronTimezone(m.stripLegacyOwners(fs.readFileSync(process.argv[2],"utf8"))))' "$ROOT/scripts/lib/night-owner-cron.js" "$BACKUP/crontab.latest" "$BACKUP/crontab.single-owner"
  cat > "$BACKUP/amy-night-run.service" <<'UNIT'
[Unit]
Description=Amy single nightly refresh, research, report and delivery owner
After=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=3
[Service]
Type=simple
User=ec2-user
Group=ec2-user
Environment=HOME=/home/ec2-user
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=SECONDBRAIN_CONTROLLER_ROOT=/opt/secondbrain
Environment=SECONDBRAIN_DATA_DIR=/opt/secondbrain/data
Environment=SECONDBRAIN_HEALER_ROOT=/home/ec2-user/secondbrain-current
Environment=SECONDBRAIN_MODEL_ROUTER=live
Environment=SECONDBRAIN_BRIEFING_CODEX_CEILING=gpt-5.6-sol:medium
Environment=BRIEFING_CONTROLLER_CONFLICT_LEASES=enforce
UnsetEnvironment=ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY
ExecStartPre=+/bin/bash /opt/secondbrain/scripts/briefing-storage-reserve-run.sh
ExecStartPre=/usr/bin/node /opt/secondbrain/scripts/heal-resource-scope-canary.js
ExecStart=/bin/bash -c 'cd "$(readlink -f /opt/secondbrain)" && exec /usr/bin/node scripts/amy-night-run.js'
ExecStopPost=+/bin/bash /opt/secondbrain/scripts/amy-night-maintenance.sh
Restart=on-failure
RestartSec=30
KillMode=control-group
TimeoutStopSec=30
# The storage reserve pre-start may need several bounded cleanup passes when
# the disk is low; the 90 s systemd default killed the night on 2026-09-26.
TimeoutStartSec=600
UNIT
  cat > "$BACKUP/amy-night-run.timer" <<'UNIT'
[Unit]
Description=Start the one dated Amy night at 23:00 CT
[Timer]
OnCalendar=*-*-* 23:00:00 America/Chicago
# Same owner, same dated receipt: recover finalization if the service failed
# earlier. Starting an already-active unit is a no-op, never a second owner.
OnCalendar=*-*-* 04:30:00 America/Chicago
# A scheduled EC2 resize can stop the service after both calendar times have
# passed. Re-enter the same dated owner after boot; terminal state decides the
# remaining stage and prevents card-production replay.
OnBootSec=2min
Persistent=true
Unit=amy-night-run.service
[Install]
WantedBy=timers.target
UNIT
  sudo systemd-analyze verify "$BACKUP/amy-night-run.service" "$BACKUP/amy-night-run.timer"
  crontab -l > "$BACKUP/crontab.apply-recheck" 2>/dev/null || true
  cmp -s "$BACKUP/crontab.latest" "$BACKUP/crontab.apply-recheck" || { echo 'Cron changed during cutover preparation; no schedules changed' >&2; exit 3; }
  trap rollback_failed_apply ERR
  sudo install -m 644 "$BACKUP/amy-night-run.service" /etc/systemd/system/amy-night-run.service
  sudo install -m 644 "$BACKUP/amy-night-run.timer" /etc/systemd/system/amy-night-run.timer
  sudo systemctl daemon-reload
  # Retire old schedules transactionally before arming the new timer.
  crontab "$BACKUP/crontab.single-owner"
  while IFS='|' read -r timer present enabled active; do
    if [ "$present" = yes ] && [ "$timer" != amy-night-run.timer ]; then sudo systemctl disable --now "$timer"; fi
  done < "$BACKUP/timers.latest"
  node "$ROOT/scripts/lib/night-owner-cutover.js" --active
  sudo systemctl enable --now amy-night-run.timer
fi
sudo systemctl is-enabled --quiet amy-night-run.timer
sudo systemctl is-active --quiet amy-night-run.timer
for legacy_timer in amy-briefing-control.timer secondbrain-storage-pressure-maintenance.timer; do
  if sudo systemctl is-enabled --quiet "$legacy_timer" || sudo systemctl is-active --quiet "$legacy_timer"; then
    echo "Duplicate legacy timer remains active: $legacy_timer" >&2; false
  fi
done
{ sudo crontab -l 2>/dev/null || true; sudo cat /etc/crontab /etc/cron.d/* 2>/dev/null || true; } | node "$ROOT/scripts/lib/night-owner-cutover.js"
if crontab -l | node -e 'const fs=require("fs"),m=require(process.argv[1]);process.exit(fs.readFileSync(0,"utf8").split("\n").some(m.isLegacyOwner)?0:1)' "$ROOT/scripts/lib/night-owner-cron.js"; then
  echo 'Duplicate briefing owner remains scheduled' >&2; false
fi
crontab -l | node -e 'const fs=require("fs"),m=require(process.argv[1]);m.assertFleetCronTimezone(fs.readFileSync(0,"utf8"))' "$ROOT/scripts/lib/night-owner-cron.js"
node "$ROOT/scripts/amy-night-run.js" --plan
if [ "$MODE" = --apply ]; then
  printf '%s\n' 'amy-night-run' > "$DATA_DIR/agent/amy-night-owner.active"
  trap - ERR
fi
