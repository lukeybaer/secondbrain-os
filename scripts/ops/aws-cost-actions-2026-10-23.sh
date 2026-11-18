#!/usr/bin/env bash
# AWS cost actions approved by the owner on 2026-10-23 (ops audit H9 items 1, 2, 3, 6, 7 and M9).
#
# OWNER-RUN. Prepared by the ops-1023 session; nothing here has been executed against
# AWS except the read-only calls that produced the numbers quoted in the hand-off.
#
# Default mode is a PLAN: every block reads AWS (describe/get/list and CloudWatch
# get-metric-statistics only), prints the evidence, the decision and the exact command
# it would run, and changes nothing. With --apply each block stops at its own gate and
# runs only after you type  APPLY <block-id>  (or the id is listed in AMY_COST_CONFIRM).
#
# Usage:
#   bash scripts/ops/aws-cost-actions-2026-10-23.sh --list
#   bash scripts/ops/aws-cost-actions-2026-10-23.sh                    # plan, all blocks
#   bash scripts/ops/aws-cost-actions-2026-10-23.sh --only h9-2        # plan, one group
#   bash scripts/ops/aws-cost-actions-2026-10-23.sh --apply --only h9-2-s3-sessions
#   AMY_COST_CONFIRM=h9-3-efs bash scripts/ops/aws-cost-actions-2026-10-23.sh --apply --only h9-3-efs
#
# Optional environment: AMY_COST_CONFIRM (comma list of block ids pre-confirmed),
# AMY_COST_WORK_DIR (where evidence, payloads, plan-<id>.json and receipt-<id>.json are kept;
# default %APPDATA%/secondbrain/data/agent/aws-cost-actions/<UTC date>, else
# ~/.secondbrain/aws-cost-actions/<UTC date>), EBS_VOLUME_ID, EFS_FILE_SYSTEM_ID,
# WAF_ACL_NAME, EC2_IP, ECR_REPLACE_POLICY=1 (replace an existing ECR policy),
# ECR_KEEP_FLOOR / ECR_KEEP_MARGIN (default 20 / 5).
#
# Hard rules this script keeps (static test: scripts/__tests__/aws-cost-actions-script.test.js):
#   - Deletion: exactly two approved classes (The owner, by voice, 2026-10-23, items H9-7 and M9).
#     Each prints a DELETES: line before its gate. Nothing else here deletes or expires data.
#       APPROVED-DELETION h9-7-ecr-*: the ECR lifecycle policy expires (permanently deletes)
#         untagged images 7 days after push and tagged images beyond the newest N.
#         Protects in-use data: N = max(20, deepest image any ECS task definition, service or
#         running task references, plus 5); the block is BLOCKED when the ECS inventory cannot
#         be read completely or any reference is missing from the repository, and the apply
#         step stores the policy only after the AWS preview expires no in-use image.
#       APPROVED-DELETION m9-dlm: the DLM policy keeps 4 weekly snapshots (RetainRule Count 4),
#         so each new snapshot deletes the oldest snapshot THAT POLICY created.
#         Protects in-use data: it never touches the volume (one tag is added) or any snapshot
#         it did not create.
#   - Everything else is non-destructive. S3 rules this script adds are transition-only; no
#     expiration of any kind is added to any bucket (the backups bucket and every raw archive
#     included), and existing rules are carried over byte for byte. No AWS delete, terminate,
#     deregister, disassociate or detach CLI verb appears anywhere.
#   - CloudWatch dashboards are never touched.
#   - Every command that changes AWS is built in a cmd_* function, shown before it runs,
#     and executed only from an apply_* function after a gate.
#   - Account ExampleCo, default profile only.
#   - Fail closed: a safety input that cannot be read or proven makes the block BLOCKED (no
#     command offered or run) and the run exits nonzero.
#   - Durable proof: every block writes plan-<id>.json; every apply writes receipt-<id>.json
#     (command run, pre-state files, post-state re-read from AWS, rollback).
#
# Blocks, in order: h9-1-ebs, h9-2-s3-backups, h9-2-s3-sessions, h9-2-s3-pixdata,
# h9-3-efs, h9-6-waf, h9-7-ecr-ExampleCo-api, h9-7-ecr-app-api,
# h9-7-ecr-secondbrain-voice, m9-dlm.

set -uo pipefail

export AWS_PAGER=""
export MSYS_NO_PATHCONV=1
export PYTHONUTF8=1

REGION="us-east-1"
EXPECT_ACCOUNT="ExampleCo"
EC2_IP="${EC2_IP:-ExampleCo}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BLOCKS="h9-1-ebs h9-2-s3-backups h9-2-s3-sessions h9-2-s3-pixdata h9-3-efs h9-6-waf h9-7-ecr-ExampleCo-api h9-7-ecr-app-api h9-7-ecr-secondbrain-voice m9-dlm"

APPLY=0
ONLY=""
CMD=()
RESULTS=()
ACCOUNT=""
NOW=""
MODE=""
SHOWN=""          # the last command show_cmd printed, as text
RAN=()            # commands the current apply step executed
RECEIPTS=()       # receipt files written this run
RECEIPT_DONE=0
PLAN_SUMMARY=""   # decision file of the current block, embedded in its plan record
ECR_INVENTORY=""  # "" (not read yet), OK, or "BLOCKED: <reason>"; read once per run, never reused from disk
INV_OUT=""

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR %s\n' "$*" >&2; exit 1; }

banner() {
  printf '\n%s\n%s\n%s\n' "================================================================" "$1" "================================================================"
}

winpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

unixpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf '%s' "$1"; fi
}

# record <id> <outcome> [reason]: the result line plus the durable plan-<id>.json.
record() {
  RESULTS+=("$1: $2")
  say "RESULT $1: $2"
  write_plan "$1" "${2%% (*}" "${3:-$2}" || true
}

# Read-only AWS wrappers. CR characters are stripped for Windows terminals.
aws_r() { aws --region "$REGION" --output json "$@" | tr -d '\r'; }
aws_q() { aws --region "$REGION" --output text "$@" | tr -d '\r'; }

none_to_empty() { local v="$1"; if [ "$v" = "None" ]; then printf ''; else printf '%s' "$v"; fi; }

