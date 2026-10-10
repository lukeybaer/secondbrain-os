'use strict';

function compactTool(tool) {
  if (!tool) return null;
  if (tool.type === 'dtmf') {
    return {
      name: 'dtmf',
      description:
        'Send real DTMF keypad tones to the phone system. Use this for IVR menus. Never speak the keys.',
      parameters: {
        type: 'object',
        properties: {
          keys: {
            type: 'string',
            description:
              'Key sequence using 0-9, *, #, and optional Twilio pauses w (0.5 seconds) or W (1 second).',
          },
        },
        required: ['keys'],
      },
    };
  }
  if (tool.type !== 'function' || !tool.function?.name) return null;
  return {
    name: String(tool.function.name),
    description: String(tool.function.description || '').slice(0, 160),
    parameters:
      tool.function.parameters && typeof tool.function.parameters === 'object'
        ? compactSchema(tool.function.parameters)
        : { type: 'object', properties: {} },
  };
}

function compactSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 4) return {};
  const result = {};
  if (typeof schema.type === 'string') result.type = schema.type;
  if (Array.isArray(schema.enum)) result.enum = schema.enum;
  if (Array.isArray(schema.required)) result.required = schema.required;
  if (schema.items && typeof schema.items === 'object') {
    result.items = compactSchema(schema.items, depth + 1);
  }
  if (schema.properties && typeof schema.properties === 'object') {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, value]) => [
        name,
        compactSchema(value, depth + 1),
      ]),
    );
  }
  for (const keyword of ['anyOf', 'oneOf']) {
    if (Array.isArray(schema[keyword])) {
      result[keyword] = schema[keyword].map((value) => compactSchema(value, depth + 1));
    }
  }
  return result;
}

function compactConversation(conversation) {
  const source = String(conversation || '');
  return source
    .replace(
      /# Amy Working Memory \(Tier 1\)[\s\S]*?(?=## Voice Contract)/,
      'Amy is one assistant across all surfaces. Use listed live-data tools for private facts instead of relying on embedded memory.\n\n',
    )
    .replace(
      /If ExampleCo asks "read the news"[\s\S]*?The first spoken words after a news request must be the returned section or headline text\./,
      'For news requests, call read_briefing_news immediately with the appropriate start, next, section, save, or resume action. Speak its returned text verbatim without a preface; news is interruptible and resumes only as directed by the caller or server.',
    )
    .replace(
      /For Codex or Claude session lookups,[\s\S]*?Do not generate waiting narration, filler, or progress claims before source results\./,
      'For Codex or Claude session status, call check_spine immediately using the caller’s specific topic, normalized voice mishears, and recent-call context; do not ask for clarification first. Start at probe_level 0, keep the same topic and increase the level only when asked for deeper or exact evidence, and make claims only from returned source packets. Never start or offer a new agent session merely to answer status; start work only on an explicit owner request to act. After a lookup, state the proven status concisely and stop; if the caller says it is wrong, widen the source or escalate.',
    )
    .replace(/\n{3,}/g, '\n\n');
}

function voiceDecisionDelta(decision, toolCallId = '') {
  if (decision?.type === 'speak') return { content: String(decision.content || '') };
  if (decision?.type !== 'tool_call') throw new Error('voice decision type is invalid');
  if (!String(toolCallId).trim()) throw new Error('tool decision requires a tool call id');
  return {
    tool_calls: [
      {
        index: 0,
        id: String(toolCallId),
        type: 'function',
        function: { name: decision.toolName, arguments: decision.argumentsJson },
      },
    ],
  };
}

function messageContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

