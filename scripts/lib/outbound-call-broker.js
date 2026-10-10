'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  assertNoRecentCall,
  listPrincipalPhones,
  normalizePhone,
} = require('./redial-guard.js');
const {
  assertCanonicalOutboundCallsAllowed,
  consumeOutboundTestAuthorizationEverywhere,
} = require('./outbound-call-control.js');
const {
  buildVapiModelHeaders,
  resolveVapiLlmSecret,
  normalizeVapiCallId,
  withVapiCallAudienceMarker,
  withVapiCallIdMarker,
  withVapiCallToolsMarker,
} = require('./vapi-call-correlation.js');
const { resolveVoicePrimary } = require('./voice-primary.js');
const { approveOutreach } = require('./jev-control-plane.js');

const DEFAULT_VAPI_OUTBOUND_PHONE_NUMBER_ID = '51f85b93-8de8-4886-bdd3-4eef3a30a637';
const DEFAULT_VAPI_INBOUND_PHONE_NUMBER_ID = 'a9802a75-6e41-4217-b027-5247465d988d';
const DEFAULT_VAPI_ASSISTANT_ID = 'ExampleCo-2da6-45b2-9379-1b575634a337';
const DEFAULT_OWNER_PHONE = '+ExampleCo';
// Vapi fetches custom LLM URLs from its own infrastructure. A loopback URL
// points at Vapi's localhost, never at the EC2 runtime, and produces an opaque
// custom-llm-500 failure as soon as the first caller turn reaches the model.
const DEFAULT_SUBSCRIPTION_LLM_ENDPOINT =
  'https://your-api-id.execute-api.us-east-1.amazonaws.com/prod/chat/completions';
function customLlmEndpoint(override) {
  const candidate = String(override || process.env.SUBSCRIPTION_LLM_ENDPOINT || DEFAULT_SUBSCRIPTION_LLM_ENDPOINT);
  try {
    return new URL(candidate).protocol === 'https:' ? candidate : DEFAULT_SUBSCRIPTION_LLM_ENDPOINT;
  } catch {
    return DEFAULT_SUBSCRIPTION_LLM_ENDPOINT;
  }
}

function normalizeOwnerDialPhone(value) {
  const normalized = normalizePhone(value);
  if (/^\d{10}$/.test(normalized)) return `+1${normalized}`;
  if (/^1\d{10}$/.test(normalized)) return `+${normalized}`;
  return normalized;
}

function writeJsonAtomicSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

function writeJsonExclusiveSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    // A hard link makes reservation atomic without exposing a partially
    // written intent. Exactly one concurrent invocation can win this name.
    fs.linkSync(temp, file);
  } finally {
    fs.unlinkSync(temp);
  }
}

function prepGaps(args = {}) {
  const missing = [];
  for (const field of [
    'recipient',
    'phone_number',
    'objective',
    'script',
    'ivr_plan',
    'end_condition',
    'compartmentalization_scope',
  ]) {
    if (!String(args[field] || '').trim()) missing.push(field);
  }
  if (
    !Array.isArray(args.prep_manifest) ||
    !args.prep_manifest.length ||
    args.prep_manifest.some(
      (item) => !String(item?.field || '').trim() || !String(item?.source_path || '').trim(),
    )
  ) {
    missing.push('prep_manifest');
  }
  if (!validQcSimulation(args.qc_simulation)) missing.push('qc_simulation');
  return [...new Set(missing)];
}

function validQcSimulation(qc) {
  if (!qc || qc.mode !== 'offline_self_roleplay') return false;
  const turns = Array.isArray(qc.transcript) ? qc.transcript : [];
  if (turns.length < 4) return false;
  const roles = new Set(turns.map((turn) => String(turn?.role || '').toLowerCase()));
  if (!roles.has('amy') || !roles.has('callee')) return false;
  if (turns.some((turn) => !String(turn?.text || '').trim())) return false;
  return Boolean(String(qc.interruption_case || '').trim() && String(qc.failure_case || '').trim());
}

const BROKERED_CALL_TOOLS = Object.freeze(['dtmf']);
const BROKERED_SILENCE_TIMEOUT_SECONDS = 30;

