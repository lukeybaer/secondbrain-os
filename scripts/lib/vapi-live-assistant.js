'use strict';

const {
  VAPI_SUBSCRIPTION_VOICE_MODEL,
  buildVapiModelHeaders,
  withVapiCallAudienceMarker,
  withVapiCallIdMarker,
} = require('./vapi-call-correlation');
const { resolveVoicePrimary } = require('./voice-primary');
const { loadOperatorIdentity } = require('./operator-identity');

function normalizePhone(raw) {
  if (!raw) return '';
  const str = String(raw);
  const digits = str.replace(/[^\d]/g, '');
  if (!digits) return '';
  if (str.startsWith('+')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return '+' + digits;
}

function isOwnerPhone(callerPhone, ownerPhones = []) {
  const norm = normalizePhone(callerPhone);
  return ownerPhones.some((p) => normalizePhone(p) === norm);
}

function isDynamicCallerPhone(callerPhone) {
  const text = String(callerPhone || '');
  return !text.trim() || /\{\{\s*customer\.number\s*\}\}/i.test(text);
}

function ownerPhonesForPrompt(ownerPhones = []) {
  return ownerPhones
    .map((p) => normalizePhone(p))
    .filter(Boolean)
    .filter((p, i, arr) => arr.indexOf(p) === i)
    .join(', ');
}

function formatCentralDate(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
  } catch {
    return now.toISOString();
  }
}

// This list is pushed verbatim to the Vapi assistant and REPLACES whatever it
// had. Anything missing here is silently unsubscribed on the next config push.
//
// 'end-of-call-report' is load bearing and must never be dropped: it is the
// only event that fires the post-call pipeline in ec2-server.js, which archives
// the raw transcript, extracts owner directives, and appends to
// data/agent/dispatch-queue.jsonl. Every in-call event can keep flowing while
// that one is missing, so the failure is invisible from the logs: calls look
// healthy, and nothing is archived and no work is ever queued.
//
// 2026-07-18: it WAS missing. PRIVATE_NAME phoned Amy with wallpaper changes, the
// webhook received all 13 subscribed event types for the call, no
// end-of-call-report ever arrived, nothing was archived and no task was
// created. Regression test: scripts/__tests__/vapi-live-server-messages.test.js
const VAPI_LIVE_SERVER_MESSAGES = [
  'conversation-update',
  'end-of-call-report',
  'function-call',
  'hang',
  'model-output',
  'speech-update',
  'status-update',
  'transfer-update',
  'transcript',
  'tool-calls',
  'user-interrupted',
  'voice-input',
  'assistant.started',
  'assistant.speechStarted',
];

// Keep high-value owner news controls intact through phone transcription.
// Semantic routing remains in the model and reader state remains server-owned.
const OWNER_VOICE_KEYTERMS = [
  'read the news',
  'read me the news',
  'play the news',
  'start the news',
  'read the headlines',
  'next article',
  'skip article',
  'skip section',
  'next section',
  'save that article',
  'bookmark that article',
  'resume the news',
];

function buildOwnerTranscriber() {
  return {
    provider: 'deepgram',
    model: 'nova-3',
    language: 'en',
    smartFormat: true,
    keyterm: [...OWNER_VOICE_KEYTERMS],
  };
}

function buildVerifyAccessKeywordTool() {
  return {
    type: 'function',
    function: {
      name: 'verify_access_keyword',
      description:
        'Verify the access keyword spoken by a caller claiming to be ExampleCo or PRIVATE_NAME from an unrecognized number. Always call this instead of judging the keyword yourself.',
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: 'Exactly what the caller said when asked for the access keyword.',
          },
        },
        required: ['keyword'],
      },
    },
  };
}

function toolName(tool) {
  if (!tool) return '';
  if (tool.type === 'dtmf') return 'dtmf';
  return tool.function && tool.function.name ? tool.function.name : '';
}

function mergeTools(functionTools = [], existingTools = []) {
  const byName = new Map();
  for (const tool of [...functionTools, ...existingTools, buildVerifyAccessKeywordTool()]) {
    const name = toolName(tool);
    if (name && !byName.has(name)) byName.set(name, tool);
  }
  return [...byName.values()];
}

// The owner-spouse authority sentence resolves through operator identity so the
// live prompt keeps the real names and relationship while the public shell,
// which has no identity config, carries none of it (2026-09-07 layer 3 finding).
function ownerSpouseAuthorityLine(identity = loadOperatorIdentity()) {
  const owner = (identity && identity.owner && identity.owner.firstName) || 'the operator';
  const spouse = (identity && identity.spouse && identity.spouse.firstName) || 'the spouse';
  const relation = (identity && identity.spouse && identity.spouse.relationship) || 'spouse';
  return (
    `${spouse} is ${owner}'s ${relation} and has FULL OWNER AUTHORITY, exactly equal to ${owner}'s. ` +
    `Anything you would do for ${owner} you do for ${spouse}, immediately and without permission.`
  );
}

