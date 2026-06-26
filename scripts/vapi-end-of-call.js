/**
 * vapi-end-of-call.js - process a Vapi end-of-call-report payload.
 *
 * Pulled out of ec2-server.js so the logic is unit-testable without
 * spinning up the HTTP server. ec2-server.js wires this in inside its
 * Vapi webhook handler.
 *
 * Pipeline (mirrors how Otter and Gmail #Amy directives flow):
 *  1. Save the full payload to data/vapi/raw/{callId}.json (raw archival
 *     before any processing, per feedback_raw_archival_principle.md).
 *  2. Extract directives from the transcript using assistant restatement
 *     lines ("Got it. <restatement>" / "Understood. <restatement>") since
 *     those are the cleanest paraphrase of the owner's ask.
 *  3. Create one spine action task per directive, then append a matching
 *     legacy queue receipt for dashboard/backfill compatibility.
 *  4. Telegram-ping the owner so they see what was captured.
 *
 * Triggered by the 2026-05-01 incident: ExampleCo asked for an immigration news
 * section on a Vapi call; Amy verbally said "Got it" but invoked no tool,
 * the webhook had no end-of-call-report handler, and the directive
 * evaporated at hangup. Fix: capture transcripts mechanically every call,
 * never rely on Amy remembering to call a tool mid-call.
 */

const fs = require('fs');
const path = require('path');
const { recordDispatchInput } = require('./lib/spine-ingress');
const {
  auditCompletedSideEffectClaims,
  readEffectReceipts,
} = require('./lib/vapi-side-effect-ledger');
const { appendRecentOwnerCallContext } = require('./lib/voice-recent-context');

function getDispatchQueuePath(opts = {}) {
  if (opts.queuePath) return opts.queuePath;
  if (process.env.DISPATCH_QUEUE) return process.env.DISPATCH_QUEUE;
  if (fs.existsSync('/opt/secondbrain/data/agent')) {
    return '/opt/secondbrain/data/agent/dispatch-queue.jsonl';
  }
  const repoRoot = path.resolve(__dirname, '..');
  return path.join(repoRoot, 'data', 'agent', 'dispatch-queue.jsonl');
}

function getVapiRawDir(opts = {}) {
  if (opts.rawDir) return opts.rawDir;
  if (fs.existsSync('/opt/secondbrain/data')) {
    return path.join('/opt/secondbrain/data', 'vapi', 'raw');
  }
  const repoRoot = path.resolve(__dirname, '..');
  return path.join(repoRoot, 'data', 'vapi', 'raw');
}

function getSpineTasksDir(opts = {}) {
  if (opts.tasksDir) return opts.tasksDir;
  if (opts.queuePath) return path.join(path.dirname(path.dirname(opts.queuePath)), 'tasks');
  return undefined;
}

/**
 * Pull the assistant's restatement of each owner directive out of a Vapi
 * transcript. The transcript is plain text with role-prefixed lines
 * ("AI: ..." / "User: ...").
 *
 * We scan AI lines that begin with an acknowledgement ("Got it",
 * "Understood", "Sure", "Okay", "Of course"), strip the acknowledgement,
 * and keep the restatement when it contains an imperative verb (add,
 * include, schedule, remember, ...). This avoids capturing pleasantries
 * while still picking up real instructions.
 */
function extractDirectivesFromTranscript(transcript) {
  if (!transcript || typeof transcript !== 'string') return [];
  const ackRe =
    /^AI:\s*(?:got it[.,!]?\s*|understood[.,!]?\s*|sure[.,!]?\s*|okay[.,!]?\s*|of course[.,!]?\s*|alright[.,!]?\s*|yes[.,!]?\s*|absolutely[.,!]?\s*|will do[.,!]?\s*)+(.+)$/i;
  const imperativeRe =
    /\b(include|add|adding|make|set|schedule|remember|save|create|update|find|track|monitor|build|enable|disable|start|stop|always|never|change|put|drop|move|switch|focus|prioritize|deprioritize|stop sending|send|email|text|call|skip|ignore|allow|disallow|require|prefer)\b/i;
  // Amy's own conversational filler ("I'll make sure...", "I'll prioritize...",
  // "Let me know if...") is NOT a directive. It used to flood the dispatch
  // queue because it follows an ack word and contains an imperative verb.
  // A genuine restated directive is in imperative mood ("Schedule...",
  // "Include...", "Always send..."), never first-person-future Amy speech.
  // Reject bodies that open with that filler shape (ExampleCo 2026-05-18).
  const fillerRe = /^(?:i'?ll\b|i will\b|i'?m\b|i can\b|i'?d\b|i have\b|i'?ve\b|let me\b|if (?:you|there|that)\b|that (?:sounds|works)\b|sounds\b|thanks\b|no problem\b|happy to\b)/i;
  const directives = [];
  const seen = new Set();
  for (const rawLine of transcript.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(ackRe);
    if (!m) continue;
    const body = (m[1] || '').trim();
    if (body.length < 20) continue;
    if (fillerRe.test(body)) continue;
    if (!imperativeRe.test(body)) continue;
    const norm = body.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(norm)) continue;
    seen.add(norm);
    directives.push(body);
  }
  return directives;
}

