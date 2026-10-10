'use strict';

// Every Gravity law names the process that produces its evidence and where
// that evidence lands on EC2 (ExampleCo 2026-09-23: evidence lives on EC2).
// liveSince is the first CT date the producer is proven to deliver; the
// evidence watchdog in gravity-health.js only escalates a two-day UNKNOWN to
// VIOLATED on or after that date. null means "declared, not yet proven live":
// set it only after the producer is deployed and seen delivering. Dates of
// 2026-09-24 were set after the 2026-09-23 EC2 run proved each producer live.
// g2/g5 stay null: the PC send-guard decision log has not been written since
// 2026-09-03. g19 was retired on 2026-09-24.
const GRAVITY_EVIDENCE_PRODUCERS = Object.freeze({
  g0: { producer: 'devops-health hook integrity', evidence: 'agent/devops-health-latest.json', liveSince: '2026-09-23' },
  g1: { producer: 'prompt provenance recorder', evidence: 'operation-provenance prompt.* events', liveSince: '2026-09-24' },
  g2: { producer: 'send-guard evidence forwarder', evidence: 'outbound-send-guard.log + comms.out events', liveSince: null },
  g3: { producer: 'dispatch log and Gmail scan heartbeat', evidence: 'agent/amy-dispatch-log.jsonl, agent/gmail-scan-heartbeat.jsonl', liveSince: '2026-09-23' },
  g4: { producer: 'big-decision ledger', evidence: 'agent/big-decisions.jsonl', liveSince: '2026-09-23' },
  g5: { producer: 'send-guard evidence forwarder', evidence: 'outbound-send-guard.log + comms.out events', liveSince: null },
  g6: { producer: 'prompt provenance recorder', evidence: 'operation-provenance prompt.* events', liveSince: '2026-09-24' },
  g7: { producer: 'Tier 1 size check', evidence: 'memory/MEMORY.md', liveSince: '2026-09-23' },
  g8: { producer: 'release tree or desktop junction proof', evidence: 'memory/MEMORY.md', liveSince: '2026-09-23' },
  g9: { producer: 'task spine store', evidence: 'tasks/', liveSince: '2026-09-23' },
  g10: { producer: 'git hygiene snapshot and land service', evidence: 'agent/git-hygiene-snapshot.json, land.pushed events', liveSince: '2026-09-24' },
  g11: { producer: 'land service', evidence: 'land.pushed events', liveSince: '2026-09-23' },
  g12: { producer: 'land service', evidence: 'land.pushed scoped_test_file_count', liveSince: '2026-09-24' },
  g13: { producer: 'task spine store', evidence: 'tasks/', liveSince: '2026-09-23' },
  g14: { producer: 'devops-health hook integrity', evidence: 'agent/devops-health-latest.json', liveSince: '2026-09-23' },
  g15: { producer: 'nightly gravity-evidence public-mirror currency receipt', evidence: 'agent/public-mirror-currency-<date>.json', liveSince: '2026-09-24' },
  g17: { producer: 'ask-ai rung log', evidence: 'agent/ask-ai-rungs.jsonl', liveSince: '2026-09-23' },
  g20: { producer: 'operation provenance comms surfaces', evidence: 'operation-provenance comms.* events', liveSince: '2026-09-23' },
  g22: { producer: 'land service', evidence: 'land.pushed scoped_test_file_count', liveSince: '2026-09-24' },
  g23: { producer: 'nightly learn receipt ledger', evidence: 'agent/learn-receipts.jsonl', liveSince: '2026-09-24' },
  g24: { producer: 'release laws provenance', evidence: 'agent/release-laws-provenance.json', liveSince: '2026-09-24' },
  g25: { producer: 'prompt provenance recorder', evidence: 'operation-provenance prompt.* events', liveSince: '2026-09-24' },
  g26: { producer: 'nightly cloud-first drift receipt', evidence: 'agent/cloud-first-drift-<date>.json', liveSince: '2026-09-24' },
  g27: { producer: 'nightly unit-independence receipt', evidence: 'agent/unit-independence-<date>.json', liveSince: '2026-09-24' },
});

module.exports = { GRAVITY_EVIDENCE_PRODUCERS };
