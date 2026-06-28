'use strict';

const VAPI_FUNCTION_TOOL_NAMES = [
  'run_claude_code',
  'query_knowledge',
  'spine_snapshot',
  'graphiti_query_live',
  'start_agent_session',
  'agent_session_status',
  'callback_commitment',
  'request_approval',
  'flag_reputation_risk',
  'bridge_in_owner',
  'check_todos',
  'check_spine',
  'manage_task',
  'send_message',
  'read_briefing_news',
  'read_otter_transcripts',
  'check_calendar',
  'create_calendar_event',
  'web_search',
];

const TOOL_RESULT_ONLY_HINT =
  'Answer with only the tool result. Do not add greetings, offers, callbacks, follow-up questions, or closing chatter. For status lookups, stop after the source-grounded status sentence.';
const NEWS_RESULT_ONLY_HINT =
  'Speak only the news-reader tool result exactly as returned. Do not prepend hold on, just a sec, okay, sure, moving on, one moment, or any other filler.';
const PROBE_LEVEL_ENUM = ['0', '1', '2', '3', '4'];

function toolMessages(message, delayedMessage = '', options = {}) {
  const messages = [];
  if (message && !options.silentStart) messages.push({ type: 'request-start', content: message });
  if (delayedMessage && !options.silentDelayed) {
    messages.push({ type: 'request-response-delayed', content: delayedMessage });
  }
  if (options.silentComplete) {
    messages.push({ type: 'request-complete', role: 'assistant', content: options.completeContent || '' });
  } else {
    messages.push({
      type: 'request-complete',
      role: 'system',
      content: TOOL_RESULT_ONLY_HINT,
    });
  }
  return messages.length ? messages : undefined;
}

function functionTool(name, description, properties, required = [], options = {}) {
  const tool = {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties,
        required,
      },
    },
  };
  if (options.messages) tool.messages = options.messages;
  return tool;
}

