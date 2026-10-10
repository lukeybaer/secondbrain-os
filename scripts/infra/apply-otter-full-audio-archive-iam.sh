#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
ROLE_NAME="${OTTER_FULL_AUDIO_ARCHIVE_ROLE_NAME:-secondbrain-ec2-ssm-role}"
POLICY_NAME="${OTTER_FULL_AUDIO_ARCHIVE_POLICY_NAME:-secondbrain-otter-full-audio-archive}"
ACCOUNT_ID="${SECONDBRAIN_AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --region "$AWS_REGION" --query Account --output text)}"
BUCKET="${SECONDBRAIN_BACKUP_BUCKET:-${ACCOUNT_ID}-secondbrain-backups}"
PREFIX="${OTTER_FULL_AUDIO_ARCHIVE_PREFIX:-data-lake/secondbrain/otter/full-audio}"

POLICY_DOCUMENT="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LocateOtterFullAudioArchiveBucket",
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:GetBucketVersioning"],
      "Resource": "arn:aws:s3:::${BUCKET}"
    },
    {
      "Sid": "ListOnlyOtterFullAudioArchivePrefix",
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
      "Sid": "ReadWriteOnlyOtterFullAudioArchiveObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/${PREFIX}/*"
    }
  ]
}
JSON
)"

aws iam put-role-policy \
  --region "$AWS_REGION" \
  --role-name "$ROLE_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document "$POLICY_DOCUMENT"

printf '{"ok":true,"role_name":"%s","policy_name":"%s","bucket":"%s","prefix":"%s"}\n' \
  "$ROLE_NAME" "$POLICY_NAME" "$BUCKET" "$PREFIX"
