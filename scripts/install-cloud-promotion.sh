#!/usr/bin/env bash
set -euo pipefail

# Use the EC2 checkout's own private-origin credentials through Git's shared
# metadata. The scheduled worktree has a separate index and detached HEAD.
source_repo=/home/ec2-user/secondbrain-current
working=/opt/secondbrain-durable/cloud-promotion/worktree
name=secondbrain-cloud-promotion
mkdir -p "$(dirname "$working")"
if [[ ! -e "$working" ]]; then
  git -C "$source_repo" worktree add --detach --lock --reason "post-freeze cloud promotion" "$working" refs/remotes/origin/master
fi
[[ "$(git -C "$working" rev-parse --show-toplevel)" == "$working" ]]
[[ "$(git -C "$working" rev-parse --path-format=absolute --git-common-dir)" == "$(git -C "$source_repo" rev-parse --path-format=absolute --git-common-dir)" ]]
if git -C "$working" symbolic-ref -q HEAD >/dev/null; then
  echo "Cloud promotion requires its own detached checkout" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -f "$tmp/$name.service" "$tmp/$name.timer"; rmdir "$tmp"' EXIT
cat > "$tmp/$name.service" <<EOF
[Unit]
Description=Promote landed private master after the overnight freeze
Wants=network-online.target
After=network-online.target pm2-ec2-user.service
RequiresMountsFor=/opt/secondbrain /opt/secondbrain-durable
StartLimitIntervalSec=1h
StartLimitBurst=4

[Service]
Type=oneshot
User=ec2-user
WorkingDirectory=$working
Environment=HOME=/home/ec2-user GIT_TERMINAL_PROMPT=0 SECONDBRAIN_DATA_DIR=/opt/secondbrain/data NODE_PATH=/opt/secondbrain-shared/node_modules
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node /opt/secondbrain/scripts/cloud-post-freeze-promotion.js
TimeoutStartSec=70min
Restart=on-failure
RestartSec=3min
EOF
cat > "$tmp/$name.timer" <<EOF
[Unit]
Description=Daily 05:35 Central cloud promotion with catch-up after EC2 resize

[Timer]
OnCalendar=*-*-* 05:35:00 America/Chicago
OnBootSec=90s
Persistent=true
AccuracySec=1s
Unit=$name.service

[Install]
WantedBy=timers.target
EOF
reload=0
for suffix in service timer; do
  dest="/etc/systemd/system/$name.$suffix"
  if ! cmp -s "$tmp/$name.$suffix" "$dest"; then
    sudo -n install -m 0644 "$tmp/$name.$suffix" "$dest"
    reload=1
  fi
done
if (( reload )); then sudo -n systemctl daemon-reload; fi
sudo -n systemctl enable --now "$name.timer"
systemctl is-active --quiet "$name.timer"