function hasExplicitAmyTrigger(text) {
  return /(?:^|[^\w])#amy\b|hashtag\s+amy\b/i.test(String(text || ''));
}

function hasExplicitUserAmyTrigger(transcript) {
  const lines = String(transcript || '').split(/\r?\n/);
  const hasRoleLines = lines.some((line) => /^(User|AI|Assistant):\s*/i.test(line.trim()));
  const userLines = lines
    .map((line) => line.trim())
    .filter((line) => /^User:\s*/i.test(line))
    .map((line) => line.replace(/^User:\s*/i, ''));
  if (userLines.length > 0) return userLines.some(hasExplicitAmyTrigger);
  if (hasRoleLines) return false;
  return hasExplicitAmyTrigger(transcript);
}

function isOwnerCall(customer, ownerPhones) {
  if (!customer || !ownerPhones || !ownerPhones.length) return false;
  const customerDigits = String(customer).replace(/\D/g, '');
  if (!customerDigits) return false;
  return ownerPhones.some((p) => {
    if (!p) return false;
    const pd = String(p).replace(/\D/g, '');
    if (!pd) return false;
    return customerDigits.includes(pd) || pd.includes(customerDigits);
  });
}

/**
 * Process an end-of-call-report event. Pure function in spirit: all I/O
 * and external sends go through injected dependencies so tests can
 * substitute fakes.
 *
 * deps = {
 *   ownerPhones: string[],     // OWNER_PHONES from ec2-server.js env
 *   sendMessage: (text) => Promise<void>,
 *   queuePath?: string,         // override for tests
 *   rawDir?: string,            // override for tests
 *   nowIso?: () => string,      // override for tests (deterministic ts)
 * }
 */
