#!/usr/bin/env bash
# Source-managed PM2 log rotation for the Amy EC2 host (The owner approved C6, 2026-10-23).
# Run on the host as ec2-user after a deploy. Idempotent: a configured host gets zero pm2 set calls.
#
#   bash scripts/ops/ec2-pm2-logrotate-setup.sh            # apply
#   bash scripts/ops/ec2-pm2-logrotate-setup.sh --check    # exit 0 only when installed and configured
#   bash scripts/ops/ec2-pm2-logrotate-setup.sh --dry-run  # print every command it would run, change nothing
#
# Target: pm2-logrotate with max_size 20M, retain 7, compress true, rotateInterval "0 0 * * *".
#
# Apply: pm2 install pm2-logrotate when pm2 jlist lists no such module; pm2 set each key that
# differs; cap oversized logs; read the config back; write a receipt to
#   ${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}/agent/receipts/pm2-logrotate-<UTC date>.json
#
# Oversized logs: $PM2_HOME/pm2.log and $PM2_HOME/logs/*.log over 50 MB (regular files only,
# symlinks skipped). The last 2000 lines go to <log>.tail-<UTC date>.txt first, then
# truncate -s 0 cuts the file in place, so running processes keep their open descriptors.
# A failed or empty tail copy leaves that log untouched.
#
# Never runs pm2 save, restart, reload, delete, stop or kill. (pm2 set on a module key makes pm2
# restart the pm2-logrotate module itself, nothing else.)
#
# Fail closed: when pm2 jlist cannot be read nothing is changed; when the read-back does not
# match the target the run exits 1 and the receipt says ok false.
#
# Exit: 0 ok, 1 not configured or a step failed, 2 usage.

set -u
shopt -s extglob nullglob

MODE=apply
for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --dry-run) MODE=dry-run ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

MODULE=pm2-logrotate
KEYS=(max_size retain compress rotateInterval)
declare -A WANT=([max_size]=20M [retain]=7 [compress]=true [rotateInterval]='0 0 * * *')
LOG_CAP_BYTES=$((50 * 1024 * 1024))
TAIL_LINES=2000
PM2_DIR="${PM2_HOME:-$HOME/.pm2}"
RECEIPT_DIR="${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}/agent/receipts"
read -r DAY HMS ISO <<<"$(date -u '+%Y-%m-%d %H%M%S %Y-%m-%dT%H:%M:%SZ')"

say() { printf '[pm2-logrotate] %s\n' "$*"; }
die() { printf '[pm2-logrotate] ERROR: %s\n' "$*" >&2; exit 1; }

# Shell-quoted rendering of a command, for the run log and dry-run.
show() {
  local a out=""
  for a in "$@"; do
    case $a in
      '' | *[!A-Za-z0-9_./:=+-]*) out+=" '${a//\'/\'\\\'\'}'" ;;
      *) out+=" $a" ;;
    esac
  done
  printf '%s\n' "${out# }"
}

# Every state-changing command goes through here: printed always, executed only in apply mode.
mutate() {
  if [ "$MODE" = apply ]; then
    printf 'run: '; show "$@"
    "$@"
  else
    printf 'would run: '; show "$@"
  fi
}

