'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { dateKeyInCt, nextDateKey, briefingRunWindow } = require('./briefing-run-window.js');
const {
  classifyText,
  ownerCommand,
  skillFromMetaPrompt,
  refineUnclassified,
} = require('./token-work-classifier.js');
// Refined classes that already have a 24-hour bar reuse that bar's name.
const PROCESS_NAME_FOR_WORK_CLASS = {
  'Briefing pipeline': 'Briefing and watcher work',
  'Otter transcript pipeline': 'Otter and transcript work',
  'Voice / phone calls': 'Voice and outbound-call work',
  Email: 'Ingest and enrichment work',
};
const {
  createPollTurnAccumulator,
  analyzePollAmplification,
  supervisedAgentIds,
} = require('./agent-supervision.js');

// The only rows the poll accumulator consumes. Filtering here keeps the
// deferred-scoring buffer bounded to turn structure instead of whole rollouts.
function isPollTelemetryRow(row) {
  if (!row) return false;
  if (row.type === 'event_msg') {
    const type = String(row.payload?.type || '');
    return type === 'task_started' || type === 'token_count';
  }
  if (row.type !== 'response_item') return false;
  return /tool_call$|^function_call$|^local_shell_call$/.test(String(row.payload?.type || ''));
}

const TOKEN_SPEND_PARETO_SCHEMA = 'token-spend-pareto.v1';
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_MS = 15 * 60 * 1000;
const TOKEN_EXPLORER_PROMPT_MAX_CHARS = 64 * 1024;
const SUBSCRIPTION_ATTEMPT_RE =
  /SECOND BRAIN SUBSCRIPTION ATTEMPT:\s*([A-Za-z0-9_-]{1,80});\s*attempt\s+(\d+)\/(\d+)/i;

function formatCount(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(
    Math.max(0, Number(value) || 0),
  );
}