function buildVapiFunctionTools() {
  const tools = [
    { type: 'dtmf' },
    functionTool(
      'run_claude_code',
      "Dispatch substantive work to Claude Code in a detached background session. Use only when ExampleCo explicitly asks you to start, run, fix, build, investigate, research, draft, or continue real work. Do not use this for frustration, waiting, status follow-ups, or 'what is going on' questions.",
      {
        task: {
          type: 'string',
          description: 'Clear task for Claude Code, including context, desired output, and any source files or systems to inspect.',
        },
        owner_explicit_start: {
          type: 'boolean',
          description:
            'Must be true only when ExampleCo explicitly asked to start/run/fix/build/investigate/research/draft/continue work. False for status follow-ups or frustration.',
        },
        priority: {
          type: 'string',
          enum: ['normal', 'urgent'],
          description: 'Urgent means the caller needs this handled immediately.',
        },
        continue_session: {
          type: 'boolean',
          description: 'True when this should continue the most recent Claude Code session instead of starting a new task.',
        },
      },
      ['task', 'owner_explicit_start'],
      { messages: toolMessages('', '', { silentStart: true, silentComplete: true }) },
    ),
    functionTool(
      'query_knowledge',
      "Search ExampleCo's Graphiti knowledge graph and memory layer for extracted facts across months of conversations, emails, transcripts, people, decisions, and projects. Use for historical recall and cross-time questions.",
      {
        question: {
          type: 'string',
          description: 'The question to answer from stored knowledge.',
        },
      },
      ['question'],
      { messages: toolMessages('Brain lookup.', 'Brain lookup still running.') },
    ),
    functionTool(
      'spine_snapshot',
      "Read Amy's cloud task spine for active, recent, callback-required, and agent-session work. Use when ExampleCo asks what is active, what happened to a prompt, whether something was picked up, or how a session is going. Treat the result as speakable live state with source packets, not as tool ids for other calls.",
      {
        query: {
          type: 'string',
          description: 'Optional words identifying a task, prompt, topic, or session.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of items to summarize. Defaults to 8.',
        },
        probe_level: {
          type: 'string',
          enum: PROBE_LEVEL_ENUM,
          description: '0 situation, 1 details, 2 evidence, 3 artifacts, 4 exact visible excerpt.',
        },
      },
    ),
    functionTool(
      'graphiti_query_live',
      "Query the EC2 Graphiti brain directly and return the facts in Graphiti's own order with source scope. Use for fast live memory questions when ExampleCo expects Amy to know his history.",
      {
        query: {
          type: 'string',
          description: 'The exact memory question or topic to query in Graphiti.',
        },
        max_facts: {
          type: 'integer',
          description: 'Maximum Graphiti facts to return. Defaults to 15.',
        },
      },
      ['query'],
      { messages: toolMessages('Graphiti lookup.', 'Graphiti lookup still running.') },
    ),
    functionTool(
      'start_agent_session',
      'Start a new cloud Claude or Codex session, attach it to a cloud spine task, and make it monitorable while ExampleCo waits. Use only when ExampleCo explicitly asks to start, run, fix, build, investigate, research, draft, or continue work. Do not use this for frustration, waiting, status follow-ups, or a read-only status lookup when check_spine already found an older or current session.',
      {
        runner: {
          type: 'string',
          enum: ['codex', 'claude'],
          description: 'Preferred cloud runner. Defaults to codex when omitted or unavailable.',
        },
        prompt: {
          type: 'string',
          description: "ExampleCo's raw task or investigation request.",
        },
        owner_explicit_start: {
          type: 'boolean',
          description:
            'Must be true only when ExampleCo explicitly asked to start/run/fix/build/investigate/research/draft/continue work. False for status follow-ups or frustration.',
        },
        callback_requested: {
          type: 'boolean',
          description: 'True when ExampleCo asked to be called back when done, blocked, failed, or needing feedback.',
        },
      },
      ['prompt', 'owner_explicit_start'],
      { messages: toolMessages('', '', { silentStart: true, silentComplete: true }) },
    ),
    functionTool(
      'agent_session_status',
      'Read observable progress for a cloud Claude or Codex session from the spine and progress ledger. Use only with the exact task_id returned by start_agent_session or run_claude_code, not with a Codex thread snapshot id, spoken label, or truncated id from check_spine.',
      {
        task_id: {
          type: 'string',
          description: 'Exact spine task_id returned by start_agent_session or run_claude_code. Do not pass Codex thread snapshot ids such as codex-thread-* or shortened spoken ids.',
        },
        session_id: {
          type: 'string',
          description: 'Alias for task_id only when it is the exact task_id from start_agent_session or run_claude_code.',
        },
        probe_level: {
          type: 'string',
          enum: PROBE_LEVEL_ENUM,
          description: '0 situation, 1 details, 2 evidence, 3 artifacts, 4 exact visible excerpt.',
        },
      },
      [],
      { messages: toolMessages('Session progress lookup.', 'Session progress lookup still running.') },
    ),
    functionTool(
      'callback_commitment',
      'Attach a durable owner callback promise to a cloud spine task. Use when ExampleCo says call me back, even if the task may need feedback or block.',
      {
        task_id: {
          type: 'string',
          description: 'Existing spine task id, if one already exists.',
        },
        reason: {
          type: 'string',
          description: 'Why Amy owes ExampleCo a callback.',
        },
        owner_intent: {
          type: 'string',
          description: 'The task or promise to capture if there is no existing task id.',
        },
      },
    ),
    functionTool(
      'request_approval',
      "Request ExampleCo's approval before sharing personal info or taking consequential actions. Always call before sharing address, phone, email, financial details, or making commitments.",
      {
        request_type: {
          type: 'string',
          enum: ['share_pii', 'transfer_call', 'commit_to_action', 'reputation_risk'],
        },
        description: {
          type: 'string',
          description: "What you're about to do, in plain English.",
        },
        data_category: {
          type: 'string',
          description: 'Type of data: home_address, phone_number, email, employer, financial, etc.',
        },
      },
      ['request_type', 'description'],
    ),
    functionTool(
      'flag_reputation_risk',
      'Flag embarrassing, defamatory, legally risky, or misrepresentational statements. Flag immediately and continue the call.',
      {
        category: {
          type: 'string',
          enum: [
            'false_statement',
            'legal_threat',
            'defamation',
            'misrepresentation',
            'illegal_activity',
            'other',
          ],
        },
        description: {
          type: 'string',
          description: "What was said and why it's a risk.",
        },
        severity: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
        },
        excerpt: {
          type: 'string',
          description: 'Exact quote that triggered the flag.',
        },
      },
      ['category', 'description', 'severity'],
    ),
    functionTool(
      'bridge_in_owner',
      "Connect caller directly to ExampleCo. Ask name first if ExampleCo. Say 'Let me get him for you' and call immediately.",
      {
        caller_name: {
          type: 'string',
          description: "Caller's name. Ask if ExampleCo.",
        },
        topic: {
          type: 'string',
          description: 'One-sentence reason they want ExampleCo.',
        },
      },
      ['caller_name', 'topic'],
    ),
    functionTool(
      'check_spine',
      "Check the status of dev tasks, Codex/Claude sessions, and durable spine items ExampleCo dispatched. Use it whenever he asks 'how is that going', 'what is queued', 'is it done yet', 'what was that session', or while he waits on the line. Pass query and probe_level when he asks about a specific session, then answer directly from this source-backed result instead of dispatching a new coding task or calling agent_session_status with returned labels.",
      {
        query: {
          type: 'string',
          description: 'Optional words identifying the session/task to look up, such as "briefing surface" or "branch cleanliness".',
        },
        detail: {
          type: 'boolean',
          description: 'True when ExampleCo asks what happened in a specific session, prompt, outcome, or history.',
        },
        probe_level: {
          type: 'string',
          enum: PROBE_LEVEL_ENUM,
          description:
            '0 situation, 1 details, 2 evidence/how do you know, 3 artifacts/files/tests/logs, 4 exact visible excerpt. Increase by one when ExampleCo says go deeper.',
        },
      },
      [],
      {
        messages: [
          { type: 'request-start', content: '' },
          { type: 'request-response-delayed', content: '' },
          { type: 'request-complete', role: 'assistant', content: '' },
        ],
      },
    ),
    functionTool(
      'check_todos',
      "Query ExampleCo's personal todo list. Can filter by assignee or priority.",
      {
        assignee: {
          type: 'string',
          enum: ['the owner', 'Amy', 'Claude Code'],
          description: "Filter by who's responsible.",
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Filter by priority level.',
        },
      },
    ),
    functionTool(
      'manage_task',
      "Queue creation or update of a project task or todo item. Use when ExampleCo says 'add a task', 'mark that done', or 'create a todo'. This returns a side-effect receipt with effect_kind=task and status=queued/succeeded/failed. Only describe the task effect that the receipt confirms.",
      {
        action: {
          type: 'string',
          enum: ['create_todo', 'complete_todo', 'create_project_task', 'update_task_status'],
          description: 'What to do.',
        },
        title: {
          type: 'string',
          description: 'Task title for create actions.',
        },
        project_name: {
          type: 'string',
          description: 'Project name for project tasks.',
        },
        task_id: {
          type: 'string',
          description: 'Task ID for updates.',
        },
        status: {
          type: 'string',
          description: 'New status for updates.',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Priority level.',
        },
        assignee: {
          type: 'string',
          enum: ['the owner', 'Amy', 'Claude Code'],
          description: "Who's responsible.",
        },
        notes: {
          type: 'string',
          description: 'Additional notes.',
        },
      },
      ['action'],
    ),
    functionTool(
      'send_message',
      "Send a Telegram message on ExampleCo's behalf. Use when ExampleCo says to message someone or send himself a note.",
      {
        channel: {
          type: 'string',
          enum: ['telegram'],
          description: 'Message channel.',
        },
        message: {
          type: 'string',
          description: 'The message to send.',
        },
      },
      ['channel', 'message'],
    ),
    functionTool(
      'read_briefing_news',
      "Read the latest morning briefing news cards aloud for ExampleCo. Use when ExampleCo says 'read the news'. While in news-reader mode, if ExampleCo says 'skip' or 'next', call action=next_article immediately. If he says 'skip section' or 'next section', call action=next_section immediately. Treat controls as efficiency commands: do not acknowledge, do not say hold on, okay, one moment, or filler, and speak only the tool result. The result includes the section name whenever the cursor enters a new section.",
      {
        action: {
          type: 'string',
          enum: ['start', 'next_article', 'next_section', 'current', 'stop'],
          description:
            'start begins the latest briefing news. next_article advances on skip/next. next_section advances on skip section/next section. current repeats the current article. stop exits news-reader mode.',
        },
        date: {
          type: 'string',
          description:
            'Optional briefing date as YYYY-MM-DD. Omit for the latest briefing. Use today only if ExampleCo explicitly asks for today.',
        },
        reload: {
          type: 'boolean',
          description: 'True to reload the briefing file and restart the cursor.',
        },
      },
      [],
      {
        messages: [
          { type: 'request-start', content: '' },
          { type: 'request-response-delayed', content: '' },
          { type: 'request-complete', role: 'system', content: NEWS_RESULT_ONLY_HINT },
        ],
      },
    ),
    functionTool(
      'read_otter_transcripts',
      'Otter recordings and transcripts indexed by date. Supports list, get, and search actions with date, date_from, date_to, days, transcript_id, and query parameters. Use for live transcript recall and never invent transcript content.',
      {
        action: {
          type: 'string',
          enum: ['list', 'get', 'search'],
          description: 'list transcript inventory, get one transcript chunk, or search transcript text.',
        },
        date: {
          type: 'string',
          description: 'Date for list action, YYYY-MM-DD, today, or yesterday.',
        },
        date_from: {
          type: 'string',
          description: 'Start date for search, YYYY-MM-DD.',
        },
        date_to: {
          type: 'string',
          description: 'End date for search, YYYY-MM-DD.',
        },
        days: {
          type: 'integer',
          description: 'Fallback rolling window for search when dates are omitted.',
        },
        transcript_id: {
          type: 'string',
          description: 'Transcript id returned by action=list.',
        },
        query: {
          type: 'string',
          description: 'Keyword query for action=search.',
        },
      },
      ['action'],
      { messages: toolMessages('Transcript lookup.', 'Transcript lookup still running.') },
    ),
    functionTool(
      'check_calendar',
      "Read ExampleCo's connected calendars. This is a read-only lookup and creates no side-effect receipt. Default to the personal Google Calendar; use Outlook work calendars only when that account is authorized. Use for schedule, availability, meetings, and calendar checks. If authorization is missing or blocked by policy, say that plainly instead of apologizing as if the capability does not exist.",
      {
        account_label: {
          type: 'string',
          description: "Calendar account label to check. Defaults to personal for ExampleCo's personal Google Calendar. Use work only if he asks for the work calendar.",
        },
        days: {
          type: 'integer',
          description: 'How many days of upcoming calendar events to inspect. Defaults to 7.',
        },
        include_subjects: {
          type: 'boolean',
          description: 'True only when ExampleCo asks what the meetings are; otherwise return counts and availability without reading subjects aloud.',
        },
      },
    ),
    functionTool(
      'create_calendar_event',
      "Create an event on ExampleCo's personal Google Calendar after ExampleCo explicitly asks for a calendar event, meeting, appointment, or calendar block. This returns a side-effect receipt with effect_kind=calendar_event and status=succeeded/failed. Only say the event was created when that receipt status is succeeded; otherwise say the tool's failure message plainly.",
      {
        title: {
          type: 'string',
          description: 'Calendar event title.',
        },
        date: {
          type: 'string',
          description: 'Event date: YYYY-MM-DD, today, or tomorrow. Defaults to today when ExampleCo says a same-day time.',
        },
        start_time: {
          type: 'string',
          description: 'Start time. Prefer a concrete local time such as 8 PM, 20:00, or an ISO-like YYYY-MM-DDTHH:mm:ss value.',
        },
        end_time: {
          type: 'string',
          description: 'Optional end time. If omitted, duration_minutes is used.',
        },
        duration_minutes: {
          type: 'integer',
          description: 'Event duration. Defaults to 30 minutes.',
        },
        timezone: {
          type: 'string',
          description: 'IANA timezone. Defaults to America/Chicago.',
        },
        description: {
          type: 'string',
          description: 'Optional event description.',
        },
        account_label: {
          type: 'string',
          description: "Calendar account label. Defaults to personal. Calendar writes currently support ExampleCo's personal Google Calendar.",
        },
      },
      ['title', 'start_time'],
    ),
    functionTool(
      'web_search',
      'Queue current web research through Claude Code and return the result out of band, usually Telegram. Use for current news, businesses, prices, reviews, facts outside local memory, and anything ExampleCo asks Amy to look up on the internet.',
      {
        query: {
          type: 'string',
          description: 'The web research question or lookup request.',
        },
        reason: {
          type: 'string',
          description: 'Optional context explaining why ExampleCo needs the research.',
        },
        priority: {
          type: 'string',
          enum: ['normal', 'urgent'],
          description: 'Urgency of the research request.',
        },
      },
      ['query'],
      { messages: toolMessages('Current source lookup.', 'Current source lookup still running.') },
    ),
  ];

  return JSON.parse(JSON.stringify(tools));
}

function buildWebResearchPrompt(params = {}) {
  const query = String(params.query || params.question || params.task || '').trim();
  const reason = String(params.reason || '').trim();
  const source = String(params.source || 'Amy phone call').trim();
  const callId = String(params.callId || '').trim();
  const lines = [
    'Web research request from Amy.',
    '',
    'Research query:',
    query || '(missing query)',
  ];
  if (reason) {
    lines.push('', 'Context:', reason);
  }
  lines.push(
    '',
    'Source: ' + source + (callId ? ' (' + callId + ')' : ''),
    '',
    'Use current web sources. Summarize the answer concisely, include source links, and send a Telegram-ready result. If the answer depends on dates, include concrete dates.',
  );
  return lines.join('\n');
}

module.exports = {
  VAPI_FUNCTION_TOOL_NAMES,
  TOOL_RESULT_ONLY_HINT,
  buildVapiFunctionTools,
  buildWebResearchPrompt,
};