JLIST=""
read_jlist() {
  JLIST=$(pm2 jlist 2>/dev/null) || return 1
  [[ $JLIST == *"["* ]]
}
module_listed() { [[ $JLIST =~ \"name\"[[:space:]]*:[[:space:]]*\"pm2-logrotate\" ]]; }

# Parse a pm2 config listing into CONF[key]. Accepts the shapes pm2 versions print:
#   $ pm2 set pm2-logrotate:max_size 20M                (pm2 conf <module>, pm2 4.x and 5.x)
#   Value for module pm2-logrotate key max_size: 20M    (pm2 get <module>:<key>)
#   "max_size": "20M",   or   max_size: 20M            (older JSON or tree dumps)
# ANSI colour codes and CR are stripped first. A key that is not printed stays unset.
declare -A CONF=()
parse_conf() {
  local line key val re
  CONF=()
  while IFS= read -r line; do
    line=${line%$'\r'}
    line=${line//$'\e'\[*([0-9;])m/}
    for key in "${KEYS[@]}"; do
      [ -n "${CONF[$key]+x}" ] && continue
      if [[ $line == *"$MODULE:$key "* ]]; then
        val=${line#*"$MODULE:$key "}
      elif [[ $line == *" key $key: "* ]]; then
        val=${line#*" key $key: "}
      else
        re="^[^[:alnum:]_]*\"?$key\"?[[:space:]]*:[[:space:]]*(.*)$"
        [[ $line =~ $re ]] || continue
        val=${BASH_REMATCH[1]}
        val=${val%,}
        val=${val%\"}
        val=${val#\"}
      fi
      val=${val%%+([[:space:]])}
      CONF[$key]=$val
    done
  done <<<"$1"
}

CONF_ERR=""
read_conf() {
  local out
  if ! out=$(pm2 conf "$MODULE" 2>&1); then
    CONF_ERR=${out##*$'\n'}
    CONF=()
    return 1
  fi
  parse_conf "$out"
}

# JSON helpers without subshells: jstr sets J, conf_to_json sets CJ from CONF.
jstr() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  J="\"$s\""
}
conf_to_json() {
  local k sep=""
  CJ="{"
  for k in "${KEYS[@]}"; do
    jstr "$k"
    CJ+="$sep$J:"
    if [ -n "${CONF[$k]+x}" ]; then jstr "${CONF[$k]}"; CJ+="$J"; else CJ+="null"; fi
    sep=","
  done
  CJ+="}"
}

command -v pm2 >/dev/null 2>&1 || die "pm2 not found on PATH; nothing changed"
read_jlist || die "pm2 jlist failed or printed no process list; nothing changed"
INSTALLED_BEFORE=false
module_listed && INSTALLED_BEFORE=true
CONF_READ_BEFORE=true
read_conf || CONF_READ_BEFORE=false
conf_to_json
BEFORE_JSON=$CJ

# ------------------------------------------------------------------ check
if [ "$MODE" = check ]; then
  bad=()
  [ "$INSTALLED_BEFORE" = true ] || bad+=("module: $MODULE is not installed")
  [ "$CONF_READ_BEFORE" = true ] || bad+=("config: pm2 conf $MODULE failed: $CONF_ERR")
  for k in "${KEYS[@]}"; do
    if [ "${CONF[$k]-}" = "${WANT[$k]}" ]; then
      say "ok $k: ${CONF[$k]}"
    else
      bad+=("$k: want '${WANT[$k]}', have '${CONF[$k]-<unset>}'")
    fi
  done
  if [ ${#bad[@]} -eq 0 ]; then
    say "check ok: $MODULE installed and configured"
    exit 0
  fi
  for b in ${bad[@]+"${bad[@]}"}; do printf '[pm2-logrotate] NOT OK %s\n' "$b" >&2; done
  exit 1
fi

# ------------------------------------------------------- apply or dry-run
FAILED=()
SET_KEYS=()
INSTALLED_NOW=false
if [ "$INSTALLED_BEFORE" = false ]; then
  if mutate pm2 install "$MODULE"; then
    [ "$MODE" = apply ] && INSTALLED_NOW=true
    # Diff against what the module holds now: pm2 may seed package defaults on install.
    if [ "$MODE" = apply ] && ! read_conf; then CONF=(); fi
  else
    FAILED+=("pm2 install $MODULE failed")
  fi
fi
if [ ${#FAILED[@]} -eq 0 ]; then
  for k in "${KEYS[@]}"; do
    [ "${CONF[$k]-}" = "${WANT[$k]}" ] && continue
    if mutate pm2 set "$MODULE:$k" "${WANT[$k]}"; then SET_KEYS+=("$k"); else FAILED+=("pm2 set $MODULE:$k failed"); fi
  done
fi

# Oversized logs. TRUNC_JSON collects {"file","beforeBytes","tailFile"} rows.
TRUNC_JSON=""
cap_log() {
  local f=$1 size tailf
  [ -L "$f" ] && { say "skip symlinked log $f"; return 0; }
  [ -f "$f" ] || return 0
  if ! size=$(wc -c <"$f"); then FAILED+=("size of $f unreadable"); return 0; fi
  size=${size//[[:space:]]/}
  [ "$size" -gt "$LOG_CAP_BYTES" ] || return 0
  tailf="$f.tail-$DAY.txt"
  [ -e "$tailf" ] && tailf="$f.tail-$DAY-$HMS.txt"
  if [ "$MODE" != apply ]; then
    printf 'would run: '; show tail -n "$TAIL_LINES" "$f"; printf '           > %s\n' "$tailf"
    printf 'would run: '; show truncate -s 0 "$f"
    return 0
  fi
  printf 'run: '; show tail -n "$TAIL_LINES" "$f"; printf '     > %s\n' "$tailf"
  if ! tail -n "$TAIL_LINES" "$f" >"$tailf" || [ ! -s "$tailf" ]; then
    FAILED+=("tail copy of $f failed; log left untouched")
    return 0
  fi
  if ! mutate truncate -s 0 "$f"; then
    FAILED+=("truncate of $f failed")
    return 0
  fi
  jstr "$f"; local jf=$J
  jstr "$tailf"
  TRUNC_JSON+="${TRUNC_JSON:+,}{\"file\":$jf,\"beforeBytes\":$size,\"tailFile\":$J}"
}
cap_log "$PM2_DIR/pm2.log"
for f in "$PM2_DIR"/logs/*.log; do cap_log "$f"; done

RECEIPT="$RECEIPT_DIR/pm2-logrotate-$DAY.json"
if [ "$MODE" = dry-run ]; then
  say "dry run: no change made; apply would write a receipt to $RECEIPT"
  [ ${#FAILED[@]} -eq 0 ] || exit 1
  exit 0
fi

# Read back. The receipt is written either way; exit 1 unless everything matches.
INSTALLED_AFTER=false
if read_jlist && module_listed; then INSTALLED_AFTER=true; else FAILED+=("$MODULE not listed by pm2 jlist after apply"); fi
read_conf || FAILED+=("pm2 conf $MODULE read-back failed: $CONF_ERR")
for k in "${KEYS[@]}"; do
  [ "${CONF[$k]-}" = "${WANT[$k]}" ] || FAILED+=("$k read back as '${CONF[$k]-<unset>}', want '${WANT[$k]}'")
done
conf_to_json
AFTER_JSON=$CJ
CONF=()
for k in "${KEYS[@]}"; do CONF[$k]=${WANT[$k]}; done
conf_to_json
WANT_JSON=$CJ

PM2_VERSION=$(pm2 --version 2>/dev/null)
PM2_VERSION=${PM2_VERSION##*$'\n'}
OK=true
[ ${#FAILED[@]} -eq 0 ] || OK=false
SETS=""
for k in ${SET_KEYS[@]+"${SET_KEYS[@]}"}; do jstr "$k"; SETS+="${SETS:+,}$J"; done
FAILS=""
for m in ${FAILED[@]+"${FAILED[@]}"}; do jstr "$m"; FAILS+="${FAILS:+,}$J"; done
jstr "$PM2_VERSION"; JV=$J
jstr "${HOSTNAME:-}"; JH=$J
jstr "$PM2_DIR"; JP=$J

mkdir -p "$RECEIPT_DIR" || die "cannot create $RECEIPT_DIR"
[ -e "$RECEIPT" ] && RECEIPT="$RECEIPT_DIR/pm2-logrotate-$DAY-$HMS.json"
printf '{"ts":"%s","host":%s,"script":"scripts/ops/ec2-pm2-logrotate-setup.sh","ok":%s,"pm2Version":%s,"pm2Home":%s,"module":"%s","installedBefore":%s,"installedNow":%s,"installedAfter":%s,"want":%s,"before":%s,"after":%s,"setKeys":[%s],"truncated":[%s],"failures":[%s]}\n' \
  "$ISO" "$JH" "$OK" "$JV" "$JP" "$MODULE" "$INSTALLED_BEFORE" "$INSTALLED_NOW" "$INSTALLED_AFTER" \
  "$WANT_JSON" "$BEFORE_JSON" "$AFTER_JSON" "$SETS" "$TRUNC_JSON" "$FAILS" >"$RECEIPT" \
  || die "cannot write receipt $RECEIPT"
say "receipt: $RECEIPT"

if [ "$OK" = true ]; then
  say "ok: $MODULE installed and configured; ${#SET_KEYS[@]} setting(s) changed"
  exit 0
fi
for m in ${FAILED[@]+"${FAILED[@]}"}; do printf '[pm2-logrotate] FAILED %s\n' "$m" >&2; done
exit 1