function ctWallClock(ms) {
  if (!Number.isFinite(ms)) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function readAttendedWatcherAutomation(
  file = path.join(
    os.homedir(),
    '.codex',
    'automations',
    'overnight-briefing-watcher',
    'automation.toml',
  ),
) {
  try {
    const source = fs.readFileSync(file, 'utf8');
    const value = (name) =>
      String(source.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] || '').replace(
        /\\n/g,
        '\n',
      );
    const threadId = value('target_thread_id');
    const rrule = value('rrule');
    const start = rrule.match(/DTSTART:(\d{8}T\d{6}Z)/)?.[1] || '';
    const until = rrule.match(/UNTIL=(\d{8}T\d{6}Z)/)?.[1] || '';
    const parseIcal = (stamp) =>
      stamp
        ? Date.parse(
            `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
          )
        : Number.NaN;
    const startMs = parseIcal(start);
    const untilMs = parseIcal(until);
    const explicitRunMs = [
      start,
      ...String(rrule.match(/^RDATE:(.+)$/m)?.[1] || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ]
      .map(parseIcal)
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    const intervalMinutes = Number(rrule.match(/INTERVAL=(\d+)/)?.[1] || 0);
    const checkCount = explicitRunMs.length
      ? explicitRunMs.length
      : Number.isFinite(startMs) &&
          Number.isFinite(untilMs) &&
          intervalMinutes > 0 &&
          untilMs >= startMs
        ? Math.floor((untilMs - startMs) / (intervalMinutes * 60_000)) + 1
        : 0;
    const active = value('status') === 'ACTIVE';
    const idMatches = value('id') === 'overnight-briefing-watcher';
    const explicitCt = explicitRunMs.map(ctWallClock).filter(Boolean);
    const expectedWallTimes = [
      [23, 0],
      [23, 30],
      [0, 30],
      [2, 30],
      [4, 0],
      [4, 15],
      [4, 30],
      [4, 45],
      [5, 0],
      [5, 15],
      [5, 30],
    ];
    const explicitScheduleMatches =
      explicitCt.length === expectedWallTimes.length &&
      explicitCt.every(
        (row, index) =>
          row.hour === expectedWallTimes[index][0] && row.minute === expectedWallTimes[index][1],
      );
    const startCt = ctWallClock(startMs);
    const untilCt = ctWallClock(untilMs);
    const legacyWindowMatches = Boolean(
      startCt &&
      untilCt &&
      startCt.hour === 4 &&
      startCt.minute === 0 &&
      untilCt.hour === 5 &&
      untilCt.minute === 45,
    );
    const windowMatches = explicitScheduleMatches || legacyWindowMatches;
    const reason = !idMatches
      ? 'id-mismatch'
      : !active
        ? 'inactive'
        : !threadId
          ? 'target-thread-missing'
          : !explicitScheduleMatches && intervalMinutes !== 15
            ? 'interval-mismatch'
            : checkCount !== (explicitScheduleMatches ? 11 : 8)
              ? 'check-count-mismatch'
              : !windowMatches
                ? 'window-mismatch'
                : 'verified';
    return {
      threadId,
      active,
      intervalMinutes,
      checkCount,
      startsAt: Number.isFinite(startMs) ? new Date(startMs).toISOString() : '',
      endsAt: Number.isFinite(untilMs) ? new Date(untilMs).toISOString() : '',
      reason,
      verified: reason === 'verified',
    };
  } catch {
    return {
      threadId: '',
      active: false,
      intervalMinutes: 0,
      checkCount: 0,
      reason: 'file-missing-or-unreadable',
      verified: false,
    };
  }
}
const TOKEN_REPORT_AGENT_PATH_LABELS = Object.freeze({
  codexOther: 'Other Codex task',
  codexHelper: 'Codex helper task',
  codexInteractive: 'Interactive Codex task',
  codexAutomated: 'Automated Codex task',
  claudeHelper: 'Claude helper task',
  claudeAutomated: 'Automated Claude task',
  claudeInteractive: 'Interactive Claude task',
});
const TOKEN_REPORT_FORBIDDEN_RUNTIME_LABEL_RE =
  /\b(?:codex_exec runner|Explicit subagent path|Background runtime|SessionStart|claude-proxy-runtime|Stop event|cache_read_input_tokens)\b/i;
const TOKEN_REPORT_LABEL_REPLACEMENTS = [
  [/\bcodex_exec runner\b/gi, 'Codex command-line task'],
  [/\bExplicit subagent path\b/gi, 'Helper task'],
  [/\bBackground runtime\b/gi, 'Automated task'],
  [/\bSessionStart\b/gi, 'Startup context'],
  [/\bclaude-proxy-runtime\b/gi, 'Phone proxy workspace'],
  [/\bStop event\b/gi, 'Completion check'],
  [/\bcache_read_input_tokens\b/gi, 'cached input'],
];

function sanitizeTokenReportLabel(value, fallback = 'Other measured work') {
  let label = compact(value || fallback, 180);
  for (const [pattern, replacement] of TOKEN_REPORT_LABEL_REPLACEMENTS) {
    label = label.replace(pattern, replacement);
  }
  return compact(label, 180) || fallback;
}

function compact(value, max = 220) {
  const text = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

// The healer driver (scripts/agentic-healer-driver.js) stamps this exact
// marker as the first line of its DYNAMIC prompt bucket, right after the
// stable skill/core-law prefix, specifically so a session's first-user-turn
// text carries a durable id back to the dispatch that produced it, with no
// other shared join key required. This is a best-effort correlation, not a
// guarantee: a very large stable prefix can push the marker past the
// TOKEN_EXPLORER_PROMPT_MAX_CHARS bound captured above, in which case this
// stays honestly unprovable rather than guessing.
const HEALER_SESSION_CORRELATION_MARKER_RE = /HEALER SESSION CORRELATION ID:\s*(\S+)/;

// The healer's own durable receipt (agentic-healer-driver.js's buildReceipt,
// written by finishReceipt to <dataDir>/agent/overnight-agentic-healer-runs/
// <date>.jsonl -- RECEIPTS_LEDGER_NAME there, duplicated here as a literal
// to avoid a cross-file require) is the second durable receipt the marker
// join makes reachable: each of its receipt.sessions[] rows carries the
// SAME correlationId this file reads out of the prompt, plus the
// briefingContext stable/delta byte split and stable-resend reason the
// token report needs to audit. There is no separate "model-router decision
// receipt" file anywhere in this codebase to join against (model-router.js
// is out of this fix's scope); this is the one durable, joinable record of
// what the retry-path context mechanism actually did for a given dispatch.
const HEALER_RECEIPTS_LEDGER_NAME = 'overnight-agentic-healer-runs';
// Bound the scan: a receipt directory accumulates one file per briefing
// date forever, and this index only needs to answer "was this exact
// correlation id dispatched recently", never a full-history query.
const HEALER_RECEIPTS_INDEX_MAX_FILES = 30;

// Build correlationId -> {stableBytes, deltaBytes, stableResendReason} from
// every session row across the most recent healer receipt files. Never
// throws: a missing directory, unreadable file, or malformed line just
// means less enrichment, never a broken token report.
function loadHealerReceiptCorrelationIndex({ dataDir } = {}) {
  const index = new Map();
  if (!dataDir) return index;
  const dir = path.join(dataDir, 'agent', HEALER_RECEIPTS_LEDGER_NAME);
  let files;
  try {
    files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name)
      .sort()
      .slice(-HEALER_RECEIPTS_INDEX_MAX_FILES);
  } catch {
    return index;
  }
  for (const file of files) {
    let lines;
    try {
      lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let receipt;
      try {
        receipt = JSON.parse(trimmed);
      } catch {
        continue;
      }
      for (const session of Array.isArray(receipt && receipt.sessions) ? receipt.sessions : []) {
        const correlationId = session && session.correlationId;
        const context = session && session.briefingContext;
        if (!correlationId || !context || typeof context !== 'object') continue;
        index.set(String(correlationId), {
          stableBytes: Number(context.stableBytes) || 0,
          deltaBytes: Number(context.dynamicBytes) || 0,
          stableResendReason: context.stableResendReason || null,
          // FIX 5 (2026-09-23, token-tracking-fixes): the same receipt row
          // already carries the repair target and a durable prompt-envelope
          // hash (agentic-healer-driver.js sessionSummary()). That is the one
          // clean, already-written signal this file can join a repeated
          // dispatch against without touching agentic-healer-driver.js or the
          // repair ledger it owns -- see classifyAvoidableHealerRepeats().
          targetCardId: String((session && session.targetCardId) || '').trim(),
          promptEnvelopeHash: String((session && session.promptEnvelopeHash) || '').trim(),
        });
      }
    }
  }
  return index;
}

// Codex review (2026-09-03, deploy gate follow-up on f2ab63192, finding 2):
// model-router.js DOES already define a durable ledger (SHADOW_LEDGER,
// data/agent/model-router-shadow.jsonl, written by recordRouterDecision on
// every decideSpawnModel call). agentic-healer-driver.js's
// fullSessionRouterDecision now receipts the SAME correlation id the healer
// stamps on its prompt (signals.correlationId), so this index can join a
// session to the model/effort/reason the router actually applied for that
// exact dispatch, not just a synthetic "yes we found the marker" receipt.
const ROUTER_LEDGER_REL = path.join('data', 'agent', 'model-router-shadow.jsonl');
// Bound the scan the same way as the healer receipt index: this only needs
// to answer "was this exact correlation id routed recently", never a full
// ledger history query, and the shadow ledger is append-only forever.
const ROUTER_LEDGER_INDEX_MAX_LINES = 20000;

function loadRouterDecisionIndex({ repoRoot } = {}) {
  const index = new Map();
  if (!repoRoot) return index;
  let lines;
  try {
    lines = fs.readFileSync(path.join(repoRoot, ROUTER_LEDGER_REL), 'utf8').split('\n');
  } catch {
    return index;
  }
  for (const line of lines.slice(-ROUTER_LEDGER_INDEX_MAX_LINES)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const correlationId = entry && entry.signals && entry.signals.correlationId;
    const decision = entry && entry.decision;
    if (!correlationId || !decision || typeof decision !== 'object') continue;
    // Last-write-wins: a correlation id should only ever have one router
    // decision (one spawn, one routing call), but if a caller ever retried
    // decideSpawnModel for the same id, the most recent entry (the ledger
    // is append-only in chronological order) is the one that actually
    // governed the spawn that followed it.
    index.set(String(correlationId), {
      model: decision.model || null,
      effort: decision.effort || null,
      reason: decision.reason || null,
      tier: Number.isFinite(Number(decision.tier)) ? Number(decision.tier) : null,
      applied: entry.applied === true,
    });
  }
  return index;
}

function correlateHealerSession(
  promptText,
  fallbackExplanation = 'No model-router decision receipt is correlated to this session. The explorer does not infer an optimal model from prompt prose.',
  correlationIndex = null,
  routerDecisionIndex = null,
) {
  const match = HEALER_SESSION_CORRELATION_MARKER_RE.exec(String(promptText || ''));
  if (!match) {
    return {
      routeReceipt: null,
      routeVerdict: 'unprovable',
      routeExplanation: fallbackExplanation,
    };
  }
  const correlationId = match[1];
  const receiptBytes = correlationIndex instanceof Map ? correlationIndex.get(correlationId) : null;
  const routerDecision =
    routerDecisionIndex instanceof Map ? routerDecisionIndex.get(correlationId) : null;
  // Codex review (2026-09-03, deploy gate follow-up on 081a628d5, finding
  // 3; round-5 follow-up on 5f6db36bd, finding 2): a router entry with
  // applied: false (SECONDBRAIN_MODEL_ROUTER=shadow mode, or a decision
  // routeModel() itself rejected) never actually governed the spawn --
  // decideSpawnModel returns null in that case and the caller inherited
  // whatever model/effort it already had, unrelated to the receipted
  // decision. routeChoice() (token-explorer.js) has no applied check of
  // its own; it treats ANY routeReceipt.decision as authoritative. Only
  // include decision/ruleId here when applied is true, or a shadow-mode
  // rule renders as "optimal"/"sub-optimal" for a choice that never
  // actually happened.
  const appliedDecision = routerDecision && routerDecision.applied === true ? routerDecision : null;
  return {
    // Codex review (2026-09-03, deploy gate follow-up on 081a628d5, finding
    // 3): the joined router decision must live inside routeReceipt.decision
    // (plus a ruleId), because that is the ALREADY-ESTABLISHED contract
    // token-explorer.js's routeChoice() reads (scripts/lib/token-explorer.js).
    // A prior version of this join stored the decision in parallel
    // appliedModel/appliedEffort/appliedReason fields the Explorer never
    // looked at, so a successfully joined decision still rendered
    // "unprovable" there. routeChoice() only needs decision.model,
    // decision.effort, and decision.reason (ruleId is optional, folded into
    // the explanation string when present).
    routeReceipt: {
      correlationId,
      source: 'healer-session-marker',
      ...(appliedDecision
        ? {
            decision: {
              model: appliedDecision.model,
              effort: appliedDecision.effort,
              reason: appliedDecision.reason,
            },
            ruleId: appliedDecision.tier != null ? `tier-${appliedDecision.tier}` : '',
            applied: true,
          }
        : routerDecision
          ? {
              // A router entry WAS found and correlated, but it was not
              // applied (shadow mode or a rejected decision); kept for
              // audit/debugging, but deliberately outside `decision` so
              // routeChoice() cannot mistake it for an authoritative rule.
              shadowDecision: {
                model: routerDecision.model,
                effort: routerDecision.effort,
                reason: routerDecision.reason,
              },
              applied: false,
            }
          : {}),
    },
    routeVerdict: receiptBytes
      ? 'correlated-to-healer-session-with-receipt'
      : 'correlated-to-healer-session',
    routeExplanation: receiptBytes
      ? "Correlated by the healer session id embedded in this session's first user turn, joined against the healer's own durable receipt (data/agent/overnight-agentic-healer-runs) for the stable/delta byte accounting below."
      : "Correlated by the healer session id embedded in this session's first user turn; the healer's durable receipt for that dispatch was not found (not yet written, or older than this index's retention), so stable/delta byte accounting is unavailable for this session.",
    stableBytes: receiptBytes ? receiptBytes.stableBytes : null,
    deltaBytes: receiptBytes ? receiptBytes.deltaBytes : null,
    stableResendReason: receiptBytes ? receiptBytes.stableResendReason : null,
    // FIX 5: carried through to session.meta so classifyAvoidableHealerRepeats()
    // can join repeated dispatches against the same repair target with an
    // unchanged prompt, without a second read of the healer receipt ledger.
    targetCardId: receiptBytes && receiptBytes.targetCardId ? receiptBytes.targetCardId : null,
    promptEnvelopeHash:
      receiptBytes && receiptBytes.promptEnvelopeHash ? receiptBytes.promptEnvelopeHash : null,
  };
}

function boundedPromptRecord(value) {
  let text = String(value || '').trim();
  const taskMarker = '=== TASK PROMPT ===';
  if (text.includes(taskMarker))
    text = text.slice(text.lastIndexOf(taskMarker) + taskMarker.length).trim();
  if (/^<(?:recommended_plugins|environment_context|app-context)>/i.test(text)) text = '';
  const chars = text.length;
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');
  const truncated = chars > TOKEN_EXPLORER_PROMPT_MAX_CHARS;
  return {
    text: truncated ? text.slice(0, TOKEN_EXPLORER_PROMPT_MAX_CHARS) : text,
    chars,
    sha256,
    truncated,
  };
}

function codexPromptText(value) {
  return boundedPromptRecord(value).text;
}

function codexResponseItemRawText(payload = {}) {
  if (payload.type !== 'message' || payload.role !== 'user') return '';
  return (Array.isArray(payload.content) ? payload.content : [])
    .filter((part) => part && /^(?:input_)?text$/.test(String(part.type || '')))
    .map((part) => part.text || '')
    .join('\n');
}

function codexResponseItemText(payload = {}) {
  return codexPromptText(codexResponseItemRawText(payload));
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function emptyUsage() {
  return {
    input: 0,
    cachedInput: 0,
    cacheWrite: 0,
    cacheCreation: 0,
    output: 0,
    reasoningOutput: 0,
    uncached: 0,
    unattributed: 0,
    processed: 0,
  };
}

function addUsage(target, addition) {
  for (const key of Object.keys(emptyUsage())) target[key] += number(addition && addition[key]);
  return target;
}

function usageFromCodexTokenBlock(raw = {}, processedOverride = 0) {
  const input = number(raw.input_tokens);
  const cachedInput = number(raw.cached_input_tokens);
  const cacheWrite = number(raw.cache_write_input_tokens);
  const output = number(raw.output_tokens);
  const rawProcessed = number(raw.total_tokens) || input + output;
  const processed = number(processedOverride) || rawProcessed;
  if (processedOverride && rawProcessed <= 0) {
    return {
      input: 0,
      cachedInput: 0,
      cacheWrite: 0,
      cacheCreation: 0,
      output: 0,
      reasoningOutput: 0,
      uncached: 0,
      unattributed: processed,
      processed,
    };
  }
  if (processedOverride && rawProcessed > 0 && processed !== rawProcessed) {
    const scaledInput = Math.max(
      0,
      Math.min(processed, Math.round((processed * input) / rawProcessed)),
    );
    const scaledOutput = Math.max(0, processed - scaledInput);
    const scaledCached =
      input > 0
        ? Math.max(0, Math.min(scaledInput, Math.round((scaledInput * cachedInput) / input)))
        : 0;
    return {
      input: scaledInput,
      cachedInput: scaledCached,
      cacheWrite: 0,
      cacheCreation: 0,
      output: scaledOutput,
      reasoningOutput:
        output > 0
          ? Math.max(
              0,
              Math.min(
                scaledOutput,
                Math.round((scaledOutput * number(raw.reasoning_output_tokens)) / output),
              ),
            )
          : 0,
      uncached: Math.max(0, processed - scaledCached),
      unattributed: 0,
      processed,
    };
  }
  return {
    input,
    cachedInput,
    cacheWrite,
    cacheCreation: 0,
    output,
    reasoningOutput: number(raw.reasoning_output_tokens),
    uncached: Math.max(0, input - cachedInput) + cacheWrite + output,
    unattributed: 0,
    processed,
  };
}

function scanJsonl(file, visit) {
  const fd = fs.openSync(file, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let carry = '';
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      const text = carry + decoder.write(buffer.subarray(0, bytes));
      const lines = text.split(/\r?\n/);
      carry = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row && typeof row === 'object' && !Array.isArray(row)) visit(row);
        } catch {
          /* a partial/corrupt telemetry line cannot erase the rest of the file */
        }
      }
    }
    carry += decoder.end();
    if (carry.trim()) {
      try {
        const row = JSON.parse(carry);
        if (row && typeof row === 'object' && !Array.isArray(row)) visit(row);
      } catch {
        /* ignore an unfinished final line from an active session */
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function walkJsonl(root, minMtimeMs) {
  const files = [];
  if (!root || !fs.existsSync(root)) return files;
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          if (fs.statSync(file).mtimeMs >= minMtimeMs) files.push(file);
        } catch {
          /* raced with session cleanup */
        }
      }
    }
  }
  return files;
}

function defaultDataDir() {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'secondbrain',
    'data',
  );
}

function defaultOutputPath() {
  return path.join(defaultDataDir(), 'agent', 'token-spend-pareto-latest.json');
}

// The authoritative overnight artifact always lands beside the 24-hour artifact
// in the same agent directory, so the adoption lookup is derived from the output
// path rather than a global default. A caller that redirects its output (a test,
// a bounded verification cut, or the overnight writer itself, which passes no
// output path at all) therefore never reaches into real runtime state.
function defaultOvernightAuthorityDir(outputPath) {
  return outputPath ? path.dirname(path.resolve(outputPath)) : null;
}

// The overnight cut has exactly one authoritative writer:
// scripts/collect-token-spend-overnight.js, which runs on the EC2 briefing host
// at 05:30 CT and measures that host's own session corpus. The 24-hour Pareto
// writer runs on the desktop against a disjoint corpus, so its own re-slice of
// the same wall-clock window is a different measurement, not a second opinion.
// Publishing both produced two irreconcilable overnight totals for one night.
// Here the 24-hour report consumes the authoritative artifact when it is present
// for the same window, and otherwise says plainly that its number is host-local.
function adoptAuthoritativeOvernight({ local, dir, date, corpusHost = '' } = {}) {
  const localWindow = local && local.window ? local.window : null;
  // Re-reconciling an already-adopted block must still report the ORIGINAL local
  // slice, not the authoritative total it previously took on, or the disclosed
  // comparison silently collapses into a tautology.
  const priorLocal = Number(local && local.provenance && local.provenance.localCombinedTokens);
  const localCombinedTokens = Number.isFinite(priorLocal)
    ? priorLocal
    : Number(local && local.combinedTokens) || 0;
  // Every outcome, adopted or refused, names the host whose corpus produced the
  // rendered number. Each host measures only its own sessions, so this number is
  // always a single-host measurement and never a cross-host union. Saying that
  // plainly in the artifact is the only thing stopping a later reader from
  // treating the published overnight total as complete.
  // The local slice belongs to the host whose corpus produced it. Reconcile
  // also runs at render time on EC2, where os.hostname() named the wrong host:
  // on 2026-09-24 the desktop's empty slice was published as the "EC2 corpus".
  const localHost = String(corpusHost || '').trim() || os.hostname();
  const keepLocal = (reason, extra = {}) => ({
    ...local,
    provenance: {
      source: 'local-host-slice',
      reason,
      corpusScope: 'single-host',
      measuredOnHost: localHost,
      renderedNumberFrom: `local host corpus on ${localHost}`,
      localWindow,
      localCombinedTokens,
      ...extra,
    },
  });
  if (!dir) return keepLocal('authoritative-overnight-adoption-disabled');
  const briefingDate = String(date || (local && local.date) || '').slice(0, 10);
  if (!briefingDate) return keepLocal('authoritative-overnight-date-unknown');
  const file = path.join(dir, `token-spend-pareto-overnight-${briefingDate}.json`);
  if (!fs.existsSync(file)) return keepLocal('authoritative-overnight-artifact-missing');
  let authority;
  try {
    authority = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return keepLocal('authoritative-overnight-artifact-unreadable', { path: file });
  }
  if (!authority || authority.schema !== TOKEN_SPEND_PARETO_SCHEMA || !authority.window) {
    return keepLocal('authoritative-overnight-artifact-invalid', { path: file });
  }
  // The authoritative writer makes the overnight window its PRIMARY window, so
  // its top-level totals are the overnight cut. Adopt it for the same night:
  // the same start instant; a shifted start would publish a wrong night. The
  // two ends are never equal because each host cuts at its own collection time
  // (04:30 CT prep on EC2, 04:23 CT on the desktop on 2026-09-24, 10:30Z on a
  // desktop re-render), so exact end equality made every night fall back to
  // the desktop's own zero. The adopted block shows the authority's own
  // window, so its real coverage stays visible.
  const sameNight =
    !!localWindow &&
    authority.window.startsAt === localWindow.startsAt &&
    Number.isFinite(Date.parse(String(authority.window.endsAt || '')));
  if (!sameNight) {
    return keepLocal('authoritative-overnight-window-mismatch', {
      path: file,
      authoritativeWindow: authority.window,
    });
  }
  // Window and schema agreement prove the artifact describes the right night. They
  // do NOT prove it measured the right corpus. The authoritative writer runs on the
  // briefing host, where the overnight work actually executes, so across one window
  // its total is expected to cover at least what any secondary host observed. An
  // authoritative total BELOW the host-local slice means the authority measured a
  // smaller corpus than its own consumer, which is the same defect class this
  // contract exists to catch. Refuse, disclose both totals, and keep the number
  // honest instead of publishing an authoritative-looking figure that understates
  // the night.
  const authoritativeCombinedTokens = Number(authority.combinedTokens) || 0;
  if (authoritativeCombinedTokens < localCombinedTokens) {
    // Sep 29 2026: the PC and the cloud server run different work, so a
    // smaller cloud total is not an undercount of the same corpus. Keep the
    // cloud cut visible beside the local one instead of dropping it (20.0M
    // tokens of cloud video rebuilds disappeared from the report this way).
    return keepLocal('authoritative-overnight-total-below-host-local', {
      path: file,
      authoritativeCombinedTokens,
      authoritativeWindow: authority.window,
      otherHost: {
        measuredOnHost:
          (typeof authority.measuredOnHost === 'string' && authority.measuredOnHost.trim()) ||
          'unrecorded-host',
        combinedTokens: authoritativeCombinedTokens,
        window: authority.window,
        codexTokens: Number(authority.platforms?.codex?.totalTokens) || 0,
        claudeTokens: Number(authority.platforms?.claude?.totalTokens) || 0,
      },
    });
  }
  const authorityHost =
    (typeof authority.measuredOnHost === 'string' && authority.measuredOnHost.trim()) ||
    'unrecorded-host';
  return {
    ...local,
    // The adopted number covers the authority's window, so show that window.
    window: authority.window,
    combinedTokens: authority.combinedTokens,
    platforms: authority.platforms,
    causalInference: authority.causalInference || local.causalInference,
    provenance: {
      source: 'authoritative-overnight-artifact',
      path: file,
      briefingDate,
      authoritativeGeneratedAt: authority.generatedAt || '',
      // The rendered number came from the authoritative host's own sessions only.
      corpusScope: 'single-host',
      measuredOnHost: authorityHost,
      adoptedOnHost: os.hostname(),
      renderedNumberFrom: `authoritative overnight corpus on ${authorityHost}`,
      supersededLocalCombinedTokens: localCombinedTokens,
      localWindow,
      localCombinedTokens,
      // The local host runs different work; keep its slice visible beside the
      // adopted cloud cut rather than replacing it (Codex review 2026-09-29).
      ...(localCombinedTokens > 0 && localHost !== authorityHost
        ? {
            otherHost: {
              measuredOnHost: localHost,
              combinedTokens: localCombinedTokens,
              window: localWindow,
              codexTokens: Number(local?.platforms?.codex?.totalTokens) || 0,
              claudeTokens: Number(local?.platforms?.claude?.totalTokens) || 0,
            },
          }
        : {}),
    },
  };
}

// A cached 24-hour report carries an overnight block that was reconciled against
// whatever authoritative artifact existed at the moment the cache was written.
// Returning that cache unconditionally lets a stale refusal outlive the artifact
// that would have cured it, so for up to a full cache window the overnight cut
// silently bypasses its own single-writer contract. The cache is therefore only
// reusable while its overnight provenance still matches the authority on disk.
function overnightCacheIsStaleAgainstAuthority({ cached, dir } = {}) {
  if (!dir) return false;
  const briefingDate = String((cached && cached.overnight && cached.overnight.date) || '').slice(
    0,
    10,
  );
  if (!briefingDate) return false;
  const file = path.join(dir, `token-spend-pareto-overnight-${briefingDate}.json`);
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return false; // No authority exists, so a cache hit cannot bypass one.
  }
  const provenance = (cached && cached.overnight && cached.overnight.provenance) || {};
  // An authority is on disk now, so any cached cut that did not adopt one is
  // already known-wrong and must be rebuilt rather than served.
  // A retained local slice that already carries the authority beside it is a
  // deliberate two-host cut, valid until the authority is rewritten.
  if (provenance.source !== 'authoritative-overnight-artifact' && !provenance.otherHost) return true;
  // The authority was rewritten after this cache was built, so the cached total is
  // superseded even though it did adopt.
  const generatedMs = Date.parse(String((cached && cached.generatedAt) || ''));
  return !Number.isFinite(generatedMs) || mtimeMs > generatedMs;
}

function assertCanonicalWindow({
  windowMs = DEFAULT_WINDOW_MS,
  hours: explicitHours,
  outputPath,
} = {}) {
  if (!outputPath) return;
  const resolved = path.resolve(outputPath);
  const isCanonicalName = path.basename(resolved) === 'token-spend-pareto-latest.json';
  const isAgentReceipt = path.basename(path.dirname(resolved)).toLowerCase() === 'agent';
  const hours = Number.isFinite(Number(explicitHours))
    ? Number(explicitHours)
    : Math.round((Number(windowMs) / 3600000) * 10) / 10;
  if (isCanonicalName && isAgentReceipt && hours !== 24) {
    throw new Error(
      'The canonical token-spend-pareto-latest.json receipt is fixed at 24 hours. Use a distinct filename for an ad hoc window.',
    );
  }
}

function readCodexTitles(file) {
  const titles = new Map();
  if (!file || !fs.existsSync(file)) return titles;
  scanJsonl(file, (row) => {
    const id = compact(row.id || row.session_id, 120);
    const title = compact(row.title || row.thread_name || row.firstUserMessage, 160);
    if (id && title) titles.set(id, title);
  });
  return titles;
}

// FIX 5 (2026-09-23, token-tracking-fixes): the weekly rollup
// (token-spend-weekly.js's projectTag) already classifies a healer session's
// first-user prompt into its actual repair target instead of the generic
// "Briefing pipeline" bucket. The overnight byProcess breakdown and the
// night-circuit topConsumers list used the coarser processLabel() below for
// every session, including healer sessions, so a night of pure card/metric
// repair rendered as one undifferentiated "Briefing and watcher work" row.
// This is the SAME marker/regex projectTag() uses (agentic-healer-driver.js
// stamps HEALER SESSION CORRELATION ID / WORK UNIT / system_health:<metric>
// into the dynamic prompt bucket); token-spend-weekly.js requires this
// module already, so it now calls this instead of duplicating the regexes.
const HEALER_REPAIR_TARGET_MARKER_RE =
  /HEALER SESSION CORRELATION ID:|You are fixing ONE briefing card|HEALER WORK UNIT|WORK UNIT:/i;

function healerRepairTarget(promptText) {
  const prompt = String(promptText || '');
  if (!HEALER_REPAIR_TARGET_MARKER_RE.test(prompt)) return null;
  const exact = prompt.match(/\bsystem_health:[a-z0-9-]+/i)?.[0]?.toLowerCase();
  if (exact) {
    return exact.endsWith(':measurement-evidence')
      ? 'Card assembly repair: missing measurement roster'
      : `Metric repair: ${exact}`;
  }
  const card = prompt.match(/(?:CARD(?: ID)?|card_id|work.unit)\s*[:=]\s*["']?([a-z][a-z0-9_:-]+)/i)?.[1];
  return `Briefing repair: ${card || 'target unclassified'}`;
}

function processLabel(text, fallback = 'Other work') {
  const source = String(text || '');
  if (/AMY_CALL_ID|VOICE RESPONSE MODE/i.test(source)) {
    return 'Voice and outbound-call work';
  }
  // Sep 29 2026: video rebuild Spine tasks carry origin 'briefing' and their
  // prompts name the briefing dashboard, so 20.0M tokens of video work were
  // reported as briefing work. Match the task identity first.
  if (/Spine task video-(?:regen|build)-|regenerate the (?:video|thumbnail) for video/i.test(source)) {
    return 'Video production';
  }
  if (/overnight|briefing|watch-report|watcher/i.test(source)) return 'Briefing and watcher work';
  if (/otter|transcript|speaker|voiceprint/i.test(source)) return 'Otter and transcript work';
  if (/review|peer[- ]review|adversarial/i.test(source)) return 'Review work';
  if (/ingest|enrichment|gmail|linkedin/i.test(source)) return 'Ingest and enrichment work';
  return fallback;
}

function subscriptionAttemptFromPrompt(prompt) {
  const match = SUBSCRIPTION_ATTEMPT_RE.exec(String(prompt || ''));
  if (!match) return null;
  const attempt = Math.max(1, Number(match[2]) || 1);
  const maxAttempts = Math.max(attempt, Number(match[3]) || attempt);
  return { chainId: match[1], attempt, maxAttempts };
}

// A fallback marker proves that the earlier rung failed and handed forward
// bounded evidence. Its consumed tokens are a candidate minimization target,
// not a billable-spend claim: the collector cannot prove how much partial work
// the second model reused. The report is deliberately observational and never
// controls whether a scheduled job launches.
function classifyAvoidableTokens(platforms) {
  const chains = new Map();
  for (const platform of Object.values(platforms || {})) {
    for (const row of platform?.sessionGraph || []) {
      const attempt = row?.meta?.subscriptionAttempt;
      if (!attempt?.chainId) continue;
      if (!chains.has(attempt.chainId)) chains.set(attempt.chainId, []);
      chains.get(attempt.chainId).push({
        job: row.label,
        platform: row.meta?.platform || '',
        attempt: attempt.attempt,
        tokens: Math.max(0, Number(row.tokens) || 0),
      });
    }
  }
  const jobs = [];
  let candidateAvoidableTokens = 0;
  for (const [chainId, rows] of chains.entries()) {
    const ordered = rows.sort((left, right) => left.attempt - right.attempt);
    const fallbackSeen = ordered.some((row) => row.attempt > 1);
    if (!fallbackSeen) continue;
    const candidates = ordered.filter((row) => row.attempt < Math.max(...ordered.map((row) => row.attempt)));
    const tokens = candidates.reduce((sum, row) => sum + row.tokens, 0);
    candidateAvoidableTokens += tokens;
    jobs.push({
      chainId,
      job: ordered[0].job,
      attempts: ordered.length,
      candidateAvoidableTokens: tokens,
      reason: 'failed primary subscription attempt handed bounded evidence to a fallback',
    });
  }
  return {
    mode: 'observational-candidate',
    candidateAvoidableTokens,
    jobs: jobs.sort(
      (left, right) =>
        right.candidateAvoidableTokens - left.candidateAvoidableTokens || left.job.localeCompare(right.job),
    ),
    note: 'Candidate tokens identify failed primary subscription attempts that triggered a bounded handoff. They are not a cap, gate, invoice, or proof that every token was wasted.',
  };
}

// FIX 5 (2026-09-23, token-tracking-fixes): repeated healer sessions for the
// SAME repair target with a byte-identical dynamic prompt (correlated above
// through targetCardId + promptEnvelopeHash, sourced from the healer's own
// durable receipt ledger via loadHealerReceiptCorrelationIndex) are the
// cleanest "unchanged input" signal already present in the token telemetry
// path. This intentionally does not read the repair ledger's own
// tacticInputHash (that ledger and agentic-healer-driver.js are owned by
// another agent this session must not edit); a session whose receipt lacks
// either field is left out rather than guessed at, and a lone dispatch for a
// target+hash proves nothing so it is never counted.
function classifyAvoidableHealerRepeats(platforms) {
  const groups = new Map();
  for (const platform of Object.values(platforms || {})) {
    for (const row of platform?.sessionGraph || []) {
      const cardId = row?.meta?.targetCardId;
      const hash = row?.meta?.promptEnvelopeHash;
      if (!cardId || !hash) continue;
      const key = `${cardId}::${hash}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        job: row.label,
        platform: row.meta?.platform || '',
        startedAt: row.meta?.startedAt || '',
        tokens: Math.max(0, Number(row.tokens) || 0),
      });
    }
  }
  const jobs = [];
  let candidateAvoidableTokens = 0;
  for (const [key, rows] of groups.entries()) {
    if (rows.length < 2) continue;
    const ordered = [...rows].sort(
      (left, right) => Date.parse(left.startedAt || '') - Date.parse(right.startedAt || ''),
    );
    const repeats = ordered.slice(1);
    const tokens = repeats.reduce((sum, row) => sum + row.tokens, 0);
    if (!tokens) continue;
    candidateAvoidableTokens += tokens;
    const [targetCardId] = key.split('::');
    jobs.push({
      targetCardId,
      job: ordered[0].job,
      attempts: ordered.length,
      candidateAvoidableTokens: tokens,
      reason:
        'repeated healer session for the same repair target with an identical dynamic prompt (promptEnvelopeHash match)',
    });
  }
  return {
    mode: 'observational-candidate',
    candidateAvoidableTokens,
    jobs: jobs.sort(
      (left, right) =>
        right.candidateAvoidableTokens - left.candidateAvoidableTokens ||
        left.targetCardId.localeCompare(right.targetCardId),
    ),
    note:
      'Candidate tokens identify repeated healer sessions on the same repair target whose dynamic prompt (promptEnvelopeHash) did not change between dispatches. Sessions without a correlated targetCardId/promptEnvelopeHash are left out, not assumed avoidable. Not a cap, gate, invoice, or proof every repeat token was wasted.',
  };
}

