#!/usr/bin/env bash
set -euo pipefail

ROLE_NAME="${SESSION_CLOUD_ROLE_NAME:-secondbrain-ec2-ssm-role}"
POLICY_NAME="${SESSION_CLOUD_POLICY_NAME:-secondbrain-session-cloud-heartbeat-read}"
REGION="${SECONDBRAIN_AWS_REGION:-${AWS_REGION:-us-east-1}}"
ACCOUNT_ID="${SECONDBRAIN_AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
BUCKET="${SECONDBRAIN_SESSIONS_BUCKET:-secondbrain-sessions-${ACCOUNT_ID}-${REGION}}"
PREFIX="session-cloud/producer-heartbeats"

policy_file="$(mktemp /tmp/session-cloud-iam.XXXXXX.json)"
cleanup() { rm -f "${policy_file}"; }
trap cleanup EXIT

cat >"${policy_file}" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LocateSessionArchiveBucket",
      "Effect": "Allow",
      "Action": "s3:GetBucketLocation",
      "Resource": "arn:aws:s3:::${BUCKET}"
    },
    {
      "Sid": "ListOnlySessionProducerHeartbeats",
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
      "Sid": "ReadOnlySessionProducerHeartbeats",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${BUCKET}/${PREFIX}/*"
    }
  ]
}
JSON

aws iam put-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name "${POLICY_NAME}" \
  --policy-document "$(cat "${policy_file}")"

aws iam get-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name "${POLICY_NAME}" \
  --query 'PolicyDocument.Statement[].Sid' \
  --output text