show_cmd() {
  local out="+" a
  for a in "$@"; do
    case "$a" in
      *[!A-Za-z0-9_./:=@%+,~-]* | "") a="$(printf '%q' "$a")" ;;
    esac
    out="$out $a"
  done
  SHOWN="${out#+ }"
  printf '%s\n' "$out"
}

# The only place a built command is executed. Called from apply_* functions only.
run_cmd() {
  show_cmd "$@" >&2
  RAN+=("$SHOWN")
  "$@"
}

# write_plan <id> <decision> <reason>: plan-<id>.json for every block, in plan and apply mode.
write_plan() {
  local f="$WORKW/plan-$1.json" s=()
  if [ -n "$PLAN_SUMMARY" ]; then s=("summary=$PLAN_SUMMARY"); fi
  PLAN_SUMMARY=""
  lib record plan "$f" "block=$1" "mode=$MODE" "decision=$2" "reason=$3" ${s[@]+"${s[@]}"} || { say "WARN could not write $f"; return 1; }
}

# write_receipt <id> <post-state call> <post-state file> <rollback> [pre-state files...]
# Called by every apply_* after its change. Records the commands run_cmd ran, the post-state
# re-read from AWS and the rollback. Returns 1 when any of those is missing (the block FAILS).
# An earlier receipt for the same block is kept under a timestamped name, never overwritten.
write_receipt() {
  local id="$1" postcall="$2" postfile="$3" rollback="$4" f="$WORK/receipt-$1.json" fw="$WORKW/receipt-$1.json" c p rc args=()
  shift 4
  args=("block=$id" "mode=$MODE" "postCall=$postcall" "postFile=$postfile" "rollback=$rollback")
  for c in ${RAN[@]+"${RAN[@]}"}; do args+=("command=$c"); done
  for p in "$@"; do args+=("pre=$p"); done
  if [ -e "$f" ]; then mv "$f" "$WORK/receipt-$id-$(date -u +%Y%m%dT%H%M%SZ).json" || say "WARN could not keep the earlier $f"; fi
  RECEIPT_DONE=1
  lib record receipt "$fw" "${args[@]}"
  rc=$?
  if [ -f "$f" ]; then RECEIPTS+=("$fw"); fi
  return "$rc"
}

selected() {
  local id="$1" t
  [ -z "$ONLY" ] && return 0
  local IFS=','
  for t in $ONLY; do
    case "$id" in "$t" | "$t"-*) return 0 ;; esac
  done
  return 1
}

gate() {
  local id="$1" answer=""
  if [ "$APPLY" != 1 ]; then
    say "PLAN ONLY (no --apply): nothing was changed."
    return 1
  fi
  if [[ ",${AMY_COST_CONFIRM:-}," == *",${id},"* ]]; then
    say "Pre-confirmed for $id through AMY_COST_CONFIRM."
    return 0
  fi
  printf 'Type  APPLY %s  to run this block; anything else skips it: ' "$id"
  read -r answer || answer=""
  [ "$answer" = "APPLY $id" ]
}

# finish_block <id> apply_<fn> <id> <rollback> [args...]: the gate, then the apply step.
# If an apply step fails after running a command but before its receipt, an incomplete
# receipt is written here so what ran is never lost.
finish_block() {
  local id="$1"
  shift
  if gate "$id"; then
    RAN=()
    RECEIPT_DONE=0
    if "$@"; then
      record "$id" APPLIED "applied; receipt $WORKW/receipt-$id.json"
    else
      if [ "${#RAN[@]}" -gt 0 ] && [ "$RECEIPT_DONE" != 1 ]; then write_receipt "$id" "" "" "${3:-}" || true; fi
      record "$id" FAILED "the apply step failed; see the output and any receipt-$id.json in $WORKW"
    fi
  elif [ "$APPLY" = 1 ]; then
    record "$id" DECLINED "the gate was not confirmed; nothing was changed"
  else
    record "$id" "PLAN ONLY" "plan only: the exact command is shown above and nothing was changed"
  fi
}

skip_block() { say "SKIP: $2"; record "$1" "SKIPPED ($2)" "$2"; }

# A safety input could not be read or proven: no command is offered or run, and the run exits nonzero.
block_refused() { say "BLOCKED: $2"; record "$1" "BLOCKED ($2)" "$2"; }

lib() { node "$LIBW" "$@"; }

jfield() { lib field "$1" "$2"; }

# fetch_metric <namespace> <metric> <dimension-name> <dimension-value> <statistic> <dir>
fetch_metric() {
  local ns="$1" metric="$2" dn="$3" dv="$4" stat="$5" dir="$6" n start end
  for n in 1 2 3 4 5 6 7; do
    read -r start end <<<"$(lib window "$n" "$NOW")"
    aws_r cloudwatch get-metric-statistics --namespace "$ns" --metric-name "$metric" \
      --dimensions "Name=$dn,Value=$dv" --start-time "$start" --end-time "$end" \
      --period 60 --statistics "$stat" >"$dir/${metric}_${n}.json" || die "metric fetch failed: $metric day $n"
  done
}

ec2_root_volume() {
  if [ -n "${EBS_VOLUME_ID:-}" ]; then
    printf '%s' "$EBS_VOLUME_ID"
    return
  fi
  none_to_empty "$(aws_q ec2 describe-instances \
    --filters "Name=ip-address,Values=$EC2_IP" "Name=instance-state-name,Values=running" \
    --query 'Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName==`/dev/xvda`].Ebs.VolumeId | [0]')"
}

# ---------------------------------------------------------------------------
# command builders: the ONLY place a state-changing AWS command is spelled out.
# They fill CMD and execute nothing.
# ---------------------------------------------------------------------------

cmd_ebs_modify() { CMD=(aws --region "$REGION" ec2 modify-volume --volume-id "$1" --iops 3000 --throughput 125); }

cmd_ebs_restore() { CMD=(aws --region "$REGION" ec2 modify-volume --volume-id "$1" --iops "$2" --throughput "$3"); }

cmd_s3_put() {
  CMD=(aws --region "$REGION" s3api put-bucket-lifecycle-configuration --bucket "$1" \
    --transition-default-minimum-object-size "$2" --lifecycle-configuration "file://$3")
}

