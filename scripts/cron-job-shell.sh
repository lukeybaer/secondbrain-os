#!/bin/bash
# Cron SHELL wrapper: every raw crontab job writes one finished row saying how
# it really ended (owner decision S-4).
#
# Cron runs each job as `$SHELL -c "<command>"`. The crontab gets one line,
# SHELL=/opt/secondbrain-shared/bin/cron-job-shell, and none of the ~30 raw job
# lines change. This script runs the command in /bin/sh (the shell cron uses
# today), records a row, and exits with the job's exact exit code. Stdout,
# stderr and stdin pass through untouched.
#
# FAIL OPEN is the top requirement. The job has already run before anything is
# recorded, and everything after it sits in a guarded block with errors
# discarded: no data dir, full disk, missing tools or a bad log can never change
# the job's exit code or output. Called with anything but `-c <command>` it
# becomes plain /bin/sh.
#
# Row (one per run), <data>/agent/scheduled-job-ends/YYYY-MM-DD.jsonl:
#   {"ts","jobId","command","exit","ended","reason","tookMs"}
# ended: done | refused | timed_out | failed. The reason is the job's own last
# two output lines taken from the log the command redirects to, or "exit N".
#
# SAFETY: raw cron jobs on a timer are NOT stopped by this. Their next tick is
# a scheduled run, not a retry, and stopping one could stop Gmail or recorder
# ingest. A job that fails the same way twice keeps running and only files one
# repair request (data/agent/night-repair-requests.jsonl), which turns the
# System Health scheduled-tasks row red so S-2's fixer takes it. Only the
# scheduled skill fleet has retries to stop, and that lives in
# scripts/lib/cloud-scheduled-fleet.js.
#
# Kill switch without a deploy: if <data>/agent/scheduled-job-ends/DISABLED
# exists the job still runs and returns its code, and nothing is recorded.

# Every job keeps the shell it has today. Cron exports SHELL, and a model session
# under a night job reads $SHELL, so without this each of its commands would come
# back through here and write a row.
SHELL=/bin/sh
export SHELL

if [ "$#" -ne 2 ] || [ "$1" != "-c" ]; then
  exec /bin/sh "$@"
fi

cmd=$2

# The off switch comes first, so a job with it set is not measured in any way.
data=${SECONDBRAIN_DATA_DIR:-/opt/secondbrain/data}
if [ -e "$data/agent/scheduled-job-ends/DISABLED" ]; then
  exec /bin/sh -c "$cmd"
fi

# One JSON string body: printable ASCII only (control and non-ASCII bytes become
# spaces so the row is always valid JSON), whitespace collapsed, cut to $1
# characters, then backslashes and quotes escaped. Secrets come out first, with the
# same patterns as redactSecretsInText in scripts/lib/cloud-scheduled-fleet.js,
# because this reason reaches a System Health row.
json_clean() {
  LC_ALL=C tr -c '[:print:]' ' ' | LC_ALL=C sed -E -e 's/  */ /g' -e 's/^ //' -e 's/ $//' \
    -e 's/Authorization *: *.*/Authorization: [redacted]/Ig' \
    -e 's#Bearer +[A-Za-z0-9._~+/-]+=*#Bearer [redacted]#Ig' \
    -e 's/AKIA[A-Z0-9]{16}/[redacted-access-key]/g' \
    -e 's/(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})/[redacted-token]/g' \
    -e 's#([A-Za-z][A-Za-z0-9+.-]*://)[^ /@:]+:[^ /@]+@#\1[redacted]@#g' \
    -e 's/(token|secret|password|api[_-]?key) *[:=] *[^ ]+/\1=[redacted]/Ig' \
    | LC_ALL=C cut -c1-"$1" | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# The log the command writes to, as "op|path": the last `>` or `>>` target that is
# not an fd duplication such as 2>&1 and not /dev/null.
log_target_of() {
  t=$(printf ' %s\n' "$1" | sed -n -E 's/.*[^0-9>](>>?) *([^ &;|<>"'"'"']+).*/\1|\2/p' | tail -n 1)
  case "${t#*|}" in
    ''|/dev/null) return 0 ;;
  esac
  printf '%s\n' "$t"
}

# "inode|size|mtime" of a regular file, from its metadata alone and bounded, so a
# pipe, a device or a stuck mount can never stop the job from starting. Anything else
# prints nothing, and the row falls back to the exit code.
stat_of() {
  s=$(timeout 2 stat -L -c '%F|%i|%s|%.9Y' -- "$1" 2> /dev/null) || return 0
  case "$s" in
    regular*) printf '%s\n' "${s#*|}" ;;
  esac
}