function buildCallPrompt(args, correlationId = '') {
  const evidence = args.prep_manifest
    .map(
      (item) =>
        `- ${item.field}: ${item.value == null ? '[read from source]' : item.value} (source: ${item.source_path})`,
    )
    .join('\n');
  return withVapiCallIdMarker(
    withVapiCallAudienceMarker(
      withVapiCallToolsMarker([
        `You are Amy, PRIVATE_NAME's executive AI assistant, calling ${args.recipient} on ExampleCo's behalf.`,
        '',
        `Objective: ${args.objective}`,
        `Opening and call guidance: ${args.script}`,
        '',
        'Information prepared before dialing:',
        evidence,
        '',
        `IVR plan: ${args.ivr_plan}`,
        `End condition: ${args.end_condition}`,
        `Compartmentalization scope: ${args.compartmentalization_scope}`,
        '',
        'Never fabricate. Share information legitimately required by the objective. Deflect off-objective probes.',
        'Your microphone is live. Never narrate waiting, thinking, tool use, or DTMF. Use DTMF silently.',
        ...(args.first_message
          ? []
          : [
              'The other person speaks first when they answer. Reply to their greeting, then open with your objective. If you have already said Hello? and they answer, start your opening.',
            ]),
        'Speak every critical short string in one naturally grouped phrase and repeat the whole string consistently.',
      ].join('\n'), BROKERED_CALL_TOOLS),
      args.call_audience === 'principal' ? 'principal' : 'outside_world',
    ),
    correlationId,
  );
}

// How people answer a phone: the callee speaks first ("Hello, this is Sam").
// Amy listens from the moment the call connects and answers that greeting. A
// scripted opener played at pickup collides with it and sounds like a robocall
// (vendor quote call, 2026-10-05 14:25 CT: the callee hung up four seconds in). On
// dead air Amy checks for a listener once with "Hello?", then takes her turn
// when someone answers (another vendor, same day: both sides waited 8 minutes).
// The "Hello?" check is opening-only, so it runs on the EC2 webhook
// (scripts/lib/vapi-listen-opening-watcher.js), keyed by this metadata flag. A
// Vapi customer.speech.timeout hook stays armed all call and would say
// "Hello?" into a later hold.
const LISTEN_OPENING_METADATA = Object.freeze({ amyListenOpening: true });

function listensForOpening(args) {
  return !args.first_message;
}

function openingOverrides(args) {
  if (!listensForOpening(args)) {
    return {
      firstMessage: args.first_message,
      firstMessageMode: 'assistant-speaks-first',
    };
  }
  return {
    firstMessage: '',
    firstMessageMode: 'assistant-waits-for-user',
  };
}

function vapiRequestBody(
  args,
  invocationKey,
  { vapiConfig = {}, correlationId = '', voicePrimary } = {},
) {
  const primary = voicePrimary || resolveVoicePrimary();
  if (!normalizeVapiCallId(correlationId)) {
    throw new Error('vapiRequestBody requires a persisted call correlation UUID');
  }
  // Third-party calls get only the phone-native IVR control. Privileged owner
  // tools add prompt weight and side-effect risk, and are irrelevant to the
  // narrow objective prepared before dialing. Owner callbacks use the same
  // narrow-objective broker deliberately; callback commitments can originate
  // only from a signed inbound owner utterance and are never exposed here.
  // Vapi still merges the persisted assistant's tools, so buildCallPrompt also
  // states this allowlist for the custom-LLM endpoint to enforce.
  const tools = BROKERED_CALL_TOOLS.map((type) => ({ type }));
  return {
    phoneNumberId: process.env.VAPI_OUTBOUND_PHONE_NUMBER_ID || DEFAULT_VAPI_OUTBOUND_PHONE_NUMBER_ID,
    assistantId: process.env.VAPI_ASSISTANT_ID || DEFAULT_VAPI_ASSISTANT_ID,
    customer: { number: normalizePhone(args.phone_number), name: args.recipient },
    metadata: {
      amyInvocationKey: invocationKey,
      amyObjective: args.objective,
      amyCallCorrelationId: correlationId,
      ...(listensForOpening(args) ? LISTEN_OPENING_METADATA : {}),
    },
    assistantOverrides: {
      ...openingOverrides(args),
      firstMessageInterruptionsEnabled: true,
      backgroundSound: 'off',
      startSpeakingPlan: {
        waitSeconds: 0.2,
        smartEndpointingPlan: { provider: 'vapi' },
      },
      stopSpeakingPlan: { numWords: 1, voiceSeconds: 0.2, backoffSeconds: 0.25 },
      serverUrl:
        process.env.VAPI_SERVER_URL ||
        'https://your-api-id.execute-api.us-east-1.amazonaws.com/prod/vapi/webhook',
      model: {
        provider: 'custom-llm',
        model: primary.model,
        url: customLlmEndpoint(),
        headers: buildVapiModelHeaders(resolveVapiLlmSecret({ config: vapiConfig }), correlationId),
        messages: [{ role: 'system', content: buildCallPrompt(args, correlationId) }],
        tools,
      },
      maxDurationSeconds: Math.max(60, Math.min(900, Number(args.max_duration_seconds || 480))),
      // The base assistant waits 600s; a silent turn on a missed voicemail
      // must end the call well before that.
      silenceTimeoutSeconds: BROKERED_SILENCE_TIMEOUT_SECONDS,
      metadata: { amyInvocationKey: invocationKey, amyCallCorrelationId: correlationId },
    },
  };
}

