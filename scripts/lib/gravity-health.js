'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { ctDateString, gravityStructure } = require('./gravity-semantic-gate.js');
const { MEMORY_MD_CAP_BYTES, lfByteLength } = require('./memory-md-cap.js');
const { readOperationEvents } = require('./operation-provenance.js');
const { GRAVITY_EVIDENCE_PRODUCERS } = require('./gravity-evidence-producers.js');
const { missingCommsSurfaces, priorCtDateKey } = require('./comms-surface-manifest.js');

const SCHEMA = 'amy.gravity_health.v1';
const LAW_STATUSES = new Set(['COMPLIANT', 'VIOLATED', 'UNKNOWN', 'NOT APPLICABLE']);
// Charged API rung names from scripts/lib/ask-ai.js (CHARGED_API_RUNGS); the
// subscription rungs above them are claude-proxy and codex.
const CHARGED_LLM_RUNGS = new Set(['openai-api', 'anthropic-api', 'bedrock']);
// How long an admitted prompt may wait for its response before it counts as
// missing. Every rerun re-derives it, so a prompt in flight at one run is
// graded as answered or missing by the next run for that CT date.
const PROMPT_IN_FLIGHT_MS = 2 * 60 * 60 * 1000;
// Keep the canonical CT calendar semantics while avoiding an ICU formatter
// allocation for every historical ledger row.
const CT_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
});
function eventCtDate(value) {
  const parsed = new Date(value || '');
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = CT_DATE_FORMATTER.formatToParts(parsed);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function runtimeDataDir(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.SECONDBRAIN_DATA_DIR) return path.resolve(process.env.SECONDBRAIN_DATA_DIR);
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'secondbrain', 'data');
  }
  if (fs.existsSync('/opt/secondbrain')) return '/opt/secondbrain/data';
  return path.join(os.homedir(), '.secondbrain', 'data');
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readTasks(tasksDir, accept = () => true) {
  if (!tasksDir || !fs.existsSync(tasksDir)) return [];
  const rows = [];
  for (const name of fs.readdirSync(tasksDir)) {
    if (!name.startsWith('spine-session-') || !name.endsWith('.json')) continue;
    const task = safeReadJson(path.join(tasksDir, name));
    if (task && accept(task)) rows.push({ ...task, evidence_path: path.join(tasksDir, name) });
  }
  return rows;
}

function sameCtDate(value, date) {
  return eventCtDate(value) === date;
}

function lawResult(row, status, reason, evidence = []) {
  if (!LAW_STATUSES.has(status)) throw new Error(`invalid law health status: ${status}`);
  return {
    id: row.id,
    law: row.law,
    ratified_status: row.status,
    verdict: status,
    reason,
    evidence: [...new Set(evidence.filter(Boolean).map(String))],
  };
}

function eventLawIds(event) {
  const raw = event?.details?.law_ids || event?.details?.lawIds || [];
  return Array.isArray(raw) ? raw.map(String) : String(raw || '').split(/[,\s]+/).filter(Boolean);
}

