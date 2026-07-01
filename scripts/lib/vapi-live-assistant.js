'use strict';

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

const VAPI_LIVE_SERVER_MESSAGES = [
  'conversation-update',
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
  now = new Date(),
} = {}) {
  const dynamicCaller = isDynamicCallerPhone(callerPhone);
  const owner = !dynamicCaller && isOwnerPhone(callerPhone, ownerPhones);
  const ownerList = ownerPhonesForPrompt(ownerPhones) || '+ExampleCo';
  const callerSection = owner
    ? [
        '## Caller Identification: OWNER',
        'This is ExampleCo calling from a verified owner phone number.',
        'Open with exactly: "Hey ExampleCo, what\'s going on?"',
        'Do not ask who is calling. Do not use returned-call greetings. This is an inbound owner call, not a callback.',
      ].join('\n')
    : dynamicCaller
      ? [
          '## Caller Identification: DYNAMIC',
          'Current caller phone from Vapi: {{customer.number}}.',
          `Verified owner phones: ${ownerList}.`,
          'If the current caller phone matches a verified owner phone after ignoring punctuation and a leading country code, this is ExampleCo or an owner. Treat the call as OWNER: help directly, do not ask who is calling, and do not call it a callback.',
          'If the current caller phone does not match a verified owner phone, treat the call as ExampleCo: use the access keyword for private information and let server-side tool policy block owner-only tools.',
          'Never classify the caller as ExampleCo merely because this saved Vapi assistant prompt was built before the phone number was known.',
        ].join('\n')
      : [
          '## Caller Identification: ExampleCo',
          'This caller is not on the verified owner list.',
          'Open neutrally. Do not call them ExampleCo.',
          'Ask who is calling if they have not said. Take a message unless live context proves a specific purpose.',
          'If they claim to be ExampleCo or PRIVATE_NAME from another number, ask for the access keyword and call verify_access_keyword. Never judge or reveal the keyword yourself.',
        ].join('\n');

  const sourceMap = [
    '## Live Data Sources',
    '- spine_snapshot and check_spine: active/recent tasks, prompts, callbacks, Claude/Codex sessions. The result is speakable evidence for session status. Use before saying a prompt was not picked up.',
    '- graphiti_query_live and query_knowledge: Graphiti, memory, contacts, transcripts, email/life archive recall. A no-match must include source and scope.',
    '- read_briefing_news: latest morning briefing news cards. Call action=start when ExampleCo asks for the news. The tool returns exact article text; speak it verbatim. During news mode, call next_article, next_section, previous, restart, current, or stop for controls. The server only dedupes repeated tool calls and triggers auto-continue after clean article endings.',
    '- read_otter_transcripts: live Otter transcript inventory and keyword search.',
    '- start_agent_session and run_claude_code: start real new Claude/Codex work for deep tasks, not to answer status for a session check_spine already found.',
    '- agent_session_status: observable progress only for an exact task_id returned by start_agent_session or run_claude_code. Never pass a Codex thread snapshot id or spoken/truncated id from check_spine.',
    '- callback_commitment: durable promise when ExampleCo explicitly says call me back.',
    '- send_message: Telegram only, and only after the server policy allows it.',
  ].join('\n');

  const voiceRules = [
    '## Voice Contract',
    `Current server date/time in America/Chicago: ${formatCentralDate(now)}.`,
    "You are Amy, ExampleCo ExampleCo's executive assistant, same memory and brain as Claude Code.",
    'Be terse, direct, warm, and source-grounded. Never fabricate.',
    'Live calls are interruptible. Default to one short sentence, then stop. If ExampleCo starts talking, yield immediately.',
    'Start with the high-level answer. Give raw detail, provenance inventory, or line-by-line status only when ExampleCo asks for detail.',
    'When a tool result is available, speak only the tool result. Never prepend "hold on", "just a sec", "give me a moment", "okay", "sure", or any other transition before the tool text.',
    'Never read markdown, code fences, separators, symbol runs, or words like equal sign equal sign aloud.',
    'Use tools instead of guessing. Say partial truth live: what you found, what source, what remains unproven.',
    'If a tool returns no match, say the scope of the no-match and widen or escalate. Never treat one narrow no-match as the whole truth.',
    'For financial or payment/refund status, proof requires a receipt, transaction source, or explicit payment-provider record.',
    'When ExampleCo says "that", "it", "the active session", "that session", or another vague follow-up, use Recent Owner Call Context to infer the likely topic before asking him to restate it.',
    'For vague session follow-ups, pass the inferred specific topic into check_spine, not generic words like "active session".',
    'For session status, do not pass one broad project word like "briefing", "voice", "dashboard", "Gmail", "Graphiti", "Codex", or "Claude" unless that is literally all ExampleCo gave you. Include the concrete current work item from his words or recent owner context.',
    'Start a Claude/Codex session only when ExampleCo explicitly asks you to start, run, fix, build, investigate, research, draft, or continue work. Frustration like "this is taking forever", "why is this slow", or "what is going on" is a status follow-up, not permission to start new work.',
    'When you do start a new agent session, set owner_explicit_start=true only if ExampleCo explicitly asked for that new work in his own words.',
    'If ExampleCo asks how an existing session is going, call check_spine with query/detail and answer directly from that result. If it found an active or recent session, say what is active, when it last updated, the source, and any detail, then say what remains ExampleCo.',
    'For live dev/session questions, use the check_spine probe ladder. First answer with probe_level 0. If ExampleCo asks details, use probe_level 1. If he asks why, how do you know, or proof, use probe_level 2. If he asks what file, test, command, or log changed, use probe_level 3. If he asks to read the exact part, use probe_level 4.',
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
    'News-reader mode is model-spoken and always interruptible. After every read_briefing_news result, speak the returned section name, headline, and ExampleCoraphs verbatim: do not paraphrase, summarize, condense, reorder, translate, add commentary, or omit sentences. If the tool result is empty, say nothing.',
    'If ExampleCo says skip or next while news is being read, stop the current sentence and call read_briefing_news with action=next_article. If he says skip section or next section, stop and call action=next_section. If he says stop, start over, repeat, or go back, call stop, restart, current, or previous. Never acknowledge the command and never say hold on, okay, sure, moving on, one moment, or any filler.',
    'When you finish speaking an article naturally, continue without asking ExampleCo: call read_briefing_news with action=next_article and speak that result verbatim. If the server injects NEWS_READER_AUTO_CONTINUE, call next_article immediately and speak only the returned text.',
    'Never call read_briefing_news more than once for the same spoken user command. The server dedupes retries, but you must not intentionally issue duplicate navigation calls.',
    'After a news-reader tool call, the first spoken words must be the returned section or headline text. If the returned text starts a new section because of next_section or because next_article rolled over after the last article, say the section name before the headline. Speak only the returned section, headline, and ExampleCoraphs.',
    'Never preface news with wait language. The first spoken words after a news request must be the returned section or headline text.',
    'Never say hold-music phrases, delay apologies, or generic waiting lines. No seconds-counting, no holding language, no moment language, no patience requests.',
    'Never say "let me know", "if you need anything else", "if you need more details", "want to start something new", "start something new", or "investigate further" in live status output. Those phrases fail the owner-call regression.',
    'Do not say raw object placeholders, raw JSON, tool ids, raw numeric counters, or internal errors out loud. Give the readable result or say the result needs a readable summary.',
    'Do not promise a callback unless ExampleCo explicitly requested one.',
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
    trimmedMemory || trimmedContacts || trimmedRecentOwnerContext
      ? ['## Current Context', trimmedRecentOwnerContext, trimmedMemory, trimmedContacts]
          .filter(Boolean)
          .join('\n\n')
      : '';

  return [callerSection, sourceMap, memoryBlock, voiceRules].filter(Boolean).join('\n\n');
}

function sanitizeLiveAssistantConfig(
  cachedConfig,
  {
    callerPhone = '',
    ownerPhones = [],
    memory = '',
    contactsSummary = '',
    recentOwnerContext = '',
    functionTools = [],
    now,
  } = {},
) {
  const cached = JSON.parse(JSON.stringify(cachedConfig || {}));
  const sourceModel = cached.model && typeof cached.model === 'object' ? cached.model : {};
  const existingTools = Array.isArray(sourceModel.tools) ? sourceModel.tools : [];
  const config = {
    model: {
      provider: sourceModel.provider || 'openai',
      model: sourceModel.model || 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: buildLiveVapiSystemPrompt({
            callerPhone,
            ownerPhones,
            memory,
            contactsSummary,
            recentOwnerContext,
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
    'server',
    'silenceTimeoutSeconds',
    'maxDurationSeconds',
    'backgroundSound',
    'endCallPhrases',
  ]) {
    if (cached[key] !== undefined) config[key] = cached[key];
  }
  config.firstMessageInterruptionsEnabled = true;
  config.stopSpeakingPlan = {
    ...(cached.stopSpeakingPlan && typeof cached.stopSpeakingPlan === 'object'
      ? cached.stopSpeakingPlan
      : {}),
    numWords: 0,
    voiceSeconds: 0.1,
    backoffSeconds: 0.5,
  };
  config.serverMessages = VAPI_LIVE_SERVER_MESSAGES;
  config.firstMessage = buildLiveVapiFirstMessage(callerPhone, { ownerPhones });
  config.firstMessageMode = config.firstMessageMode || 'assistant-speaks-first';
  return config;
}

module.exports = {
  buildLiveVapiFirstMessage,
  buildLiveVapiSystemPrompt,
  sanitizeLiveAssistantConfig,
  VAPI_LIVE_SERVER_MESSAGES,
  normalizePhone,
  isOwnerPhone,
  isDynamicCallerPhone,
};