async function defaultModelPreflight(args, opts = {}) {
  const primary = opts.voicePrimary || resolveVoicePrimary();
  const endpoint =
    customLlmEndpoint(opts.endpoint);
  const timeoutMs = Math.max(1000, Math.min(3000, Number(opts.timeoutMs || 3000)));
  const started = Date.now();
  const vapiLlmSecret =
    opts.vapiLlmSecret || resolveVapiLlmSecret({ config: opts.vapiConfig || {} });
  const controller = new AbortController();
  const preflightCallId = crypto.randomUUID();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (opts.fetchImpl || fetch)(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(vapiLlmSecret ? { 'x-amy-llm-secret': vapiLlmSecret } : {}),
        'x-amy-call-id': preflightCallId,
      },
      body: JSON.stringify({
        model: primary.preflightModel,
        stream: true,
        messages: [
          {
            role: 'system',
            content: buildCallPrompt(args, preflightCallId),
          },
          {
            role: 'user',
            content: `${String(args?.recipient || 'The recipient').slice(0, 80)} answers the phone and says, "Hello?" Respond with the first substantive phone-safe turn you would actually say.`,
          },
        ],
        tools: [],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, latencyMs: Date.now() - started, reason: `HTTP ${response.status}` };
    }
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, latencyMs: Date.now() - started, reason: 'no response stream' };
    const decoder = new TextDecoder();
    let streamBuffer = '';
    let spokenContent = '';
    while (Date.now() - started < timeoutMs) {
      const { value, done } = await reader.read();
      if (done) break;
      streamBuffer += decoder.decode(value, { stream: true });
      const lines = streamBuffer.split(/\r?\n/);
      streamBuffer = lines.pop() || '';
      for (const line of lines) {
        const data = line.replace(/^\s*data:\s*/, '').trim();
        if (!data || data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          spokenContent += String(event?.choices?.[0]?.delta?.content || '');
        } catch {
          // A partial or diagnostic SSE line cannot prove first content.
        }
      }
      if (spokenContent.trim().length >= 12) {
        controller.abort();
        return { ok: true, latencyMs: Date.now() - started, contentChars: spokenContent.trim().length };
      }
      if (streamBuffer.length > 16000) streamBuffer = streamBuffer.slice(-8000);
    }
    return { ok: false, latencyMs: Date.now() - started, reason: 'no first content before deadline' };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      reason: error?.name === 'AbortError' ? 'first token deadline exceeded' : String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function vapiFetch(route, options = {}) {
  const token = process.env.VAPI_API_KEY;
  if (!token) throw new Error('VAPI_API_KEY is unavailable');
  const response = await fetch(`https://api.vapi.ai${route}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(json.message || json.error || `Vapi HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return json;
}

function defaultVapiApi() {
  return {
    createCall: (body) =>
      vapiFetch('/call/phone', { method: 'POST', body: JSON.stringify(body) }),
    findCallByInvocationKey: async (key, intent) => {
      const calls = await vapiFetch('/call?limit=100');
      const rows = Array.isArray(calls) ? calls : calls.results || [];
      const exact = rows.find(
        (call) =>
          call.metadata?.amyInvocationKey === key ||
          call.assistantOverrides?.metadata?.amyInvocationKey === key,
      );
      if (exact) return exact;
      const reservedAt = Date.parse(intent.reserved_at || '');
      return (
        rows.find((call) => {
          const createdAt = Date.parse(call.createdAt || '');
          return (
            normalizePhone(call.customer?.number) === normalizePhone(intent.phone_number) &&
            Number.isFinite(createdAt) &&
            Number.isFinite(reservedAt) &&
            Math.abs(createdAt - reservedAt) < 2 * 60 * 1000
          );
        }) || null
      );
    },
    getCall: (callId) => vapiFetch(`/call/${encodeURIComponent(callId)}`),
  };
}

function isAmbiguousProviderError(error) {
  return (
    error?.name === 'AbortError' ||
    ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.code) ||
    Number(error?.status || 0) >= 500 ||
    /timeout|timed out|connection reset|socket hang up/i.test(String(error?.message || ''))
  );
}