// Combines the two independent observational candidate-avoidable-token
// signals under the one report field so a reader sees both a failed
// subscription-attempt handoff AND a repeated same-input healer dispatch,
// instead of only the first. Shape stays backward compatible with the prior
// classifyAvoidableTokens() output: mode/candidateAvoidableTokens/jobs/note.
function classifyAllAvoidableTokens(platforms) {
  const subscriptionFallback = classifyAvoidableTokens(platforms);
  const healerRepeats = classifyAvoidableHealerRepeats(platforms);
  return {
    mode: 'observational-candidate',
    candidateAvoidableTokens:
      subscriptionFallback.candidateAvoidableTokens + healerRepeats.candidateAvoidableTokens,
    jobs: [...subscriptionFallback.jobs, ...healerRepeats.jobs].sort(
      (left, right) => right.candidateAvoidableTokens - left.candidateAvoidableTokens,
    ),
    signals: {
      subscriptionFallback: {
        candidateAvoidableTokens: subscriptionFallback.candidateAvoidableTokens,
        note: subscriptionFallback.note,
      },
      healerRepeats: {
        candidateAvoidableTokens: healerRepeats.candidateAvoidableTokens,
        note: healerRepeats.note,
      },
    },
    note:
      'Two independent observational signals combined: a failed primary subscription attempt that handed a bounded fallback, and a repeated healer session on the same repair target with an unchanged dynamic prompt. Neither is a cap, gate, invoice, or proof every counted token was wasted.',
  };
}

function makeAccumulator(key, label, meta = null) {
  return { key, label, usage: emptyUsage(), turns: 0, sessions: new Set(), meta };
}

