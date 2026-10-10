#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
ROLE_NAME="${OTTER_DERIVED_AUDIO_ROLE_NAME:-secondbrain-ec2-ssm-role}"
POLICY_NAME="${OTTER_DERIVED_AUDIO_POLICY_NAME:-secondbrain-otter-derived-audio-retention}"
ACCOUNT_ID="${SECONDBRAIN_AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --region "$AWS_REGION" --query Account --output text)}"
BUCKET="${SECONDBRAIN_BACKUP_BUCKET:-${ACCOUNT_ID}-secondbrain-backups}"
PREFIX="${OTTER_DERIVED_AUDIO_ARCHIVE_PREFIX:-data-lake/secondbrain/otter/derived-audio}"

POLICY_FILE="$(mktemp)"
trap 'rm -f "$POLICY_FILE"' EXIT

cat >"$POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LocateOtterDerivedAudioArchiveBucket",
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::${BUCKET}"
    },
    {
      "Sid": "ListOnlyOtterDerivedAudioArchivePrefix",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::${BUCKET}",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["${PREFIX}", "${PREFIX}/*"]
        }
      }
    },
    {
      "Sid": "ReadWriteOnlyOtterDerivedAudioArchiveObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/${PREFIX}/*"
    }
  ]
}
JSON

aws iam put-role-policy \
  --region "$AWS_REGION" \
  --role-name "$ROLE_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document "file://${POLICY_FILE}"

printf '{"ok":true,"role_name":"%s","policy_name":"%s","bucket":"%s","prefix":"%s"}\n' \
  "$ROLE_NAME" "$POLICY_NAME" "$BUCKET" "$PREFIX"