function callIntentPath(dataDir, invocationKey) {
  const key = String(invocationKey || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(key)) {
    const error = new Error('outbound call invocation key contains unsafe characters');
    error.code = 'OUTBOUND_CALL_INVALID_INVOCATION_KEY';
    throw error;
  }
  return path.join(dataDir, 'calls', 'intents', `${key}.json`);
}

function callRecordPath(dataDir, callId) {
  return path.join(dataDir, 'calls', `${callId}.json`);
}

async function reconcileExistingIntent(intent, intentFile, api) {
  if (intent.status === 'dial_succeeded' && intent.call_id) {
    return { ok: true, reused: true, call_id: intent.call_id, status: intent.provider_status || 'queued' };
  }
  if (!['reserved', 'dial_unknown'].includes(intent.status)) {
    return { ok: false, status: intent.status, reason: intent.reason || 'Prior dial did not succeed' };
  }
  let found = null;
  try {
    found = await api.findCallByInvocationKey(intent.invocation_key, intent);
  } catch {
    found = null;
  }
  if (!found?.id) {
    const reservedAt = Date.parse(intent.reserved_at || '');
    if (
      intent.status === 'reserved' &&
      Number.isFinite(reservedAt) &&
      Date.now() - reservedAt < 2 * 60 * 1000
    ) {
      return {
        ok: false,
        status: 'dial_in_progress',
        reason: 'A matching provider request is still within its reservation window. No redial was attempted.',
      };
    }
    const next = {
      ...intent,
      status: 'dial_unknown',
      reconciled_at: new Date().toISOString(),
      reason: 'Provider state did not prove whether the reserved dial was accepted. No redial was attempted.',
    };
    writeJsonAtomicSync(intentFile, next);
    return { ok: false, status: 'dial_unknown', reason: next.reason };
  }
  const next = {
    ...intent,
    status: 'dial_succeeded',
    call_id: found.id,
    provider_status: found.status || 'unknown',
    reconciled_at: new Date().toISOString(),
  };
  writeJsonAtomicSync(intentFile, next);
  return { ok: true, recovered: true, call_id: found.id, status: next.provider_status };
}

