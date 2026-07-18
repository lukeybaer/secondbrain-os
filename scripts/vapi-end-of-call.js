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
 *  4. Send one deduped Telegram brief after every non-ExampleCo conversation;
 *     owner directive captures use the same voice-followup channel.
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

function callTranscript(msg, callObj) {
  return String(
    (msg && msg.transcript) ||
      (msg && msg.artifact && msg.artifact.transcript) ||
      (callObj && callObj.transcript) ||
      '',
  ).trim();
}

function callSummary(msg, callObj) {
  return String(
    (msg && msg.analysis && msg.analysis.summary) ||
      (msg && msg.summary) ||
      (callObj && callObj.summary) ||
      '',
  ).replace(/\s+/g, ' ').trim();
}

function callerTurns(transcript) {
  return String(transcript || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.match(/^(?:User|Caller|Customer):\s*(.+)$/i))
    .filter(Boolean)
    .map((match) => match[1].replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function transcriptSummaryFallback(transcript) {
  const turns = callerTurns(transcript);
  if (!turns.length) return '';
  let text = turns.slice(0, 3).join(' ');
  const introduction = text.match(/^this is\s+([^.!?]+)[.!?]\s*(.+)$/i);
  if (introduction) text = `${introduction[1].trim()}: ${introduction[2].trim()}`;
  if (text.length > 700) text = text.slice(0, 697).replace(/\s+\S*$/, '') + '...';
  return text;
}

function callDurationSeconds(callObj) {
  const explicit = Number(callObj && callObj.durationSeconds);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.round(explicit);
  const start = Date.parse((callObj && callObj.startedAt) || '');
  const end = Date.parse((callObj && callObj.endedAt) || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

function formatCallDuration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  if (!minutes) return `${remainder}s`;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function endedWithoutConversation(callObj, transcript) {
  if (callerTurns(transcript).length) return false;
  const reason = String((callObj && callObj.endedReason) || '').toLowerCase();
  return /(?:did-not-answer|customer-busy|call-rejected|invalid-number|number-unavailable|failed-to-connect|no-route)/.test(
    reason,
  );
}

function buildThirdPartyCallBrief(msg, callObj) {
  const transcript = callTranscript(msg, callObj);
  if (endedWithoutConversation(callObj, transcript)) return null;
  const generatedSummary = callSummary(msg, callObj);
  const groundedSummary = generatedSummary || transcriptSummaryFallback(transcript);
  if (!groundedSummary) return null;

  const customer = (callObj && callObj.customer) || (msg && msg.call && msg.call.customer) || {};
  const name = String(customer.name || '').replace(/\s+/g, ' ').trim();
  const phone = String(customer.number || '').trim();
  const party = name && phone ? `${name} (${phone})` : name || phone || 'ExampleCo caller';
  const type = String((callObj && callObj.type) || '').toLowerCase();
  const direction = type.includes('inbound') ? 'Inbound' : type.includes('outbound') ? 'Outbound' : '';
  const duration = formatCallDuration(callDurationSeconds(callObj));
  const endedReason = String((callObj && callObj.endedReason) || '').replace(/[-_]+/g, ' ').trim();
  const facts = [direction, duration, endedReason].filter(Boolean);
  const lines = [`Phone call with ${party}`];
  if (facts.length) lines.push(facts.join(' | '));
  lines.push('', `Summary: ${groundedSummary}`);
  return lines.join('\n');
}

function sendVoiceFollowup(deps, sendMessage, payload) {
  const notify =
    typeof deps.notify === 'function'
      ? deps.notify
      : ({ text, kind, source, dedupKey }) =>
          sendMessage(text, {
            raw: true,
            kind,
            extras: { source, dedup_key: dedupKey },
          });
  Promise.resolve(notify(payload)).catch(() => {});
}

/**
 * Process an end-of-call-report event. Pure function in spirit: all I/O
 * and external sends go through injected dependencies so tests can
 * substitute fakes.
 *
 * deps = {
 *   ownerPhones: string[],     // OWNER_PHONES from ec2-server.js env
 *   ExampleCoPhones?: string[],     // ExampleCo identities only; controls third-party summaries
 *   sendMessage: (text) => Promise<void>,
 *   notify?: (payload) => Promise<object>, // notify-with-fallback in production
 *   queuePath?: string,         // override for tests
 *   rawDir?: string,            // override for tests
 *   nowIso?: () => string,      // override for tests (deterministic ts)
 * }
 */
function handleEndOfCallReport(msg, callObj, deps = {}) {
  const ownerPhones = Array.isArray(deps.ownerPhones) ? deps.ownerPhones : [];
  const ExampleCoPhones = Array.isArray(deps.ExampleCoPhones) ? deps.ExampleCoPhones : ownerPhones;
  const sendMessage = typeof deps.sendMessage === 'function' ? deps.sendMessage : () => Promise.resolve();
  const nowIso = typeof deps.nowIso === 'function' ? deps.nowIso : () => new Date().toISOString();

  const callId = (callObj && callObj.id) || (msg && msg.callId) || 'ExampleCo';
  const transcript = callTranscript(msg, callObj);
  const summary = callSummary(msg, callObj);
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

  // Every completed conversation with someone other than ExampleCo gets one
  // grounded Telegram brief. This is separate from the owner authorization
  // gate: PRIVATE_NAME or another authorized principal is still "not ExampleCo" and must
  // be summarized to him. Empty no-answer events have no conversation to
  // summarize and therefore do not notify.
  const thirdPartyBrief = !isOwnerCall(customer, ExampleCoPhones)
    ? buildThirdPartyCallBrief(msg, callObj)
    : null;
  if (thirdPartyBrief) {
    sendVoiceFollowup(deps, sendMessage, {
      text: thirdPartyBrief,
      source: 'vapi-end-of-call',
      kind: 'voice-followup',
      dedupKey: `third-party-call:${callId}`,
      raw: true,
    });
  }

  // 2) Only mine directives from owner calls. Random inbounds get archived
  //    but never auto-dispatched.
  if (!isOwnerCall(customer, ownerPhones)) {
    return {
      archived: !!rawPath,
      rawPath,
      directives: [],
      skipped: 'non-owner',
      spineTaskId,
      sideEffectAudit,
      thirdPartyBrief: !!thirdPartyBrief,
    };
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
  sendVoiceFollowup(deps, sendMessage, {
    text: lines.join('\n'),
    source: 'vapi-end-of-call-directives',
    kind: 'voice-followup',
    dedupKey: `owner-call-directives:${callId}`,
    raw: true,
  });

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
  callTranscript,
  callSummary,
  transcriptSummaryFallback,
  buildThirdPartyCallBrief,
  handleEndOfCallReport,
  getDispatchQueuePath,
  getVapiRawDir,
  getSpineTasksDir,
};