function handleEndOfCallReport(msg, callObj, deps = {}) {
  const ownerPhones = Array.isArray(deps.ownerPhones) ? deps.ownerPhones : [];
  const sendMessage = typeof deps.sendMessage === 'function' ? deps.sendMessage : () => Promise.resolve();
  const nowIso = typeof deps.nowIso === 'function' ? deps.nowIso : () => new Date().toISOString();

  const callId = (callObj && callObj.id) || (msg && msg.callId) || 'ExampleCo';
  const transcript = (msg && msg.transcript) || '';
  const summary =
    (msg && msg.analysis && msg.analysis.summary) ||
    (msg && msg.summary) ||
    '';
  const customer =
    (callObj && callObj.customer && callObj.customer.number) ||
    (msg && msg.call && msg.call.customer && msg.call.customer.number) ||
    '';
  const startedAt =
    (callObj && callObj.startedAt) ||
    (msg && msg.startedAt) ||
    nowIso();
  const spineOpts = { nowIso };
  const tasksDir = getSpineTasksDir(deps);
  if (tasksDir) spineOpts.tasksDir = tasksDir;
  const effectReceipts = Array.isArray(deps.effectReceipts)
    ? deps.effectReceipts
    : readEffectReceipts({ callId, ledgerPath: deps.effectLedgerPath });
  const sideEffectAudit = auditCompletedSideEffectClaims({ transcript, receipts: effectReceipts });

  // 1) Raw archival before any processing.
  let rawPath = '';
  try {
    const rawDir = getVapiRawDir({ rawDir: deps.rawDir });
    fs.mkdirSync(rawDir, { recursive: true });
    rawPath = path.join(rawDir, callId + '.json');
    fs.writeFileSync(
      rawPath,
      JSON.stringify({ savedAt: nowIso(), callObj, msg }, null, 2),
    );
  } catch (e) {
    // Raw archive failure is non-fatal: the dispatch path still runs.
    rawPath = '';
  }

  let spineTaskId = null;
  try {
    const task = recordDispatchInput(
      {
        kind: 'ingest',
        origin: 'voice',
        sourceType: 'amy-call',
        sourceRef: callId,
        title: `Amy call: ${callId}`,
        text: transcript || summary || '(No transcript text captured.)',
        ts: startedAt,
        approved: false,
        meta: {
          explicitRequest: false,
          callId,
          rawPath: rawPath || null,
          customerPhone: customer || null,
        },
      },
      spineOpts,
    );
    spineTaskId = task.id;
  } catch (e) {
    // Spine write failure is non-fatal for the archival path, but it is
    // surfaced in the return payload for probes/tests.
    spineTaskId = null;
  }

  // 2) Only mine directives from owner calls. Random inbounds get archived
  //    but never auto-dispatched.
  if (!isOwnerCall(customer, ownerPhones)) {
    return { archived: !!rawPath, rawPath, directives: [], skipped: 'non-owner', spineTaskId, sideEffectAudit };
  }

  const recentContext = appendRecentOwnerCallContext(
    {
      callId,
      customer,
      startedAt,
      transcript,
      summary,
    },
    {
      contextPath: deps.recentContextPath,
      nowIso,
    },
  );

  if (!sideEffectAudit.ok) {
    const lines = [
      'Amy side-effect claim failed audit on call ' + callId + ':',
    ];
    for (const claim of sideEffectAudit.unsupported.slice(0, 5)) {
      lines.push('- Unsupported ' + claim.effect_kind + ' completion claim: "' + claim.text.slice(0, 240) + '"');
    }
    lines.push('');
    lines.push('No matching successful side-effect receipt was recorded, so treat the claim as false until repaired.');
    Promise.resolve(sendMessage(lines.join('\n'))).catch(() => {});
  }

  // 3) Extract directives, write one spine task per directive, and append
  //    matching legacy queue receipts for dashboard/backfill compatibility.
  const directives = extractDirectivesFromTranscript(transcript);
  if (directives.length === 0) {
    return { archived: !!rawPath, rawPath, directives: [], skipped: 'no-directives', spineTaskId, sideEffectAudit, recentContext };
  }

  if (!hasExplicitUserAmyTrigger(transcript)) {
    return {
      archived: !!rawPath,
      rawPath,
      directives: [],
      skipped: 'no-explicit-amy-trigger',
      spineTaskId,
      sideEffectAudit,
      recentContext,
    };
  }

  const queuePath = getDispatchQueuePath({ queuePath: deps.queuePath });
  const writtenEntries = [];
  const directiveTaskIds = [];
  try {
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    for (const [index, d] of directives.entries()) {
      const directiveTask = recordDispatchInput(
        {
          origin: 'voice',
          sourceType: 'vapi_call',
          sourceRef: `${callId}:directive:${index + 1}`,
          title: `Voice directive: ${d}`.slice(0, 100),
          text: [
            `Directive captured from Vapi call ${callId}.`,
            `Call started: ${startedAt}`,
            summary ? `Call summary: ${summary}` : '',
            '',
            d,
          ].filter(Boolean).join('\n'),
          parentId: spineTaskId || undefined,
          approved: true,
          meta: {
            explicitRequest: true,
            callId,
            directiveIndex: index + 1,
            rawPath: rawPath || null,
            customerPhone: customer || null,
          },
        },
        spineOpts,
      );
      directiveTaskIds.push(directiveTask.id);
      const entry = {
        ts: nowIso(),
        source: 'vapi_call',
        vapi_call_id: callId,
        customer_phone: customer,
        call_started_at: startedAt,
        section: 'voice_directive',
        itemRef: callId,
        comment: d,
        call_summary: summary,
        raw_path: rawPath,
        spine_task_id: directiveTask.id,
        explicitRequest: true,
        explicitAmyTrigger: true,
        status: 'queued',
      };
      fs.appendFileSync(queuePath, JSON.stringify(entry) + '\n');
      writtenEntries.push(entry);
    }
  } catch (e) {
    return { archived: !!rawPath, rawPath, directives, directiveWriteError: e.message, spineTaskId, directiveTaskIds, sideEffectAudit, recentContext };
  }

  // 4) Telegram ping so ExampleCo sees what was captured.
  const lines = ['Captured ' + directives.length + ' directive(s) from your last call:'];
  directives.forEach((d, i) => {
    lines.push((i + 1) + '. ' + d.slice(0, 280));
  });
  lines.push('');
  lines.push('Queued for processing. process-dispatches.js will route them.');
  Promise.resolve(sendMessage(lines.join('\n'))).catch(() => {});

  return {
    archived: !!rawPath,
    rawPath,
    directives,
    queuePath,
    written: writtenEntries.length,
    spineTaskId,
    directiveTaskIds,
    sideEffectAudit,
    recentContext,
  };
}

module.exports = {
  extractDirectivesFromTranscript,
  hasExplicitAmyTrigger,
  hasExplicitUserAmyTrigger,
  isOwnerCall,
  handleEndOfCallReport,
  getDispatchQueuePath,
  getVapiRawDir,
  getSpineTasksDir,
};