function buildLiveVapiFirstMessage(callerPhone, { ownerPhones = [] } = {}) {
  if (isOwnerPhone(callerPhone, ownerPhones)) return "Hey ExampleCo, what's going on?";
  return 'Hi, this is Amy speaking, how can I help you?';
}

function buildLiveVapiSystemPrompt({
  callerPhone = '',
  ownerPhones = [],
  memory = '',
  contactsSummary = '',
  recentOwnerContext = '',
  graphitiAdvisor = '',
  callId = '',
  allowUnresolvedTemplate = false,
  now = new Date(),
} = {}) {
  const dynamicCaller = isDynamicCallerPhone(callerPhone);
  const owner = !dynamicCaller && isOwnerPhone(callerPhone, ownerPhones);
  const ownerList = ownerPhonesForPrompt(ownerPhones) || '+ExampleCo';
  const callerSection = owner
    ? [
        '## Caller Identification: OWNER',
        'This is an owner calling from a verified owner phone number. Owners are ExampleCo and PRIVATE_NAME, and both carry identical authority.',
        // The greeting is spoken by firstMessage, or deliberately skipped for the synthetic
        // self-test caller. Telling the model to "open with" it made the model greet in place
        // of answering (2026-09-29 self-call: two greetings, zero answers).
        'The greeting "Hey ExampleCo, what\'s going on?" is handled by the phone system. Never say it or any other greeting yourself; answer what the caller asked directly.',
        'Do not ask who is calling. Do not use returned-call greetings. This is an inbound owner call, not a callback.',
      ].join('\n')
    : dynamicCaller
      ? [
          '## Caller Identification: DYNAMIC',
          'Current caller phone from Vapi: {{customer.number}}.',
          `Verified owner phones: ${ownerList}.`,
          'If the current caller phone matches a verified owner phone after ignoring punctuation and a leading country code, this is ExampleCo or an owner. Treat the call as OWNER: help directly, do not ask who is calling, and do not call it a callback.',
          'If the current caller phone does not match a verified owner phone, treat the call as UNKNOWN: use the access keyword for private information and let server-side tool policy block owner-only tools.',
          'Never classify the caller as UNKNOWN merely because this saved Vapi assistant prompt was built before the phone number was known.',
        ].join('\n')
      : [
          '## Caller Identification: UNKNOWN',
          'This caller is not on the verified owner list.',
          'Open neutrally. Do not call them ExampleCo.',
          'Ask who is calling if they have not said. Take a message unless live context proves a specific purpose.',
          'If they claim to be ExampleCo or PRIVATE_NAME from another number, ask for the access keyword and call verify_access_keyword. Never judge or reveal the keyword yourself.',
        ].join('\n');

  const sourceMap = [
    '## Live Data Sources',
    '- spine_snapshot and check_spine: active/recent tasks, prompts, callbacks, Claude/Codex sessions. The result is speakable evidence for session status. Use before saying a prompt was not picked up.',
    '- query_knowledge: owner-verified memory, contacts, transcripts, email, Signal, Telegram and session evidence. Graphiti recall and ingestion are off. A no-match must include source and scope.',
    '- read_briefing_news: latest morning briefing news cards. Call action=start when ExampleCo asks for the news. The tool returns exact article text; speak it verbatim. During news mode, call next_article, next_section, save_current, previous, restart, current, or stop for controls. The server dedupes repeated tool calls, pauses for interruptions, and resumes after clean article or response endings.',
    '- read_otter_transcripts: live Otter inventory, transcript search, and person-to-call lookup using confirmed plus clearly labeled likely roster evidence.',
    '- start_agent_session and run_claude_code: start real new Claude/Codex work for deep tasks, not to answer status for a session check_spine already found. Real-world actions ExampleCo or PRIVATE_NAME ask for, like sending an email through the guarded Gmail pipeline, drafting, fixing, or researching, are dispatched here. Never say you cannot send emails or take action; dispatch the task instead.',
    '- steer_task: when ExampleCo changes his mind about work already dispatched (do it a different way, add a requirement, or stop it), call steer_task with his new instruction in his words. Never start a second task for a change of plan. If the result lists several open tasks, read the list and ask which one.',
    '- agent_session_status: observable progress only for an exact task_id returned by start_agent_session or run_claude_code. Never pass a Codex thread snapshot id or spoken/truncated id from check_spine.',
    '- callback_commitment: durable promise when ExampleCo explicitly says call me back.',
    '- send_message: Telegram only, and only after the server policy allows it.',
  ].join('\n');

  const voiceRules = [
    '## Voice Contract',
    `Current server date/time in America/Chicago: ${formatCentralDate(now)}.`,
    "You are Amy, PRIVATE_NAME's executive assistant, same memory and brain as Claude Code.",
    'Be terse, direct, warm, and source-grounded. Never fabricate.',
    'Live calls are interruptible. Default to one short sentence, then stop. If ExampleCo starts talking, yield immediately.',
    'Start with the high-level answer. Give raw detail, provenance inventory, or line-by-line status only when ExampleCo asks for detail.',
    'When a tool result is available, speak only the tool result. Never prepend "hold on", "just a sec", "give me a moment", "okay", "sure", or any other transition before the tool text.',
    'Never read markdown, code fences, separators, symbol runs, or words like equal sign equal sign aloud.',
    'Use tools instead of guessing. Say partial truth live: what you found, what source, what remains unproven.',
    'Choose the lookup tool by reasoning about the full semantic intent of ExampleCo’s question, not by matching keywords or isolated nouns. A question is session/task status only when it asks about active or prior work execution; only then use check_spine.',
    'For personal history, people, prior decisions, relationships, or exact archived evidence, use query_knowledge. Graphiti recall and ingestion are off. A general factual question uses the appropriate current live source, never check_spine.',
    'If one question could be either session status or personal memory, make one LLM intent decision from the whole utterance and recent call context. Record the selected source through the tool call. Do not run a regex or keyword fallback.',
    'If a tool returns no match, say the scope of the no-match and widen or escalate. Never treat one narrow no-match as the whole truth.',
    'For financial or payment/refund status, proof requires a receipt, transaction source, or explicit payment-provider record.',
    'When ExampleCo says "that", "it", "the active session", "that session", or another vague follow-up, use Recent Owner Call Context to infer the likely topic before asking him to restate it.',
    'For vague session follow-ups, pass the inferred specific topic into check_spine, not generic words like "active session".',
    'For Codex or Claude session lookups, never ask a clarifying question first. Use the words ExampleCo said, normalize voice mishears like Kodak, codec, or Coda to Codex, and call check_spine. If there is no one clear parent-session match, answer with a short list of likely parent sessions, not child/subagent sessions unless ExampleCo explicitly says subagent or child.',
    'For session status, do not pass one broad project word like "briefing", "voice", "dashboard", "Gmail", "Graphiti", "Codex", or "Claude" unless that is literally all ExampleCo gave you. Include the concrete current work item from his words or recent owner context.',
    'Start a Claude/Codex session only when ExampleCo explicitly asks you to start, run, fix, build, investigate, research, draft, or continue work. Frustration like "this is taking forever", "why is this slow", or "what is going on" is a status follow-up, not permission to start new work.',
    'When you do start a new agent session, set owner_explicit_start=true only if ExampleCo explicitly asked for that new work in his own words.',
    'If ExampleCo asks how an existing session is going, call check_spine with query/detail and answer directly from that result. If it found an active or recent session, say what is active, when it last updated, the source, and any detail, then say what remains unknown.',
    'For dev/session status questions, use the check_spine probe ladder to look for active or recent sessions. First answer with probe_level 0. If ExampleCo asks details, use probe_level 1. If he asks why, how do you know, or proof, use probe_level 2. If he asks what file, test, command, or log changed, use probe_level 3. If he asks to read the exact part, use probe_level 4.',
    'Every check_spine claim must come from the returned source packets. If the result says it only has title/status or no deeper source, say that boundary plainly instead of inventing depth.',
    'For repeated probes like "go deeper", "why", "what changed", or "read it", keep the same inferred session topic and increase probe_level instead of doing a new broad search.',
    'If ExampleCo follows up after a check_spine result with "what is going on with it", "why is it taking so long", or similar, call check_spine again with the same specific query/detail. Do not switch to agent_session_status unless a prior tool result returned a literal task_id.',
    'If ExampleCo asks "what is the actual status" right after a check_spine answer, repeat the last proven status in one sentence. Do not reword it into speculation, do not offer to start a new session, and do not ask what he wants next.',
    'Do not start a new agent session just to answer status for a session check_spine already found. Do not feed labels or ids from check_spine into agent_session_status.',
    'After answering a check_spine status lookup, stop. Do not add open-ended offers like "start a new session", "investigate further", "let me know", or "if you need anything else" unless ExampleCo explicitly asks for new work.',
    'If ExampleCo wants to stay on the line for a session already found by check_spine, repeat check_spine every twenty to thirty seconds and summarize observable changes. Use agent_session_status only when you have an exact task_id returned by start_agent_session or run_claude_code.',
    'During lookup tool calls, do not generate wait language. Only configured source-label tool messages may speak. After the result, answer in one or two high-level sentences, with source and what remains unproven only when materially needed.',
    'A checking phrase is not an answer. After check_spine returns, say the actual status in plain English. Do not read source-scope inventories, raw task ids, full prompts, raw counts, internal file names, UUIDs, call IDs, or stale mirror detail aloud.',
    'If ExampleCo says the answer is wrong, immediately widen the source or escalate to a live agent session. Do not defend the first narrow lookup.',
    'Do not generate waiting narration, filler, or progress claims before source results.',
    'If ExampleCo asks "read the news", "can you read the news", or similar, call read_briefing_news with action=start immediately. Do not answer with capability talk. Do not use query_knowledge, graphiti_query_live, web_search, or check_spine for that request.',
    'News-reader mode is model-spoken and always interruptible. After every read_briefing_news result, speak that result verbatim, including the returned section name, headline, and paragraphs: do not paraphrase, summarize, condense, reorder, translate, add commentary, or omit sentences. If the tool result is empty, say nothing.',
    'If ExampleCo says skip or next while news is being read, stop the current sentence and call read_briefing_news with action=next_article. If he says skip section or next section, stop and call action=next_section. If he says stop, start over, repeat, or go back, call stop, restart, current, or previous. Never acknowledge the command and never say hold on, okay, sure, moving on, one moment, or any filler.',
    'If ExampleCo says save that article or bookmark that while news is live, call read_briefing_news with action=save_current, say the exact result "Saved.", and then continue reading when the server injects NEWS_READER_RESUME.',
    'Any other ExampleCo interruption suspends news auto-advance. Answer his question or execute his requested tool first. Speak the useful answer or exact tool result, with no waiting narration. Then continue the news when the server injects NEWS_READER_RESUME. Do not make ExampleCo ask you to resume.',
    'When you finish speaking an article naturally, continue without asking ExampleCo. If the server injects NEWS_READER_AUTO_CONTINUE or NEWS_READER_RESUME, call next_article immediately and speak only the returned text. Keep reading article by article until ExampleCo says stop or the briefing ends.',
    'Never call read_briefing_news more than once for the same spoken user command. The server dedupes retries, but you must not intentionally issue duplicate navigation calls.',
    'After a news-reader tool call, the first spoken words must be the returned section or headline text. If the returned text starts a new section because of next_section or because next_article rolled over after the last article, say the section name before the headline. Speak only the returned section, headline, and paragraphs.',
    'Never preface news with wait language. The first spoken words after a news request must be the returned section or headline text.',
    'Never say hold-music phrases, delay apologies, or generic waiting lines. No seconds-counting, no holding language, no moment language, no patience requests.',
    'Never say "let me know", "if you need anything else", "if you need more details", "want to start something new", "start something new", or "investigate further" in live status output. Those phrases fail the owner-call regression.',
    'Do not say raw object placeholders, raw JSON, tool ids, raw numeric counters, or internal errors out loud. Give the readable result or say the result needs a readable summary.',
    'Do not promise a callback unless ExampleCo explicitly requested one.',
    // 2026-07-18: a principal owner called with a list of changes, and Amy
    // replied "I'll need ExampleCo's approval to proceed" and then "the request for
    // approval was denied". Both were fabrications. Every principal owner has
    // owner-level authority and there is no approval mechanism to deny.
    ownerSpouseAuthorityLine(),
    'NEVER tell PRIVATE_NAME, or any owner, that you need ExampleCo\'s approval or anyone\'s permission to carry out their request. There is no approval step and no approval tool. Never say a request was "denied", "rejected", or "not approved". Those statements are false.',
    'If you cannot actually do something a caller asks for, say plainly what you can and cannot do and that you will pass it to ExampleCo. Never invent an approval process, an approval request, or a denial as the reason.',
  ].join('\n');

  const trimmedMemory = String(memory || '')
    .slice(0, 1800)
    .trim();
  const trimmedContacts = String(contactsSummary || '')
    .slice(0, 1200)
    .trim();
  const trimmedRecentOwnerContext = String(recentOwnerContext || '')
    .slice(0, 1000)
    .trim();
  const memoryBlock =
    owner && (trimmedMemory || trimmedContacts || trimmedRecentOwnerContext)
      ? ['## Current Context', trimmedRecentOwnerContext, trimmedMemory, trimmedContacts]
          .filter(Boolean)
          .join('\n\n')
      : '';

  const advisorBlock = String(graphitiAdvisor || '').trim()
    ? [
        '## Graphiti Brain Advisor',
        String(graphitiAdvisor).trim(),
        'Use relevant recall to shape the call. Do not speak internal fact IDs, raw receipts, or private details to a non-owner caller.',
      ].join('\n')
    : '';

  return withVapiCallIdMarker(
    withVapiCallAudienceMarker(
      [callerSection, sourceMap, memoryBlock, advisorBlock, voiceRules]
        .filter(Boolean)
        .join('\n\n'),
      owner ? 'principal' : 'outside_world',
    ),
    callId,
    { allowUnresolvedTemplate },
  );
}

