# Graphiti Companion Deployment

## Role

Graphiti is the companion temporal knowledge graph for SecondBrain. The Electron
app keeps local markdown/SQLite memory as the primary durable store and sends
episodes to Graphiti for semantic and temporal retrieval. If Graphiti is
unavailable, local memory and session archives continue to operate.

## Topology

- Client: SecondBrain Electron app on Windows.
- Companion server: EC2 host running Docker containers for Graphiti and Neo4j.
- Graphiti MCP endpoint: `http://127.0.0.1:8000/mcp` from the client
  perspective.
- Access pattern: local SSH tunnel maps Windows `127.0.0.1:8000` to the EC2
  host's local Graphiti port.

The code assumes Graphiti accepts localhost requests only. Do not expose the MCP
port directly to the public internet.

## Authentication And Access

Client access is mediated by SSH:

```powershell
ssh -fNL 8000:localhost:8000 ec2-user@98.80.164.16
```

The app and CLI then talk to `http://127.0.0.1:8000`. SSH key material must stay
outside backup manifests and logs; backup logging redacts the
`secondbrain-backend-key.pem` filename and common secret patterns.

## Offline Behavior

Graphiti calls are best-effort. `src/main/graphiti-client.ts` initializes an MCP
session with timeouts, returns `null`/empty results on failure, and lets callers
fall back to local memory. `scripts/graphiti-cli.mjs` exits quietly for most
pipeline callers when Graphiti is unreachable so archival hooks do not block the
main workflow.

Expected offline behavior:

- Episode ingestion may be skipped while the tunnel or EC2 host is down.
- Search returns no Graphiti hits and should fall back to SQLite/FTS/local
  memory where available.
- No live user data should be overwritten or deleted because Graphiti is
  unavailable.

## Backup Behavior

App-created snapshots attempt a Neo4j dump over SSH into the snapshot staging
area before encryption. If the SSH key or Graphiti host is unavailable, the
Graphiti dump is skipped and the local data/config snapshot still completes.
The dump, when captured, is encrypted along with the rest of the snapshot
payload.

Scheduled backup CLI snapshots encrypt local data/config payloads by default
and upload the encrypted snapshot archive plus redacted manifest to S3. The
backup encryption key is not uploaded with the archive; off-host restores need
the local `.backup-key` or an operator-provided backup key/passphrase.

## Retry And Recovery

- S3 uploads retry up to three times with bounded wait intervals and
  `--no-progress` to avoid `execSync` buffer exhaustion.
- `--sync-orphaned` uploads recent local snapshots missing from S3 and prunes
  manifest entries for snapshots that were already locally removed before a
  successful upload.
- Prune is skip-on-lock: locked snapshot directories remain in the manifest and
  are retried on the next run.
- Graphiti ingestion/search itself does not currently queue retries. Recovery is
  by rerunning seed/backfill scripts or normal future ingestion after the tunnel
  and companion services are healthy.