cmd_efs_update() {
  CMD=(aws --region "$REGION" efs update-file-system --file-system-id "$1" --throughput-mode "$2")
  if [ -n "${3:-}" ]; then CMD+=(--provisioned-throughput-in-mibps "$3"); fi
}

cmd_cf_update() {
  CMD=(aws --region "$REGION" cloudfront update-distribution --id "$1" --distribution-config "file://$2" --if-match "$3")
}

cmd_ecr_preview() {
  CMD=(aws --region "$REGION" ecr start-lifecycle-policy-preview --repository-name "$1" --lifecycle-policy-text "file://$2")
}

cmd_ecr_put() {
  CMD=(aws --region "$REGION" ecr put-lifecycle-policy --repository-name "$1" --lifecycle-policy-text "file://$2")
}

cmd_iam_create_role() {
  CMD=(aws --region "$REGION" iam create-role --role-name "$1" --assume-role-policy-document "file://$2")
}

cmd_iam_attach_role() {
  CMD=(aws --region "$REGION" iam attach-role-policy --role-name "$1" --policy-arn "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole")
}

cmd_ec2_tag() {
  CMD=(aws --region "$REGION" ec2 create-tags --resources "$1" --tags "Key=AmyWeeklySnapshot,Value=true")
}

cmd_dlm_disable() {
  CMD=(aws --region "$REGION" dlm update-lifecycle-policy --policy-id "$1" --state DISABLED)
}

cmd_dlm_create() {
  CMD=(aws --region "$REGION" dlm create-lifecycle-policy --description "$1" --state ENABLED \
    --execution-role-arn "$2" --policy-details "file://$3")
}

# ---------------------------------------------------------------------------
# H9-1 EBS
# ---------------------------------------------------------------------------

apply_ebs() {
  local id="$1" rollback="$2" vol="$3" post="$WORKW/ebs-post.json"
  cmd_ebs_modify "$vol"
  run_cmd "${CMD[@]}" || return 1
  say "Modification state (it moves modifying -> optimizing -> completed; the volume stays online):"
  aws_r ec2 describe-volumes-modifications --volume-ids "$vol" >"$post"
  cat "$post"
  write_receipt "$id" "aws ec2 describe-volumes-modifications --volume-ids $vol" "$post" "$rollback" "$WORKW/ebs-summary.json"
}

block_ebs() {
  local id="$1" vol vtype vsize viops vtp decision saving rollback summary
  banner "H9-1 EBS: lower the root volume to the gp3 baseline, only if 7 days of data say it is idle"
  vol="$(ec2_root_volume)"
  if [ -z "$vol" ]; then skip_block "$id" "could not find the EC2 root volume"; return; fi
  read -r vtype vsize viops vtp <<<"$(aws_q ec2 describe-volumes --volume-ids "$vol" --query 'Volumes[0].[VolumeType,Size,Iops,Throughput]')"
  say "volume $vol: type $vtype, ${vsize} GiB, ${viops} IOPS, ${vtp} MiB/s"
  if [ "$vtype" != "gp3" ]; then skip_block "$id" "volume type is $vtype, not gp3"; return; fi
  if [ "${viops:-0}" -le 3000 ] 2>/dev/null && [ "${vtp:-0}" -le 125 ] 2>/dev/null; then
    skip_block "$id" "already at or under the gp3 baseline (3000 IOPS, 125 MiB/s)"
    return
  fi
  mkdir -p "$WORK/ebs"
  say "Reading 7 days of one-minute CloudWatch data (35 read-only calls)..."
  fetch_metric AWS/EBS VolumeQueueLength VolumeId "$vol" Average "$WORKW/ebs"
  fetch_metric AWS/EBS VolumeReadOps VolumeId "$vol" Sum "$WORKW/ebs"
  fetch_metric AWS/EBS VolumeWriteOps VolumeId "$vol" Sum "$WORKW/ebs"
  fetch_metric AWS/EBS VolumeReadBytes VolumeId "$vol" Sum "$WORKW/ebs"
  fetch_metric AWS/EBS VolumeWriteBytes VolumeId "$vol" Sum "$WORKW/ebs"
  lib ebs-text "$WORKW/ebs"
  summary="$WORKW/ebs-summary.json"
  lib ebs "$WORKW/ebs" >"$summary" || { block_refused "$id" "could not compute the EBS decision"; return; }
  PLAN_SUMMARY="$summary"
  decision="$(jfield "$summary" decision)"
  if [ "$decision" != "REDUCE" ]; then
    skip_block "$id" "$(jfield "$summary" reason); no command is offered"
    return
  fi
  saving="$(awk -v i="$viops" -v t="$vtp" 'BEGIN { ei = (i > 3000) ? i - 3000 : 0; et = (t > 125) ? t - 125 : 0; printf "%.2f", ei * 0.005 + et * 0.04 }')"
  say "Saves about \$$saving per month (\$0.005 per IOPS above 3000, \$0.04 per MiB/s above 125)."
  say "Rollback: modify the volume back to ${viops} IOPS and ${vtp} MiB/s (AWS allows one change per volume per 6 hours):"
  cmd_ebs_restore "$vol" "$viops" "$vtp"
  show_cmd "${CMD[@]}"
  rollback="$SHOWN"
  cmd_ebs_modify "$vol"
  show_cmd "${CMD[@]}"
  finish_block "$id" apply_ebs "$id" "$rollback" "$vol"
}

# ---------------------------------------------------------------------------
# H9-2 S3 lifecycle (transition-only)
# ---------------------------------------------------------------------------

apply_s3() {
  local id="$1" rollbackcmd="$2" kind="$3" bucket="$4" put="$5" min="$6" before="$7" after="$WORKW/${3}-after.json" rollback="$WORKW/${3}-rollback.json"
  cmd_s3_put "$bucket" "$min" "$put"
  run_cmd "${CMD[@]}" || return 1
  aws --region "$REGION" --output json s3api get-bucket-lifecycle-configuration --bucket "$bucket" >"$after" || return 1
  say "== lifecycle configuration AFTER =="
  cat "$after"
  write_receipt "$id" "aws s3api get-bucket-lifecycle-configuration --bucket $bucket" "$after" "$rollbackcmd" "$before" "$put" || return 1
  if lib s3-diff "$kind" "$before" "$after"; then
    return 0
  fi
  lib s3-rollback "$kind" "$before" >"$rollback"
  say "The stored configuration is not what was sent. Rollback payload saved at $rollback; restore with:"
  cmd_s3_put "$bucket" "$min" "$rollback"
  show_cmd "${CMD[@]}"
  return 1
}