function addToMap(map, key, label, usage, sessionId) {
  if (!map.has(key)) map.set(key, makeAccumulator(key, label));
  const item = map.get(key);
  addUsage(item.usage, usage);
  item.turns += 1;
  if (sessionId) item.sessions.add(sessionId);
}

function finalizeRows(map, total, limit = 12) {
  return [...map.values()]
    .map((item) => ({
      key: item.key,
      label: item.label,
      tokens: item.usage.processed,
      share: total > 0 ? item.usage.processed / total : 0,
      turns: item.turns,
      sessions: item.sessions.size,
      usage: item.usage,
      ...(item.meta ? { meta: item.meta } : {}),
    }))
    .filter((item) => item.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label))
    .slice(0, limit);
}

function summarizePlatformRecords(records, { accounting = null } = {}) {
  const sessions = new Map();
  const byModelEffort = new Map();
  const byProcess = new Map();
  const byAgentPath = new Map();
  const total = emptyUsage();
  const contributingFiles = new Set();
  for (const record of records) {
    if (record.sourceFile) contributingFiles.add(record.sourceFile);
    if (!sessions.has(record.sessionId)) {
      sessions.set(record.sessionId, makeAccumulator(record.sessionId, record.label));
    }
    const session = sessions.get(record.sessionId);
    addUsage(session.usage, record.usage);
    session.turns += 1;
    session.sessions.add(record.sessionId);
    addUsage(total, record.usage);
    addToMap(
      byModelEffort,
      `${record.model}|${record.effort}`,
      `${record.model} + ${record.effort}`,
      record.usage,
      record.sessionId,
    );
    addToMap(byProcess, record.process, record.process, record.usage, record.sessionId);
    addToMap(byAgentPath, record.agentPath, record.agentPath, record.usage, record.sessionId);
  }
  const result = {
    totalTokens: total.processed,
    turns: [...sessions.values()].reduce((sum, item) => sum + item.turns, 0),
    sessions: sessions.size,
    usage: total,
    topSessions: finalizeRows(sessions, total.processed, 10),
    byProcess: finalizeRows(byProcess, total.processed, 10),
    byAgentPath: finalizeRows(byAgentPath, total.processed, 10),
    byModelEffort: finalizeRows(byModelEffort, total.processed, 12),
    sourceFiles: contributingFiles.size,
  };
  if (accounting) {
    result.accounting = {
      method: 'fork-aware-cumulative-delta-sliced-from-primary-pass',
      componentMethod: accounting.componentMethod,
      correctedTokens: total.processed,
      sourceAccountingScope: 'primary-window',
      uncertaintyNote:
        'The parent-window fork counters below cover the primary report window and may exclude slice-only events when an ad hoc primary window is shorter than the overnight slice. Corrected slice tokens and component splits come from the same fork-aware event pass.',
      componentTelemetryMissingEvents: records.filter(
        (record) => Number(record.usage?.unattributed || 0) > 0,
      ).length,
      unattributedCorrectedTokens: records.reduce(
        (sum, record) => sum + Number(record.usage?.unattributed || 0),
        0,
      ),
      parentWindowUnresolvedForkBoundaries: accounting.unresolvedForkBoundaries,
      parentWindowUnresolvedForkEventsExcluded: accounting.unresolvedForkEventsExcluded,
      parentWindowUnresolvedForkRawLastUsageUpperBound:
        accounting.unresolvedForkRawLastUsageUpperBound,
      parentWindowFileIdentityFallbacks: accounting.fileIdentityFallbacks,
      parentWindowCumulativeResetEvents: accounting.cumulativeResetEvents,
      parentWindowUnattributedCorrectedTokens: accounting.unattributedCorrectedTokens,
    };
  }
  return result;
}

function collectCodex({
  root,
  indexPath,
  startMs,
  endMs,
  scanStartMs = startMs,
  sliceStartMs,
  sliceEndMs,
  pollTurns = null,
  dataDir = defaultDataDir(),
  repoRoot = path.resolve(__dirname, '..', '..'),
}) {
  // Built once per collection pass, not per session: loadHealerReceiptCorrelationIndex
  // and loadRouterDecisionIndex each do their own bounded scan.
  const healerCorrelationIndex = loadHealerReceiptCorrelationIndex({ dataDir });
  const routerDecisionIndex = loadRouterDecisionIndex({ repoRoot });
  const titles = readCodexTitles(indexPath);
  const sessions = new Map();
  const byModelEffort = new Map();
  const byProcess = new Map();
  const byAgentPath = new Map();
  const total = emptyUsage();
  const eventRecords = [];
  const primarySourceFiles = new Set();
  const sessionMetadata = new Map();
  const accounting = {
    method: 'fork-aware-cumulative-delta',
    componentMethod: 'proportional-apportionment-to-cumulative-delta',
    rawLastUsageTokens: 0,
    correctedTokens: 0,
    forkReplayEventsExcluded: 0,
    duplicateCumulativeEventsExcluded: 0,
    cumulativeResetEvents: 0,
    unresolvedForkBoundaries: 0,
    unresolvedForkEventsExcluded: 0,
    unresolvedForkRawLastUsageUpperBound: 0,
    fileIdentityFallbacks: 0,
    componentTelemetryMissingEvents: 0,
    unattributedCorrectedTokens: 0,
  };

  for (const file of walkJsonl(root, scanStartMs)) {
    let sessionId = path.basename(file, '.jsonl');
    let model = 'unknown';
    let effort = 'unknown';
    let agentPath = TOKEN_REPORT_AGENT_PATH_LABELS.codexOther;
    let firstUser = '';
    const userRows = [];
    const tokenEvents = [];
    let rowIndex = -1;
    let firstMeta = null;
    let lastForeignMetaIndex = -1;
    const taskStartedRows = [];
    // Poll-turn telemetry rides the scan that is already happening, but it
    // cannot be SCORED until the fork boundary and the window are known: a
    // recently touched rollout carries out-of-window history, and a forked file
    // replays the parent's turns. Buffer only the rows the accumulator needs.
    const pollRows = [];
    scanJsonl(file, (row) => {
      rowIndex += 1;
      if (pollTurns && isPollTelemetryRow(row)) {
        pollRows.push({ rowIndex, ts: Date.parse(String(row.timestamp || row.ts || '')), row });
      }
      const ts = Date.parse(String(row.timestamp || row.ts || ''));
      if (row.type === 'session_meta' && row.payload) {
        const forkLikeMeta = Boolean(
          row.payload.forked_from_id ||
          row.payload.parent_thread_id ||
          /subagent/i.test(JSON.stringify(row.payload.thread_source || row.payload.source || '')),
        );
        const metaIdentity = compact(
          row.payload.id ||
            (forkLikeMeta ? path.basename(file, '.jsonl') : row.payload.session_id) ||
            '',
          120,
        );
        if (!firstMeta) {
          firstMeta = { ...row.payload, rowIndex, identity: metaIdentity || sessionId };
          if (forkLikeMeta && !row.payload.id) accounting.fileIdentityFallbacks += 1;
          sessionId = firstMeta.identity;
          const source = JSON.stringify(row.payload.thread_source || row.payload.source || '');
          if (/subagent/i.test(source)) agentPath = TOKEN_REPORT_AGENT_PATH_LABELS.codexHelper;
          else if (/codex_app/i.test(String(row.payload.originator || ''))) {
            agentPath = TOKEN_REPORT_AGENT_PATH_LABELS.codexInteractive;
          } else if (/exec|cli/i.test(String(row.payload.originator || row.payload.source || ''))) {
            agentPath = TOKEN_REPORT_AGENT_PATH_LABELS.codexAutomated;
          }
        } else if (metaIdentity && metaIdentity !== firstMeta.identity) {
          lastForeignMetaIndex = rowIndex;
        }
      }
      if (row.type === 'turn_context' && row.payload) {
        model = compact(row.payload.model || model, 100) || model;
        effort = compact(row.payload.effort || effort, 40) || effort;
      }
      if (row.type === 'event_msg' && row.payload?.type === 'task_started') {
        taskStartedRows.push({ rowIndex, turnId: compact(row.payload.turn_id || '', 120) });
      }
      if (row.type === 'event_msg' && row.payload?.type === 'user_message') {
        const prompt = boundedPromptRecord(row.payload.message || '');
        if (prompt.text) userRows.push({ rowIndex, prompt });
      }
      if (row.type === 'response_item') {
        const prompt = boundedPromptRecord(codexResponseItemRawText(row.payload));
        if (prompt.text) userRows.push({ rowIndex, prompt });
      }
      if (row.type !== 'event_msg' || row.payload?.type !== 'token_count' || !Number.isFinite(ts)) {
        return;
      }
      const info = row.payload?.info || {};
      const raw = info.last_token_usage || {};
      tokenEvents.push({
        rowIndex,
        ts,
        raw,
        cumulativeTotal: number(info.total_token_usage?.total_tokens),
        model,
        effort,
      });
    });
    const isFork = Boolean(
      firstMeta &&
      (firstMeta.forked_from_id ||
        firstMeta.parent_thread_id ||
        (firstMeta.session_id && firstMeta.id && firstMeta.session_id !== firstMeta.id) ||
        /subagent/i.test(JSON.stringify(firstMeta.thread_source || firstMeta.source || ''))),
    );
    const childUuidPrefix = String(sessionId || '').split('-')[0];
    const childStart = isFork
      ? taskStartedRows.find(
          (item) =>
            item.rowIndex > lastForeignMetaIndex &&
            childUuidPrefix &&
            item.turnId.startsWith(childUuidPrefix),
        )
      : null;
    const unresolvedForkBoundary = isFork && !childStart;
    if (unresolvedForkBoundary) accounting.unresolvedForkBoundaries += 1;
    const liveBoundaryRow = isFork ? (childStart?.rowIndex ?? -1) : -1;
    const firstPrompt =
      (isFork
        ? userRows.find((row) => row.rowIndex > liveBoundaryRow)?.prompt
        : userRows[0]?.prompt) || boundedPromptRecord('');
    firstUser = firstPrompt.text;
    if (pollTurns) {
      // An unresolved fork boundary means we cannot tell which turns are this
      // child's, exactly as the token accounting concludes, so none are scored.
      if (!unresolvedForkBoundary) {
        let lastTs = NaN;
        for (const item of pollRows) {
          const effectiveTs = Number.isFinite(item.ts) ? item.ts : lastTs;
          if (Number.isFinite(item.ts)) lastTs = item.ts;
          if (isFork && item.rowIndex <= liveBoundaryRow) continue;
          if (Number.isFinite(effectiveTs) && (effectiveTs < scanStartMs || effectiveTs > endMs))
            continue;
          pollTurns.observeCodexRow(file, item.row);
        }
      }
      pollTurns.label(file, sessionId);
    }
    let previousCumulative = 0;
    const correctedEvents = [];
    for (const event of tokenEvents) {
      const rawUsage = usageFromCodexTokenBlock(event.raw);
      if (event.ts >= startMs && event.ts <= endMs) {
        accounting.rawLastUsageTokens += rawUsage.processed;
      }
      const priorCumulative = previousCumulative;
      if (event.cumulativeTotal > 0) previousCumulative = event.cumulativeTotal;
      if (unresolvedForkBoundary) {
        if (event.ts >= startMs && event.ts <= endMs) {
          accounting.unresolvedForkEventsExcluded += 1;
          accounting.unresolvedForkRawLastUsageUpperBound += rawUsage.processed;
        }
        continue;
      }
      const beforeForkLiveBoundary = isFork && event.rowIndex <= liveBoundaryRow;
      if (beforeForkLiveBoundary) {
        if (event.ts >= startMs && event.ts <= endMs) accounting.forkReplayEventsExcluded += 1;
        continue;
      }
      if (event.ts < scanStartMs || event.ts > endMs) continue;
      let processed = rawUsage.processed;
      if (event.cumulativeTotal > 0 && priorCumulative > 0) {
        if (event.cumulativeTotal === priorCumulative) {
          if (isFork) accounting.forkReplayEventsExcluded += 1;
          else accounting.duplicateCumulativeEventsExcluded += 1;
          continue;
        }
        if (event.cumulativeTotal > priorCumulative) {
          processed = event.cumulativeTotal - priorCumulative;
        } else if (event.ts >= startMs) {
          accounting.cumulativeResetEvents += 1;
        }
      }
      if (!processed) continue;
      const correctedUsage = usageFromCodexTokenBlock(event.raw, processed);
      if (event.ts >= startMs && correctedUsage.unattributed > 0) {
        accounting.componentTelemetryMissingEvents += 1;
        accounting.unattributedCorrectedTokens += correctedUsage.unattributed;
      }
      correctedEvents.push({
        ts: event.ts,
        sourceFile: file,
        usage: correctedUsage,
        model: event.model,
        effort: event.effort,
      });
    }
    if (!correctedEvents.length) continue;
    const threadSpawn = firstMeta?.source?.subagent?.thread_spawn || {};
    const parentSessionId = compact(
      firstMeta?.forked_from_id ||
        firstMeta?.parent_thread_id ||
        threadSpawn.parent_thread_id ||
        '',
      120,
    );
    const depthValue = Number(threadSpawn.depth);
    const sessionMeta = {
      platform: 'codex',
      sessionId,
      parentSessionId,
      depth: Number.isInteger(depthValue) && depthValue >= 0 ? depthValue : parentSessionId ? 1 : 0,
      agentPath: compact(threadSpawn.agent_path || firstMeta?.agent_path || '', 180),
      agentName: compact(threadSpawn.agent_nickname || firstMeta?.agent_nickname || '', 100),
      prompt: firstUser,
      promptChars: firstPrompt.chars,
      promptSha256: firstPrompt.sha256,
      promptTruncated: firstPrompt.truncated,
      subscriptionAttempt: subscriptionAttemptFromPrompt(firstUser),
      startedAt: new Date(Math.min(...correctedEvents.map((event) => event.ts))).toISOString(),
      endedAt: new Date(Math.max(...correctedEvents.map((event) => event.ts))).toISOString(),
      model: compact(correctedEvents.at(-1)?.model || model, 100),
      effort: compact(correctedEvents.at(-1)?.effort || effort, 40),
      ...correlateHealerSession(
        firstUser,
        'No model-router decision receipt is correlated to this session. The explorer does not infer an optimal model from prompt prose.',
        healerCorrelationIndex,
        routerDecisionIndex,
      ),
    };
    const title = sanitizeTokenReportLabel(
      titles.get(sessionId) || `Codex task ${sessionId.slice(0, 8)}`,
    );
    // FIX 5: a healer-marked prompt classifies to its actual repair target
    // ("Metric repair: system_health:<x>" / "Briefing repair: <card>") before
    // falling back to the generic keyword bucket, so overnight byProcess and
    // topConsumers stop folding every card/metric repair into one row.
    const process = healerRepairTarget(firstUser) || processLabel(`${title} ${firstUser}`);
    sessionMeta.process = process;
    sessionMetadata.set(sessionId, sessionMeta);
    for (const event of correctedEvents) {
      eventRecords.push({
        ts: event.ts,
        sourceFile: event.sourceFile,
        sessionId,
        label: title,
        process,
        agentPath,
        model: event.model,
        effort: event.effort,
        usage: event.usage,
      });
      if (event.ts < startMs || event.ts > endMs) continue;
      primarySourceFiles.add(event.sourceFile);
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, makeAccumulator(sessionId, title, sessionMetadata.get(sessionId)));
      }
      const session = sessions.get(sessionId);
      addUsage(session.usage, event.usage);
      session.turns += 1;
      session.sessions.add(sessionId);
      addUsage(total, event.usage);
      addToMap(
        byModelEffort,
        `${event.model}|${event.effort}`,
        `${event.model} + ${event.effort}`,
        event.usage,
        sessionId,
      );
      addToMap(byProcess, process, process, event.usage, sessionId);
      addToMap(byAgentPath, agentPath, agentPath, event.usage, sessionId);
    }
  }
  accounting.correctedTokens = total.processed;
  const result = {
    totalTokens: total.processed,
    turns: [...sessions.values()].reduce((sum, item) => sum + item.turns, 0),
    sessions: sessions.size,
    usage: total,
    topSessions: finalizeRows(sessions, total.processed, 10),
    // Token Explorer is an attribution surface, not a Pareto ranking. Keep
    // every measured generation so a low-token child cannot disappear and
    // turn its descendants into false roots.
    sessionGraph: finalizeRows(sessions, total.processed, sessions.size),
    recentRootPrompts: finalizeRows(sessions, total.processed, sessions.size)
      .filter((row) => !row.meta?.parentSessionId)
      .sort(
        (left, right) =>
          Date.parse(String(right.meta?.startedAt || '')) -
          Date.parse(String(left.meta?.startedAt || '')),
      )
      .slice(0, 50),
    byProcess: finalizeRows(byProcess, total.processed, 10),
    byAgentPath: finalizeRows(byAgentPath, total.processed, 10),
    byModelEffort: finalizeRows(byModelEffort, total.processed, 12),
    sourceFiles: primarySourceFiles.size,
    accounting,
  };
  if (Number.isFinite(sliceStartMs) && Number.isFinite(sliceEndMs)) {
    result.slice = summarizePlatformRecords(
      eventRecords.filter((event) => event.ts >= sliceStartMs && event.ts <= sliceEndMs),
      { accounting },
    );
  }
  return result;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : '',
    )
    .join('\n');
}

