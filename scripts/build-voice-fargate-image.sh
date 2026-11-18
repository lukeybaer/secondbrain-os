#!/usr/bin/env bash
# Rebuild the Fargate voice image from one landed SHA and register it as the
# next secondbrain-voice task-definition revision (2026-09-24).
#
# An EC2 release never touches Fargate: voice jobs keep running the image the
# last manual CodeBuild produced, so a producer fix is live on EC2 only. This
# script makes the rebuild one repeatable step. Build the SAME SHA that EC2
# runs, so the envelope provenance (image source SHA plus core-doc hash) matches
# the cutover release that deploy recorded.
#
# Usage: bash scripts/build-voice-fargate-image.sh <40-char landed sha>
set -euo pipefail

SHA="${1:?usage: build-voice-fargate-image.sh <landed sha>}"
REGION="${AWS_REGION:-us-east-1}"
BUCKET="${VOICE_BUILD_BUCKET:?set VOICE_BUILD_BUCKET to your deploy bucket}"
PROJECT="${VOICE_BUILD_PROJECT:-secondbrain-voice}"
FAMILY="${VOICE_FARGATE_TASKDEF:-secondbrain-voice}"
# A trial build registers under a separate family (for example
# secondbrain-voice-test) copied from FAMILY, so production voice launches keep
# the known-good image until the trial job is proven.
REGISTER_FAMILY="${VOICE_FARGATE_REGISTER_FAMILY:-$FAMILY}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
PYTHON_BIN="$(command -v python3 || command -v python)"

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "refused: need the full 40-character sha" >&2; exit 64; }
git -C "$REPO_ROOT" fetch -q origin master
git -C "$REPO_ROOT" merge-base --is-ancestor "$SHA" origin/master || {
  echo "refused: $SHA is not on origin/master" >&2
  exit 65
}

work="$(mktemp -d)"
trap 'rm -rf "$work" "$work.zip"' EXIT
git -C "$REPO_ROOT" archive --format=tar "$SHA" | tar -x -C "$work"

# Load the voice job's entry modules from exactly the repo paths the Dockerfile
# copies, with no node_modules, before building. A 2026-09-24 image without
# config/ crashed every voice job on start.
image_root="$(mktemp -d)"
while read -r source target; do
  mkdir -p "$image_root/$(dirname "$target")"
  cp -r "$work/$source" "$image_root/$target"
done < <(sed -nE 's#^COPY[[:space:]]+([^[:space:]]+)[[:space:]]+\./([^[:space:]]+)[[:space:]]*$#\1 \2#p' "$work/deploy/voice-fargate/Dockerfile")
if ! (cd "$image_root" && NODE_PATH= node -e '
  for (const f of ["scripts/otter-post-ingest-voice-intelligence.js", "scripts/otter-diarized-segment-backfill.js",
    "scripts/otter-track-probe-builder.js", "scripts/lib/otter-exact-call-envelope-producer.js"]) require("./" + f);
'); then
  rm -rf "$image_root"
  echo "[voice-image] refused: the image file set cannot load the voice job" >&2
  exit 1
fi
rm -rf "$image_root"
aws s3 sync --only-show-errors --region "$REGION" \
  "s3://$BUCKET/voice-fargate/model-cache/speechbrain-ecapa-voxceleb/" \
  "$work/data/life-archive/voiceprints/model-cache/speechbrain-ecapa-voxceleb/"
[[ -s "$work/data/life-archive/voiceprints/model-cache/speechbrain-ecapa-voxceleb/embedding_model.ckpt" ]] || {
  echo "[voice-image] refused: the ECAPA model cache did not download" >&2
  exit 1
}
"$PYTHON_BIN" - "$work" "$work.zip" <<'PY'
import os, sys, zipfile
root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
    for base, _dirs, files in os.walk(root):
        for name in files:
            full = os.path.join(base, name)
            archive.write(full, os.path.relpath(full, root))
PY
aws s3 cp --only-show-errors --region "$REGION" "$work.zip" "s3://$BUCKET/voice-fargate/source.zip"
aws s3 cp --only-show-errors --region "$REGION" "$work.zip" "s3://$BUCKET/voice-fargate/sources/source-$SHA.zip"
rm -f "$work.zip"

build_id="$(aws codebuild start-build --region "$REGION" --project-name "$PROJECT" \
  --environment-variables-override "name=SECONDBRAIN_SOURCE_SHA,value=$SHA,type=PLAINTEXT" \
  --query build.id --output text)"
echo "[voice-image] build $build_id started for $SHA"
while :; do
  status="$(aws codebuild batch-get-builds --region "$REGION" --ids "$build_id" --query 'builds[0].buildStatus' --output text)"
  [[ "$status" == "IN_PROGRESS" ]] || break
  sleep 15
done
[[ "$status" == "SUCCEEDED" ]] || { echo "[voice-image] build $build_id ended $status" >&2; exit 1; }

tag="${SHA:0:12}"
digest="$(aws ecr describe-images --region "$REGION" --repository-name secondbrain-voice \
  --image-ids "imageTag=$tag" --query 'imageDetails[0].imageDigest' --output text)"
[[ "$digest" == sha256:* ]] || { echo "[voice-image] no pushed image for tag $tag" >&2; exit 1; }

# The task definition pins an image digest, so a new image runs only after a
# new revision names it. Copy the current revision and change only the image.
# Voice jobs are one-off run-task launches by family name (no ECS service), so
# every launch after registration uses the new revision; tasks already running
# finish on the image they started with.
current="$(aws ecs describe-task-definition --region "$REGION" --task-definition "$FAMILY" --query taskDefinition --output json)"
registry="$(printf '%s' "$current" | "$PYTHON_BIN" -c 'import json,sys; print(json.load(sys.stdin)["containerDefinitions"][0]["image"].split("@")[0].split(":")[0])')"
next="$(printf '%s' "$current" | "$PYTHON_BIN" -c '
import json, sys
spec = json.load(sys.stdin)
image = sys.argv[1]
keep = ["family", "taskRoleArn", "executionRoleArn", "networkMode", "containerDefinitions",
        "volumes", "placementConstraints", "requiresCompatibilities", "cpu", "memory",
        "runtimePlatform", "ephemeralStorage"]
out = {key: spec[key] for key in keep if spec.get(key) not in (None, [], {})}
out["containerDefinitions"][0]["image"] = image
out["family"] = sys.argv[2]
print(json.dumps(out))
' "$registry@$digest" "$REGISTER_FAMILY")"
revision="$(aws ecs register-task-definition --region "$REGION" --cli-input-json "$next" \
  --query 'taskDefinition.revision' --output text)"
echo "[voice-image] $REGISTER_FAMILY:$revision registered; new voice launches use $registry@$digest (source $SHA)"