function buildGravityHealth({
  date,
  now = new Date(),
  structure,
  events = [],
  tasks = [],
  devopsHealth = null,
  gravityPath = '',
  devopsPath = '',
  amendmentApproval = null,
  amendmentLedgerRows = [],
  gravityChangedToday = null,
  gravityChangeSource = null,
  junctionProof = false,
  releaseTreeProof = false,
  gitHygiene = null,
  gitHygienePath = '',
  ledgers = {},
  memoryCommittedToday = null,
  learnCommittedToday = null,
  learnGitAvailable = null,
  cloudFirstDriftReceipt = null,
  cloudFirstDriftReceiptPath = '',
  unitIndependenceReceipt = null,
  unitIndependenceReceiptPath = '',
  learnReceiptRows = null,
  learnReceiptPath = '',
  publicMirrorReceipt = null,
  publicMirrorReceiptPath = '',
  priorGravityHealth = null,
  producers = GRAVITY_EVIDENCE_PRODUCERS,
} = {}) {
  const priorDate = priorCtDateKey(date);
  // A receipt counts for the day it names only when written within two CT
  // days of it, so a late or replayed receipt cannot vouch for an old day.
  const coversDay = (receipt) => {
    if (!receipt) return false;
    if (sameCtDate(receipt.generatedAt, date)) return true;
    if (receipt.date !== date) return false;
    const written = eventCtDate(receipt.generatedAt);
    const latest = new Date(Date.parse(`${date}T12:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
    return Boolean(written) && written >= date && written <= latest;
  };
  const dayEvents = events.filter((event) => sameCtDate(event.occurred_at, date));
  const dayTasks = tasks.filter((task) =>
    sameCtDate(task.updatedAt || task.completedAt || task.startedAt || task.createdAt, date),
  );
  const eventTypes = (type) => dayEvents.filter((event) => event.event_type === type);
  const promptAdmissions = eventTypes('prompt.admitted');
  const promptDeliveries = eventTypes('prompt.context.delivered');
  const admissionOps = new Set(promptAdmissions.map((event) => event.operation_id));
  const deliveryOps = new Set(promptDeliveries.map((event) => event.operation_id));
  const promptsFullyLinked =
    admissionOps.size > 0 && [...admissionOps].every((operationId) => deliveryOps.has(operationId));
  const landPushes = eventTypes('land.pushed');
  // Since the 2026-09-07 overhaul the land service no longer writes a
  // separate land.tests.passed event: land.pushed carries the branch and the
  // scoped test count, so it is the land-test evidence too.
  const landTests = [...eventTypes('land.tests.passed'), ...landPushes];
  // telegram-out is the owner-only alert channel to ExampleCo, not a send to
  // another human, so it is not outbound traffic for the send-guard laws.
  const outboundEvents = eventTypes('comms.out').filter((event) => event.surface !== 'telegram-out');
  // Responses may land after midnight, so read them across the whole event
  // window, not only the graded day.
  const promptResponses = events.filter((event) => event.event_type === 'prompt.response.recorded');
  // One response answers every prompt still open in its session (a message
  // sent mid-turn is answered by the same final response).
  const responseOps = new Set(promptResponses.flatMap((event) => [
    event.operation_id,
    ...(Array.isArray(event.details?.answers_operation_ids) ? event.details.answers_operation_ids : []),
  ]));
  // A later response in the same session also answers it: before 2026-09-24
  // a mid-turn message replaced the open prompt, so its answer carried a
  // different operation id (all five 2026-09-23 "unanswered" prompts were).
  const answeredLaterInSession = (prompt) => Boolean(prompt.session_id) && promptResponses.some(
    (response) => response.session_id === prompt.session_id && String(response.occurred_at) > String(prompt.occurred_at),
  );
  const unanswered = promptAdmissions.filter(
    (prompt) => !responseOps.has(prompt.operation_id) && !answeredLaterInSession(prompt),
  );
  // A prompt admitted within the in-flight window can still be answered, so
  // it is not yet due (2026-09-28: live interactive turns minutes old were
  // graded as missing). A future-dated prompt is never in flight.
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const promptInFlight = (prompt) => {
    const age = nowMs - Date.parse(prompt.occurred_at);
    return Number.isFinite(age) && age >= 0 && age < PROMPT_IN_FLIGHT_MS;
  };
  // A headless `claude -p` run (entrypoint sdk-cli, recorded by the prompt
  // hook) that a caller timeout killed never reaches the Stop hook
  // (2026-09-26/27/28: every unanswered prompt was an EC2 automation run, e.g.
  // the caption emphasis scorer's 180 s timeout). Without a durable
  // caller-ended receipt that is indistinguishable from a crash, so it still
  // counts as missing (Codex deploy review 2026-09-28); the detail names how
  // many were headless so the owning caller is visible.
  const promptsInFlight = unanswered.filter(promptInFlight);
  const promptsMissing = unanswered.filter((prompt) => !promptInFlight(prompt));
  const promptsMissingResponse = promptsMissing.map((prompt) => prompt.operation_id);
  const headlessMissing = promptsMissing.filter((prompt) => prompt.details?.headless === true).length;
  const promptNotes = [
    promptsInFlight.length ? `${promptsInFlight.length} still in flight` : '',
    headlessMissing ? `${headlessMissing} of the missing were headless automation runs with no caller-ended receipt` : '',
  ].filter(Boolean).join('; ');
  const promptNoteSuffix = promptNotes ? ` (${promptNotes}.)` : '';
  const completedTasks = dayTasks.filter((task) =>
    ['done', 'archive_pending'].includes(String(task.status || '')),
  );
  const badClosedTasks = completedTasks.filter(
    (task) => task.status === 'done' && !task.archiveReceipt,
  );
  const pendingTasks = completedTasks.filter((task) => task.status === 'archive_pending');
  const archiveEvents = eventTypes('session.archive.replicated');
  const hookMetric =
    devopsHealth?.result?.metrics?.hookRegistrationIntegrity ||
    devopsHealth?.metrics?.hookRegistrationIntegrity ||
    null;
  // A green hook metric only counts when the Dev Ops receipt is from the audit
  // date; a stale green must read UNKNOWN with its age, never COMPLIANT.
  const hookFresh = sameCtDate(devopsHealth?.generated_at, date);
  const hookStaleDetail = () => {
    const at = devopsHealth?.generated_at ? Date.parse(devopsHealth.generated_at) : NaN;
    const age = Number.isFinite(at)
      ? `${Math.max(0, Math.round(((now instanceof Date ? now.getTime() : Date.parse(now)) - at) / 3600000))}h old (generated ${devopsHealth.generated_at})`
      : 'missing or unparseable generated_at';
    return `Dev Ops hook integrity receipt is not same-date: ${age}.`;
  };
  const ledgerRows = (name) =>
    ledgers[name] && Array.isArray(ledgers[name].rows) ? ledgers[name].rows : [];
  const ledgerFile = (name) => String(ledgers[name]?.path || '');
  // null means the decision log itself was unreadable; [] means a quiet day.
  const sendGuardRows =
    ledgers.sendGuard && Array.isArray(ledgers.sendGuard.rows)
      ? ledgers.sendGuard.rows.filter((entry) => sameCtDate(entry.ts, date))
      : null;
  const dispatchRows = ledgerRows('dispatchLog').filter((entry) =>
    sameCtDate(entry.processed_at || entry.ts, date),
  );
  const heartbeatRows = ledgerRows('scanHeartbeat').filter((entry) => sameCtDate(entry.ts, date));
  const decisionRows = ledgerRows('bigDecisions').filter((entry) =>
    String(entry.date || entry.loggedAt || '').startsWith(date),
  );
  const rungRows = ledgerRows('askAiRungs').filter(
    (entry) => entry.rung && sameCtDate(entry.ts, date),
  );
  const evidence = {
    gravity: gravityPath,
    devops: devopsPath,
    operations: dayEvents.map((event) => event.ledger_path),
    tasks: dayTasks.map((task) => task.evidence_path),
  };

  const laws = [];
  for (const row of structure.rows) {
    const explicitViolations = dayEvents.filter(
      (event) =>
        (event.status === 'red' || /\.violation$/.test(event.event_type)) &&
        eventLawIds(event).includes(row.id),
    );
    if (explicitViolations.length) {
      laws.push(
        lawResult(
          row,
          'VIOLATED',
          'A same-date immutable operation event explicitly records a violation.',
          explicitViolations.map((event) => event.ledger_path),
        ),
      );
      continue;
    }

    if (row.id === 'g0') {
      if (hookMetric?.status === 'red') {
        laws.push(lawResult(row, 'VIOLATED', hookMetric.detail, [evidence.devops]));
      } else if (hookMetric?.status === 'green' && !hookFresh) {
        laws.push(lawResult(row, 'UNKNOWN', hookStaleDetail(), [evidence.devops]));
      } else if (hookMetric?.status === 'green') {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            'Hook registration and delivery integrity is green in the same-date Dev Ops receipt.',
            [evidence.devops],
          ),
        );
      } else {
        laws.push(
          lawResult(row, 'UNKNOWN', 'No same-date hook-delivery integrity proof was available.', [
            evidence.devops,
          ]),
        );
      }
      continue;
    }

    if (['g1', 'g6'].includes(row.id)) {
      if (
        promptAdmissions.length &&
        promptAdmissions.every((event) => event.status === 'green') &&
        !promptsMissingResponse.length
      ) {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            `Every observed prompt carried a verified current authority/persona digest.${promptNoteSuffix}`,
            evidence.operations,
          ),
        );
      } else {
        laws.push(
          lawResult(row, 'UNKNOWN', promptAdmissions.length && promptsMissingResponse.length
            ? `${promptsMissingResponse.length} admitted prompt(s) have no same-date recorded response.${promptNoteSuffix}`
            : 'Prompt authority/persona proof was missing or incomplete.', [
            ...evidence.operations,
            evidence.gravity,
          ]),
        );
      }
      continue;
    }

    if (['g2', 'g5'].includes(row.id)) {
      // Every send channel writes a comms.out record naming its authorization
      // (scripts/lib/outbound-send-record.js; coverage-tested), so each send is
      // judged from its own record. The PC send-guard log adds identity
      // attestations for sends launched from a Claude session.
      const guardRows = sendGuardRows || [];
      const unattested = guardRows.filter(
        (entry) => entry.decision === 'ALLOW' && !['amy', 'ExampleCo-approved'].includes(entry.mode),
      );
      const authorizationOf = (event) => String(event.details?.authorization || '');
      const VERIFIED = /^(owner-only|amy|ExampleCo-approved|principal-test|jev:.+|standing:.+)$/;
      const unauthorized = outboundEvents.filter((event) => authorizationOf(event) === 'none');
      const unverified = outboundEvents.filter(
        (event) => authorizationOf(event) !== 'none' && !VERIFIED.test(authorizationOf(event)),
      );
      const evidenceRefs = [ledgerFile('sendGuard'), ...outboundEvents.map((event) => event.ledger_path)];
      const bySurface = (events) => [...new Set(events.map((event) => event.surface))].join(', ');
      if (unattested.length || unauthorized.length) {
        laws.push(lawResult(row, 'VIOLATED',
          `${unattested.length + unauthorized.length} outbound send(s) went out without an authorization or identity attestation${unauthorized.length ? ` (${bySurface(unauthorized)})` : ''}.`,
          evidenceRefs));
      } else if (unverified.length) {
        laws.push(lawResult(row, 'UNKNOWN',
          `${unverified.length} outbound send(s) were recorded without a verifiable authorization (${bySurface(unverified)}).`,
          evidenceRefs));
      } else if (outboundEvents.length || guardRows.length) {
        laws.push(lawResult(row, 'COMPLIANT',
          `Every same-date outbound send carried a verified authorization${outboundEvents.length ? ` (${outboundEvents.length} send(s): ${bySurface(outboundEvents)})` : ''}.`,
          evidenceRefs));
      } else {
        laws.push(lawResult(row, 'NOT APPLICABLE',
          'No outbound send was recorded this CT date, and every send channel writes an outbound record.',
          evidenceRefs));
      }
      continue;
    }

    if (row.id === 'g3') {
      const actedWithoutDispatch = dispatchRows.filter(
        (entry) =>
          /^implement/.test(String(entry.action?.type || '')) &&
          /no explicit/i.test(String(entry.note || '')),
      );
      const ownerRejected = heartbeatRows.filter((entry) => Number(entry.amyOwnerRejected || 0) > 0);
      const honestScan = heartbeatRows.some((entry) => entry.fetchOk !== false);
      if (actedWithoutDispatch.length) {
        laws.push(
          lawResult(
            row,
            'VIOLATED',
            `${actedWithoutDispatch.length} ingest row(s) were acted on while recording no explicit dispatch.`,
            [ledgerFile('dispatchLog')],
          ),
        );
      } else if (ownerRejected.length) {
        laws.push(
          lawResult(
            row,
            'UNKNOWN',
            'The scan heartbeat reports an owner-sent dispatch was rejected; the dispatch gate needs inspection.',
            [ledgerFile('scanHeartbeat')],
          ),
        );
      } else if (honestScan) {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            'Same-date gate evidence shows explicit-only execution and an honest healthy scan heartbeat.',
            [ledgerFile('dispatchLog'), ledgerFile('scanHeartbeat')],
          ),
        );
      } else {
        laws.push(
          lawResult(
            row,
            'UNKNOWN',
            'No same-date healthy scan-heartbeat evidence was available; the ingest channel cannot be proven honest for this date.',
            [ledgerFile('dispatchLog'), ledgerFile('scanHeartbeat')],
          ),
        );
      }
      continue;
    }

    if (row.id === 'g4') {
      const supersessions = amendmentLedgerRows.filter(
        (entry) =>
          String(entry.date || entry.ts || '').startsWith(date) &&
          Array.isArray(entry.amendedRows) &&
          entry.amendedRows.length,
      );
      if (!supersessions.length) {
        laws.push(
          lawResult(row, 'NOT APPLICABLE', 'No same-date rule supersession was recorded to reconcile.'),
        );
      } else if (decisionRows.length) {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            'Every same-date rule supersession has a same-date big-decisions ledger entry.',
            [ledgerFile('bigDecisions'), evidence.gravity],
          ),
        );
      } else {
        laws.push(
          lawResult(row, 'VIOLATED', 'A same-date rule supersession left no big-decisions ledger entry.', [
            ledgerFile('bigDecisions'),
            evidence.gravity,
          ]),
        );
      }
      continue;
    }

    if (row.id === 'g7') {
      // Score the CANONICAL repo Tier 1 (desktop junction or EC2 checkout),
      // not whichever checkout this module happens to run from.
      const canonicalMemory = [
        path.join(os.homedir(), 'secondbrain', 'memory', 'MEMORY.md'),
        '/opt/secondbrain/memory/MEMORY.md',
      ].find((candidate) => fs.existsSync(candidate));
      const memoryFile =
        canonicalMemory ||
        (structure.rows.length && gravityPath
          ? path.join(path.dirname(gravityPath), 'MEMORY.md')
          : '');
      if (
        memoryFile &&
        fs.existsSync(memoryFile) &&
        lfByteLength(fs.readFileSync(memoryFile, 'utf8')) <= MEMORY_MD_CAP_BYTES
      ) {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            `Tier 1 exists and remains under the shared ${MEMORY_MD_CAP_BYTES}-byte LF cap.`,
            [memoryFile],
          ),
        );
      } else {
        laws.push(lawResult(row, 'UNKNOWN', 'Fresh Tier-1 byte-cap proof was unavailable.', [memoryFile]));
      }
      continue;
    }

    if (row.id === 'g8') {
      // Junction architecture is scored independently of memory activity: a
      // broken junction must stay visible on quiet days (Codex 2026-08-02).
      // On the EC2 release host there is no desktop junction at all (the
      // canonical tree IS /opt/secondbrain, a plain release checkout), so a
      // proven release tree is an equally honest, independent path to
      // COMPLIANT rather than a substitute for a missing junction.
      if (junctionProof) {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            memoryCommittedToday === true
              ? 'Same-date memory changes are git-tracked commits reached through the live project-relative junction.'
              : 'The canonical junction is live, preserving project-relative zero-permission access; no same-date memory writes to score.',
            [path.join(os.homedir(), 'secondbrain', 'memory')],
          ),
        );
      } else if (releaseTreeProof) {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            'The EC2 release host has no desktop junction to prove; the canonical tree resolves directly to a live release root containing memory/MEMORY.md.',
            [typeof releaseTreeProof === 'string' ? releaseTreeProof : '/opt/secondbrain/memory/MEMORY.md'],
          ),
        );
      } else {
        laws.push(
          lawResult(
            row,
            'UNKNOWN',
            'Neither the desktop canonical junction nor a live EC2 release tree could be proven on this machine; architecture health is unverified regardless of memory activity.',
          ),
        );
      }
      continue;
    }

    if (row.id === 'g10') {
      // Shared-tree dirt is a direct g10 breach regardless of how clean the
      // land events look: mutations exist ONLY in isolated worktrees, so a
      // same-date git-hygiene snapshot reporting an unclean shared master
      // pins this law at VIOLATED and can never be outvoted by land linkage.
      const hygieneFresh = gitHygiene && sameCtDate(gitHygiene.generatedAt, date);
      if (hygieneFresh && gitHygiene?.snapshot?.master?.clean === false) {
        const dirtCount = Number(gitHygiene?.snapshot?.counts?.uncommittedEdits || 0);
        laws.push(
          lawResult(
            row,
            'VIOLATED',
            `The shared checkout carries ${dirtCount} uncommitted change(s); the shared tree must stay mechanically clean.`,
            [gitHygienePath],
          ),
        );
      } else if (!landTests.length && !landPushes.length && !dayTasks.length) {
        laws.push(lawResult(row, 'NOT APPLICABLE', 'No coding work was observed for this CT date.'));
      } else if (!landTests.length && landPushes.length) {
        laws.push(
          lawResult(
            row,
            'UNKNOWN',
            `${landPushes.length} land(s) reached master this CT date, but no land-test event proving the source branch reached this host.`,
            evidence.operations,
          ),
        );
      } else if (
        landTests.length &&
        landTests.every(
          (event) =>
            (event.branch || event.details?.branch) &&
            (event.branch || event.details?.branch) !== 'master',
        )
      ) {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            'Every observed mutation reached the land gate from a non-master session branch.',
            evidence.operations,
          ),
        );
      } else {
        laws.push(
          lawResult(
            row,
            'UNKNOWN',
            'Coding activity existed, but complete worktree-to-mutation linkage was missing.',
            [...evidence.operations, ...evidence.tasks],
          ),
        );
      }
      continue;
    }

    if (row.id === 'g11') {
      if (!landPushes.length) {
        laws.push(lawResult(row, 'NOT APPLICABLE', 'No master advance was observed for this CT date.'));
      } else if (
        landPushes.every(
          (event) =>
            event.surface === 'land-service' &&
            event.status === 'green' &&
            event.details?.lease_consumed === true &&
            event.details?.push_proof === 'consumed-one-use-git-directory-proof' &&
            /^[a-f0-9]{40}$/i.test(event.base_sha || '') &&
            /^[a-f0-9]{40}$/i.test(event.commit || '') &&
            event.details?.target === 'master',
        )
      ) {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            'Every observed master advance used a consumed commit/base/test-bound land lease.',
            evidence.operations,
          ),
        );
      } else {
        laws.push(
          lawResult(
            row,
            'VIOLATED',
            'A master advance lacked complete land-service lease proof.',
            evidence.operations,
          ),
        );
      }
      continue;
    }

    if (row.id === 'g12') {
      if (!landTests.length && landPushes.length) {
        laws.push(
          lawResult(row, 'UNKNOWN', `${landPushes.length} land(s) reached master, but no land-test evidence reached this host to prove staged tests.`, evidence.operations),
        );
      } else if (!landTests.length) {
        laws.push(lawResult(row, 'NOT APPLICABLE', 'No staged production-code land was observed.'));
      } else if (
        landTests.every((event) => Number(event.details?.scoped_test_file_count || 0) > 0)
      ) {
        laws.push(
          lawResult(row, 'COMPLIANT', 'Every observed land included scoped staged test files.', evidence.operations),
        );
      } else {
        laws.push(
          lawResult(row, 'UNKNOWN', 'A land existed without enough staged-test detail to prove the law.', evidence.operations),
        );
      }
      continue;
    }

    if (row.id === 'g14') {
      if (hookMetric?.status === 'red') {
        laws.push(lawResult(row, 'VIOLATED', hookMetric.detail, [evidence.devops]));
      } else if (hookMetric?.status === 'green' && !hookFresh) {
        laws.push(lawResult(row, 'UNKNOWN', hookStaleDetail(), [evidence.devops]));
      } else if (hookMetric?.status === 'green') {
        laws.push(
          lawResult(row, 'COMPLIANT', 'Hook integrity explicitly reports no silent dead registrations.', [
            evidence.devops,
          ]),
        );
      } else {
        laws.push(lawResult(row, 'UNKNOWN', 'No fresh fail-loud hook integrity receipt.', [evidence.devops]));
      }
      continue;
    }

    if (row.id === 'g15' && coversDay(publicMirrorReceipt)) {
      // EC2's own nightly check (the PC-only copy never had a same-day result).
      const verdict = publicMirrorReceipt.status === 'green' ? 'COMPLIANT' : publicMirrorReceipt.status === 'red' ? 'VIOLATED' : 'UNKNOWN';
      laws.push(lawResult(row, verdict, String(publicMirrorReceipt.detail || 'The public mirror check returned no detail.'), [publicMirrorReceiptPath]));
      continue;
    }

    if (row.id === 'g15') {
      const mirrorMetric =
        devopsHealth?.result?.metrics?.publicMirrorCurrency ||
        devopsHealth?.metrics?.publicMirrorCurrency ||
        null;
      const devopsFresh = sameCtDate(devopsHealth?.generated_at, date);
      if (mirrorMetric && devopsFresh && mirrorMetric.status === 'red') {
        laws.push(lawResult(row, 'VIOLATED', mirrorMetric.detail, [evidence.devops]));
      } else if (mirrorMetric && devopsFresh && ['green', 'amber'].includes(mirrorMetric.status)) {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            'The public mirror matches the screened payload or is behind within the weekly window with a stated reason.',
            [evidence.devops],
          ),
        );
      } else {
        laws.push(
          lawResult(row, 'UNKNOWN', 'No same-date public-mirror currency receipt was available.', [
            evidence.devops,
          ]),
        );
      }
      continue;
    }

    if (row.id === 'g17') {
      const chargedAnswers = rungRows.filter(
        (entry) => CHARGED_LLM_RUNGS.has(entry.rung) && entry.outcome === 'answered',
      );
      const subFailedBefore = (rung, ts) =>
        rungRows.some(
          (entry) =>
            entry.rung === rung &&
            entry.outcome !== 'answered' &&
            !/^transient-retry:/.test(String(entry.outcome || '')) &&
            Date.parse(entry.ts) <= Date.parse(ts),
        );
      const uncovered = chargedAnswers.filter(
        (entry) => !(subFailedBefore('claude-proxy', entry.ts) && subFailedBefore('codex', entry.ts)),
      );
      if (!rungRows.length) {
        laws.push(lawResult(row, 'NOT APPLICABLE', 'No same-date LLM ladder attempts were observed.'));
      } else if (uncovered.length) {
        laws.push(
          lawResult(
            row,
            'VIOLATED',
            `${uncovered.length} charged API answer(s) lack same-date proof that both subscription rungs failed first.`,
            [ledgerFile('askAiRungs')],
          ),
        );
      } else {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            'No charged rung answered without both subscription rungs first failing that same CT date.',
            [ledgerFile('askAiRungs')],
          ),
        );
      }
      continue;
    }

    if (row.id === 'g22') {
      if (!landTests.length && landPushes.length) {
        laws.push(
          lawResult(row, 'UNKNOWN', `${landPushes.length} land(s) reached master, but no land-test evidence reached this host to prove the drift lints ran.`, evidence.operations),
        );
      } else if (!landTests.length) {
        laws.push(
          lawResult(
            row,
            'NOT APPLICABLE',
            'No same-date land was observed; master did not advance past its last drift-linted state.',
          ),
        );
      } else if (landTests.every((event) => Number(event.details?.scoped_test_file_count || 0) > 0)) {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            'Every same-date land ran the always-on core guards, which execute the drift-lint family (core.test.js).',
            evidence.operations,
          ),
        );
      } else {
        laws.push(
          lawResult(
            row,
            'UNKNOWN',
            'A same-date land lacked scoped-test detail proving the drift lints ran.',
            evidence.operations,
          ),
        );
      }
      continue;
    }

    if (row.id === 'g23' && Array.isArray(learnReceiptRows)) {
      const dayRows = learnReceiptRows.filter((entry) => (entry.type === 'heartbeat' ? entry.date === date : sameCtDate(entry.ts, date)));
      const learned = dayRows.filter((entry) => entry.type === 'learn' && entry.status === 'committed');
      if (learned.length) {
        laws.push(lawResult(row, 'COMPLIANT', `${learned.length} same-date lesson commit(s) were recorded in the learn receipt ledger.`, [learnReceiptPath]));
        continue;
      }
      if (dayRows.some((entry) => entry.type === 'heartbeat')) {
        laws.push(lawResult(row, 'NOT APPLICABLE', 'The learn receipt ledger ran this CT date and recorded no lesson commit.', [learnReceiptPath]));
        continue;
      }
    }

    if (row.id === 'g23') {
      if (learnCommittedToday === true) {
        laws.push(
          lawResult(row, 'COMPLIANT', 'A same-date lesson artifact was committed next to the method it corrects.'),
        );
      } else if (learnGitAvailable === false) {
        // No .git on the EC2 release checkout means git log can never prove
        // or disprove a same-day lesson commit, and no dedicated #learn
        // receipt ledger exists yet to read instead (traced
        // 2026-09-22): stay UNKNOWN rather than invent a positive-absence
        // signal this evaluator cannot actually observe.
        laws.push(
          lawResult(
            row,
            'UNKNOWN',
            'This release checkout has no .git directory, so git history cannot prove a same-date lesson commit, and no #learn receipt ledger exists yet for this evaluator to read instead.',
          ),
        );
      } else {
        laws.push(
          lawResult(
            row,
            'UNKNOWN',
            'No same-date learn receipt or committed lesson artifact was observed; the learn loop may simply not have fired.',
          ),
        );
      }
      continue;
    }

    if (row.id === 'g20') {
      const activeOps = new Set(dayEvents.map((event) => event.operation_id));
      const priorDayEvents = events.filter((event) =>
        sameCtDate(event.occurred_at, priorDate),
      );
      const missingSurfaces = missingCommsSurfaces(dayEvents, priorDayEvents);
      if (!activeOps.size || !dayEvents.every((event) => event.event_sha256)) {
        laws.push(
          lawResult(row, 'UNKNOWN', 'Ingress/egress provenance coverage was empty or incomplete.', evidence.operations),
        );
      } else if (missingSurfaces.length) {
        laws.push(
          lawResult(
            row,
            'UNKNOWN',
            `Declared comms surfaces recorded no event or idle marker this date: ${missingSurfaces.join(', ')}.`,
            evidence.operations,
          ),
        );
      } else {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            'Every hashed operation seam plus every declared comms surface recorded provenance this date.',
            evidence.operations,
          ),
        );
      }
      continue;
    }

    if (row.id === 'g24') {
      const approvalToday = Boolean(
        amendmentApproval &&
          amendmentApproval.date === date &&
          ['ExampleCo', 'PRIVATE_NAME'].includes(String(amendmentApproval.approvedBy || '').toLowerCase()),
      );
      const ledgerToday = amendmentLedgerRows.some(
        (entry) =>
          String(entry.date || entry.ts || '').startsWith(date) &&
          ['ExampleCo', 'PRIVATE_NAME'].includes(String(entry.approvedBy || '').toLowerCase()),
      );
      if (!structure.ok) {
        laws.push(lawResult(row, 'VIOLATED', 'Gravity row/count/status structure is invalid.', [evidence.gravity]));
      } else if (gravityChangeSource === 'mtime') {
        // The EC2 release checkout has no .git directory, so git log can
        // never see a same-day laws-file edit. The release file's own mtime
        // is deploy-time evidence only (a stale edit deployed today still
        // moves the mtime), so a changed mtime can prove COMPLIANT only when
        // paired with a same-day ledger row, and can never alone prove
        // VIOLATED.
        if (gravityChangedToday === true && ledgerToday) {
          laws.push(
            lawResult(
              row,
              'COMPLIANT',
              'Gravity structure is valid; the laws file mtime changed today on the live release and a same-day amendment ledger row with principal approval backs it.',
              [evidence.gravity],
            ),
          );
        } else if (gravityChangedToday === false) {
          laws.push(
            lawResult(
              row,
              'NOT APPLICABLE',
              'The laws file mtime on the live release shows no change today; there is nothing to reconcile on this git-free host.',
              [evidence.gravity],
            ),
          );
        } else if (gravityChangedToday === true) {
          laws.push(
            lawResult(
              row,
              'UNKNOWN',
              'The laws file mtime on the live release changed today but no same-day amendment ledger row backs it; release mtime alone is only deploy-time evidence, not proof of an actual same-day edit.',
              [evidence.gravity],
            ),
          );
        } else {
          laws.push(
            lawResult(
              row,
              'UNKNOWN',
              'No laws-file mtime evidence was readable on this git-free host.',
              [evidence.gravity],
            ),
          );
        }
      } else if (gravityChangedToday === true && !(approvalToday && ledgerToday)) {
        laws.push(
          lawResult(
            row,
            'VIOLATED',
            'The laws file changed this CT date without same-day principal approval plus ledger proof.',
            [evidence.gravity],
          ),
        );
      } else if (approvalToday && ledgerToday) {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            'Gravity structure is valid and today’s amendment has principal approval plus ledger proof.',
            [evidence.gravity],
          ),
        );
      } else if (gravityChangedToday === false) {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            'Gravity structure is valid and the laws file did not change today; leftover approval artifacts are inert.',
            [evidence.gravity],
          ),
        );
      } else {
        laws.push(
          lawResult(
            row,
            'UNKNOWN',
            'No same-day laws-file change proof was available; a stale approval artifact alone never violates.',
            [evidence.gravity],
          ),
        );
      }
      continue;
    }

    if (row.id === 'g25') {
      if (promptsFullyLinked && !promptsMissingResponse.length) {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            `Every observed prompt operation has one admitted token and a matching delivered context event.${promptNoteSuffix}`,
            evidence.operations,
          ),
        );
      } else {
        laws.push(
          lawResult(
            row,
            'UNKNOWN',
            promptAdmissions.length
              ? (promptsFullyLinked
                ? `${promptsMissingResponse.length} admitted prompt(s) have no same-date prompt.response.recorded event.${promptNoteSuffix}`
                : 'At least one prompt lacks same-date delivered-context provenance.')
              : 'No prompt-admission operation proof was available for observed activity.',
            evidence.operations,
          ),
        );
      }
      continue;
    }

    if (row.id === 'g13') {
      const doneClaims = completedTasks.filter((task) => task.status === 'done');
      if (badClosedTasks.length) {
        laws.push(
          lawResult(
            row,
            'VIOLATED',
            `${badClosedTasks.length} session task(s) claimed done without an archive receipt.`,
            badClosedTasks.map((task) => task.evidence_path),
          ),
        );
      } else if (doneClaims.length) {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            'Every observed same-date done claim carries an archive receipt as proof.',
            doneClaims.map((task) => task.evidence_path),
          ),
        );
      } else {
        laws.push(lawResult(row, 'NOT APPLICABLE', 'No same-date done claims were observed.'));
      }
      continue;
    }

    if (row.id === 'g9') {
      if (!completedTasks.length) {
        // Zero completed tasks in the Task Spine store for this CT date is a
        // genuine "nothing to judge" day, not missing evidence: name it
        // NOT_APPLICABLE instead of falling into the generic UNKNOWN catch-all.
        laws.push(
          lawResult(
            row,
            'NOT APPLICABLE',
            'No same-date completed coding session was observed in the Task Spine store; there is no archive claim to verify.',
          ),
        );
      } else if (!badClosedTasks.length && !pendingTasks.length && archiveEvents.length >= completedTasks.length) {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            'Every completed observed coding session has checksum-verified archive provenance.',
            [...evidence.operations, ...evidence.tasks],
          ),
        );
      } else {
        laws.push(
          lawResult(
            row,
            'UNKNOWN',
            `${pendingTasks.length} completed session(s) remain archive-pending; no false done claim was inferred.`,
            [...evidence.operations, ...evidence.tasks],
          ),
        );
      }
      continue;
    }

    if (row.id === 'g26') {
      // No producer in this codebase persists a per-date cloud-first drift
      // receipt today (traced 2026-09-22: scripts/verify-cloud-first-drift.js
      // runs a check but writes no dated receipt file). Read one if a future
      // producer starts writing it; otherwise name the missing receipt
      // explicitly rather than inventing a pass.
      const fresh = coversDay(cloudFirstDriftReceipt);
      if (fresh && cloudFirstDriftReceipt.status === 'unknown') {
        laws.push(lawResult(row, 'UNKNOWN', String(cloudFirstDriftReceipt.detail || 'The cloud-first drift producer could not obtain its input.'), [cloudFirstDriftReceiptPath]));
      } else if (fresh && cloudFirstDriftReceipt.status === 'red') {
        laws.push(
          lawResult(
            row,
            'VIOLATED',
            String(cloudFirstDriftReceipt.detail || 'The same-date cloud-first drift receipt reports a PC-only production producer.'),
            [cloudFirstDriftReceiptPath],
          ),
        );
      } else if (fresh && cloudFirstDriftReceipt.status === 'green') {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            'The same-date cloud-first drift receipt reports every production producer stayed cloud-resident.',
            [cloudFirstDriftReceiptPath],
          ),
        );
      } else {
        laws.push(
          lawResult(
            row,
            'UNKNOWN',
            `No same-date cloud-first drift receipt exists at ${cloudFirstDriftReceiptPath || '(no path configured)'}; scripts/verify-cloud-first-drift.js runs the check but does not persist a dated receipt for this evaluator to read.`,
          ),
        );
      }
      continue;
    }

    if (row.id === 'g27') {
      // Same situation as g26: scripts/lib/gravity-semantic-gate.js and the
      // unit-independence contract test exercise the behavior, but nothing
      // persists a same-date per-unit-independence gate receipt today.
      const fresh = coversDay(unitIndependenceReceipt);
      if (fresh && unitIndependenceReceipt.status === 'unknown') {
        laws.push(lawResult(row, 'UNKNOWN', String(unitIndependenceReceipt.detail || 'The unit-independence producer could not obtain its input.'), [unitIndependenceReceiptPath]));
      } else if (fresh && unitIndependenceReceipt.status === 'red') {
        laws.push(
          lawResult(
            row,
            'VIOLATED',
            String(unitIndependenceReceipt.detail || 'The same-date unit-independence receipt reports a unit blocked by an unrelated failure or unscoped shared dependency.'),
            [unitIndependenceReceiptPath],
          ),
        );
      } else if (fresh && unitIndependenceReceipt.status === 'green') {
        laws.push(
          lawResult(
            row,
            'COMPLIANT',
            'The same-date unit-independence receipt reports every unit owned its own progress and verdict with no unrelated-failure or unscoped-dependency breach.',
            [unitIndependenceReceiptPath],
          ),
        );
      } else {
        laws.push(
          lawResult(
            row,
            'UNKNOWN',
            `No same-date unit-independence gate receipt exists at ${unitIndependenceReceiptPath || '(no path configured)'}; scripts/lib/gravity-semantic-gate.js has no persisted per-date receipt producer for this evaluator to read.`,
          ),
        );
      }
      continue;
    }

    laws.push(
      lawResult(
        row,
        'UNKNOWN',
        'No complete same-date immutable evidence set currently proves or disproves this law.',
        [...evidence.operations, ...evidence.tasks],
      ),
    );
  }

  applyEvidenceWatchdog({ laws, date, priorDate, priorGravityHealth, producers });

  const counts = {
    compliant: laws.filter((law) => law.verdict === 'COMPLIANT').length,
    violated: laws.filter((law) => law.verdict === 'VIOLATED').length,
    unknown: laws.filter((law) => law.verdict === 'UNKNOWN').length,
    not_applicable: laws.filter((law) => law.verdict === 'NOT APPLICABLE').length,
    total: laws.length,
  };
  const status = counts.violated ? 'red' : counts.unknown ? 'amber' : 'green';
  return {
    schema: SCHEMA,
    date,
    generated_at: now.toISOString(),
    status,
    auto_heal: false,
    owner: 'Amy',
    consequence:
      status === 'green'
        ? 'Governed work may claim same-date Gravity proof.'
        : 'Do not claim governed-complete; inspect the named violations or missing evidence.',
    counts,
    coverage: {
      operation_events: dayEvents.length,
      operations: new Set(dayEvents.map((event) => event.operation_id)).size,
      coding_tasks: dayTasks.length,
      completed_tasks: completedTasks.length,
      replicated_archives: archiveEvents.length,
    },
    laws,
  };
}

// W7 evidence watchdog (ExampleCo 2026-09-23): a law that has had no evidence two
// CT days running is a broken producer, not a quiet day. Stateless: it is
// re-derived every run from today's verdict and yesterday's receipt, so a
// producer that resumes clears it on the next run. Laws whose producer is not
// yet declared live (liveSince null) never escalate.
function applyEvidenceWatchdog({ laws, date, priorDate, priorGravityHealth, producers }) {
  const priorLaws = Array.isArray(priorGravityHealth?.laws) ? priorGravityHealth.laws : null;
  for (const law of laws) {
    if (law.verdict !== 'UNKNOWN') continue;
    const producer = producers?.[law.id];
    if (!producer) {
      law.reason = `${law.reason} (no evidence producer declared)`;
      continue;
    }
    if (!producer.liveSince || priorDate < producer.liveSince) continue;
    if (!priorLaws || priorGravityHealth?.date !== priorDate) {
      law.reason = `${law.reason} (no prior-day verdict to compare)`;
      continue;
    }
    const prior = priorLaws.find((entry) => entry.id === law.id);
    if (prior?.verdict !== 'UNKNOWN') continue;
    law.verdict = 'VIOLATED';
    law.reason = `Evidence missing 2 days running; producer ${producer.producer} is not delivering. Today: ${law.reason}`;
    law.watchdog = { priorDate, producer: producer.producer, evidence: producer.evidence };
  }
  return laws;
}

function readJsonl(file, accept = () => true, metrics = null) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      // Ignore malformed trailing row; the append-only prefix remains valid.
      continue;
    }
    if (metrics) metrics.parsed_rows = (metrics.parsed_rows || 0) + 1;
    if (accept(row)) rows.push(row);
  }
  if (metrics) metrics.retained_rows = rows.length;
  return rows;
}

// One decision per line: `<iso> ALLOW (amy) :: reasons :: command` or
// `<iso> BLOCK :: reasons :: command` or `<iso> BLOCK (identity-mismatch) ::
// command`, written by scripts/claude-hooks/outbound-send-guard.mjs. Returns
// null when the log itself is unreadable so a missing ledger is never scored
// as a quiet day.
const SEND_GUARD_LINE_RE = /^(\S+) (ALLOW|BLOCK)(?: \(([^)]+)\))? ::/;

function parseSendGuardLog(file, accept = () => true) {
  if (!file || !fs.existsSync(file)) return null;
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(SEND_GUARD_LINE_RE);
    if (match) {
      const row = { ts: match[1], decision: match[2], mode: match[3] || '' };
      if (accept(row)) rows.push(row);
    }
  }
  return rows;
}

// The CT day a briefing grades: the most recent day that has had at least 22
// hours to happen. The night run for briefing date D starts at 23:00 on D-1,
// so grading D itself judged an empty day and every activity law read "not
// applicable" (found 2026-09-24). Grading the day that just finished fixes it.
function ctHour(now) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

function gradedCtDate(date, now = new Date()) {
  const today = ctDateString(now);
  let graded = date < today ? date : today;
  if (graded === today && ctHour(now) < 22) graded = priorCtDateKey(graded);
  return graded;
}

function probeGravityHealth({
  root = path.resolve(__dirname, '..', '..'),
  dataDir,
  date: briefingDate = ctDateString(new Date()),
  gradedDate = null,
  now = new Date(),
  tasksDir,
  write = true,
  platform = process.platform,
  releaseRoot = '/opt/secondbrain',
} = {}) {
  const probeStarted = performance.now();
  const phases = {};
  const ledgerCounts = {};
  const timed = (name, action) => {
    const started = performance.now();
    try { return action(); } finally { phases[name] = Math.round((performance.now() - started) * 1000) / 1000; }
  };
  const runtime = runtimeDataDir(dataDir);
  const date = gradedDate || gradedCtDate(briefingDate, now);
  const priorDate = priorCtDateKey(date);
  const gravityPath = path.join(root, 'memory', 'AMY_GRAVITY.md');
  const structure = timed('gravity_structure', () => gravityStructure(fs.readFileSync(gravityPath, 'utf8')));
  const devopsPath = path.join(runtime, 'agent', 'devops-health-latest.json');
  const gitHygienePath = path.join(runtime, 'agent', 'git-hygiene-snapshot.json');
  const approvalPath = path.join(root, 'data', 'agent', 'gravity-amendment-approval.json');
  const ledgerPath = path.join(root, 'data', 'agent', 'gravity-amendments.jsonl');
  // The Task Spine store lives under the runtime data root: APPDATA on the
  // desktop (SECONDBRAIN_DATA_DIR/win32 branch of runtimeDataDir), and
  // /opt/secondbrain/data on the EC2 release host (dev-plans/core/spine.md).
  // Routing through `runtime` here, instead of a hardcoded APPDATA path,
  // reproduces the exact desktop default while also resolving correctly on
  // Linux.
  const taskRoot = tasksDir || path.join(runtime, 'tasks');
  let junctionProof = false;
  try {
    junctionProof = fs.lstatSync(path.join(os.homedir(), 'secondbrain')).isSymbolicLink();
  } catch {
    // Windows junctions may report as directories through some Node builds.
    junctionProof = fs.existsSync(path.join(os.homedir(), 'secondbrain', 'memory', 'MEMORY.md'));
  }
  // g8 on the EC2 release host: there is no desktop-style junction to prove
  // (the canonical tree IS /opt/secondbrain, a plain symlinked release
  // checkout), so independently prove the release root resolves to a real
  // directory carrying memory/MEMORY.md.
  let releaseTreeProof = false;
  // Linux release hosts only: the desktop must keep proving its junction, so a
  // plain checkout with memory/MEMORY.md never satisfies g8 on Windows.
  if (!junctionProof && platform === 'linux') {
    try {
      if (fs.statSync(releaseRoot).isDirectory()) {
        const memoryFile = path.join(releaseRoot, 'memory', 'MEMORY.md');
        if (fs.existsSync(memoryFile)) releaseTreeProof = memoryFile;
      }
    } catch {
      // No live release root on this machine; g8 falls through to UNKNOWN.
    }
  }
  // g23/g24: the EC2 release directory is a file copy with NO .git directory
  // (it is a symlink into /opt/secondbrain-releases/<sha>), so `git log`
  // against it always fails. Detect that up front so the law evaluators can
  // choose an honest, weaker (mtime-based) proof path instead of silently
  // treating "no git" the same as "checked git, found nothing".
  const hasGitDir = fs.existsSync(path.join(root, '.git'));
  const releaseLawsProvenancePath = path.join(runtime, 'agent', 'release-laws-provenance.json');
  let releaseLawsProvenanceValue;
  const releaseLawsProvenance = () => {
    if (releaseLawsProvenanceValue === undefined) releaseLawsProvenanceValue = safeReadJson(releaseLawsProvenancePath);
    return releaseLawsProvenanceValue;
  };
  let gravityChangedToday = null;
  let gravityChangeSource = null;
  const gravityGitStarted = performance.now();
  if (hasGitDir) {
    gravityChangeSource = 'git';
    try {
      const lastGravityCommit = execFileSync(
        'git',
        ['log', '-1', '--format=%cI', '--', 'memory/AMY_GRAVITY.md'],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
      ).trim();
      if (lastGravityCommit) gravityChangedToday = sameCtDate(lastGravityCommit, date);
    } catch {
      // No git proof of a same-day laws-file change; g24 degrades to UNKNOWN, never VIOLATED.
    }
  } else if (Number.isFinite(Date.parse(releaseLawsProvenance()?.lawsLastCommitAt || ''))) {
    // Git-free release host: the deploy/nightly producer recorded the laws
    // file's real last commit time, which is commit evidence, not deploy time.
    gravityChangeSource = 'release-provenance';
    gravityChangedToday = sameCtDate(releaseLawsProvenance().lawsLastCommitAt, date);
  } else {
    gravityChangeSource = 'mtime';
    try {
      const stat = fs.statSync(gravityPath);
      gravityChangedToday = sameCtDate(stat.mtime.toISOString(), date);
    } catch {
      // No laws file to stat; g24 stays UNKNOWN on this host.
    }
  }
  phases.git_gravity_change = Math.round((performance.now() - gravityGitStarted) * 1000) / 1000;
  // Ledgers live in the runtime data dir on EC2 and in the tracked repo
  // data dir on the desktop; the first existing file wins.
  const agentDirs = [...new Set([path.join(runtime, 'agent'), path.join(root, 'data', 'agent')])];
  const agentLedger = (name, accept = () => true) => {
    for (const dir of agentDirs) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) {
        ledgerCounts[name] = { parsed_rows: 0, retained_rows: 0 };
        return { path: file, rows: timed(`ledger:${name}`, () => readJsonl(file, accept, ledgerCounts[name])) };
      }
    }
    return { path: path.join(agentDirs[0], name), rows: [] };
  };
  const lastCommitSameCtDate = (pathspecs, phase) => {
    const started = performance.now();
    try {
      const iso = execFileSync('git', ['log', '-1', '--format=%cI', '--', ...pathspecs], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();
      return iso ? sameCtDate(iso, date) : false;
    } catch {
      return null; // No git history on this machine; the affected laws stay UNKNOWN.
    } finally { phases[phase] = Math.round((performance.now() - started) * 1000) / 1000; }
  };
  // g26/g27: no producer in this codebase persists a dated receipt for
  // either evaluator yet (traced 2026-09-22). Read one if a future producer
  // starts writing it at these conventional paths; today safeReadJson
  // returns null and the law stays honestly UNKNOWN, naming the gap.
  const cloudFirstDriftReceiptPath = path.join(runtime, 'agent', `cloud-first-drift-${date}.json`);
  const unitIndependenceReceiptPath = path.join(runtime, 'agent', `unit-independence-${date}.json`);
  const learnReceiptPath = path.join(runtime, 'agent', 'learn-receipts.jsonl');
  const publicMirrorReceiptPath = path.join(runtime, 'agent', `public-mirror-currency-${date}.json`);
  const denylistPath = path.join(root, 'data', 'agent', 'pii-denylist.json');
  const denylistValue = safeReadJson(denylistPath);
  let denylistCurrent = null;
  const contactsGitStarted = performance.now();
  try {
    const contactsIso = execFileSync('git', ['log', '-1', '--format=%cI', '--', 'memory/contacts'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    const generatedAt = Date.parse(denylistValue?.generatedAt || '');
    if (contactsIso && Number.isFinite(generatedAt)) {
      denylistCurrent = generatedAt >= Date.parse(contactsIso);
    }
  } catch {
    // Denylist currency cannot be proven without contact history; stays null.
  }
  phases.git_contacts = Math.round((performance.now() - contactsGitStarted) * 1000) / 1000;
  const sendGuardPath = path.join(os.homedir(), '.secondbrain', 'outbound-send-guard.log');
  const allEvents = timed('operation_event_read_verify_sort', () => readOperationEvents({ dataDir: runtime }));
  const events = timed('operation_event_window', () => allEvents.filter(event => {
    const eventDate = eventCtDate(event.occurred_at);
    // The next CT day is included so a response written after midnight still
    // answers the graded day's prompt; dayEvents stays the graded day only.
    const nextDate = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
    return eventDate === date || eventDate === priorDate || eventDate === nextDate;
  }));
  const eventCount = allEvents.length;
  allEvents.length = 0; // The law evaluator only consumes current and prior CT dates.
  const tasks = timed('task_receipts', () => readTasks(taskRoot, task =>
    sameCtDate(task.updatedAt || task.completedAt || task.startedAt || task.createdAt, date)));
  const evidence = {
    date,
    now,
    structure,
    events,
    tasks,
    devopsHealth: timed('devops_snapshot', () => safeReadJson(devopsPath)),
    gravityPath,
    devopsPath,
    amendmentApproval: safeReadJson(approvalPath),
    amendmentLedgerRows: timed('amendment_ledger', () => readJsonl(ledgerPath)),
    gravityChangedToday,
    gravityChangeSource,
    junctionProof,
    releaseTreeProof,
    gitHygiene: timed('git_hygiene_snapshot', () => safeReadJson(gitHygienePath)),
    gitHygienePath,
    cloudFirstDriftReceipt: safeReadJson(cloudFirstDriftReceiptPath),
    cloudFirstDriftReceiptPath,
    unitIndependenceReceipt: safeReadJson(unitIndependenceReceiptPath),
    unitIndependenceReceiptPath,
    learnReceiptRows: fs.existsSync(learnReceiptPath) ? timed('learn_receipts', () => readJsonl(learnReceiptPath)) : null,
    learnReceiptPath,
    publicMirrorReceipt: safeReadJson(publicMirrorReceiptPath),
    publicMirrorReceiptPath,
    priorGravityHealth: (() => {
      // Receipts are keyed by briefing date; compare against the day it graded.
      const prior = safeReadJson(path.join(runtime, 'agent', `gravity-health-${priorCtDateKey(briefingDate)}.json`));
      return prior ? { ...prior, date: prior.graded_date || prior.date } : null;
    })(),
    ledgers: {
      sendGuard: { path: sendGuardPath, rows: timed('send_guard_log', () => parseSendGuardLog(sendGuardPath, row => sameCtDate(row.ts, date))) },
      dispatchLog: agentLedger('amy-dispatch-log.jsonl', row => sameCtDate(row.processed_at || row.ts, date)),
      scanHeartbeat: agentLedger('gmail-scan-heartbeat.jsonl', row => sameCtDate(row.ts, date)),
      bigDecisions: agentLedger('big-decisions.jsonl', row => String(row.date || row.loggedAt || '').startsWith(date)),
      askAiRungs: agentLedger('ask-ai-rungs.jsonl', row => row.rung && sameCtDate(row.ts, date)),
      piiDenylist: { path: denylistPath, value: denylistValue, currentWithContacts: denylistCurrent },
    },
    memoryCommittedToday: lastCommitSameCtDate(['memory'], 'git_memory'),
    learnCommittedToday: lastCommitSameCtDate(['memory/feedback_*.md', '*LESSONS.md', '*LEARNINGS.md'], 'git_lessons'),
    learnGitAvailable: hasGitDir,
  };
  const receipt = timed('law_evaluation', () => buildGravityHealth(evidence));
  receipt.timings = { schema: 'amy.gravity_health_timings.v1', phases_ms: phases,
    measured_before_write_ms: Math.round((performance.now() - probeStarted) * 1000) / 1000,
    per_git_timeout_ms: 5000, operation_events_read: eventCount, operation_events_in_window: events.length,
    coding_tasks_in_window: tasks.length, ledger_rows: ledgerCounts };
  receipt.date = briefingDate;
  receipt.graded_date = date;
  const receiptPath = path.join(runtime, 'agent', `gravity-health-${briefingDate}.json`);
  if (write) {
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    const temp = `${receiptPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.renameSync(temp, receiptPath);
  }
  return { ...receipt, receipt_path: receiptPath };
}

function formatGravityHealthRow(receipt) {
  if (!receipt || receipt.schema !== SCHEMA) {
    return '? Laws of Amy Gravity: UNKNOWN - no same-date Gravity health receipt. Consequence: do not claim governed-complete; owner Amy.';
  }
  const glyph = receipt.status === 'green' ? '✓' : receipt.status === 'red' ? '✗' : '?';
  const label = receipt.status.toUpperCase();
  const proof = receipt.receipt_path
    ? path.basename(receipt.receipt_path)
    : `gravity-health-${receipt.date}.json`;
  const violations = (receipt.laws || []).filter((law) => law.verdict === 'VIOLATED');
  const violationDetail = violations.length
    ? ` Violations: ${violations.map((law) => `${law.id} (${law.law || law.title || law.id}): ${law.reason}`).join(' | ')} Proposed fix: ${violations.map(gravityViolationRepair).join(' | ')}`
    : '';
  // An unknown law is missing evidence, not a pass. Name each one and its
  // evidence-seam repair so "0 violated" can never read as governed-complete.
  const unknowns = (receipt.laws || []).filter((law) => law.verdict === 'UNKNOWN');
  const unknownDetail = unknowns.length
    ? ` Unknown: ${unknowns.map((law) => `${law.id}: ${law.reason}`).join(' | ')} Unknown repair: ${unknowns.map((law) => `${law.id}: ${gravityUnknownRepair(law)}`).join(' | ')}`
    : '';
  return `${glyph} Laws of Amy Gravity: ${label} - ${receipt.counts.violated} violated, ${receipt.counts.unknown} unknown, ${receipt.counts.compliant} compliant, ${receipt.counts.not_applicable} not applicable of ${receipt.counts.total}.${violationDetail}${unknownDetail} ${receipt.graded_date ? ` Graded day: ${receipt.graded_date}.` : ''} Consequence: ${receipt.consequence} Proof: ${proof}.`;
}

function gravityViolationRepair(law) {
  const id = String(law?.id || '').toLowerCase();
  const specific = {
    g0: 'Repair the named hook registration or delivery path, rerun its integrity test, and require a same-date green Dev Ops receipt.',
    // g2 and g5 intentionally share the same repair because both consume the
    // same outbound-send identity-attestation guard.
    g2: 'Block the unattested outbound sends, restore Amy or ExampleCo-approved identity attestation at the send guard, and re-audit the same-date decisions.',
    g3: 'Revert or stop the undispatched action, require an explicit dispatch for that item, then rerun the ingest and dispatch proof.',
    g4: 'Write the missing same-date big-decisions entry for the rule supersession and rerun the Gravity probe.',
    g5: 'Block the unattested outbound sends, restore Amy or ExampleCo-approved identity attestation at the send guard, and re-audit the same-date decisions.',
    g10: 'Identify the owner of every shared-checkout change, move each owned change into an isolated worktree, land validated work through the land gate, and return the shared checkout to clean without discarding another session\'s work.',
    g11: 'Re-land the affected master advance through the land service with commit, base, test, target, and consumed one-use lease proof.',
    g13: 'Reopen each unsupported done claim, create and verify its archive receipt, then close the task only after the receipt is attached.',
    g14: 'Repair the named dead or silent hook registration, prove fail-loud delivery, and rerun the hook-integrity receipt.',
    g15: 'Regenerate the screened public mirror from the current private source and verify its same-date currency receipt.',
    g17: 'Stop charged API fallback until both subscription rungs have same-date failed-attempt receipts, then rerun through the authorized ladder.',
    g24: 'Restore valid Gravity structure or obtain same-day ExampleCo or PRIVATE_NAME approval plus the amendment-ledger receipt, then rerun the exact Gravity probe.',
    g27: 'Remove the cross-unit dependency or declare it explicitly, regenerate only the affected unit, and prove sibling cards and metrics stayed unchanged.',
  };
  return specific[id] || `Correct ${id || 'the named law'} at the failing evidence seam (${String(law?.reason || 'violation recorded')}), then rerun the exact Gravity probe and require rendered proof.`;
}

// Evidence-seam repairs for laws the EC2 probe cannot prove (traced 2026-09-22).
function gravityUnknownRepair(law) {
  const id = String(law?.id || '').toLowerCase();
  const promptAdmission =
    'Emit prompt.admitted and prompt.context.delivered provenance from EC2 automated model runs via prompt-admission-token.js, or record not applicable on days with no prompt-eligible operation.';
  const specific = {
    g1: promptAdmission,
    g6: promptAdmission,
    g25: promptAdmission,
    g8: 'Treat /opt/secondbrain as the canonical tree on the EC2 release host instead of requiring the desktop home-directory junction.',
    g9: 'Read completed tasks from the EC2 spine Task store instead of the desktop APPDATA path, and record not applicable when none completed.',
    g15: 'Repair the Dev Ops public-mirror currency check so it produces the public-safe payload digest on EC2 instead of reporting unknown.',
    g19: 'Run scripts/build-pii-denylist.js on EC2 so data/agent/pii-denylist.json exists for derived-artifact screening.',
    g23: 'Read a same-date #learn receipt ledger instead of git log, because the EC2 release snapshot has no .git directory.',
    g24: 'Read the laws-file change time from the live release manifest instead of git log, because the EC2 release snapshot has no .git directory.',
    g26: 'Add a g26 evaluator that reads the same-date cloud-first drift receipt from scripts/verify-cloud-first-drift.js.',
    g27: 'Add a g27 evaluator that reads same-date unit-independence gate results from scripts/lib/gravity-semantic-gate.js.',
  };
  return specific[id] || `Produce same-date evidence for ${id || 'the named law'} at its evaluator seam (${String(law?.reason || 'evidence missing')}), then rerun the exact Gravity probe.`;
}

function gravityHealthPresentation(detail) {
  const text = String(detail || '').replace(/\s+/g, ' ').trim();
  const violation = text.match(/Violations:\s*(.*?)\s+Proposed fix:/i);
  const proposed = text.match(/Proposed fix:\s*(.*?)\s+(?:Unknown:|Consequence:)/i);
  const evidenceIdentified = Boolean(violation && violation[1] && violation[1].trim());
  const unknown = text.match(/Unknown:\s*(.*?)\s+Unknown repair:/i);
  const unknownRepair = text.match(/Unknown repair:\s*(.*?)\s+Consequence:/i);
  if (!evidenceIdentified && unknown && unknown[1] && unknown[1].trim()) {
    return {
      problem: `Unknown evidence: ${unknown[1].trim()}`,
      solution: (unknownRepair && unknownRepair[1] && unknownRepair[1].trim()) || 'Produce the missing same-date evidence for each named law, then rerun the exact Gravity probe.',
      evidenceIdentified: true,
    };
  }
  return {
    problem:
      (evidenceIdentified && violation[1].trim()) ||
      'Gravity is non-green, but the violated law and reason were not preserved.',
    solution:
      (proposed && proposed[1] && proposed[1].trim()) ||
      'Repair the named evidence seam, rerun the exact Gravity probe, and require the corrected detail to appear on the live card.',
    evidenceIdentified,
  };
}

module.exports = {
  gradedCtDate,
  LAW_STATUSES,
  SCHEMA,
  buildGravityHealth,
  formatGravityHealthRow,
  gravityViolationRepair,
  gravityUnknownRepair,
  gravityHealthPresentation,
  parseSendGuardLog,
  probeGravityHealth,
  readTasks,
  readJsonl,
  eventCtDate,
  runtimeDataDir,
};