function collectClaude({
  root,
  startMs,
  endMs,
  scanStartMs = startMs,
  sliceStartMs,
  sliceEndMs,
  pollTurns = null,
  dataDir = defaultDataDir(),
  repoRoot = path.resolve(__dirname, '..', '..'),
}) {
  const healerCorrelationIndex = loadHealerReceiptCorrelationIndex({ dataDir });
  const routerDecisionIndex = loadRouterDecisionIndex({ repoRoot });
  const sessions = new Map();
  const byModelEffort = new Map();
  const byProcess = new Map();
  const byAgentPath = new Map();
  const total = emptyUsage();
  const messageEvents = new Map();
  const sessionMetadata = new Map();
  const eventRecords = [];
  const primarySourceFiles = new Set();

  for (const file of walkJsonl(root, scanStartMs)) {
    const fileIdentity = path.basename(file, '.jsonl');
    let sessionId = `claude:${fileIdentity}`;
    let reportedSessionId = '';
    let agentId = '';
    let agentName = '';
    let firstPrompt = boundedPromptRecord('');
    let cwd = '';
    let title = '';
    const skills = new Set();
    const ownerCommands = new Set();
    let laterPrompts = '';
    let sidechain = /[\\/]subagents[\\/]/i.test(file);
    const pollRows = [];
    scanJsonl(file, (row) => {
      if (pollTurns && row && row.type === 'assistant' && row.message) {
        pollRows.push({ ts: Date.parse(String(row.timestamp || '')), row });
      }
      reportedSessionId = compact(row.sessionId || reportedSessionId, 120);
      agentId = compact(row.agentId || agentId, 120);
      agentName = compact(row.attributionAgent || agentName, 100);
      cwd = compact(row.cwd || cwd, 260);
      sidechain = sidechain || row.isSidechain === true;
      sessionId =
        sidechain && agentId
          ? `claude-agent:${agentId}`
          : `claude:${reportedSessionId || fileIdentity}`;
      if (row.type === 'custom-title' && row.customTitle) title = compact(row.customTitle, 160);
      else if (row.type === 'ai-title' && row.aiTitle && !title) title = compact(row.aiTitle, 160);
      if (row.type === 'user') {
        const userText = textFromContent(row.message?.content);
        const skill = skillFromMetaPrompt(userText);
        if (skill) skills.add(skill);
        else if (!row.isMeta && firstPrompt.text && userText && !/^\s*(?:<task-notification>|\[SYSTEM NOTIFICATION|\[Image)/.test(userText)) {
          const command = ownerCommand(userText);
          if (command) ownerCommands.add(command);
          if (laterPrompts.length < 4000) laterPrompts += ` ${userText.slice(0, 1000)}`;
        }
      }
      if (!firstPrompt.text && row.type === 'user') {
        firstPrompt = boundedPromptRecord(textFromContent(row.message?.content));
        const command = ownerCommand(firstPrompt.text);
        if (command) ownerCommands.add(command);
      }
      if (row.type !== 'assistant' || !row.message?.usage) return;
      const ts = Date.parse(String(row.timestamp || ''));
      if (!Number.isFinite(ts) || ts < scanStartMs || ts > endMs) return;
      const messageId = compact(row.message.id || row.requestId || row.uuid, 180);
      const dedupeKey = messageId || `${ts}:${JSON.stringify(row.message.usage)}`;
      if (messageEvents.has(dedupeKey)) return;
      const raw = row.message.usage;
      const usage = {
        input: number(raw.input_tokens),
        cachedInput: 0,
        cacheWrite: 0,
        cacheCreation: number(raw.cache_creation_input_tokens),
        output: number(raw.output_tokens),
        reasoningOutput: 0,
        uncached:
          number(raw.input_tokens) +
          number(raw.cache_creation_input_tokens) +
          number(raw.output_tokens),
        processed:
          number(raw.input_tokens) +
          number(raw.cache_creation_input_tokens) +
          number(raw.cache_read_input_tokens) +
          number(raw.output_tokens),
      };
      usage.cachedInput = number(raw.cache_read_input_tokens);
      const model = compact(row.message.model || 'unknown', 100);
      const effort = compact(row.effort || 'not exposed', 40);
      messageEvents.set(dedupeKey, { sessionId, usage, model, effort, ts, sourceFile: file });
    });
    if (pollTurns) {
      // Same rule as Codex: a session file touched inside the scan window still
      // holds turns from days outside it, and those turns are not this window's
      // supervision behaviour.
      let lastTs = NaN;
      for (const item of pollRows) {
        const effectiveTs = Number.isFinite(item.ts) ? item.ts : lastTs;
        if (Number.isFinite(item.ts)) lastTs = item.ts;
        if (Number.isFinite(effectiveTs) && (effectiveTs < scanStartMs || effectiveTs > endMs))
          continue;
        pollTurns.observeClaudeRow(file, item.row);
      }
      pollTurns.label(file, sessionId);
    }
    const existing = sessionMetadata.get(sessionId) || {};
    const parentSessionId = sidechain && reportedSessionId ? `claude:${reportedSessionId}` : '';
    sessionMetadata.set(sessionId, {
      cwd: existing.cwd || cwd,
      firstUser: existing.firstUser || firstPrompt.text,
      promptChars: existing.promptChars || firstPrompt.chars,
      promptSha256: existing.promptSha256 || firstPrompt.sha256,
      promptTruncated: Boolean(existing.promptTruncated || firstPrompt.truncated),
      sidechain: Boolean(existing.sidechain || sidechain),
      parentSessionId: existing.parentSessionId || parentSessionId,
      depth: Math.max(Number(existing.depth || 0), parentSessionId ? 1 : 0),
      agentId: existing.agentId || agentId,
      agentName: existing.agentName || agentName,
      // Classification signals only: the title and later-prompt digest are
      // reduced to categories here so no raw owner text beyond the first
      // prompt persists in token receipts.
      titleClass: existing.titleClass || classifyText(title),
      skills: [...new Set([...(existing.skills || []), ...skills])],
      ownerCommands: [...new Set([...(existing.ownerCommands || []), ...ownerCommands])],
      laterPromptClass: existing.laterPromptClass || classifyText(laterPrompts.slice(0, 4000)),
    });
  }
  const refinedProcessBySession = new Map();
  for (const event of messageEvents.values()) {
    const sessionId = event.sessionId;
    const metadata = sessionMetadata.get(sessionId) || {};
    // FIX 5: same healer-target-first classification as the Codex collector
    // above, so a healer session's process/label and topConsumers entry name
    // its actual repair target instead of the generic keyword bucket.
    const legacyProcess =
      healerRepairTarget(metadata.firstUser || '') ||
      processLabel(`${metadata.cwd || ''} ${metadata.firstUser || ''}`);
    // Only the generic Other-work bar is refined, once per session: the event
    // loop runs per assistant turn, and the EC2 weekly collector has a 45 s
    // budget. The session label keeps the legacy wording so weekly
    // projectTag() is unchanged for classified rows.
    let process = legacyProcess;
    if (legacyProcess === 'Other work') {
      if (!refinedProcessBySession.has(sessionId)) {
        const workClass = refineUnclassified({ ...metadata, prompt: metadata.firstUser || '' }).project;
        refinedProcessBySession.set(
          sessionId,
          workClass !== 'Unclassified work' ? PROCESS_NAME_FOR_WORK_CLASS[workClass] || workClass : legacyProcess,
        );
      }
      process = refinedProcessBySession.get(sessionId);
    }
    const agentPath = metadata.sidechain
      ? TOKEN_REPORT_AGENT_PATH_LABELS.claudeHelper
      : /claude-proxy-runtime|sb-runtime|appdata|background/i.test(metadata.cwd || '')
        ? TOKEN_REPORT_AGENT_PATH_LABELS.claudeAutomated
        : TOKEN_REPORT_AGENT_PATH_LABELS.claudeInteractive;
    const label = `${legacyProcess} (${sessionId.replace(/^claude(?:-agent)?:/, '').slice(0, 8)})`;
    eventRecords.push({
      ts: event.ts,
      sourceFile: event.sourceFile,
      sessionId,
      label,
      process,
      agentPath,
      model: event.model,
      effort: event.effort,
      usage: event.usage,
    });
    if (event.ts < startMs || event.ts > endMs) continue;
    primarySourceFiles.add(event.sourceFile);
    if (!sessions.has(sessionId)) {
      sessions.set(
        sessionId,
        makeAccumulator(sessionId, label, {
          platform: 'claude',
          sessionId,
          process,
          parentSessionId: metadata.parentSessionId || '',
          depth: Number(metadata.depth || 0),
          agentPath: metadata.sidechain
            ? `/claude/${metadata.agentId || sessionId.replace(/^claude-agent:/, '')}`
            : '',
          agentName: metadata.agentName || '',
          cwd: metadata.cwd || '',
          titleClass: metadata.titleClass || '',
          skills: metadata.skills || [],
          ownerCommands: metadata.ownerCommands || [],
          laterPromptClass: metadata.laterPromptClass || '',
          prompt: metadata.firstUser || '',
          promptChars: Number(metadata.promptChars || 0),
          promptSha256: metadata.promptSha256 || '',
          promptTruncated: Boolean(metadata.promptTruncated),
          subscriptionAttempt: subscriptionAttemptFromPrompt(metadata.firstUser),
          startedAt: new Date(event.ts).toISOString(),
          endedAt: new Date(event.ts).toISOString(),
          model: event.model,
          effort: event.effort,
          ...correlateHealerSession(
            metadata.firstUser,
            'Claude recorded the actual model and effort, but no routing-decision receipt is correlated to this generation.',
            healerCorrelationIndex,
            routerDecisionIndex,
          ),
        }),
      );
    }
    const session = sessions.get(sessionId);
    addUsage(session.usage, event.usage);
    session.turns += 1;
    session.sessions.add(sessionId);
    if (session.meta) {
      session.meta.endedAt = new Date(event.ts).toISOString();
      session.meta.model = event.model;
      session.meta.effort = event.effort;
    }
    addUsage(total, event.usage);
    addToMap(
      byModelEffort,
      `${event.model}|${event.effort}`,
      `${event.model} + ${event.effort}`,
      event.usage,
      sessionId,
    );
    addToMap(byProcess, process, process, event.usage, sessionId);
    addToMap(byAgentPath, agentPath, agentPath, event.usage, sessionId);
  }
  const result = {
    totalTokens: total.processed,
    turns: [...sessions.values()].reduce((sum, item) => sum + item.turns, 0),
    sessions: sessions.size,
    usage: total,
    topSessions: finalizeRows(sessions, total.processed, 10),
    sessionGraph: finalizeRows(sessions, total.processed, sessions.size),
    recentRootPrompts: finalizeRows(sessions, total.processed, sessions.size)
      .filter((row) => !row.meta?.parentSessionId)
      .sort(
        (left, right) =>
          Date.parse(String(right.meta?.startedAt || '')) -
          Date.parse(String(left.meta?.startedAt || '')),
      )
      .slice(0, 50),
    byProcess: finalizeRows(byProcess, total.processed, 10),
    byAgentPath: finalizeRows(byAgentPath, total.processed, 10),
    byModelEffort: finalizeRows(byModelEffort, total.processed, 12),
    sourceFiles: primarySourceFiles.size,
  };
  if (Number.isFinite(sliceStartMs) && Number.isFinite(sliceEndMs)) {
    result.slice = summarizePlatformRecords(
      eventRecords.filter((event) => event.ts >= sliceStartMs && event.ts <= sliceEndMs),
    );
  }
  return result;
}

function causalProcessLabel(process) {
  if (process === 'vapi-voice') return 'Phone reply lane';
  if (process === 'openai-compatible-claude-proxy') return 'Legacy compatibility lane';
  return sanitizeTokenReportLabel(
    process || 'Other instrumented inference',
    'Other instrumented inference',
  );
}

// Tokens by card or job from the model-call rung ledger (ask-ai-rungs.jsonl).
// Each row that carries measured tokens is grouped under its card, then job,
// then surface; a legacy row with none of those is "unknown" and counts as
// unattributed. attributableShare divides by the window's measured total, so
// calls that never reported tokens (direct CLI spawns) show as the gap.
function defaultRungLedgerFile(repoRoot) {
  return (
    process.env.ASK_AI_RUNGS_FILE ||
    path.join(repoRoot || path.resolve(__dirname, '..', '..'), 'data', 'agent', 'ask-ai-rungs.jsonl')
  );
}

function collectModelCallLedger({ file, startMs, endMs, totalTokens = 0 }) {
  const jobs = new Map();
  let taggedTokens = 0;
  let attributedTokens = 0;
  let tokenedCalls = 0;
  let untokenedCalls = 0;
  if (file && fs.existsSync(file)) {
    scanJsonl(file, (row) => {
      if (!row.rung || row.budgetWarning || row.brainSwitch || row.retry) return;
      const ts = Date.parse(String(row.ts || ''));
      if (!Number.isFinite(ts) || ts < startMs || ts > endMs) return;
      const tokens = number(row.processedTokens);
      if (!(tokens > 0)) {
        if (row.outcome === 'answered') untokenedCalls += 1;
        return;
      }
      tokenedCalls += 1;
      taggedTokens += tokens;
      const key = compact(row.card || row.job || row.surface || 'unknown', 120);
      if (key !== 'unknown') attributedTokens += tokens;
      if (!jobs.has(key)) jobs.set(key, { key, label: sanitizeTokenReportLabel(key, 'Unknown job'), calls: 0, tokens: 0 });
      const target = jobs.get(key);
      target.calls += 1;
      target.tokens += tokens;
    });
  }
  const denominator = Math.max(number(totalTokens), taggedTokens);
  return {
    tokenedCalls,
    untokenedCalls,
    taggedTokens,
    attributedTokens,
    attributableShare: denominator > 0 ? Math.round((attributedTokens / denominator) * 1000) / 1000 : 0,
    byJob: [...jobs.values()]
      .map((row) => ({ ...row, share: denominator > 0 ? row.tokens / denominator : 0 }))
      .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label)),
  };
}