block_s3() {
  local id="$1" kind="$2" bucket before put min lcerr rollback
  banner "H9-2 S3 lifecycle ($kind): transition-only, no expiration"
  bucket="$(lib buckets "$ACCOUNT" | awk -v k="$kind" '$1 == k { print $2 }' | tr -d '\r')"
  if [ -z "$bucket" ]; then skip_block "$id" "no bucket name for $kind"; return; fi
  if ! aws --region "$REGION" s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    skip_block "$id" "bucket $bucket not reachable"
    return
  fi
  say "bucket: $bucket"
  say "versioning: $(aws_q s3api get-bucket-versioning --bucket "$bucket" --query Status)"
  before="$WORKW/${kind}-before.json"
  put="$WORKW/${kind}-put.json"
  lcerr="$WORK/${kind}-lc.err"
  if ! aws --region "$REGION" --output json s3api get-bucket-lifecycle-configuration --bucket "$bucket" >"$before" 2>"$lcerr"; then
    if grep -q NoSuchLifecycleConfiguration "$lcerr"; then
      echo '{"Rules":[]}' >"$before"
    else
      cat "$lcerr" >&2
      skip_block "$id" "could not read the current lifecycle configuration"
      return
    fi
  fi
  say "== lifecycle configuration BEFORE =="
  cat "$before"
  lib s3-plan "$kind" "$before" || { skip_block "$id" "rule validation failed"; return; }
  lib s3-merge "$kind" "$before" >"$put" || { skip_block "$id" "merge failed"; return; }
  min="$(lib s3-min-size "$before")"
  say "== exact payload (existing rules are carried over unchanged; a PUT replaces the whole configuration) =="
  cat "$put"
  cmd_s3_put "$bucket" "$min" "$put"
  say "== exact command =="
  show_cmd "${CMD[@]}"
  say "Saves money only for objects older than 30 days, so the effect builds over the first 1 to 6 months."
  say "Transition requests cost \$0.01 per 1,000 (to Standard-IA) and \$0.02 per 1,000 (to Glacier Instant Retrieval), once per object."
  lib s3-rollback "$kind" "$before" >"$WORK/${kind}-rollback.json"
  cmd_s3_put "$bucket" "$min" "$WORKW/${kind}-rollback.json"
  say "Rollback command (re-puts the BEFORE rules; with no prior rules it re-puts the new rules Disabled; nothing is deleted either way):"
  show_cmd "${CMD[@]}"
  rollback="$SHOWN"
  finish_block "$id" apply_s3 "$id" "$rollback" "$kind" "$bucket" "$put" "$min" "$before"
}

# ---------------------------------------------------------------------------
# H9-3 EFS
# ---------------------------------------------------------------------------

apply_efs() {
  local id="$1" rollback="$2" fs="$3" decision="$4" post="$WORKW/efs-post.json" q='FileSystems[0].[ThroughputMode,ProvisionedThroughputInMibps,LifeCycleState]'
  cmd_efs_update "$fs" "$decision"
  run_cmd "${CMD[@]}" || return 1
  aws_r efs describe-file-systems --file-system-id "$fs" --query "$q" >"$post"
  cat "$post"
  write_receipt "$id" "aws efs describe-file-systems --file-system-id $fs --query $q" "$post" "$rollback" "$WORKW/efs-summary.json"
}

block_efs() {
  local id="$1" fs mode pmibps stdbytes decision summary rollback
  banner "H9-3 EFS: stop paying for provisioned throughput the file system does not use"
  fs="${EFS_FILE_SYSTEM_ID:-}"
  if [ -z "$fs" ]; then
    fs="$(none_to_empty "$(aws_q efs describe-file-systems --query "FileSystems[?Name=='secondbrain-voice'].FileSystemId | [0]")")"
  fi
  if [ -z "$fs" ]; then skip_block "$id" "file system secondbrain-voice not found"; return; fi
  read -r mode pmibps stdbytes <<<"$(aws_q efs describe-file-systems --file-system-id "$fs" \
    --query 'FileSystems[0].[ThroughputMode,ProvisionedThroughputInMibps,SizeInBytes.ValueInStandard]')"
  say "file system $fs: throughput mode $mode, provisioned $pmibps MiB/s, standard-class bytes $stdbytes"
  if [ "$mode" != "provisioned" ]; then skip_block "$id" "mode is $mode, nothing to reduce"; return; fi
  if [ "$stdbytes" = "None" ] || [ -z "$stdbytes" ]; then
    stdbytes="$(aws_q efs describe-file-systems --file-system-id "$fs" --query 'FileSystems[0].SizeInBytes.Value')"
  fi
  mkdir -p "$WORK/efs"
  say "Reading 7 days of one-minute CloudWatch data (42 read-only calls)..."
  fetch_metric AWS/EFS MeteredIOBytes FileSystemId "$fs" Sum "$WORKW/efs"
  fetch_metric AWS/EFS DataReadIOBytes FileSystemId "$fs" Sum "$WORKW/efs"
  fetch_metric AWS/EFS DataWriteIOBytes FileSystemId "$fs" Sum "$WORKW/efs"
  fetch_metric AWS/EFS MetadataIOBytes FileSystemId "$fs" Sum "$WORKW/efs"
  fetch_metric AWS/EFS BurstCreditBalance FileSystemId "$fs" Minimum "$WORKW/efs"
  fetch_metric AWS/EFS PermittedThroughput FileSystemId "$fs" Minimum "$WORKW/efs"
  lib efs-text "$WORKW/efs" "$stdbytes" "$pmibps"
  summary="$WORKW/efs-summary.json"
  lib efs "$WORKW/efs" "$stdbytes" "$pmibps" >"$summary" || { block_refused "$id" "could not compute the EFS decision"; return; }
  PLAN_SUMMARY="$summary"
  decision="$(jfield "$summary" decision)"
  case "$decision" in
    bursting | elastic) ;;
    *) skip_block "$id" "decision $decision: $(jfield "$summary" reason)"; return ;;
  esac
  say "Switching is online (no remount). AWS allows one throughput-mode change per file system per 24 hours."
  say "Rollback (same cooldown):"
  cmd_efs_update "$fs" provisioned "$pmibps"
  show_cmd "${CMD[@]}"
  rollback="$SHOWN"
  say "Command for this block:"
  cmd_efs_update "$fs" "$decision"
  show_cmd "${CMD[@]}"
  finish_block "$id" apply_efs "$id" "$rollback" "$fs" "$decision"
}

