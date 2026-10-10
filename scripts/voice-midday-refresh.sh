#!/usr/bin/env bash
#
# voice-midday-refresh.sh -- on-demand midday refresh of the voice/Otter briefing.
#
# ExampleCo 2026-06-24: do NOT poll every X minutes. This is a single on-demand pass
# for a mid-day run that (1) pulls the latest Otter calls including today, (2)
# processes any new ones, (3) regenerates the coverage reports from the LIVE
# store, and (4) republishes the briefing so the "Otter speaker enrichment" row
# reflects today's calls, treating today as the last day. If there are no new
# calls, it is a safe no-op that just re-confirms the current state.
#
# MUST run from the deploy root where the live data lives (/opt/secondbrain on
# EC2). The report builders are REPO-relative (REPO=__dirname/..) and ignore
# SECONDBRAIN_DATA_DIR, so running from the wrong dir reads an empty data tree.
# See memory/feedback_voice_coverage_reports_run_from_opt_secondbrain.md.
#
# Usage (on EC2):
#   /opt/secondbrain/scripts/voice-midday-refresh.sh
#
set -uo pipefail

# Repo root = parent of this script's dir (so the REPO-relative builders read
# the live data tree next to this checkout, e.g. /opt/secondbrain/data).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "[midday-refresh] cannot cd to repo root $ROOT" >&2; exit 1; }
DATA_DIR="$ROOT/data"

echo "[midday-refresh] root=$ROOT data=$DATA_DIR"

echo "[midday-refresh] 1/4 pulling today's Otter calls + processing any new ones ..."
# --once does a single pull pass (same code path as the every-2-min watcher) and
# queues/launches processing (audio + diarize + resolve) for genuinely new otids.
node scripts/otter-ingest-watch.js --once || echo "[midday-refresh] pull/process pass reported errors (continuing to report regen)"

echo "[midday-refresh] 2/4 regenerating coverage reports from the live store ..."
node scripts/otter-call-completeness-report.js --write >/dev/null && echo "  completeness ok"
node scripts/otter-text-audio-coverage-report.js --write >/dev/null && echo "  text-audio ok"
node scripts/otter-call-speaker-rosters.js --write >/dev/null && echo "  rosters ok"

echo "[midday-refresh] 3/4 voice processing coverage verdict ..."
OTTER_VOICEPRINTS_DIR="$DATA_DIR/life-archive/voiceprints" node scripts/otter-processing-coverage-probe.js 2>&1 | head -2

echo "[midday-refresh] 4/4 republishing briefing ..."
SECONDBRAIN_DATA_DIR="$DATA_DIR" node scripts/cloud-morning-briefing.js --publish --self-heal-refresh

echo "[midday-refresh] done."