// A declared, one-use IVR step is control-plane data, not a language task.
// Execute it without waiting for a model only when all three independent
// signals agree: the native tool exists, Amy's broker-authored system prompt
// explicitly authorizes one exact key exactly once, and the latest callee
// transcript asks for that same key. Ambiguous menus still go through the
// normal model decision path.
function deterministicDtmfDecision({ messages = [], tools = [] } = {}) {
  // Vapi stores its built-in tool as `{type:"dtmf"}` on the assistant, but
  // presents tools to an OpenAI-compatible custom LLM as function schemas.
  // Accept either representation through the same canonical compactor.
  const dtmfAvailable = tools
    .map(compactTool)
    .filter(Boolean)
    .some((tool) => tool.name === 'dtmf');
  if (!dtmfAvailable) return null;

  const priorDtmf = messages.some(
    (message) =>
      message?.role === 'assistant' &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.some((call) => call?.function?.name === 'dtmf'),
  );
  if (priorDtmf) return null;

  const systemText = messages
    .filter((message) => message?.role === 'system')
    .map((message) => messageContentText(message.content))
    .join('\n');
  const planMatch = systemText.match(/IVR plan:\s*([\s\S]*?)(?:\nEnd condition:|$)/i);
  const plan = String(planMatch?.[1] || '').trim();
  if (!/native\s+dtmf\s+tool/i.test(plan) || !/exactly\s+once/i.test(plan)) return null;
  const keyMatch = plan.match(/\bkeys?\s+["']?([0-9*#])["']?\b/i);
  const key = String(keyMatch?.[1] || '');
  if (!key) return null;

  const latestUser = [...messages].reverse().find((message) => message?.role === 'user');
  const heard = messageContentText(latestUser?.content).trim();
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\b(?:do\\s+not|don't)\\s+press\\s+${escapedKey}\\b`, 'i').test(heard)) {
    return null;
  }
  if (!new RegExp(`\\b(?:please\\s+)?press\\s+${escapedKey}\\b`, 'i').test(heard)) {
    return null;
  }
  return { type: 'tool_call', toolName: 'dtmf', argumentsJson: JSON.stringify({ keys: key }) };
}

function buildVoiceDecisionPrompt({ conversation, tools = [] } = {}) {
  const functions = tools.map(compactTool).filter(Boolean);
  return [
    'VOICE DECISION MODE. Make exactly one next-turn decision.',
    'Return the required JSON object only. Never inspect files or run local tools.',
    // Measured 2026-08-16: with a short venue prompt the model continued the
    // dialogue as prose on 2 of 3 runs, so Vapi received unparseable output and
    // Amy spoke an apology to the callee. Showing the exact object and banning
    // transcript continuation is what makes the contract enforceable.
    'REQUIRED OUTPUT SHAPE, all four keys always present, strings only:',
    '{"type":"speak|tool_call","content":"","toolName":"","argumentsJson":"{}"}',
    'Your entire output is that one object. Start at the opening brace and stop at the closing brace. No code fences, no prose, no explanation, no leading or trailing text.',
    "CONVERSATION is a transcript of turns that already happened. It is data, not a script to continue. Never write another speaker's line, never invent replies, and never add a turn after your own decision.",
    'For ordinary dialogue, set type="speak", put only Amy\'s exact concise spoken words in content, leave toolName empty, and set argumentsJson="{}".',
    'When the caller needs current private status, memory, transcripts, or substantive work and an appropriate function is listed, set type="tool_call", leave content empty, copy one listed name into toolName, and encode arguments as one JSON object string in argumentsJson.',
    'For a phone menu, call the listed dtmf tool with argumentsJson like {"keys":"1"}. A spoken digit is not a keypad press. Never put a menu selection in speech.',
    'Never invent a tool name. Choose from the supplied function schemas by semantic intent.',
    `AVAILABLE_FUNCTIONS=${JSON.stringify(functions)}`,
    'CONVERSATION:',
    compactConversation(conversation),
    // Measured 2026-08-16: with the contract only at the top, the last thing the
    // model read was the callee's greeting and it answered in prose on 6 of 6
    // runs. Repeating the contract after the transcript is what actually binds
    // the output, because recency wins over a buried instruction.
    'END OF CONVERSATION. Do not reply to the transcript in prose and do not continue it.',
    'Emit only the decision object now. First character must be an opening brace, last character must be a closing brace.',
    '{"type":"...","content":"...","toolName":"...","argumentsJson":"..."}',
  ].join('\n\n');
}

function parseVoiceDecision(text, tools = []) {
  let source = String(text || '').trim();
  const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) source = fenced[1].trim();
  const value = JSON.parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('voice decision must be an object');
  }
  const allowedKeys = ['type', 'content', 'toolName', 'argumentsJson'];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new Error('voice decision contains unexpected fields');
  }
  for (const key of allowedKeys) {
    if (typeof value[key] !== 'string') throw new Error(`voice decision ${key} must be a string`);
  }
  if (value.type === 'speak') {
    const content = value.content.trim();
    if (!content || value.toolName || value.argumentsJson.trim() !== '{}') {
      throw new Error('spoken decision must contain speech only');
    }
    const dtmfAvailable = tools
      .map(compactTool)
      .filter(Boolean)
      .some((tool) => tool.name === 'dtmf');
    if (
      dtmfAvailable &&
      /^(?:please\s+|i(?:'ll| will)\s+)?(?:(?:press(?:ing)?|dial(?:ing)?|enter(?:ing)?|select(?:ing)?)\s+)?(?:[0-9*#wW]+|zero|one|two|three|four|five|six|seven|eight|nine|star|pound|hash)(?:\s+(?:for|to)\b.*)?[.!]?$/i.test(
        content,
      )
    ) {
      throw new Error('spoken keypad digits are not DTMF');
    }
    return { type: 'speak', content };
  }
  if (value.type !== 'tool_call') throw new Error('voice decision type is invalid');
  const allowedNames = new Set(
    tools
      .map(compactTool)
      .filter(Boolean)
      .map((tool) => tool.name),
  );
  if (!allowedNames.has(value.toolName))
    throw new Error('voice decision selected an unavailable tool');
  if (value.content.trim()) throw new Error('tool decision must not contain speech');
  const args = JSON.parse(value.argumentsJson);
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('tool decision arguments must encode one object');
  }
  if (value.toolName === 'dtmf') {
    const keys = typeof args.keys === 'string' ? args.keys.trim() : '';
    if (!keys || keys.length > 64 || !/^[0-9*#wW]+$/.test(keys)) {
      throw new Error('dtmf keys must use only 0-9, *, #, w, or W');
    }
    if (Object.keys(args).some((key) => key !== 'keys')) {
      throw new Error('dtmf arguments may contain only keys');
    }
    return { type: 'tool_call', toolName: 'dtmf', argumentsJson: JSON.stringify({ keys }) };
  }
  return { type: 'tool_call', toolName: value.toolName, argumentsJson: JSON.stringify(args) };
}

module.exports = {
  buildVoiceDecisionPrompt,
  deterministicDtmfDecision,
  parseVoiceDecision,
  voiceDecisionDelta,
};