async function placeOutboundCall({
  dataDir,
  args = {},
  turn = {},
  invocationKey,
  api = defaultVapiApi(),
  callControlPreflight = assertCanonicalOutboundCallsAllowed,
  modelPreflight = defaultModelPreflight,
  vapiConfig = {},
  voicePrimary,
  allowNoHumanRedial = false,
  consumeTestAuthorization = consumeOutboundTestAuthorizationEverywhere,
  redialGuard = (phone, guardOpts = {}) =>
    assertNoRecentCall(phone, {
      callsDir: path.join(dataDir, 'calls'),
      canonicalRemoteChecked: true,
      ...guardOpts,
    }),
  outreachApproval = approveOutreach,
} = {}) {
  if (!dataDir || !invocationKey) throw new Error('outbound call broker requires dataDir and invocationKey');
  const primary = voicePrimary || resolveVoicePrimary();
  const intentFile = callIntentPath(dataDir, invocationKey);
  const existing = fs.existsSync(intentFile) ? JSON.parse(fs.readFileSync(intentFile, 'utf8')) : null;
  if (existing) return reconcileExistingIntent(existing, intentFile, api);

  const normalizedTarget = normalizePhone(args.phone_number);
  const verifiedPrincipal = listPrincipalPhones({
    callsDir: path.join(dataDir, 'calls'),
    contactsPath: path.join(dataDir, 'agent', 'contacts.json'),
  }).includes(normalizedTarget);
  const principalTest = turn.principal_test === true;
  if (principalTest && !verifiedPrincipal) {
    return {
      ok: false,
      status: 'outbound_paused',
      reason: 'A scoped principal test can target only an exact verified principal phone.',
    };
  }
  const effectiveArgs = {
    ...args,
    call_audience: verifiedPrincipal ? 'principal' : 'outside_world',
  };
  const callControlArgs = {
    dataDir,
    ...(principalTest
      ? {
          purpose: 'principal-test',
          phoneNumber: normalizedTarget,
          invocationKey,
        }
      : {}),
  };
  try {
    await callControlPreflight(callControlArgs);
  } catch (error) {
    return { ok: false, status: 'outbound_paused', reason: String(error.message || error) };
  }
  const missing = prepGaps(effectiveArgs);
  if (missing.length) return { ok: false, status: 'prep_incomplete', missing };

  let redialGuardReceipt;
  try {
    redialGuardReceipt = redialGuard(effectiveArgs.phone_number, {
      allowNoHumanRedial: allowNoHumanRedial === true,
      ownerRequestText: turn.owner_request_text,
      purpose: principalTest ? 'principal-test' : 'outbound-call',
      phoneNumber: normalizedTarget,
      invocationKey,
    });
  } catch (error) {
    return { ok: false, status: 'redial_blocked', reason: String(error.message || error) };
  }

  if (!verifiedPrincipal) {
    try {
      const approval = await outreachApproval({
        recipientName: effectiveArgs.recipient,
        recipientAddress: normalizedTarget,
        message: effectiveArgs.script,
        context: `Outbound call objective: ${effectiveArgs.objective}. End condition: ${effectiveArgs.end_condition}.`,
        channel: 'phone',
      });
      if (!approval.accepted) {
        return {
          ok: false,
          status: 'jev_outreach_blocked',
          reason: `Jev did not approve this exact call script (${approval.choice || approval.reason || 'uncertain'}).`,
          confidence: Number(approval.minProbability || 0),
          threshold: Number(approval.threshold || 0.95),
        };
      }
    } catch (error) {
      return { ok: false, status: 'jev_outreach_blocked', reason: `Jev outreach approval failed closed: ${String(error.message || error)}` };
    }
  }

  let preflight;
  try {
    preflight = await modelPreflight(effectiveArgs, { vapiConfig, voicePrimary: primary });
  } catch (error) {
    preflight = { ok: false, reason: String(error.message || error) };
  }
  if (!preflight?.ok) {
    return {
      ok: false,
      status: 'model_preflight_failed',
      reason: preflight?.reason || 'The subscription voice model did not pass its first-token preflight.',
      latency_ms: preflight?.latencyMs,
    };
  }

  // Model proof can take several seconds. Re-read both stop states after that
  // wait so a newer owner/safety pause wins before the provider sees a dial.
  try {
    await callControlPreflight(callControlArgs);
  } catch (error) {
    return { ok: false, status: 'outbound_paused', reason: String(error.message || error) };
  }

  const reservedAt = new Date().toISOString();
  const correlationId = crypto.randomUUID();
  const intent = {
    schema: 'amy.outbound-call-intent.v1',
    invocation_key: invocationKey,
    turn_id: turn.turn_id || null,
    session_id: turn.session_id || null,
    recipient: effectiveArgs.recipient,
    phone_number: normalizePhone(effectiveArgs.phone_number),
    objective: effectiveArgs.objective,
    prep_manifest: effectiveArgs.prep_manifest,
    ivr_plan: effectiveArgs.ivr_plan,
    end_condition: effectiveArgs.end_condition,
    compartmentalization_scope: effectiveArgs.compartmentalization_scope,
    qc_simulation: effectiveArgs.qc_simulation,
    call_audience: effectiveArgs.call_audience,
    principal_test: principalTest,
    model_preflight: preflight,
    redial_guard: redialGuardReceipt || null,
    owner_redial_authorization_text:
      redialGuardReceipt?.ownerAuthorizedNoHumanRetry === true
        ? String(turn.owner_request_text || '').trim()
        : null,
    reserved_at: reservedAt,
    call_correlation_id: correlationId,
    status: 'reserved',
  };
  try {
    writeJsonExclusiveSync(intentFile, intent);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const concurrent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
    return reconcileExistingIntent(concurrent, intentFile, api);
  }

  try {
    const call = await api.createCall(
      vapiRequestBody(effectiveArgs, invocationKey, { vapiConfig, correlationId, voicePrimary: primary }),
    );
    if (!call?.id) throw new Error('Vapi accepted no call id');
    // Non-principal calls reach here only after Jev approved this exact script.
    require('./outbound-send-record.js').recordOutboundSend({
      surface: 'vapi-call-out',
      authorization: verifiedPrincipal ? 'principal-test' : 'jev:approved',
      content: effectiveArgs.script || '',
      details: { call_id: call.id, correlation_id: correlationId },
    });
    const completed = {
      ...intent,
      status: 'dial_succeeded',
      call_id: call.id,
      provider_status: call.status || 'queued',
      dialed_at: new Date().toISOString(),
    };
    writeJsonAtomicSync(intentFile, completed);
    writeJsonAtomicSync(callRecordPath(dataDir, call.id), {
      id: call.id,
      createdAt: completed.dialed_at,
      phoneNumber: completed.phone_number,
      recipient: completed.recipient,
      objective: effectiveArgs.objective,
      instructions: effectiveArgs.objective,
      status: completed.provider_status,
      prep_manifest: effectiveArgs.prep_manifest,
      qc_simulation: effectiveArgs.qc_simulation,
      model_preflight: preflight,
      outcome_classification: 'pending',
      invocation_key: invocationKey,
      turn_id: turn.turn_id || null,
      principal_contact: verifiedPrincipal,
      principal_test: principalTest,
    });
    let testAuthorizationConsumed = null;
    if (principalTest) {
      try {
        testAuthorizationConsumed = await consumeTestAuthorization({
          dataDir,
          phoneNumber: normalizedTarget,
          invocationKey,
        });
      } catch (error) {
        testAuthorizationConsumed = { ok: false, error: String(error.message || error) };
      }
    }
    return {
      ok: true,
      call_id: call.id,
      status: completed.provider_status,
      ...(principalTest ? { test_authorization_consumed: testAuthorizationConsumed?.ok === true } : {}),
    };
  } catch (error) {
    const ambiguous = isAmbiguousProviderError(error);
    const failed = {
      ...intent,
      status: ambiguous ? 'dial_unknown' : 'dial_failed',
      failed_at: new Date().toISOString(),
      reason: String(error.message || error).slice(0, 400),
    };
    writeJsonAtomicSync(intentFile, failed);
    return { ok: false, status: failed.status, reason: failed.reason };
  }
}