# Reads a flock command's own options, however they are spelled: -n, --nb, -xn, -w 0.5,
# --timeout=5, -E 75, --conflict-exit-code=75. Sets lock_nb, lock_conflict and lock_path.
parse_flock() {
  lock_nb=0
  lock_conflict=1
  lock_path=""
  set -f
  # shellcheck disable=SC2086
  set -- $1
  set +f
  while [ "$#" -gt 0 ]; do
    case "$1" in
      flock|*/flock) shift; break ;;
    esac
    shift
  done
  while [ "$#" -gt 0 ]; do
    a=$1
    shift
    case "$a" in
      --nonblock|--nb) lock_nb=1 ;;
      --conflict-exit-code=*) lock_conflict=${a#*=} ;;
      --conflict-exit-code) lock_conflict=$1; shift ;;
      --wait=*|--timeout=*) ;;
      --wait|--timeout) shift ;;
      --*) ;;
      -*)
        cluster=${a#-}
        while [ -n "$cluster" ]; do
          c=${cluster%"${cluster#?}"}
          cluster=${cluster#?}
          case "$c" in
            n) lock_nb=1 ;;
            E)
              if [ -n "$cluster" ]; then lock_conflict=$cluster; else lock_conflict=$1; shift; fi
              cluster=""
              ;;
            w)
              [ -n "$cluster" ] || shift
              cluster=""
              ;;
          esac
        done
        ;;
      *)
        lock_path=${a#[\"\']}
        lock_path=${lock_path%[\"\']}
        return 0
        ;;
    esac
  done
  return 1
}

# Everything below is read before the job starts, and none of it can change the job.
start_ns=$(date +%s%N 2> /dev/null) || start_ns=""
log_op=""
log_path=""
log_pre=""
target=$(log_target_of "$cmd" 2> /dev/null) || target=""
if [ -n "$target" ]; then
  log_op=${target%%|*}
  log_path=${target#*|}
  log_pre=$(stat_of "$log_path" 2> /dev/null) || log_pre=""
fi

# Whether this run's lock was already held, read from the kernel's table without
# touching the lock. Read now, not after the job: by then another run may hold it.
lock_nb=0
lock_conflict=1
lock_held_before=0
case "$cmd" in
  *flock*)
    if parse_flock "$cmd" 2> /dev/null && [ "$lock_nb" -eq 1 ]; then
      lock_inode=$(timeout 2 stat -L -c %i -- "$lock_path" 2> /dev/null) || lock_inode=""
      if [ -n "$lock_inode" ] && grep -qE "FLOCK +ADVISORY +(READ|WRITE) +[0-9]+ +[0-9a-f]+:[0-9a-f]+:$lock_inode " "${CRON_JOB_SHELL_PROC_LOCKS:-/proc/locks}" 2> /dev/null; then
        lock_held_before=1
      fi
    fi
    ;;
esac

/bin/sh -c "$cmd"
rc=$?

# The words that name a refusal without one having happened come out first, with the
# same three rules as outputSaysRefused in scripts/lib/scheduled-job-ends.js.
says_refused() {
  printf '%s' "$1" | LC_ALL=C sed -E \
    -e 's/"refus[a-zA-Z_]*"[[:space:]]*:[[:space:]]*(false|0|null|\[[[:space:]]*\])//Ig' \
    -e 's/\b(no|not|never|without|zero|0)[[:space:]]+([a-zA-Z0-9_]+[[:space:]]+)?refus[a-zA-Z0-9_]*//Ig' \
    -e 's/\brefus[a-zA-Z0-9_]*[[:space:]]*[:=]?[[:space:]]*(0|false|none)\b//Ig' \
    | grep -qiE '\brefus'
}

record() {
  dir=$data/agent/scheduled-job-ends

  end_ns=$(date +%s%N)
  took=0
  case "$start_ns$end_ns" in
    *[!0-9]*|'') took=0 ;;
    *) took=$(( (end_ns - start_ns) / 1000000 )) ;;
  esac
  case "$took" in *[!0-9]*|'') took=0 ;; esac

  # The job's own new output. A `>` redirect starts the file over, so all of it is new
  # unless nothing about the file changed. A `>>` redirect adds to it, so only the bytes
  # past the old size are new, unless the file was replaced or cut.
  tail_text=""
  log_post=""
  [ -n "$log_path" ] && log_post=$(stat_of "$log_path")
  if [ -n "$log_post" ]; then
    inode1=${log_post%%|*}
    rest=${log_post#*|}
    size1=${rest%%|*}
    inode0=""
    size0=0
    if [ -n "$log_pre" ]; then
      inode0=${log_pre%%|*}
      rest=${log_pre#*|}
      size0=${rest%%|*}
    fi
    from=-1
    if [ "$log_op" = ">" ]; then
      [ "$log_post" = "$log_pre" ] || from=0
    elif [ -z "$log_pre" ] || [ "$inode1" != "$inode0" ] || [ "$size1" -lt "$size0" ]; then
      from=0
    elif [ "$size1" -gt "$size0" ]; then
      from=$size0
    fi
    if [ "$from" -ge 0 ] && [ "$size1" -gt "$from" ]; then
      n=$((size1 - from))
      [ "$n" -gt 4096 ] && n=4096
      tail_text=$(timeout 5 tail -c "$n" "$log_path" | tail -n 2)
    fi
  fi

  ended=failed
  case "$rc" in
    124|137) ended=timed_out ;;
    0)
      ended=done
      if says_refused "$tail_text"; then ended=refused; fi
      ;;
  esac

  reason=$(printf '%s' "$tail_text" | json_clean 300)
  lock_busy=0
  # Lock busy only when flock itself said so: non-blocking, its own conflict code, fast,
  # silent, and the lock was held before this run began. Its real exit code is kept.
  if [ "$lock_nb" -eq 1 ] && [ "$lock_held_before" -eq 1 ] && [ "$rc" -eq "$lock_conflict" ] && [ "$took" -lt 2000 ] && [ -z "$tail_text" ]; then
    ended=refused
    reason="lock busy"
    lock_busy=1
  fi
  [ -n "$reason" ] || reason="exit $rc"

  day=$(date -u +%Y-%m-%d)
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  hash=$(printf '%s' "$cmd" | sha1sum | cut -c1-8)
  name=$(printf '%s' "$cmd" | grep -oE '[A-Za-z0-9_./-]+\.(js|sh|py)' | head -n 1)
  name=${name##*/}
  name=${name%.*}
  [ -n "$name" ] || name=cmd
  job="$name-$hash"
  cmd_json=$(printf '%s' "$cmd" | json_clean 200)

  mkdir -p "$dir/state" || return 0
  # About 600 KB a day across every job, and a month of rows is plenty.
  [ -f "$dir/$day.jsonl" ] || find "$dir" -maxdepth 1 -name '*.jsonl' -mtime +30 -delete
  printf '{"ts":"%s","jobId":"%s","command":"%s","exit":%s,"ended":"%s","reason":"%s","tookMs":%s}\n' \
    "$now" "$job" "$cmd_json" "$rc" "$ended" "$reason" "$took" >> "$dir/$day.jsonl"

  # Same failure twice files one repair request. A lock-busy skip is another
  # run holding the lock, not a failure, so it neither counts nor clears.
  state=$dir/state/$job
  if [ "$ended" = done ]; then
    if [ -f "$state" ]; then
      rm -f "$state"
      req=$data/agent/night-repair-requests.jsonl
      if [ -f "$req" ] && grep -qF "\"jobId\":\"$job\"" "$req"; then
        printf '{"kind":"resolved","ts":"%s","source":"cron","jobId":"%s","by":"job-ended-done"}\n' "$now" "$job" >> "$req"
      fi
    fi
  elif [ "$lock_busy" -eq 0 ]; then
    fp=$(printf '%s' "$reason" | sed 's/[0-9][0-9]*/N/g' | sha1sum | cut -c1-40)
    prev_fp=""
    count=0
    if [ -f "$state" ]; then read -r prev_fp count < "$state"; fi
    case "$count" in *[!0-9]*|'') count=0 ;; esac
    if [ "$prev_fp" = "$fp" ]; then count=$((count + 1)); else count=1; fi
    printf '%s %s\n' "$fp" "$count" > "$state"
    if [ "$count" -ge 2 ]; then
      req=$data/agent/night-repair-requests.jsonl
      if ! { [ -f "$req" ] && grep -F "\"jobId\":\"$job\"" "$req" | grep -F "\"fingerprint\":\"$fp\"" | grep -qF "\"date\":\"$day\""; }; then
        printf '{"ts":"%s","source":"cron","jobId":"%s","reason":"%s","fingerprint":"%s","workUnitId":"system_health:scheduled-tasks","date":"%s"}\n' \
          "$now" "$job" "$reason" "$fp" "$day" >> "$req"
      fi
    fi
  fi
  return 0
}

( record ) > /dev/null 2>&1 || true

exit "$rc"
