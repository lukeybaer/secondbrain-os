#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
ROLE_NAME="${OVERNIGHT_CAPACITY_ROLE_NAME:-secondbrain-ec2-ssm-role}"
POLICY_NAME="${OVERNIGHT_CAPACITY_POLICY_NAME:-secondbrain-overnight-capacity-measurement}"
POLICY_FILE="$(mktemp)"
trap 'rm -f "$POLICY_FILE"' EXIT

cat > "$POLICY_FILE" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadSecondBrainInstanceAndVolumeBinding",
      "Effect": "Allow",
      "Action": ["ec2:DescribeInstances"],
      "Resource": "*"
    },
    {
      "Sid": "ReadOvernightCapacityMetrics",
      "Effect": "Allow",
      "Action": ["cloudwatch:GetMetricData"],
      "Resource": "*"
    }
  ]
}
JSON

POLICY_AWS_PATH="$POLICY_FILE"
if command -v cygpath >/dev/null 2>&1; then
  POLICY_AWS_PATH="$(cygpath -w "$POLICY_FILE")"
fi

aws iam put-role-policy \
  --region "$AWS_REGION" \
  --role-name "$ROLE_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document "file://${POLICY_AWS_PATH}"

printf '{"ok":true,"role_name":"%s","policy_name":"%s"}\n' "$ROLE_NAME" "$POLICY_NAME"