function sanitizeLiveAssistantConfig(
  cachedConfig,
  {
    callerPhone = '',
    ownerPhones = [],
    memory = '',
    contactsSummary = '',
    recentOwnerContext = '',
    graphitiAdvisor = '',
    functionTools = [],
    waitForCallerPhones = [],
    authSecret = '',
    callId = '',
    voicePrimary,
    now,
  } = {},
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(callId || '').trim(),
  )) {
    throw new Error('Live Vapi assistant config requires a literal call correlation UUID.');
  }
  const primary = voicePrimary || resolveVoicePrimary();
  const cached = JSON.parse(JSON.stringify(cachedConfig || {}));
  const sourceModel = cached.model && typeof cached.model === 'object' ? cached.model : {};
  const existingTools = Array.isArray(sourceModel.tools) ? sourceModel.tools : [];
  const config = {
    model: {
      // The custom endpoint owns both the subscription default and the one
      // registered paid voice alias. Tool and call authentication stay here.
      provider: 'custom-llm',
      model: primary.model,
      url: 'https://your-api-id.execute-api.us-east-1.amazonaws.com/prod/chat/completions',
      // Never trust a Vapi GET response to round-trip a secret header. The
      // server supplies this credential from its own durable environment.
      headers: buildVapiModelHeaders(authSecret, callId),
      messages: [
        {
          role: 'system',
          content: buildLiveVapiSystemPrompt({
            callerPhone,
            ownerPhones,
            memory,
            contactsSummary,
            recentOwnerContext,
            graphitiAdvisor,
            callId,
            now,
          }),
        },
      ],
      tools: mergeTools(functionTools, existingTools),
      temperature: 0,
      maxTokens: Math.max(Number(sourceModel.maxTokens) || 0, 2200),
    },
  };
  for (const key of [
    'voice',
    'transcriber',
    'server',
    'silenceTimeoutSeconds',
    'maxDurationSeconds',
    'backgroundSound',
    'endCallPhrases',
  ]) {
    if (cached[key] !== undefined) config[key] = cached[key];
  }
  if (isOwnerPhone(callerPhone, ownerPhones)) {
    config.transcriber = buildOwnerTranscriber();
  }
  config.firstMessageInterruptionsEnabled = true;
  config.backgroundSound = 'off';
  config.startSpeakingPlan = {
    waitSeconds: 0.2,
    smartEndpointingPlan: { provider: 'vapi' },
  };
  config.stopSpeakingPlan = {
    ...(cached.stopSpeakingPlan && typeof cached.stopSpeakingPlan === 'object'
      ? cached.stopSpeakingPlan
      : {}),
    numWords: 1,
    voiceSeconds: 0.2,
    backoffSeconds: 0.25,
  };
  config.serverMessages = VAPI_LIVE_SERVER_MESSAGES;
  if (isOwnerPhone(callerPhone, waitForCallerPhones)) {
    // A real self-call has two assistants. Let the dedicated synthetic caller
    // put the test utterance on the wire so simultaneous greetings cannot
    // interrupt or splice the acceptance question.
    config.firstMessage = '';
    config.firstMessageMode = 'assistant-waits-for-user';
  } else {
    config.firstMessage = buildLiveVapiFirstMessage(callerPhone, { ownerPhones });
    config.firstMessageMode = 'assistant-speaks-first';
  }
  return config;
}

module.exports = {
  buildLiveVapiFirstMessage,
  ownerSpouseAuthorityLine,
  buildLiveVapiSystemPrompt,
  sanitizeLiveAssistantConfig,
  VAPI_LIVE_SERVER_MESSAGES,
  OWNER_VOICE_KEYTERMS,
  buildOwnerTranscriber,
  normalizePhone,
  isOwnerPhone,
  isDynamicCallerPhone,
};
