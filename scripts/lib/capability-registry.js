'use strict';

const { buildVapiFunctionTools } = require('./vapi-tool-contract.js');

const VAPI_INPUT_SCHEMAS = new Map(
  buildVapiFunctionTools().flatMap((tool) =>
    tool.function?.name ? [[tool.function.name, tool.function.parameters]] : [],
  ),
);

const GENERIC_OUTPUT = {
  type: 'object',
  additionalProperties: true,
};

const RECEIPT_SCHEMA = {
  type: 'object',
  required: ['receipt_id', 'turn_id', 'tool', 'status', 'ts'],
  properties: {
    receipt_id: { type: 'string' },
    turn_id: { type: 'string' },
    tool: { type: 'string' },
    status: { enum: ['succeeded', 'failed', 'denied', 'queued'] },
    ts: { type: 'string' },
  },
};

const CALL_INPUT_SCHEMA = {
  type: 'object',
  required: [
    'recipient', 'phone_number', 'objective', 'script', 'prep_manifest', 'ivr_plan',
    'end_condition', 'compartmentalization_scope', 'qc_simulation',
  ],
  properties: {
    recipient: { type: 'string' },
    phone_number: { type: 'string' },
    objective: { type: 'string' },
    script: { type: 'string' },
    prep_manifest: {
      type: 'array',
      items: {
        type: 'object',
        required: ['field', 'source_path'],
        properties: { field: { type: 'string' }, source_path: { type: 'string' }, value: {} },
      },
    },
    ivr_plan: { type: 'string' },
    end_condition: { type: 'string' },
    compartmentalization_scope: { type: 'string' },
    qc_simulation: {
      type: 'object',
      required: ['mode', 'transcript', 'interruption_case', 'failure_case'],
      properties: {
        mode: { enum: ['offline_self_roleplay'] },
        transcript: {
          type: 'array',
          minItems: 4,
          items: {
            type: 'object',
            required: ['role', 'text'],
            properties: { role: { enum: ['amy', 'callee'] }, text: { type: 'string' } },
          },
        },
        interruption_case: { type: 'string' },
        failure_case: { type: 'string' },
      },
    },
  },
};

function descriptor(name, description, options = {}) {
  const effect = options.effect || 'read';
  return Object.freeze({
    name,
    description,
    input_schema:
      options.input_schema ||
      VAPI_INPUT_SCHEMAS.get(name) ||
      { type: 'object', additionalProperties: true },
    output_schema: options.output_schema || GENERIC_OUTPUT,
    execution_placement: options.execution_placement || 'ec2',
    effect,
    authorization_policy:
      options.authorization_policy ||
      (effect === 'read'
        ? 'owner_verified_read'
        : effect === 'internal_write'
          ? 'owner_verified_internal_write'
          : 'owner_current_turn_dispatch'),
    credential_reference: options.credential_reference || 'none',
    idempotency_policy:
      options.idempotency_policy ||
      (effect === 'read' ? 'turn_tool_arguments_cache' : 'turn_tool_arguments_exactly_once'),
    timeout_and_retry_policy: options.timeout_and_retry_policy || {
      timeout_ms: 30_000,
      retries: effect === 'read' ? 1 : 0,
    },
    health_probe: options.health_probe || { type: 'executor_preflight' },
    // Names the registered verifier that may prove this capability's work
    // finished on the other host. Null means it can never be proven complete,
    // which is the fail-closed default for anything running off-box.
    completion_proof: options.completion_proof || null,
    receipt_schema: RECEIPT_SCHEMA,
    executor: options.executor || name,
  });
}

const read = (name, description, executor = name, options = {}) =>
  descriptor(name, description, { ...options, executor, effect: 'read' });
const internal = (name, description, executor = name, options = {}) =>
  descriptor(name, description, { ...options, executor, effect: 'internal_write' });
const external = (name, description, executor = name, options = {}) =>
  descriptor(name, description, { ...options, executor, effect: 'external_side_effect' });