# ---------------------------------------------------------------------------
# H9-6 WAF: detach from CloudFront, keep the ACL
# ---------------------------------------------------------------------------

apply_waf() {
  local id="$1" rollback="$2" dist etag newcfg acl post="$WORK/post-$1.txt" pre=()
  shift 2
  : >"$post" || return 1
  for dist in "$@"; do
    newcfg="$WORKW/cf-$dist-new.json"
    pre+=("$WORKW/cf-$dist.json")
    etag="$(lib cf-drop-acl "$WORKW/cf-$dist.json" --etag)"
    cmd_cf_update "$dist" "$newcfg" "$etag"
    run_cmd "${CMD[@]}" >/dev/null || return 1
    acl="$(aws_q cloudfront get-distribution --id "$dist" --query 'Distribution.DistributionConfig.WebACLId')"
    say "Distribution $dist now reports WebACLId: '$acl' (empty means detached; CloudFront redeploys in a few minutes)."
    printf "%s WebACLId='%s'\n" "$dist" "$acl" >>"$post"
  done
  write_receipt "$id" "aws cloudfront get-distribution --id <each distribution> --query Distribution.DistributionConfig.WebACLId" "$WORKW/post-$id.txt" "$rollback" ${pre[@]+"${pre[@]}"}
}

block_waf() {
  local id="$1" name acl_id acl_arn rules dists dist etag restore rollback=""
  banner "H9-6 VENTURE alpha WAF: detach the web ACL from CloudFront and KEEP the ACL"
  name="${WAF_ACL_NAME:-venture-front-door-alpha}"
  acl_id="$(none_to_empty "$(aws_q wafv2 list-web-acls --no-paginate --scope CLOUDFRONT --query "WebACLs[?Name=='$name'].Id | [0]")")"
  acl_arn="$(none_to_empty "$(aws_q wafv2 list-web-acls --no-paginate --scope CLOUDFRONT --query "WebACLs[?Name=='$name'].ARN | [0]")")"
  if [ -z "$acl_id" ] || [ -z "$acl_arn" ]; then skip_block "$id" "web ACL $name not found (scope CLOUDFRONT)"; return; fi
  rules="$(aws_q wafv2 get-web-acl --name "$name" --scope CLOUDFRONT --id "$acl_id" --query 'length(WebACL.Rules)')"
  say "web ACL $name ($acl_id), $rules rules, scope CLOUDFRONT"
  dists="$(aws_q cloudfront list-distributions-by-web-acl-id --web-acl-id "$acl_arn" --query 'DistributionList.Items[].Id')"
  dists="$(printf '%s' "$dists" | tr '\t' ' ')"
  if [ -z "$dists" ] || [ "$dists" = "None" ]; then
    skip_block "$id" "the ACL is not attached to any CloudFront distribution"
    return
  fi
  say "attached to: $dists"
  for dist in $dists; do
    aws_r cloudfront get-distribution-config --id "$dist" >"$WORK/cf-$dist.json" || { skip_block "$id" "cannot read distribution $dist"; return; }
    lib cf-drop-acl "$WORKW/cf-$dist.json" >"$WORK/cf-$dist-new.json" || { skip_block "$id" "cannot build the detached config for $dist"; return; }
    lib cf-restore "$WORKW/cf-$dist.json" >"$WORK/cf-$dist-restore.json"
    etag="$(lib cf-drop-acl "$WORKW/cf-$dist.json" --etag)"
    say "distribution $dist: $(aws_q cloudfront get-distribution --id "$dist" --query 'Distribution.[DomainName,Status,DistributionConfig.Comment]')"
    say "only WebACLId changes (verified by the helper). New config saved at $WORKW/cf-$dist-new.json, original at $WORKW/cf-$dist-restore.json"
    cmd_cf_update "$dist" "$WORKW/cf-$dist-new.json" "$etag"
    say "== exact command =="
    show_cmd "${CMD[@]}"
    say "Rollback (fetch a fresh ETag first: get-distribution-config --id $dist --query ETag):"
    cmd_cf_update "$dist" "$WORKW/cf-$dist-restore.json" "NEW_ETAG_HERE"
    show_cmd "${CMD[@]}"
    rollback="${rollback:+$rollback ; }fetch a fresh ETag (get-distribution-config --id $dist --query ETag), then $SHOWN"
  done
  say "EFFECT: the managed common rules, known-bad-inputs rules and the auth rate limit stop filtering traffic to the live VENTURE alpha front door."
  say "SAVING: about \$0. The ACL fee (\$5) and per-rule fees (\$1 x $rules) bill whether or not the ACL is attached; only the \$0.60 per million request fee stops."
  say "Deleting the ACL itself is what would stop the base charge (about \$$((5 + rules)) per month: \$5 plus \$1 for each of the $rules rules). That is a separate decision and is NOT in this script."
  # shellcheck disable=SC2086
  finish_block "$id" apply_waf "$id" "$rollback" $dists
}

# ---------------------------------------------------------------------------
# H9-7 ECR
# ---------------------------------------------------------------------------

# Images referenced by ECS: the newest revision of every active family, every service's
# task definition, and every running task's task definition. Fail closed: every call's exit
# status is checked; any failure, an empty answer where one is required, or an empty result
# sets ECR_INVENTORY to BLOCKED and every ECR block refuses.

