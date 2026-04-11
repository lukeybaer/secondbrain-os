-- sessions-ddl.sql
--
-- Athena external table over the session metadata archive in
-- s3://secondbrain-sessions-672613094048-us-east-1/secondbrain/YYYY-MM-DD/
-- *.meta.json
--
-- Gives SQL access to every historical Claude Code session without
-- spinning up a database server. Complements the SQLite FTS5 index in
-- scripts/session-search.ts — that's for fast local grep, this is for
-- structured queries like "sessions per day by tool count" or "all
-- sessions that mentioned 'dentist'" over all time.
--
-- Apply via:
--   aws athena start-query-execution --query-string "$(cat scripts/athena/sessions-ddl.sql)" \
--     --result-configuration OutputLocation=s3://secondbrain-athena-results-672613094048-us-east-1/
--
-- Or via the bootstrap helper:
--   bash scripts/athena/setup-athena.sh
--
-- Commit 17 of 18 in plans/dazzling-rolling-moler.md.

CREATE DATABASE IF NOT EXISTS secondbrain;

CREATE EXTERNAL TABLE IF NOT EXISTS secondbrain.session_meta (
    session_id    string,
    repo          string,
    started_at    string,
    ended_at      string,
    message_count int,
    tool_calls    array<string>,
    first_prompt  string,
    last_response string,
    topic_guess   string
)
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
WITH SERDEPROPERTIES ('ignore.malformed.json' = 'true')
LOCATION 's3://secondbrain-sessions-672613094048-us-east-1/meta/secondbrain/'
TBLPROPERTIES ('has_encrypted_data' = 'false');
