/**
 * Tests for the query_knowledge inline-answer fix.
 *
 * Before this fix, query_knowledge added to queryQueue and polled queryAnswers,
 * which was never populated — always timing out after 25s.
 *
 * After the fix: query_knowledge calls askAmy() inline and returns the answer
 * directly within Vapi's timing window (<20s).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  VAPI_FUNCTION_TOOL_NAMES,
  buildVapiFunctionTools,
} = require('../../../scripts/lib/vapi-tool-contract');

// ── Simulate the key behaviors from ec2-server.js ───────────────────────────

const VAPI_SERVER_URL = 'https://unay54a6jh.execute-api.us-east-1.amazonaws.com/prod/vapi/webhook';

const VAPI_FUNCTION_TOOLS = buildVapiFunctionTools();

// Simulates the new inline query_knowledge handler
async function handleQueryKnowledge(
  question: string,
  askAmyFn: (q: string) => Promise<string>,
  timeoutMs = 20000,
): Promise<{ result: string }> {
  try {
    const answer = await Promise.race([
      askAmyFn(question),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    return { result: answer || "I couldn't find that right now." };
  } catch {
    return { result: "I had trouble looking that up. I'll send you the answer on Telegram." };
  }
}

// Simulates the updated initiateVapiOutbound body builder
function buildOutboundCallBody(
  to: string,
  message: string,
  vapiPhoneNumberId: string,
  assistantId?: string,
) {
  return {
    phoneNumberId: vapiPhoneNumberId || undefined,
    assistantId: assistantId || undefined,
    customer: { number: to },
    assistantOverrides: {
      firstMessage: message,
      serverUrl: VAPI_SERVER_URL,
      model: {
        tools: VAPI_FUNCTION_TOOLS,
      },
    },
  };
}

describe('query_knowledge — inline answer fix', () => {
  it('returns askAmy answer directly without polling', async () => {
    const mockAskAmy = vi.fn().mockResolvedValue('PRIVATE_NAME Paruchuri is a contact at Amazon.');
    const result = await handleQueryKnowledge('Who is PRIVATE_NAME?', mockAskAmy);
    expect(result.result).toBe('PRIVATE_NAME Paruchuri is a contact at Amazon.');
    expect(mockAskAmy).toHaveBeenCalledWith('Who is PRIVATE_NAME?');
  });

  it('returns fallback when askAmy times out', async () => {
    const slowAskAmy = vi
      .fn()
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('answer'), 5000)),
      );
    const result = await handleQueryKnowledge('Who is PRIVATE_NAME?', slowAskAmy, 10);
    expect(result.result).toContain('I had trouble');
  });

  it('returns fallback when askAmy throws', async () => {
    const failingAskAmy = vi.fn().mockRejectedValue(new Error('API error'));
    const result = await handleQueryKnowledge('Who is PRIVATE_NAME?', failingAskAmy);
    expect(result.result).toContain('I had trouble');
  });

  it('returns placeholder when askAmy returns empty string', async () => {
    const emptyAskAmy = vi.fn().mockResolvedValue('');
    const result = await handleQueryKnowledge('anything', emptyAskAmy);
    expect(result.result).toBe("I couldn't find that right now.");
  });
});

describe('VAPI_FUNCTION_TOOLS', () => {
  it('includes dtmf tool', () => {
    expect(VAPI_FUNCTION_TOOLS.some((t: any) => t.type === 'dtmf')).toBe(true);
  });

  it('includes query_knowledge', () => {
    const tool = VAPI_FUNCTION_TOOLS.find((t: any) => t.function?.name === 'query_knowledge');
    expect(tool).toBeDefined();
    expect(tool!.type).toBe('function');
    expect((tool as any).function.parameters.required).toContain('question');
  });

  it('includes run_claude_code', () => {
    const tool = VAPI_FUNCTION_TOOLS.find((t: any) => t.function?.name === 'run_claude_code');
    expect(tool).toBeDefined();
    expect((tool as any).function.parameters.required).toContain('task');
    expect(Object.keys((tool as any).function.parameters.properties)).toContain('continue_session');
  });

  it('includes flag_reputation_risk', () => {
    const tool = VAPI_FUNCTION_TOOLS.find((t: any) => t.function?.name === 'flag_reputation_risk');
    expect(tool).toBeDefined();
    expect((tool as any).function.parameters.required).toContain('severity');
  });

  it('includes web_search, read_otter_transcripts, check_calendar, and create_calendar_event', () => {
    const names = VAPI_FUNCTION_TOOLS.map((t: any) => t.function?.name).filter(Boolean);
    expect(names).toContain('web_search');
    expect(names).toContain('read_otter_transcripts');
    expect(names).toContain('check_calendar');
    expect(names).toContain('create_calendar_event');
  });

  it('lets check_spine answer detailed session follow-ups without dispatching code', () => {
    const tool = VAPI_FUNCTION_TOOLS.find((t: any) => t.function?.name === 'check_spine');
    expect(tool).toBeDefined();
    const props = (tool as any).function.parameters.properties;
    expect(props.query.description).toMatch(/session|task/i);
    expect(props.detail.description).toMatch(/specific session/i);
    expect((tool as any).function.description).toMatch(/instead of dispatching a new coding task/i);
    expect((tool as any).function.description).toMatch(/answer directly from this source-backed result/i);
  });

  it('does not let agent launch/status tools steal read-only spine status lookups', () => {
    const startAgent = VAPI_FUNCTION_TOOLS.find((t: any) => t.function?.name === 'start_agent_session');
    const statusTool = VAPI_FUNCTION_TOOLS.find((t: any) => t.function?.name === 'agent_session_status');
    const statusProps = (statusTool as any).function.parameters.properties;

    expect((startAgent as any).function.description).toMatch(/or a read-only status lookup/i);
    expect((statusTool as any).function.description).toMatch(/exact task_id/i);
    expect((statusTool as any).function.description).toMatch(/not with a Codex thread snapshot id/i);
    expect(statusProps.task_id.description).toMatch(/Do not pass Codex thread snapshot ids/i);
  });

  it('keeps check_spine silent while the server speaks the source result', () => {
    const checkSpine = VAPI_FUNCTION_TOOLS.find((t: any) => t.function?.name === 'check_spine');
    const queryKnowledge = VAPI_FUNCTION_TOOLS.find((t: any) => t.function?.name === 'query_knowledge');
    const startAgent = VAPI_FUNCTION_TOOLS.find((t: any) => t.function?.name === 'start_agent_session');
    expect((checkSpine as any).messages).toEqual([
      { type: 'request-start', content: '' },
      { type: 'request-response-delayed', content: '' },
      { type: 'request-complete', role: 'assistant', content: '' },
    ]);
    expect((queryKnowledge as any).messages?.[0]?.type).toBe('request-start');
    expect((startAgent as any).messages?.[0]?.type).toBe('request-complete');
  });

  it('has the full phone tool contract plus dtmf', () => {
    expect(VAPI_FUNCTION_TOOLS).toHaveLength(VAPI_FUNCTION_TOOL_NAMES.length + 1);
  });
});

describe('initiateVapiOutbound — tool config fix', () => {
  it('includes serverUrl in assistantOverrides', () => {
    const body = buildOutboundCallBody('+15551234567', 'Hi there', 'phone-id-123');
    expect(body.assistantOverrides.serverUrl).toBe(VAPI_SERVER_URL);
  });

  it('includes VAPI_FUNCTION_TOOLS in assistantOverrides.model.tools', () => {
    const body = buildOutboundCallBody('+15551234567', 'Hi there', 'phone-id-123');
    expect(body.assistantOverrides.model.tools).toHaveLength(VAPI_FUNCTION_TOOL_NAMES.length + 1);
    expect(
      body.assistantOverrides.model.tools.some((t: any) => t.function?.name === 'query_knowledge'),
    ).toBe(true);
  });

  it('uses VAPI_PHONE_NUMBER_ID as phoneNumberId, not customer number', () => {
    const phoneNumberId = 'vapi-phone-number-id';
    const customerNumber = '+15551234567';
    const body = buildOutboundCallBody(customerNumber, 'message', phoneNumberId);
    expect(body.phoneNumberId).toBe(phoneNumberId);
    expect(body.customer.number).toBe(customerNumber);
    // phoneNumberId should NOT equal customer number
    expect(body.phoneNumberId).not.toBe(body.customer.number);
  });

  it('includes the firstMessage', () => {
    const body = buildOutboundCallBody('+15551234567', 'Hello the owner, your task is done.', 'pid');
    expect(body.assistantOverrides.firstMessage).toBe('Hello the owner, your task is done.');
  });
});