# inv_q: aws_q for the inventory; output in INV_OUT, status checked.
inv_q() {
  INV_OUT=""
  if ! INV_OUT="$(aws_q "$@" 2>"$WORK/ecr-inventory.err")"; then
    ECR_INVENTORY="BLOCKED: aws $1 $2 failed ($(tr '\r\n' '  ' <"$WORK/ecr-inventory.err" | cut -c1-200))"
    return 1
  fi
  INV_OUT="$(none_to_empty "$INV_OUT")"
}

add_td_images() {
  inv_q ecs describe-task-definition --task-definition "$1" --query 'taskDefinition.containerDefinitions[].image' || return 1
  if [ -z "$INV_OUT" ]; then ECR_INVENTORY="BLOCKED: task definition $1 lists no container image"; return 1; fi
  printf '%s\n' "$INV_OUT" | tr '\t' '\n' >>"$WORK/ecr-refs.new" || { ECR_INVENTORY="BLOCKED: cannot write the ECS inventory file"; return 1; }
}

collect_ecr_refs() {
  local fams clusters services tasks fam c s t td
  if [ -n "$ECR_INVENTORY" ]; then
    [ "$ECR_INVENTORY" = OK ]
    return
  fi
  : >"$WORK/ecr-refs.new" || { ECR_INVENTORY="BLOCKED: cannot write the ECS inventory file"; return 1; }
  inv_q ecs list-task-definition-families --status ACTIVE --query 'families[]' || return 1
  fams="$INV_OUT"
  for fam in $fams; do add_td_images "$fam" || return 1; done
  inv_q ecs list-clusters --query 'clusterArns[]' || return 1
  clusters="$INV_OUT"
  for c in $clusters; do
    inv_q ecs list-services --cluster "$c" --query 'serviceArns[]' || return 1
    services="$INV_OUT"
    for s in $services; do
      inv_q ecs describe-services --cluster "$c" --services "$s" --query 'services[0].taskDefinition' || return 1
      td="$INV_OUT"
      if [ -z "$td" ]; then ECR_INVENTORY="BLOCKED: service $s reports no task definition"; return 1; fi
      add_td_images "$td" || return 1
    done
    inv_q ecs list-tasks --cluster "$c" --query 'taskArns[]' || return 1
    tasks="$INV_OUT"
    for t in $tasks; do
      inv_q ecs describe-tasks --cluster "$c" --tasks "$t" --query 'tasks[0].taskDefinitionArn' || return 1
      td="$INV_OUT"
      if [ -z "$td" ]; then ECR_INVENTORY="BLOCKED: task $t reports no task definition"; return 1; fi
      add_td_images "$td" || return 1
    done
  done
  sort -u "$WORK/ecr-refs.new" | grep -v '^$' >"$WORK/ecr-refs.sorted"
  if [ ! -s "$WORK/ecr-refs.sorted" ]; then ECR_INVENTORY="BLOCKED: the ECS inventory found no image references"; return 1; fi
  mv "$WORK/ecr-refs.sorted" "$WORK/ecr-refs.txt" || { ECR_INVENTORY="BLOCKED: cannot write the ECS inventory file"; return 1; }
  ECR_INVENTORY=OK
}

apply_ecr() {
  local id="$1" rollback="$2" repo="$3" policy="$4" keepjson="$5" preview="$WORKW/ecr-$3-preview.json" post="$WORKW/ecr-$3-post.json" i status=""
  shift 5
  if [ "$(jfield "$keepjson" ok)" != "true" ]; then
    say "REFUSING: the keep computation is not ok: $(jfield "$keepjson" note). Policy NOT stored."
    return 1
  fi
  cmd_ecr_preview "$repo" "$policy"
  run_cmd "${CMD[@]}" >/dev/null || return 1
  for i in $(seq 1 30); do
    # --no-paginate: a repo with more than 100 images answers in pages and a text-mode scalar
    # query prints "None" for every page after the first, so "COMPLETE" never matched (2026-10-23).
    status="$(aws_q ecr get-lifecycle-policy-preview --no-paginate --repository-name "$repo" --query status)"
    if [ "$status" = "COMPLETE" ]; then break; fi
    if [ "$status" = "FAILED" ]; then say "preview failed"; return 1; fi
    sleep "${POLL_SLEEP_SECONDS:-4}"
  done
  if [ "$status" != "COMPLETE" ]; then say "preview did not finish in time; policy NOT stored"; return 1; fi
  aws_r ecr get-lifecycle-policy-preview --repository-name "$repo" >"$preview" || return 1
  if ! lib ecr-preview-check "$keepjson" "$preview"; then
    say "REFUSING: the previewed policy would expire an image that ECS references. Policy NOT stored."
    return 1
  fi
  cmd_ecr_put "$repo" "$policy"
  run_cmd "${CMD[@]}" >/dev/null || return 1
  aws_r ecr get-lifecycle-policy --repository-name "$repo" >"$post"
  cat "$post"
  write_receipt "$id" "aws ecr get-lifecycle-policy --repository-name $repo" "$post" "$rollback" "$@"
}

