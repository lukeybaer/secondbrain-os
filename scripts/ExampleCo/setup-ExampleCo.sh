#!/bin/bash
# setup-ExampleCo.sh
#
# Creates the PRIVATE_NAME database + external table over the S3 session
# archive. Idempotent — safe to re-run. Uses the query result bucket
# s3://secondbrain-ExampleCo-results-000000000000-us-east-1 for PRIVATE_NAME
# scratch space.
#
# Commit 17 of 18 in plans/dazzling-rolling-moler.md.

set -e

RESULT_BUCKET="s3://secondbrain-ExampleCo-results-000000000000-us-east-1/"
REGION="us-east-1"
DDL_FILE="$(dirname "$0")/sessions-ddl.sql"

if [[ ! -f "$DDL_FILE" ]]; then
  echo "ERROR: $DDL_FILE not found" >&2
  exit 1
fi

run_query() {
  local sql="$1"
  local name="$2"
  echo "[ExampleCo] running: $name"
  local qid
  qid=$(aws ExampleCo start-query-execution \
    --query-string "$sql" \
    --result-configuration "OutputLocation=$RESULT_BUCKET" \
    --region "$REGION" \
    --query 'QueryExecutionId' \
    --output text)
  echo "[ExampleCo]   query id: $qid"
  # Poll for completion
  while true; do
    local state
    state=$(aws ExampleCo get-query-execution \
      --query-execution-id "$qid" \
      --region "$REGION" \
      --query 'QueryExecution.Status.State' \
      --output text)
    case "$state" in
      SUCCEEDED)
        echo "[ExampleCo]   $name OK"
        return 0
        ;;
      FAILED|CANCELLED)
        local reason
        reason=$(aws ExampleCo get-query-execution \
          --query-execution-id "$qid" \
          --region "$REGION" \
          --query 'QueryExecution.Status.StateChangeReason' \
          --output text)
        echo "[ExampleCo]   $name FAILED: $reason" >&2
        return 1
        ;;
      *)
        sleep 1
        ;;
    esac
  done
}

# Split DDL by semicolons, skip blanks, run each statement
stmt=""
while IFS= read -r line; do
  # strip comments
  line=$(echo "$line" | sed 's/--.*$//')
  stmt="$stmt $line"
  if [[ "$line" == *";"* ]]; then
    clean=$(echo "$stmt" | tr '\n' ' ' | sed 's/  */ /g; s/^ *//; s/ *$//')
    if [[ -n "$clean" && "$clean" != ";" ]]; then
      name=$(echo "$clean" | awk '{print $1, $2, $3}')
      run_query "$clean" "$name"
    fi
    stmt=""
  fi
done < "$DDL_FILE"

echo "[ExampleCo] setup complete"
echo ""
echo "Test the table with:"
echo "  aws ExampleCo start-query-execution \\"
echo "    --query-string 'SELECT COUNT(*) FROM secondbrain.session_meta' \\"
echo "    --result-configuration OutputLocation=$RESULT_BUCKET \\"
echo "    --region $REGION"