function collectInferenceLedger({ file, startMs, endMs, rungLedgerFile = null, totalTokens = 0 }) {
  const settled = new Map();
  if (file && fs.existsSync(file)) {
    scanJsonl(file, (row) => {
      if (row.schema !== 'inference-work-event.v1' || row.event !== 'settled') return;
      const ts = Date.parse(String(row.ts || ''));
      if (!Number.isFinite(ts) || ts < startMs || ts > endMs || !row.inferenceId) return;
      settled.set(String(row.inferenceId), row);
    });
  }
  const byProcess = new Map();
  let attributedInferences = 0;
  let unattributedInferences = 0;
  let processedTokens = 0;
  for (const row of settled.values()) {
    const process = compact(row.process || 'unknown', 100);
    const attributed = !String(row.rootWorkId || '').includes('unattributed-');
    const rowTokens =
      number(row.processedTokens) || number(row.inputTokens) + number(row.outputTokens);
    processedTokens += rowTokens;
    if (attributed) attributedInferences += 1;
    else unattributedInferences += 1;
    if (!byProcess.has(process)) {
      byProcess.set(process, {
        key: process,
        label: causalProcessLabel(process),
        inferences: 0,
        attributedInferences: 0,
        unattributedInferences: 0,
        tokens: 0,
      });
    }
    const target = byProcess.get(process);
    target.inferences += 1;
    target.attributedInferences += attributed ? 1 : 0;
    target.unattributedInferences += attributed ? 0 : 1;
    target.tokens += rowTokens;
  }
  return {
    settledInferences: settled.size,
    attributedInferences,
    unattributedInferences,
    processedTokens,
    byProcess: [...byProcess.values()].sort(
      (a, b) => b.inferences - a.inferences || a.label.localeCompare(b.label),
    ),
    ...(rungLedgerFile
      ? { modelCalls: collectModelCallLedger({ file: rungLedgerFile, startMs, endMs, totalTokens }) }
      : {}),
  };
}