block_ecr() {
  local id="$1" repo="$2" images keepjson policy keep ok existing lperr rollback previous="" pre=()
  banner "H9-7 ECR lifecycle: $repo (keep the newest tagged images, expire untagged after 7 days)"
  if ! collect_ecr_refs; then
    block_refused "$id" "ECS inventory incomplete, so the in-use images are unknown: ${ECR_INVENTORY#BLOCKED: }"
    return
  fi
  images="$WORKW/ecr-$repo-images.json"
  keepjson="$WORKW/ecr-$repo-keep.json"
  policy="$WORKW/ecr-$repo-policy.json"
  aws_r ecr describe-images --repository-name "$repo" >"$images" || { block_refused "$id" "cannot list images of $repo"; return; }
  existing="$WORK/ecr-$repo-existing.json"
  lperr="$WORK/ecr-$repo-existing.err"
  if aws --region "$REGION" --output json ecr get-lifecycle-policy --repository-name "$repo" >"$existing" 2>"$lperr"; then
    say "A lifecycle policy already exists on $repo (a PUT replaces it):"
    cat "$existing"
    if [ "${ECR_REPLACE_POLICY:-0}" != "1" ]; then
      skip_block "$id" "existing policy kept; set ECR_REPLACE_POLICY=1 to replace it"
      return
    fi
    previous="$WORKW/ecr-$repo-previous-policy.json"
    jfield "$WORKW/ecr-$repo-existing.json" lifecyclePolicyText >"$previous" || { block_refused "$id" "cannot save the existing policy of $repo for rollback"; return; }
  elif ! grep -q LifecyclePolicyNotFoundException "$lperr"; then
    cat "$lperr" >&2
    block_refused "$id" "cannot read the current lifecycle policy of $repo"
    return
  fi
  lib ecr-text "$repo" "$images" "$WORKW/ecr-refs.txt"
  say "ECS references to this repository (task definitions of every active family, services, running tasks):"
  grep -E "/${repo}[:@]" "$WORK/ecr-refs.txt" | sed 's/^/  /'
  lib ecr-keep "$repo" "$images" "$WORKW/ecr-refs.txt" >"$keepjson" || { block_refused "$id" "keep computation failed"; return; }
  PLAN_SUMMARY="$keepjson"
  ok="$(jfield "$keepjson" ok)"
  if [ "$ok" != "true" ]; then block_refused "$id" "$(jfield "$keepjson" note)"; return; fi
  keep="$(jfield "$keepjson" keep)"
  lib ecr-policy "$keep" >"$policy"
  say "== policy =="
  cat "$policy"
  cmd_ecr_put "$repo" "$policy"
  say "== exact command (the apply step first runs a lifecycle policy preview and refuses if it would expire an in-use image) =="
  show_cmd "${CMD[@]}"
  say "Rollback: put-lifecycle-policy with a larger keep count, or remove the policy; expired images cannot be restored, so the keep count is the safety margin."
  if [ -n "$previous" ]; then
    cmd_ecr_put "$repo" "$previous"
    rollback="$SHOWN (puts back the policy that was there before; images already expired stay gone)"
  else
    rollback="no lifecycle policy existed before: remove the lifecycle policy of $repo in the ECR console (Repositories, $repo, Lifecycle Policy); images already expired stay gone"
  fi
  pre=("$images" "$keepjson" "$WORKW/ecr-refs.txt")
  if [ -n "$previous" ]; then pre+=("$WORKW/ecr-$repo-existing.json"); fi
  say "DELETES: this policy permanently expires $repo images: untagged ones 7 days after push and tagged ones beyond the newest $keep ($(jfield "$keepjson" wouldExpire) images today). Approved deletion class h9-7-ecr-* (owner decision); every in-use image ranks inside the kept set."
  finish_block "$id" apply_ecr "$id" "$rollback" "$repo" "$policy" "$keepjson" "${pre[@]}"
}

# ---------------------------------------------------------------------------
# M9 DLM weekly EBS snapshot, 4 retained
# ---------------------------------------------------------------------------

apply_dlm() {
  local id="$1" rollback="$2" vol="$3" role="$4" role_arn="$5" desc="$6" polfile="$7" trust="$8" role_exists="$9" pid post="$WORKW/dlm-post.json"
  if [ "$role_exists" != "1" ]; then
    cmd_iam_create_role "$role" "$trust"
    run_cmd "${CMD[@]}" >/dev/null || return 1
    cmd_iam_attach_role "$role"
    run_cmd "${CMD[@]}" || return 1
    say "Waiting ${ROLE_WAIT_SECONDS:-15} seconds for the new role to propagate..."
    sleep "${ROLE_WAIT_SECONDS:-15}"
  fi
  cmd_ec2_tag "$vol"
  run_cmd "${CMD[@]}" || return 1
  cmd_dlm_create "$desc" "$role_arn" "$polfile"
  run_cmd "${CMD[@]}" >"$WORK/dlm-create.json" || return 1
  cat "$WORK/dlm-create.json"
  pid="$(jfield "$WORKW/dlm-create.json" PolicyId)"
  if [ "$pid" = undefined ]; then pid=""; fi
  rollback="${rollback//POLICY_ID_FROM_CREATE_OUTPUT/${pid:-POLICY_ID_FROM_CREATE_OUTPUT}}"
  : >"$post"
  if [ -n "$pid" ]; then aws_r dlm get-lifecycle-policy --policy-id "$pid" >"$post"; else say "ERROR the create output has no PolicyId"; fi
  cat "$post"
  write_receipt "$id" "aws dlm get-lifecycle-policy --policy-id ${pid:-?}" "$post" "$rollback" "$polfile" "$trust"
}