async function callOwner(context = {}) {
  const objective = String(context.args?.objective || '').trim();
  const ownerPhone =
    context.args?.phone_number ||
    process.env.ExampleCo_PRIVATE_SIM ||
    process.env.ExampleCo_PHONE ||
    process.env.OWNER_PHONE ||
    DEFAULT_OWNER_PHONE;
  const args = {
    ...context.args,
    recipient: context.args?.recipient || 'ExampleCo',
    phone_number: normalizeOwnerDialPhone(ownerPhone),
    objective,
    script: context.args?.script || `Talk with ExampleCo about: ${objective}`,
    prep_manifest:
      context.args?.prep_manifest ||
      [{ field: 'objective', source_path: `session:${context.turn?.turn_id}`, value: objective }],
    ivr_plan: context.args?.ivr_plan || 'No IVR expected. Wait for ExampleCo to answer.',
    end_condition: context.args?.end_condition || 'ExampleCo has discussed the stated objective or ends the call.',
    compartmentalization_scope:
      context.args?.compartmentalization_scope || 'This is the authenticated owner. Stay within the stated objective.',
    first_message: context.args?.wait_for_callee
      ? ''
      : context.args?.first_message || `Hi ExampleCo, Amy here. You asked me to call about ${objective}.`,
  };
  return placeOutboundCall({ ...context, args });
}

module.exports = {
  LISTEN_OPENING_METADATA,
  DEFAULT_OWNER_PHONE,
  DEFAULT_SUBSCRIPTION_LLM_ENDPOINT,
  DEFAULT_VAPI_ASSISTANT_ID,
  DEFAULT_VAPI_INBOUND_PHONE_NUMBER_ID,
  DEFAULT_VAPI_OUTBOUND_PHONE_NUMBER_ID,
  buildCallPrompt,
  callIntentPath,
  callOwner,
  customLlmEndpoint,
  defaultVapiApi,
  defaultModelPreflight,
  isAmbiguousProviderError,
  normalizeOwnerDialPhone,
  placeOutboundCall,
  prepGaps,
  reconcileExistingIntent,
  vapiRequestBody,
  validQcSimulation,
  writeJsonAtomicSync,
  writeJsonExclusiveSync,
};
