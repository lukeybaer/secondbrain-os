'use strict';

const VAPI_FUNCTION_TOOL_NAMES = [
  'run_claude_code',
  'query_knowledge',
  'request_approval',
  'flag_reputation_risk',
  'bridge_in_owner',
  'check_project_status',
  'check_todos',
  'manage_task',
  'send_message',
  'read_otter_transcripts',
  'check_calendar',
  'create_calendar_event',
  'web_search',
];

function functionTool(name, description, properties, required = []) {
  return {
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
}

function buildVapiFunctionTools() {
  const tools = [
    { type: 'dtmf' },
    functionTool(
      'run_claude_code',
      "Dispatch substantive work to Claude Code in a detached background session. Use for coding, debugging, research, drafting, investigation, and any task too deep for a live voice answer. If it finishes quickly, the answer can be spoken inline; otherwise the result is delivered out of band, usually Telegram, or by callback only when explicitly requested.",
      {
        task: {
          type: 'string',
          description: 'Clear task for Claude Code, including context, desired output, and any source files or systems to inspect.',
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
      ['task'],
    ),
    functionTool(
      'query_knowledge',
      "Search Luke's Graphiti knowledge graph and memory layer for extracted facts across months of conversations, emails, transcripts, people, decisions, and projects. Use for historical recall and cross-time questions.",
      {
        question: {
          type: 'string',
          description: 'The question to answer from stored knowledge.',
        },
      },
      ['question'],
    ),
    functionTool(
      'request_approval',
      "Request Luke's approval before sharing personal info or taking consequential actions. Always call before sharing address, phone, email, financial details, or making commitments.",
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
      "Connect caller directly to Luke. Ask name first if unknown. Say 'Let me get him for you' and call immediately.",
      {
        caller_name: {
          type: 'string',
          description: "Caller's name. Ask if unknown.",
        },
        topic: {
          type: 'string',
          description: 'One-sentence reason they want Luke.',
        },
      },
      ['caller_name', 'topic'],
    ),
    functionTool(
      'check_project_status',
      'Query active projects and their task statuses. Use when Luke asks about project progress, task counts, or what needs attention.',
      {
        project_name: {
          type: 'string',
          description: 'Optional filter to a specific project by name.',
        },
      },
    ),
    functionTool(
      'check_todos',
      "Query Luke's personal todo list. Can filter by assignee or priority.",
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
      "Queue creation or update of a project task or todo item. Use when Luke says 'add a task', 'mark that done', or 'create a todo'. This returns a side-effect receipt with effect_kind=task and status=queued/succeeded/failed. Only describe the task effect that the receipt confirms.",
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
      "Send a Telegram message on Luke's behalf. Use when Luke says to message someone or send himself a note.",
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
    ),
    functionTool(
      'check_calendar',
      "Read Luke's connected calendars. This is a read-only lookup and creates no side-effect receipt. Default to the personal Google Calendar; use Outlook work calendars only when that account is authorized. Use for schedule, availability, meetings, and calendar checks. If authorization is missing or blocked by policy, say that plainly instead of apologizing as if the capability does not exist.",
      {
        account_label: {
          type: 'string',
          description: "Calendar account label to check. Defaults to personal for Luke's personal Google Calendar. Use work only if he asks for the work calendar.",
        },
        days: {
          type: 'integer',
          description: 'How many days of upcoming calendar events to inspect. Defaults to 7.',
        },
        include_subjects: {
          type: 'boolean',
          description: 'True only when Luke asks what the meetings are; otherwise return counts and availability without reading subjects aloud.',
        },
      },
    ),
    functionTool(
      'create_calendar_event',
      "Create an event on Luke's personal Google Calendar after Luke explicitly asks for a calendar event, meeting, appointment, or calendar block. This returns a side-effect receipt with effect_kind=calendar_event and status=succeeded/failed. Only say the event was created when that receipt status is succeeded; otherwise say the tool's failure message plainly.",
      {
        title: {
          type: 'string',
          description: 'Calendar event title.',
        },
        date: {
          type: 'string',
          description: 'Event date: YYYY-MM-DD, today, or tomorrow. Defaults to today when Luke says a same-day time.',
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
          description: "Calendar account label. Defaults to personal. Calendar writes currently support Luke's personal Google Calendar.",
        },
      },
      ['title', 'start_time'],
    ),
    functionTool(
      'web_search',
      'Queue current web research through Claude Code and return the result out of band, usually Telegram. Use for current news, businesses, prices, reviews, facts outside local memory, and anything Luke asks Amy to look up on the internet.',
      {
        query: {
          type: 'string',
          description: 'The web research question or lookup request.',
        },
        reason: {
          type: 'string',
          description: 'Optional context explaining why Luke needs the research.',
        },
        priority: {
          type: 'string',
          enum: ['normal', 'urgent'],
          description: 'Urgency of the research request.',
        },
      },
      ['query'],
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
  buildVapiFunctionTools,
  buildWebResearchPrompt,
};
