#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
ROLE_NAME="${OTTER_RAW_ARCHIVE_ROLE_NAME:-secondbrain-ec2-ssm-role}"
POLICY_NAME="${OTTER_RAW_ARCHIVE_POLICY_NAME:-secondbrain-otter-raw-archive}"
ACCOUNT_ID="${SECONDBRAIN_AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --region "$AWS_REGION" --query Account --output text)}"
BUCKET="${SECONDBRAIN_BACKUP_BUCKET:-${ACCOUNT_ID}-secondbrain-backups}"
PREFIX="${OTTER_RAW_ARCHIVE_PREFIX:-data-lake/secondbrain/otter/raw}"
DERIVED_PREFIX="${OTTER_DERIVED_AUDIO_ARCHIVE_PREFIX:-data-lake/secondbrain/otter/derived-audio}"

POLICY_FILE="$(mktemp)"
trap 'rm -f "$POLICY_FILE"' EXIT

cat >"$POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LocateOtterRawArchiveBucket",
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::${BUCKET}"
    },
    {
      "Sid": "ListOnlyOtterRawArchivePrefix",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::${BUCKET}",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["${PREFIX}/*", "${DERIVED_PREFIX}/*"]
        }
      }
    },
    {
      "Sid": "ReadWriteOnlyOtterRawArchiveObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": [
        "arn:aws:s3:::${BUCKET}/${PREFIX}/*",
        "arn:aws:s3:::${BUCKET}/${DERIVED_PREFIX}/*"
      ]
    }
  ]
}
JSON

aws iam put-role-policy \
  --region "$AWS_REGION" \
  --role-name "$ROLE_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document "file://${POLICY_FILE}"

printf '{"ok":true,"role_name":"%s","policy_name":"%s","bucket":"%s","raw_prefix":"%s","derived_audio_prefix":"%s"}\n' \
  "$ROLE_NAME" "$POLICY_NAME" "$BUCKET" "$PREFIX" "$DERIVED_PREFIX"