const CAPABILITY_REGISTRY = Object.freeze([
  read('otter-query', 'ExampleCo\'s Otter calls, processed first: {"id"} returns the speaker-labeled transcript (confirmed names, (guess), [speaker not named]); {"query"} finds calls by person or words. Raw text only for unprocessed calls.', 'otter_query'),
  read('transcript-fastpath', 'List the most recent Otter calls with ids; read one with otter-query {"id"}.', 'otter_recent'),
  read('read_otter_transcripts', 'Read Otter calls processed first: {"id"} returns the speaker-labeled transcript; {"query"} searches by person or words.', 'otter_query'),
  read('unified_knowledge_search', 'Search owner-private transcripts, email, Signal, Telegram, People, and desktop/cloud sessions through the shared FTS5 evidence reader.', 'unified_knowledge_search'),
  read('query_knowledge', 'Compatibility alias for the shared owner-private FTS5 knowledge reader.', 'query_knowledge'),
  read('memory_search', 'Search canonical SecondBrain memory with file and excerpt evidence.'),
  read('memory_read_block', 'Read an approved canonical memory block.'),
  read('graphiti_search', 'Search Amy\'s Graphiti knowledge graph.', 'graphiti_search'),
  read('sb_session_search', 'Search cloud-saved Claude and Codex prompts, responses, and durable Amy session history.', 'session_search'),
  read('contacts_lookup', 'Read a named person record from canonical contacts.'),
  read('contacts_index', 'List canonical contact records.'),
  read('gmail_search', 'Search authenticated Gmail.', 'gmail_search', {
    credential_reference: 'gmail_oauth_owner',
  }),
  read('gmail_read_thread', 'Read an authenticated Gmail thread.', 'gmail_read_thread', {
    credential_reference: 'gmail_oauth_owner',
  }),
  internal('gmail_create_draft', 'Create a Gmail draft without sending it.', 'gmail_create_draft', {
    credential_reference: 'gmail_oauth_owner',
    input_schema: {
      type: 'object', required: ['to', 'subject', 'body'],
      properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, thread_id: { type: 'string' } },
    },
  }),
  external('gmail_send', 'Send one existing Gmail draft after draft-specific owner authorization.', 'gmail_send', {
    credential_reference: 'gmail_oauth_owner',
    authorization_policy: 'new_human_email_send',
    input_schema: {
      type: 'object', required: ['draft_id'], properties: { draft_id: { type: 'string' } },
    },
  }),
  read('briefing_today', 'Read the latest durable executive briefing.'),
  read('briefing_action_items', 'Read current briefing action items.'),
  read('caller_auth_status', 'Read caller authentication evidence.', 'caller_auth_status'),
  external('place_outbound_call', 'Place an authorized outbound call through the call broker.', 'place_outbound_call', {
    credential_reference: 'vapi_outbound_owner',
    authorization_policy: 'owner_current_turn_call',
    idempotency_policy: 'write_before_dial_invocation_key',
    input_schema: CALL_INPUT_SCHEMA,
  }),
  external('call_owner', 'Call ExampleCo at the configured owner number.', 'call_owner', {
    credential_reference: 'vapi_outbound_owner',
    authorization_policy: 'owner_current_turn_call',
    idempotency_policy: 'write_before_dial_invocation_key',
    input_schema: {
      type: 'object',
      required: ['recipient', 'objective', 'qc_simulation'],
      properties: {
        recipient: { type: 'string', description: 'Use ExampleCo when the owner said call me.' },
        objective: { type: 'string' },
        first_message: { type: 'string' },
        qc_simulation: CALL_INPUT_SCHEMA.properties.qc_simulation,
      },
    },
  }),
  external('telegram_send', 'Send an additional owner-requested Telegram message.', 'telegram_send'),
  external('signal_send', 'Send an owner-requested Signal message with optional attachments.', 'signal_send', {
    credential_reference: 'signal_linked_device',
    idempotency_policy: 'write_before_send_invocation_key',
    timeout_and_retry_policy: { timeout_ms: 180_000, retries: 0 },
    input_schema: {
      type: 'object',
      required: ['recipient'],
      properties: {
        recipient: { type: 'string' },
        message: { type: 'string' },
        attachments: { type: 'array', items: { type: 'string' } },
      },
    },
  }),
  read('check_calendar', 'Read connected calendar events.', 'check_calendar', {
    credential_reference: 'google_calendar_owner',
  }),
  external('create_calendar_event', 'Create an owner-requested calendar event.', 'create_calendar_event', {
    credential_reference: 'google_calendar_owner',
  }),
  internal('run_test_suite', 'Queue an isolated repository test task.', 'code_task'),
  read('pipeline_heartbeat', 'Read durable pipeline health evidence.'),
  read('web_search', 'Research the current public web through a subscription agent task.', 'web_task'),
  internal('run_claude_code', 'Start an isolated subscription coding task through the Spine.', 'code_task'),
  read('query_knowledge', 'Compatibility alias for the shared owner-private FTS5 knowledge reader.', 'query_knowledge'),
  read('spine_snapshot', 'Read active and recent Task Spine state.', 'spine_snapshot'),
  read('graphiti_query_live', 'Search live Graphiti facts.', 'graphiti_search'),
  internal('start_agent_session', 'Start a durable isolated agent task.', 'code_task'),
  read('agent_session_status', 'Read a durable agent task status.', 'agent_session_status'),
  internal('callback_commitment', 'Record a callback commitment in durable task state.', 'callback_commitment'),
  internal('request_approval', 'Hold one scoped action and open a durable owner decision that resumes the exact originating surface.', 'request_approval', {
    input_schema: {
      type: 'object',
      properties: {
        request_type: {
          type: 'string',
          enum: ['share_pii', 'transfer_call', 'commit_to_action', 'reputation_risk'],
        },
        description: {
          type: 'string',
          description: 'Secret-safe purpose and scope. Never include the PII value itself.',
        },
        data_category: { type: 'string' },
        ttl_ms: { type: 'number' },
        kind: { type: 'string' },
        subject_ref: { type: 'string' },
        draft_id: { type: 'string' },
        task_id: { type: 'string' },
        allowed_responses: { type: 'array', items: { type: 'string' } },
      },
    },
    timeout_and_retry_policy: { timeout_ms: 7.25 * 60 * 1000, retries: 0 },
  }),
  internal('flag_reputation_risk', 'Record a reputation-risk flag.', 'internal_event'),
  external('bridge_in_owner', 'Bridge ExampleCo into an already-active authenticated voice call.', 'bridge_in_owner', {
    credential_reference: 'vapi_active_call_context',
    authorization_policy: 'owner_current_turn_dispatch',
  }),
  read('check_todos', 'Read canonical task state.', 'spine_snapshot'),
  read('check_spine', 'Read canonical Task Spine state.', 'spine_snapshot'),
  internal('manage_task', 'Create or update a Task Spine item.', 'manage_task'),
  external('send_message', 'Send an owner-requested message through Telegram or Signal.', 'send_message'),
  read('read_briefing_news', 'Read the current briefing news evidence.', 'briefing_today'),
  read('aws_cost_usage', 'Read Cost Explorer usage for every configured AWS account.', 'aws_cost_usage', {
    credential_reference: 'aws_cost_explorer_roles',
    timeout_and_retry_policy: { timeout_ms: 60_000, retries: 1 },
  }),
  internal('start_code_task', 'Start an isolated subscription coding task through the Spine.', 'code_task'),
  internal(
    'steer_task',
    'Change or cancel open owner-dispatched Spine work (a change of plan). Interrupts the live attempt and restarts it in the same worktree with the new instruction; never starts a second task.',
    'steer_task',
    {
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['amend', 'cancel'] },
          instruction: { type: 'string' },
          task_hint: { type: 'string' },
          task_id: { type: 'string' },
        },
        required: ['action'],
      },
    },
  ),
  read(
    'check_dev_sessions',
    'Read current and recently completed Claude and Codex activities from the cloud session projection, including terminal receipt proof.',
    'session_cloud_snapshot',
    {
      input_schema: {
        type: 'object',
        properties: {
          recent_hours: { type: 'number' },
          limit: { type: 'number' },
        },
      },
    },
  ),
  read(
    'check_desktop_dev_sessions',
    'Read current active Codex and Claude development sessions from the authenticated desktop session registry.',
    'desktop_session_snapshot',
    {
      execution_placement: 'desktop_relay',
      credential_reference: 'desktop_signed_relay',
      completion_proof: 'desktop_signed_receipt',
      input_schema: {
        type: 'object',
        properties: {
          stale_after_minutes: { type: 'number' },
          limit: { type: 'number' },
        },
      },
      timeout_and_retry_policy: { timeout_ms: 60_000, retries: 0 },
    },
  ),
  // The executor waits a bounded window for the desktop to acknowledge or
  // finish, so these timeouts must outlive that wait. If they do not, the caller
  // sees an opaque broker timeout instead of the true queued/accepted/failed
  // state, which is the fabrication this capability already caused once.
  external('desktop_browser_task', 'Send an owner-requested browser task to the authenticated desktop relay and report whether it was confirmed.', 'desktop_relay', {
    execution_placement: 'desktop_relay',
    credential_reference: 'desktop_signed_relay',
    completion_proof: 'desktop_signed_receipt',
    input_schema: { type: 'object', required: ['task'], properties: { task: { type: 'string' } } },
    timeout_and_retry_policy: { timeout_ms: 60_000, retries: 0 },
  }),
  external('desktop_app_task', 'Send an owner-requested Windows app task to the authenticated desktop relay and report whether it was confirmed.', 'desktop_relay', {
    execution_placement: 'desktop_relay',
    credential_reference: 'desktop_signed_relay',
    completion_proof: 'desktop_signed_receipt',
    input_schema: { type: 'object', required: ['task'], properties: { task: { type: 'string' }, app: { type: 'string' } } },
    timeout_and_retry_policy: { timeout_ms: 60_000, retries: 0 },
  }),
]);

const CAPABILITY_BY_NAME = new Map(CAPABILITY_REGISTRY.map((item) => [item.name, item]));

module.exports = { CAPABILITY_BY_NAME, CAPABILITY_REGISTRY, RECEIPT_SCHEMA, descriptor };
