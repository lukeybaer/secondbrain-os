#!/usr/bin/env bash
set -euo pipefail

ROLE_NAME="${SIGNAL_ARCHIVE_ROLE_NAME:-secondbrain-ec2-ssm-role}"
POLICY_NAME="${SIGNAL_ARCHIVE_POLICY_NAME:-secondbrain-signal-raw-archive}"
BUCKET="${SECONDBRAIN_DATA_BUCKET:-ExampleCo-secondbrain-backups}"
PREFIX="data-lake/secondbrain/life-archive/data/signal/raw"

tmp="$(mktemp /tmp/signal-archive-iam.XXXXXX.json)"
cleanup() { rm -f "${tmp}"; }
trap cleanup EXIT

cat >"${tmp}" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LocateSignalRawArchiveBucket",
      "Effect": "Allow",
      "Action": "s3:GetBucketLocation",
      "Resource": "arn:aws:s3:::${BUCKET}"
    },
    {
      "Sid": "ListOnlySignalRawArchivePrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::${BUCKET}",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["${PREFIX}", "${PREFIX}/*"]
        }
      }
    },
    {
      "Sid": "ReadWriteOnlySignalRawArchiveObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/${PREFIX}/*"
    }
  ]
}
JSON

aws iam put-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name "${POLICY_NAME}" \
  --policy-document "$(cat "${tmp}")"

aws iam get-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name "${POLICY_NAME}" \
  --query 'PolicyDocument.Statement[].Sid' \
  --output text
