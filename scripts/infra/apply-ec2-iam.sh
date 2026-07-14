#!/usr/bin/env bash
# scripts/infra/apply-ec2-iam.sh
#
# IAM-as-code for the SecondBrain EC2 instance role (report breakpoint 7,
# Perspective A: "IAM-as-code: a checked-in policy plus scripts/infra/
# apply-ec2-iam.sh ExampleCoing the budget actions").
#
# ExampleCos the instance role the READ-ONLY budget permission the Bedrock
# funded-lane collector needs (budgets:ViewBudget on the amy-llm-fallback-bedrock
# budget). Idempotent: put-role-policy overwrites in place, safe to re-run.
#
# This is the ONE privileged write Amy cannot perform herself: modifying IAM
# access controls is a fixed safety line, so ExampleCo runs this once:
#
#     bash scripts/infra/apply-ec2-iam.sh
#
# After it succeeds, ec2-iam-precondition.js flips the Bedrock collector out of
# its PROVISIONING state on the next collector run, and the funded-lane burn
# reappears on the token card.
#
# The account id is resolved at RUNTIME, never hardcoded: the literal 12-digit
# id is a PII denylist token and this file ships in the public-sync allowlist.
set -euo pipefail

ROLE_NAME="${SECONDBRAIN_EC2_ROLE:-secondbrain-ec2-ssm-role}"
POLICY_NAME="${SECONDBRAIN_BUDGET_POLICY:-amy-bedrock-budget-read}"
BUDGET_NAME="${BEDROCK_BUDGET_NAME:-amy-llm-fallback-bedrock}"
REGION="${AWS_REGION:-us-east-1}"

ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)}"
if ! [[ "${ACCOUNT_ID}" =~ ^[0-9]{12}$ ]]; then
  echo "[apply-ec2-iam] ERROR: could not resolve a 12-digit AWS account id (set AWS_ACCOUNT_ID or configure aws sts)" >&2
  exit 1
fi

POLICY_DOC="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AmyBedrockBudgetRead",
      "Effect": "Allow",
      "Action": "budgets:ViewBudget",
      "Resource": "arn:aws:budgets::${ACCOUNT_ID}:budget/${BUDGET_NAME}"
    }
  ]
}
JSON
)"

echo "[apply-ec2-iam] role=${ROLE_NAME} policy=${POLICY_NAME} action=budgets:ViewBudget budget=${BUDGET_NAME}"
aws iam put-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name "${POLICY_NAME}" \
  --policy-document "${POLICY_DOC}"

echo "[apply-ec2-iam] applied. verify with: node scripts/lib/ec2-iam-precondition.js"
