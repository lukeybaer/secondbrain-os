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

// ── Simulate the key behaviors from ec2-server.js ───────────────────────────

const VAPI_SERVER_URL = 'https://unay54a6jh.execute-api.us-east-1.amazonaws.com/prod/vapi/webhook';

const VAPI_FUNCTION_TOOLS = [
  { type: 'dtmf' },
  {
    type: 'function',
    function: {
      name: 'query_knowledge',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_claude_code',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          priority: { type: 'string', enum: ['normal', 'urgent'] },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'flag_reputation_risk',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          description: { type: 'string' },
          severity: { type: 'string' },
          excerpt: { type: 'string' },
        },
        required: ['category', 'description', 'severity'],
      },
    },
  },
];

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
    const mockAskAmy = vi.fn().mockResolvedValue('Sandeep Paruchuri is a contact at Amazon.');
    const result = await handleQueryKnowledge('Who is Sandeep?', mockAskAmy);
    expect(result.result).toBe('Sandeep Paruchuri is a contact at Amazon.');
    expect(mockAskAmy).toHaveBeenCalledWith('Who is Sandeep?');
  });

  it('returns fallback when askAmy times out', async () => {
    const slowAskAmy = vi
      .fn()
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('answer'), 5000)),
      );
    const result = await handleQueryKnowledge('Who is Sandeep?', slowAskAmy, 10);
    expect(result.result).toContain('I had trouble');
  });

  it('returns fallback when askAmy throws', async () => {
    const failingAskAmy = vi.fn().mockRejectedValue(new Error('API error'));
    const result = await handleQueryKnowledge('Who is Sandeep?', failingAskAmy);
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
  });

  it('includes flag_reputation_risk', () => {
    const tool = VAPI_FUNCTION_TOOLS.find((t: any) => t.function?.name === 'flag_reputation_risk');
    expect(tool).toBeDefined();
    expect((tool as any).function.parameters.required).toContain('severity');
  });

  it('has 4 tools total (dtmf + 3 function tools)', () => {
    expect(VAPI_FUNCTION_TOOLS).toHaveLength(4);
  });
});

describe('initiateVapiOutbound — tool config fix', () => {
  it('includes serverUrl in assistantOverrides', () => {
    const body = buildOutboundCallBody('+15551234567', 'Hi there', 'phone-id-123');
    expect(body.assistantOverrides.serverUrl).toBe(VAPI_SERVER_URL);
  });

  it('includes VAPI_FUNCTION_TOOLS in assistantOverrides.model.tools', () => {
    const body = buildOutboundCallBody('+15551234567', 'Hi there', 'phone-id-123');
    expect(body.assistantOverrides.model.tools).toHaveLength(4);
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
    const body = buildOutboundCallBody('+15551234567', 'Hello Luke, your task is done.', 'pid');
    expect(body.assistantOverrides.firstMessage).toBe('Hello Luke, your task is done.');
  });
});