function sourceIncludes(file, pattern) {
  try {
    return pattern.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

function controlStatus(repoRoot) {
  const proxy = path.join(repoRoot, 'claude-proxy.js');
  const watcher = path.join(repoRoot, 'scripts', 'overnight-watcher-launcher.js');
  const exporter = path.join(repoRoot, 'scripts', 'export-codex-thread-index.js');
  const askAi = path.join(repoRoot, 'scripts', 'lib', 'ask-ai.js');
  const helperPolicy = path.join(repoRoot, 'memory', 'feedback_bounded_helper_context.md');
  const pareto = path.join(repoRoot, 'scripts', 'lib', 'token-spend-pareto.js');
  const tests = {
    accounting: path.join(repoRoot, 'scripts', '__tests__', 'token-spend-pareto.test.js'),
    watcher: path.join(repoRoot, 'scripts', '__tests__', 'overnight-watcher-launcher.test.js'),
    helpers: path.join(repoRoot, 'scripts', '__tests__', 'bounded-helper-context-policy.test.js'),
    outcome: path.join(repoRoot, 'scripts', '__tests__', 'codex-thread-index-export.test.js'),
    canary: path.join(repoRoot, 'scripts', '__tests__', 'claude-health-canary.test.js'),
    effort: path.join(repoRoot, 'scripts', '__tests__', 'model-effort-policy.test.js'),
    continuation: path.join(repoRoot, 'scripts', '__tests__', 'inference-continuation.test.js'),
  };
  return {
    forkAwareAccounting:
      sourceIncludes(pareto, /fork-aware-cumulative-delta/) &&
      sourceIncludes(pareto, /forkReplayEventsExcluded/) &&
      sourceIncludes(tests.accounting, /fork-aware-cumulative-delta/),
    modelFreeWatcher:
      sourceIncludes(watcher, /watcherEvidenceFingerprint/) &&
      sourceIncludes(watcher, /unchanged-no-inference/) &&
      sourceIncludes(watcher, /MAX_EVENT_SESSION_MS/) &&
      sourceIncludes(tests.watcher, /model-free unchanged-state attendance/i),
    boundedHelpers:
      sourceIncludes(helperPolicy, /fresh isolated context/i) &&
      sourceIncludes(tests.helpers, /fresh one-shot helper work/i),
    oneOutcomeTask:
      sourceIncludes(exporter, /outcomeKeyForCodexSession/) &&
      sourceIncludes(exporter, /spine-outcome-/) &&
      sourceIncludes(tests.outcome, /one outcome key/i),
    isolatedHealthCanary:
      sourceIncludes(proxy, /buildClaudeHealthCanary/) &&
      sourceIncludes(proxy, /classifyClaudeHealthCanaryOutput/) &&
      sourceIncludes(tests.canary, /isolated low-effort response/i),
    phaseEffort:
      sourceIncludes(askAi, /resolveModelEffort/) &&
      sourceIncludes(watcher, /model_reasoning_effort="low"/) &&
      sourceIncludes(tests.effort, /bounded phase model effort policy/i),
    evidenceContinuation:
      sourceIncludes(watcher, /admitInferenceContinuation/) &&
      sourceIncludes(watcher, /changed-watcher-evidence/) &&
      sourceIncludes(tests.continuation, /evidence-based inference continuation/i),
  };
}

function hasVerifiedAmySelfCall(dataDir) {
  const dir = path.join(dataDir || defaultDataDir(), 'agent');
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((name) => /^vapi-self-call-inference-proof-.+\.json$/i.test(name))
      .map((name) => path.join(dir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {
    return false;
  }
  for (const file of files.slice(0, 10)) {
    try {
      const proof = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (
        proof.schema === 'amy.vapi_self_call_inference_proof.v1' &&
        proof.ok === true &&
        Number(proof.voiceInferences || 0) > 0 &&
        Number(proof.legacyEvents || 0) === 0 &&
        Array.isArray(proof.callIds) &&
        proof.callIds.length >= 2 &&
        Array.isArray(proof.observedToolNames) &&
        proof.observedToolNames.includes('check_spine')
      ) {
        return true;
      }
    } catch {
      /* an invalid acceptance artifact cannot certify the control */
    }
  }
  return false;
}

function readTokenControlDecisions(
  repoRoot,
  file = path.join(repoRoot, 'config', 'briefing-token-control-decisions.json'),
) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed?.schema === 'secondbrain.briefing-token-control-decisions.v1' &&
      parsed.controls &&
      typeof parsed.controls === 'object'
      ? parsed.controls
      : {};
  } catch {
    return {};
  }
}

function selectTopTokenControls(controls, ownerDecisions = {}) {
  const limit = 5;
  const eligible = (Array.isArray(controls) ? controls : [])
    .map((control) => {
      const ownerDecision = ownerDecisions[control.stableId] || null;
      const decision = String(ownerDecision?.decision || '')
        .trim()
        .toLowerCase();
      if (decision === 'skipped') return null;
      return {
        ...control,
        status: decision === 're-queued-with-errors' ? 're-queued-with-errors' : control.status,
        ownerDecision,
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) => number(right.impactScore) - number(left.impactScore) || left.id - right.id,
    );
  if (eligible.length < limit) {
    throw new Error(
      `token control pool has ${eligible.length} eligible improvements after owner decisions; exactly five are required`,
    );
  }
  return eligible.slice(0, limit).map((control, index) => ({
    ...control,
    currentRank: index + 1,
  }));
}

function controlsFor(
  report,
  repoRoot,
  dataDir,
  watcherAutomation = readAttendedWatcherAutomation(),
) {
  const status = controlStatus(repoRoot);
  const codexTop = report.platforms.codex.topSessions[0];
  const watcherSession = watcherAutomation?.threadId
    ? report.platforms.codex.topSessions.find(
        (item) => String(item.key || '') === String(watcherAutomation.threadId),
      )
    : null;
  const watcherBridgeImplemented =
    status.modelFreeWatcher &&
    fs.existsSync(path.join(repoRoot, 'scripts', 'attended-briefing-watcher-bridge.js'));
  const codexModel = report.platforms.codex.byModelEffort[0];
  const codexHelpers = report.platforms.codex.byAgentPath.find(
    (item) => item.key === TOKEN_REPORT_AGENT_PATH_LABELS.codexHelper,
  );
  // Measure the probe sessions themselves, never the whole Other-work bar.
  const probeRows = (report.platforms.claude.sessionGraph || []).filter(
    (row) => row.meta?.process === 'Health checks and model probes',
  );
  const claudeProbes = probeRows.length
    ? { tokens: probeRows.reduce((sum, row) => sum + number(row.tokens), 0), sessions: probeRows.length }
    : null;
  const accounting = report.platforms.codex.accounting || {};
  const combinedTokens = Math.max(1, Number(report.combinedTokens) || 0);
  const percent = (tokens) => (Math.max(0, Number(tokens) || 0) / combinedTokens) * 100;
  const oneDecimalPercent = (value) => `${Math.max(0, Number(value) || 0).toFixed(1)}%`;
  const accountingCorrection = Math.max(
    0,
    number(accounting.rawLastUsageTokens) - number(accounting.correctedTokens),
  );
  const watcherModeledSavings = watcherSession ? percent(watcherSession.tokens) : 0;
  const helperModeledSavings = codexHelpers ? percent(codexHelpers.tokens * 0.75) : 0;
  const phaseEffortModeledSavings = percent(
    Math.max(0, report.platforms.codex.totalTokens - report.platforms.codex.usage.cachedInput) *
      0.5,
  );
  const codexCachedShare = report.platforms.codex.totalTokens
    ? report.platforms.codex.usage.cachedInput / report.platforms.codex.totalTokens
    : 0;
  const claudeCachedShare = report.platforms.claude.totalTokens
    ? (report.platforms.claude.usage.cachedInput + report.platforms.claude.usage.cacheCreation) /
      report.platforms.claude.totalTokens
    : 0;
  const controls = [
    {
      id: 1,
      stableId: 'TOKEN-1',
      causeKey: 'token-accounting',
      impactScore: 0,
      title: 'Correct the token report before ExampleCo acts on it',
      status: status.forkAwareAccounting
        ? 'implemented-in-source-and-regression-test-defined'
        : 'open',
      problem: `The uncorrected report would show ${Math.round(number(accounting.rawLastUsageTokens)).toLocaleString()} tokens instead of ${Math.round(number(accounting.correctedTokens)).toLocaleString()}, overstating the measured day by ${oneDecimalPercent(percent(accountingCorrection))}. ExampleCo could make a cost decision from an inflated number.`,
      rootCause:
        'A fork rollout begins with the child identity, then embeds parent session metadata and historical token events before the child turn boundary. The collector preferred the parent session_id and summed every last_token_usage row, so replayed history was counted again and attributed to the wrong session.',
      fix: 'The first session metadata owns identity. Establish the cumulative baseline through replay, count only positive cumulative token deltas after the live child boundary, and publish raw-versus-corrected reconciliation fields.',
      impact:
        'This fixes analysis, not subscription consumption. Corrected totals can be much lower than prior reports, but real post-fork child work remains counted. Component splits are labeled proportional apportionments, missing component telemetry is unattributed, and unresolved forks publish an event count plus a replay-inclusive raw-volume upper bound.',
      estimatedSavings: '0.0% of the measured 24-hour spend.',
      savingsBasis: `${oneDecimalPercent(percent(accountingCorrection))} of this report was a measurement correction, not tokens that the control could save.`,
      targets: 'Codex platform, helper-path, persistent-conversation, and model-effort bars.',
      fixes: ['platform:codex', 'codex:top-session', 'agent-path:*', 'model-effort:*'],
    },
    {
      id: 2,
      stableId: 'TOKEN-2',
      causeKey: 'attended-watcher-terminal-bridge',
      impactScore: watcherModeledSavings,
      title: 'Unchanged time is model-free; only a proven cloud failure wakes the attended watcher',
      status: watcherBridgeImplemented
        ? 'implemented-event-bridge-awaiting-next-night-live-proof'
        : 'open',
      problem: watcherSession
        ? `The registered attended watcher task used ${formatCount(watcherSession.tokens)} processed tokens over ${formatCount(watcherSession.turns)} model ${Number(watcherSession.turns) === 1 ? 'turn' : 'turns'}. That proves the persistent watcher conversation was a major token lane, although the 24-hour trace still cannot claim that any particular unchanged poll launched unnecessary inference.`
        : 'The first report inferred that unchanged watcher polls were repeatedly invoking a model, but the available 24-hour token trace cannot attribute that burn to unchanged polls.',
      rootCause: watcherSession
        ? 'The attended watcher stayed attached to one growing desktop conversation, so each small heartbeat inherited the accumulated transcript and full project context. The cloud watcher already fingerprints stable evidence and skips inference on unchanged state, but that control does not shrink a desktop heartbeat task.'
        : 'A source audit found that the cloud watcher already fingerprints stable evidence and skips inference on unchanged state. The missing exact attended-task attribution, not a proven missing cloud gate, created the uncertainty.',
      fix: watcherSession
        ? 'Leave the independent cloud watcher as the sole overnight owner. A deterministic desktop bridge reads its bounded escalation outbox without inference and resumes the same attended Codex task only after EC2 proves recovery exhaustion, a stuck finalization, or a delivery miss. There are no scheduled attended model turns and no artificial task, turn, or token budget.'
        : 'Leave the independent cloud watcher as the sole overnight owner. Install the model-free desktop bridge and let only a new, proven terminal cloud event resume the same attended Codex task; unchanged evidence never launches a model.',
      impact: watcherBridgeImplemented
        ? 'On a healthy night, the attended-watcher model lane falls to zero while EC2 continues every production check. On a failed night, one semantic terminal event wakes the same normal Codex task to repair the existing cloud path. The next complete overnight receipt must prove the live reduction.'
        : 'This preserves recovery without inventing a causal claim. The next report must keep the attended bridge unproven until installation and a subsequent overnight receipt verify it.',
      estimatedSavings: watcherSession
        ? `About ${oneDecimalPercent(watcherModeledSavings)} of the measured 24-hour spend.`
        : 'Not measurable from this 24-hour receipt.',
      savingsBasis: watcherSession
        ? `The healthy-night target removes the full measured ${formatCount(watcherSession.turns)}-turn attended-watcher lane because only a proven terminal cloud failure can resume it. It is not additive with TOKEN-7 and must be proved by the next complete overnight receipt.`
        : 'The receipt did not identify the attended watcher conversation, so no percentage is invented.',
      targets: watcherSession
        ? 'The measured attended-watcher persistent conversation bar.'
        : 'The attended-watcher event bridge and unchanged-state cloud control.',
      fixes: watcherSession
        ? [`codex:session:${watcherSession.key}`, 'briefing:unchanged-state']
        : ['briefing:unchanged-state'],
    },
    {
      id: 3,
      stableId: 'TOKEN-3',
      causeKey: 'bounded-helper-context',
      impactScore: helperModeledSavings,
      title: 'Helpers are fresh one-shot workers, not copies of the owner session',
      status: status.boundedHelpers
        ? 'implemented-policy-and-parity-with-regression-test-defined'
        : 'open',
      problem: codexHelpers
        ? `Codex helper paths used ${Math.round(codexHelpers.tokens).toLocaleString()} corrected tokens across ${codexHelpers.sessions} sessions. Their narrow assignments inherited the parent conversation and replayed large cached context before doing their own work.`
        : 'Helper assignments could inherit an entire long parent conversation for a narrow result.',
      rootCause:
        'Canonical memory broadly preferred delegation but never constrained fork history, helper lifetime, or nested delegation. A request such as inspect one test file therefore started as a full-history fork, making the helper pay for the watcher transcript before reading the one file it needed.',
      fix: 'Each helper now receives one independent deliverable, a fresh isolated session, the smallest compact evidence packet, explicit source paths and acceptance evidence, and one return condition. Codex defaults to fork_turns none or the minimal recent window; the owning agent closes the lifecycle and nested delegation is off by default.',
      impact:
        'The handoff must explicitly include safety authority and evidence the helper truly needs. A rare tightly coupled investigation may justify more context, but must name why a compact packet is insufficient.',
      estimatedSavings: codexHelpers
        ? `About ${oneDecimalPercent(helperModeledSavings)} of the measured 24-hour spend.`
        : '0.0% directly measurable from this receipt.',
      savingsBasis: codexHelpers
        ? 'Planning estimate assumes a fresh compact helper packet removes 75% of the measured helper-path context. It overlaps any savings credited to TOKEN-2 or TOKEN-7.'
        : 'No distinct helper-path row was measured, so the report does not invent a saving.',
      targets: 'Codex and Claude helper-path bars plus their cached-input portions.',
      fixes: ['agent-path:*', 'platform:codex', 'platform:claude'],
    },
    {
      id: 4,
      stableId: 'TOKEN-4',
      causeKey: 'outcome-ownership',
      impactScore: 0,
      title: 'One outcome has one Spine task and one autonomous owner',
      status: status.oneOutcomeTask
        ? 'implemented-for-nightly-watcher-in-source-and-regression-test-defined'
        : 'open',
      problem:
        'Parallel watcher conversations pursued the same nightly outcome, so each one independently replayed evidence, diagnosed state, and continued. The duplicate work looked like separate sessions even though ExampleCo wanted one morning result.',
      rootCause:
        'Codex reconciliation created one Task per session ID and had no semantic outcome key. The autonomous watcher had a night lock, but attended watcher chats bypassed that ownership boundary and the Spine could not show that two sessions represented one outcome.',
      fix: 'Recognized nightly watcher sessions now share briefing-watcher:<date> and reconcile into one Spine outcome task with one active autonomous session and a session lineage. The cloud watcher remains the sole autonomous owner; a human does not need to create fresh sessions, and a second launcher fire is still refused by the night lock. Existing per-session files remain archive-compatible lineage records, but active legacy statuses become non-owning lineage so old running-status consumers cannot see duplicate owners.',
      impact:
        'Automatic outcome grouping is intentionally limited to the known nightly watcher class to avoid merging unrelated work with similar titles. Historical transcripts remain individually archived under the shared outcome lineage.',
      estimatedSavings: '0.0% directly measurable from this receipt.',
      savingsBasis:
        'The 24-hour data does not isolate a second autonomous owner from the main watcher lane. This control prevents future duplicate ownership but cannot honestly claim a separate saving today.',
      targets: 'Multiple thick persistent watcher conversation bars and the Codex platform total.',
      fixes: ['codex:top-session', 'platform:codex'],
    },
    {
      id: 5,
      stableId: 'TOKEN-5',
      causeKey: 'claude-health-canary',
      impactScore: 0.0001,
      title: 'Claude health is an isolated exact canary, not a general agent turn',
      status: status.isolatedHealthCanary
        ? 'implemented-in-source-and-regression-test-defined'
        : 'open',
      problem: claudeProbes
        ? `Claude health checks and model probes used ${Math.round(claudeProbes.tokens).toLocaleString()} tokens across ${claudeProbes.sessions} sessions, ${oneDecimalPercent(percent(claudeProbes.tokens))} of the measured window.`
        : 'No Claude health check or model probe session was measured in this window.',
      rootCause:
        'The June liveness repair correctly required end-to-end subscription proof, but its subprocess had only model and print flags. It inherited settings, hooks, tools, and session persistence, and the test suite checked timeout honesty rather than isolation or exact output.',
      fix: 'The canary now runs Sonnet at low effort with empty settings sources, empty MCP, no tools, no session persistence, and an exact random nonce contract. Windows scans past stale npm shims for a packaged native executable so empty isolation arguments survive; if none is runnable, the canary stays unavailable rather than spawning through an unsafe shim. A cross-process atomic claim admits only one canary at a time, and health readers keep the newest timestamped state so an older process cannot overwrite fresh proof.',
      impact:
        'A canary still uses a small subscription inference because token-file presence alone cannot prove server-side acceptance. Isolation removes unrelated context and side effects without weakening the live-auth check.',
      estimatedSavings: 'Less than 0.1% of the measured 24-hour spend.',
      savingsBasis:
        'The isolated availability check is intentionally tiny; its benefit is reliable health proof, not a material share of the day.',
      targets: 'Claude health-check and model-probe sessions.',
      fixes: ['platform:claude', 'claude:process:Health checks and model probes', 'agent-path:*', 'model-effort:*'],
    },
    {
      id: 6,
      stableId: 'TOKEN-6',
      causeKey: 'desktop-model-class-routing',
      impactScore: phaseEffortModeledSavings,
      title: 'Route routine desktop sessions to Terra and hard decisions to Sol',
      status: status.phaseEffort
        ? 'implemented-for-automation-in-source-and-regression-test-defined'
        : 'open',
      problem: codexModel
        ? `${codexModel.label} used ${Math.round(codexModel.tokens).toLocaleString()} tokens, ${(codexModel.share * 100).toFixed(1)}% of the desktop-synchronized Codex volume. This collector is desktop-scoped and cannot establish EC2 automation routing, so the evidenced gap is desktop task creation rather than every production model call.`
        : 'The desktop-synchronized receipt did not prove that routine desktop tasks selected Terra while genuinely hard decisions selected Sol.',
      rootCause:
        'Desktop task creation inherited the active session model and recorded model plus effort without a task-class reason. The intended effort guard could lower reasoning but could not change the inherited model class, and host-local collection made that desktop-only gap look universal.',
      fix: 'At desktop task creation, select Terra for bounded observation, extraction, testing, and routine synthesis, and Sol for hard architecture, ambiguous diagnosis, and final semantic decisions. Apply the existing effort policy inside that class and record host, task class, model, effort, and reason. Leave EC2 routing unchanged unless its own receipt fails, and make report QC state host coverage instead of generalizing one host.',
      impact:
        'Routine desktop work should move off Sol while hard decisions retain frontier reasoning. This is a medium-complexity desktop routing and receipt change; a shadow receipt, explicit hard-decision escape, and separate EC2 slice contain under-routing and regression risk.',
      estimatedSavings: `About ${oneDecimalPercent(phaseEffortModeledSavings)} of the measured 24-hour spend.`,
      savingsBasis:
        'Planning estimate applies a 50% reduction only to measured non-cached Codex volume. Cached input is not treated as avoidable reasoning, and the next receipt must prove the result.',
      targets:
        'Desktop-synchronized Codex model-and-reasoning-effort bars, especially Sol plus ultra or xhigh.',
      fixes: ['model-effort:*'],
    },
    {
      id: 7,
      stableId: 'TOKEN-7',
      causeKey: 'evidence-continuation-admission',
      impactScore: watcherModeledSavings,
      title: 'Continue inference only for new evidence, changed state, or closure',
      status: status.evidenceContinuation
        ? 'implemented-for-watcher-and-briefing-in-source-and-regression-test-defined'
        : 'open',
      problem: `Cached input is ${(codexCachedShare * 100).toFixed(1)}% of Codex and ${(claudeCachedShare * 100).toFixed(1)}% of Claude volume. Replaying cached context is economically cheap per token but still consumes subscription capacity when the inference has no new evidence or closure work.`,
      rootCause:
        'The system had briefing-specific stable and dynamic hashes, but no shared admission receipt tying an automated inference to an outcome, evidence fingerprint, trigger, expected next state, and return condition. A continuing model could therefore treat elapsed time or its own prior output as a reason to continue.',
      fix: 'Automated continuation now fails closed on the same dated outcome plus any recently seen semantic evidence fingerprint. First evidence, genuinely changed evidence, and one terminal closure assessment are admitted with content-free receipts; watcher clocks, ages, and A-B-A evidence flapping cannot reopen the model. An ownership-token atomic admission claim prevents concurrent spending, and every denial increments the outcome receipt.',
      impact:
        'This is a value gate, not a 40-turn or 80-turn cap. A complex task may run hundreds of useful turns if each continuation carries new evidence toward acceptance, while a second unchanged turn is correctly suppressed.',
      estimatedSavings: watcherSession
        ? `Up to ${oneDecimalPercent(watcherModeledSavings)} of the measured 24-hour spend.`
        : 'Not separately measurable from this receipt.',
      savingsBasis: watcherSession
        ? 'This is the admission gate for the same avoidable watcher lane modeled in TOKEN-2. The two percentages overlap completely and must never be added.'
        : 'The value gate had no separately attributable denial-to-token counter in this receipt.',
      targets:
        'Cached portions of platform, watcher-session, automated-task, and model-effort bars.',
      fixes: [
        'platform:codex',
        'platform:claude',
        'codex:top-session',
        'agent-path:*',
        'model-effort:*',
      ],
    },
  ];
  return selectTopTokenControls(controls, readTokenControlDecisions(repoRoot));
}

function buildDifferentiators(platforms) {
  const combined = platforms.codex.totalTokens + platforms.claude.totalTokens;
  const rows = [];
  for (const [name, platform] of Object.entries(platforms)) {
    rows.push({
      kind: 'platform',
      label: name === 'codex' ? 'Codex' : 'Claude',
      tokens: platform.totalTokens,
      share: combined > 0 ? platform.totalTokens / combined : 0,
    });
    if (platform.topSessions[0]) {
      rows.push({
        kind: `${name}-top-session`,
        label: platform.topSessions[0].label,
        tokens: platform.topSessions[0].tokens,
        share: platform.topSessions[0].share,
      });
    }
    if (platform.byModelEffort[0]) {
      rows.push({
        kind: `${name}-model-effort`,
        label: platform.byModelEffort[0].label,
        tokens: platform.byModelEffort[0].tokens,
        share: platform.byModelEffort[0].share,
      });
    }
  }
  return rows.sort((a, b) => b.tokens - a.tokens);
}

function collectTokenSpendPareto({
  nowMs = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  cacheMs = DEFAULT_CACHE_MS,
  force = false,
  codexRoot = path.join(os.homedir(), '.codex', 'sessions'),
  claudeRoot = path.join(os.homedir(), '.claude', 'projects'),
  codexIndexPath = path.join(defaultDataDir(), 'agent', 'codex-thread-index.jsonl'),
  inferenceLedgerFile = path.join(defaultDataDir(), 'agent', 'inference-work-events.jsonl'),
  outputPath = defaultOutputPath(),
  repoRoot = path.resolve(__dirname, '..', '..'),
  watcherAutomation = readAttendedWatcherAutomation(),
  overnightAuthorityDir = defaultOvernightAuthorityDir(outputPath),
  dataDir = defaultDataDir(),
} = {}) {
  assertCanonicalWindow({ windowMs, outputPath });
  if (!force && outputPath && fs.existsSync(outputPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      const generatedMs = Date.parse(String(cached.generatedAt || ''));
      if (
        cached.schema === TOKEN_SPEND_PARETO_SCHEMA &&
        Number(cached.window?.hours) === Math.round((windowMs / 3600000) * 10) / 10 &&
        Number.isFinite(generatedMs) &&
        nowMs - generatedMs >= 0 &&
        nowMs - generatedMs < cacheMs &&
        // A cache hit must never outrank the single authoritative overnight writer.
        !overnightCacheIsStaleAgainstAuthority({ cached, dir: overnightAuthorityDir })
      ) {
        return { ...cached, cacheHit: true };
      }
    } catch {
      /* rebuild corrupt or obsolete cache */
    }
  }
  const startMs = nowMs - windowMs;
  const ctDate = dateKeyInCt(nowMs);
  const nextWindow = briefingRunWindow(nextDateKey(ctDate));
  const overnightDefinition =
    nowMs >= nextWindow.inputStartMs ? nextWindow : briefingRunWindow(ctDate);
  const overnightStartMs = overnightDefinition.inputStartMs;
  const overnightEndMs = Math.min(nowMs, overnightDefinition.deliveryDeadlineMs);
  const scanStartMs = Math.min(startMs, overnightStartMs);
  // Correlate polling with the agents actually under supervision, so a generic
  // process wait is not scored as agent polling.
  let supervised = new Set();
  try {
    supervised = supervisedAgentIds();
  } catch {
    supervised = new Set();
  }
  const pollTurns = createPollTurnAccumulator({ supervisedIds: supervised });
  const codexCollected = collectCodex({
    root: codexRoot,
    indexPath: codexIndexPath,
    startMs,
    scanStartMs,
    endMs: nowMs,
    sliceStartMs: overnightStartMs,
    sliceEndMs: overnightEndMs,
    pollTurns,
    dataDir,
    repoRoot,
  });
  const claudeCollected = collectClaude({
    root: claudeRoot,
    startMs,
    scanStartMs,
    endMs: nowMs,
    sliceStartMs: overnightStartMs,
    sliceEndMs: overnightEndMs,
    pollTurns,
    dataDir,
    repoRoot,
  });
  // The T-3 prevention lint, measured where the spend is measured: a session
  // that burns more than POLL_TURN_SHARE_LIMIT of its turns polling spawned
  // agents is reported red in the canonical token receipt.
  const pollSupervision = analyzePollAmplification({ sessions: pollTurns.finalize() });
  const { slice: codexOvernight, ...codex } = codexCollected;
  const { slice: claudeOvernight, ...claude } = claudeCollected;
  const platforms = {
    codex,
    claude,
  };
  const combinedTokens = platforms.codex.totalTokens + platforms.claude.totalTokens;
  const rungLedgerFile = defaultRungLedgerFile(repoRoot);
  const causalInference = collectInferenceLedger({
    file: inferenceLedgerFile,
    startMs,
    endMs: nowMs,
    rungLedgerFile,
    totalTokens: combinedTokens,
  });
  const overnightPlatforms = {
    codex: codexOvernight || summarizePlatformRecords([], { accounting: codex.accounting }),
    claude: claudeOvernight || summarizePlatformRecords([]),
  };
  const localOvernight = {
    date: overnightDefinition.date,
    window: {
      startsAt: new Date(overnightStartMs).toISOString(),
      endsAt: new Date(overnightEndMs).toISOString(),
      hours: Math.round(((overnightEndMs - overnightStartMs) / 3600000) * 10) / 10,
    },
    combinedTokens: overnightPlatforms.codex.totalTokens + overnightPlatforms.claude.totalTokens,
    platforms: overnightPlatforms,
    causalInference: collectInferenceLedger({
      file: inferenceLedgerFile,
      startMs: overnightStartMs,
      endMs: overnightEndMs,
      rungLedgerFile,
      totalTokens: overnightPlatforms.codex.totalTokens + overnightPlatforms.claude.totalTokens,
    }),
  };
  const overnight = adoptAuthoritativeOvernight({
    local: localOvernight,
    dir: overnightAuthorityDir,
    date: overnightDefinition.date,
  });
  const report = {
    schema: TOKEN_SPEND_PARETO_SCHEMA,
    generatedAt: new Date(nowMs).toISOString(),
    provenance: {
      corpusScope: 'desktop-synced-24-hour-runtime',
      measuredOnHost: os.hostname(),
    },
    window: {
      startsAt: new Date(startMs).toISOString(),
      endsAt: new Date(nowMs).toISOString(),
      hours: Math.round((windowMs / 3600000) * 10) / 10,
    },
    combinedTokens,
    platforms,
    avoidableTokenClassification: classifyAllAvoidableTokens(platforms),
    causalInference,
    overnight,
    pollSupervision,
    differentiators: buildDifferentiators(platforms),
    limitations: [
      'Processed tokens are local runtime telemetry, not a provider invoice.',
      'Codex cached input is a subset of input_tokens; Claude cache read and creation are separate usage fields.',
      'Corrected Codex component splits are proportionally apportioned to the accepted cumulative delta; only corrected processed-token totals are measured directly from that delta.',
      'When a corrected delta has no component telemetry, the report labels that volume unattributed rather than guessing cached or uncached input.',
      'A turn count is descriptive. Practical value and state change, not a fixed numeric cap, determine whether work should continue.',
      'pollSupervision counts turns whose entire tool use was agent status polling. It measures supervision shape, not whether a turn was useful.',
      'Unknown parentage remains explicitly unattributed until a causal inference ledger covers that runner.',
      'Process labels are heuristic where the runtime did not emit a structured process owner; causal-lane rows come only from the inference ledger.',
    ],
  };
  report.controls = controlsFor(
    report,
    repoRoot,
    path.dirname(path.dirname(inferenceLedgerFile)),
    watcherAutomation,
  );
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temp = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temp, outputPath);
  }
  return report;
}

// Exact, fork-aware telemetry cut for a bounded verification run. Unlike the
// canonical 24-hour Pareto writer, this function never writes or reuses a
// cache. It is suitable for proving that a cache-only card recheck opened zero
// Codex or Claude model sessions during its own wall-clock interval.
function collectModelSessionLedgerCut({
  startMs,
  endMs,
  codexRoot = path.join(os.homedir(), '.codex', 'sessions'),
  claudeRoot = path.join(os.homedir(), '.claude', 'projects'),
  codexIndexPath = path.join(defaultDataDir(), 'agent', 'codex-thread-index.jsonl'),
  dataDir = defaultDataDir(),
  repoRoot = path.resolve(__dirname, '..', '..'),
} = {}) {
  if (!Number.isFinite(Number(startMs)) || !Number.isFinite(Number(endMs)) || endMs < startMs) {
    throw new Error('model session ledger cut requires a valid startMs and endMs');
  }
  const codex = collectCodex({
    root: codexRoot,
    indexPath: codexIndexPath,
    startMs: Number(startMs),
    scanStartMs: Number(startMs),
    endMs: Number(endMs),
    dataDir,
    repoRoot,
  });
  const claude = collectClaude({
    root: claudeRoot,
    startMs: Number(startMs),
    scanStartMs: Number(startMs),
    endMs: Number(endMs),
    dataDir,
    repoRoot,
  });
  const platforms = { codex, claude };
  return {
    schema: 'secondbrain.model-session-ledger-cut.v1',
    startsAt: new Date(Number(startMs)).toISOString(),
    endsAt: new Date(Number(endMs)).toISOString(),
    combinedTokens: Number(codex.totalTokens || 0) + Number(claude.totalTokens || 0),
    combinedTurns: Number(codex.turns || 0) + Number(claude.turns || 0),
    combinedSessions: Number(codex.sessions || 0) + Number(claude.sessions || 0),
    platforms,
  };
}

module.exports = {
  DEFAULT_CACHE_MS,
  DEFAULT_WINDOW_MS,
  TOKEN_REPORT_AGENT_PATH_LABELS,
  TOKEN_REPORT_FORBIDDEN_RUNTIME_LABEL_RE,
  TOKEN_SPEND_PARETO_SCHEMA,
  collectInferenceLedger,
  collectModelCallLedger,
  collectCodex,
  collectClaude,
  collectModelSessionLedgerCut,
  collectTokenSpendPareto,
  classifyAvoidableTokens,
  classifyAvoidableHealerRepeats,
  classifyAllAvoidableTokens,
  healerRepairTarget,
  subscriptionAttemptFromPrompt,
  codexPromptText,
  codexResponseItemText,
  adoptAuthoritativeOvernight,
  overnightCacheIsStaleAgainstAuthority,
  assertCanonicalWindow,
  defaultOutputPath,
  defaultOvernightAuthorityDir,
  readAttendedWatcherAutomation,
  readTokenControlDecisions,
  selectTopTokenControls,
  hasVerifiedAmySelfCall,
  usageFromCodexTokenBlock,
  processLabel,
  sanitizeTokenReportLabel,
  scanJsonl,
  correlateHealerSession,
  loadHealerReceiptCorrelationIndex,
  loadRouterDecisionIndex,
};
