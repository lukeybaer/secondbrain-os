#!/usr/bin/env bash
set -euo pipefail

mapfile -t watcher_scopes < <(
  /usr/bin/systemctl --user list-units --all --plain --no-legend 'secondbrain-watcher-*.scope' |
    /usr/bin/awk '{print $1}'
)

# The control service is the only production watcher owner on the host: a
# global flock protects each fire, the dated semantic lock rejects overlap,
# and shadow mode never launches a model watcher. Stopping the complete named
# watcher family therefore removes stale scopes from this or any superseded
# attempt without crossing into card-healer scopes.
if [ "${#watcher_scopes[@]}" -gt 0 ]; then
  /usr/bin/systemctl --user stop "${watcher_scopes[@]}"
fi