block_dlm() {
  local id="$1" vol vsize role role_arn desc polfile trust role_exists existing rollback
  banner "M9 DLM: weekly EBS snapshot of the root volume, 4 kept"
  vol="$(ec2_root_volume)"
  if [ -z "$vol" ]; then skip_block "$id" "could not find the EC2 root volume"; return; fi
  vsize="$(aws_q ec2 describe-volumes --volume-ids "$vol" --query 'Volumes[0].Size')"
  role="AWSDataLifecycleManagerDefaultRole"
  role_arn="arn:aws:iam::${ACCOUNT}:role/${role}"
  desc="amy-weekly-ebs-snapshot-keep-4"
  # The existence read must succeed before a create is offered: a failed read
  # looked like "no policy" and could create a duplicate (closure of fc5b9a2b458a).
  if ! existing="$(aws_q dlm get-lifecycle-policies --query "Policies[?Description=='$desc'].PolicyId" 2>"$WORK/dlm-read.err")"; then
    block_refused "$id" "dlm get-lifecycle-policies failed ($(tr '\r\n' '  ' <"$WORK/dlm-read.err" | cut -c1-200)); no create offered"
    return
  fi
  say "existing DLM policies named $desc: '${existing:-none}'"
  if [ -n "$existing" ] && [ "$existing" != "None" ]; then skip_block "$id" "policy already exists"; return; fi
  role_exists=0
  if aws --region "$REGION" iam get-role --role-name "$role" >/dev/null 2>&1; then role_exists=1; fi
  say "service role $role exists: $role_exists"
  polfile="$WORKW/dlm-policy.json"
  trust="$WORKW/dlm-trust.json"
  cat >"$WORK/dlm-policy.json" <<'POLICY_JSON'
{
  "PolicyType": "EBS_SNAPSHOT_MANAGEMENT",
  "ResourceTypes": ["VOLUME"],
  "TargetTags": [{ "Key": "AmyWeeklySnapshot", "Value": "true" }],
  "Schedules": [
    {
      "Name": "weekly-sunday-keep-4",
      "CopyTags": true,
      "TagsToAdd": [{ "Key": "CreatedBy", "Value": "dlm-amy-weekly" }],
      "CreateRule": { "CronExpression": "cron(0 11 ? * SUN *)" },
      "RetainRule": { "Count": 4 }
    }
  ]
}
POLICY_JSON
  cat >"$WORK/dlm-trust.json" <<'TRUST_JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "dlm.amazonaws.com" }, "Action": "sts:AssumeRole" }
  ]
}
TRUST_JSON
  say "== policy-details =="
  cat "$WORK/dlm-policy.json"
  say "Schedule: Sundays 11:00 UTC (6 AM Central in daylight time), after the weekly EC2 disk janitor window (03:30 CT plus its 90 minute cap)."
  say "Cost: snapshots bill \$0.05 per GB-month of stored blocks. Volume is ${vsize} GiB; the first snapshot holds the written blocks (about 60 to 100 percent of that), so roughly \$15 to \$25 per month, plus changed blocks for each of the 4 kept weeks."
  say "Optional before the first snapshot: run  sudo fstrim -av  on the EC2 host so freed blocks are not carried into the snapshot (not run by this script)."
  if [ "$role_exists" != "1" ]; then
    say "== trust policy for the new service role =="
    cat "$WORK/dlm-trust.json"
    cmd_iam_create_role "$role" "$trust"
    show_cmd "${CMD[@]}"
    cmd_iam_attach_role "$role"
    show_cmd "${CMD[@]}"
  fi
  cmd_ec2_tag "$vol"
  show_cmd "${CMD[@]}"
  cmd_dlm_create "$desc" "$role_arn" "$polfile"
  show_cmd "${CMD[@]}"
  say "Rollback (disable the schedule; snapshots already taken stay until their retention expires; the policy id is in the create output):"
  cmd_dlm_disable "POLICY_ID_FROM_CREATE_OUTPUT"
  show_cmd "${CMD[@]}"
  rollback="$SHOWN"
  say "DELETES: once 4 weekly snapshots exist, each new one makes DLM permanently delete the oldest snapshot this policy created (RetainRule Count 4). Approved deletion class m9-dlm (owner decision); the volume and every snapshot this policy did not create are never touched."
  finish_block "$id" apply_dlm "$id" "$rollback" "$vol" "$role" "$role_arn" "$desc" "$polfile" "$trust" "$role_exists"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

usage() {
  say "usage: $0 [--list] [--apply] [--only id[,id...]]"
  say "blocks: $BLOCKS"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --only)
      shift
      ONLY="${1:-}"
      ;;
    --list)
      for b in $BLOCKS; do say "$b"; done
      exit 0
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1"
      ;;
  esac
  shift
done

command -v aws >/dev/null 2>&1 || die "aws CLI not found"
command -v node >/dev/null 2>&1 || die "node not found"
LIBW="$(winpath "$REPO_ROOT/scripts/lib/aws-cost-actions.js")"
[ -f "$LIBW" ] || [ -f "$REPO_ROOT/scripts/lib/aws-cost-actions.js" ] || die "helper missing: scripts/lib/aws-cost-actions.js"

if [ -n "${AWS_PROFILE:-}" ] && [ "$AWS_PROFILE" != "default" ]; then
  die "AWS_PROFILE=$AWS_PROFILE; this script runs in the default profile (owner-admin) only"
fi
ACCOUNT="$(aws_q sts get-caller-identity --query Account)"
[ "$ACCOUNT" = "$EXPECT_ACCOUNT" ] || die "running in account '$ACCOUNT', expected $EXPECT_ACCOUNT"

# Durable evidence, plans and receipts: never a temp dir.
RUN_DATE="$(date -u +%Y-%m-%d)"
if [ -n "${AMY_COST_WORK_DIR:-}" ]; then
  WORK="$AMY_COST_WORK_DIR"
elif [ -n "${APPDATA:-}" ]; then
  WORK="$(unixpath "$APPDATA")/secondbrain/data/agent/aws-cost-actions/$RUN_DATE"
elif [ -n "${HOME:-}" ]; then
  WORK="$HOME/.secondbrain/aws-cost-actions/$RUN_DATE"
else
  die "no durable place for evidence and receipts; set AMY_COST_WORK_DIR"
fi
mkdir -p "$WORK" || die "cannot create $WORK"
WORKW="$(winpath "$WORK")"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
MODE="$([ "$APPLY" = 1 ] && echo APPLY || echo PLAN)"
say "AWS cost actions, $NOW UTC, account $ACCOUNT, mode: $MODE"
say "Evidence, payloads, plans and receipts are kept in $WORK"

selected h9-1-ebs && block_ebs h9-1-ebs
selected h9-2-s3-backups && block_s3 h9-2-s3-backups backups
selected h9-2-s3-sessions && block_s3 h9-2-s3-sessions sessions
selected h9-2-s3-pixdata && block_s3 h9-2-s3-pixdata pixdata
selected h9-3-efs && block_efs h9-3-efs
selected h9-6-waf && block_waf h9-6-waf
selected h9-7-ecr-ExampleCo-api && block_ecr h9-7-ecr-ExampleCo-api ExampleCo-api
selected h9-7-ecr-app-api && block_ecr h9-7-ecr-app-api app-api
selected h9-7-ecr-secondbrain-voice && block_ecr h9-7-ecr-secondbrain-voice secondbrain-voice
selected m9-dlm && block_dlm m9-dlm

banner "SUMMARY"
rc=0
for r in "${RESULTS[@]:-}"; do
  [ -n "$r" ] && say "$r"
  case "$r" in *": FAILED"* | *": BLOCKED"*) rc=1 ;; esac
done
say "Receipts: ${RECEIPTS[*]:-none} (plans and evidence in $WORKW)"
exit "$rc"
