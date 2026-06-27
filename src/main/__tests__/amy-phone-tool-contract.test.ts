import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('Amy phone-call tool contract', () => {
  const requiredTools = [
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

  it('versioned Amy exposes every phone-call tool and keeps web research ready', () => {
    const src = read('src/main/amy-versions.ts');

    for (const name of requiredTools) {
      expect(src, `amy-versions.ts must expose ${name} to Vapi`).toContain(`name: '${name}'`);
    }

    expect(src, 'run_claude_code must support continuing the current coding context').toContain(
      'continue_session',
    );

    expect(src, 'Web Research must not be presented to Amy as unavailable').toMatch(
      /name:\s*'Web Research'[\s\S]{0,500}availability:\s*'ready'/,
    );
    expect(src, 'Check Calendar must be a real phone capability, not a coming-soon apology').toMatch(
      /name:\s*'Check Calendar'[\s\S]{0,500}availability:\s*'ready'/,
    );
  });

  it('EC2 uses the shared Vapi tool contract and handles web_search', () => {
    const src = read('ec2-server.js');

    expect(src).toContain('buildVapiFunctionTools');
    expect(src).toContain('buildWebResearchPrompt');
    expect(src).toContain('const VAPI_FUNCTION_TOOLS = buildVapiFunctionTools();');
    expect(src).toContain("case 'web_search'");
    expect(src).toContain("case 'check_calendar'");
    expect(src).toContain("case 'create_calendar_event'");
    expect(src).toContain('handleCheckCalendar');
    expect(src).toContain('handleCreateCalendarEvent');
  });

  it('voice callback failures fall back visibly instead of being marked delivered', () => {
    const src = read('ec2-server.js');

    expect(src).toContain("kind: 'cmd-result-callback-failed'");
    expect(src).toContain('callbackResult._ok === false');
    expect(src).toContain('callbackResult.error');
    expect(src).toContain("cmd.deliveryStatus = 'failed'");
    expect(src).toContain("if (cmd.deliveryStatus !== 'failed') cmd.deliveryStatus = 'delivered'");
  });

  it('completed side-effect claims require matching side-effect receipts', () => {
    const contract = read('scripts/lib/vapi-tool-contract.js');
    const amyVersions = read('src/main/amy-versions.ts');
    const ec2 = read('ec2-server.js');

    for (const src of [contract, amyVersions]) {
      expect(src).toContain('side-effect receipt');
      expect(src).toContain('effect_kind');
      expect(src).toContain('status');
    }

    expect(ec2).toContain('recordEffectReceipt');
    expect(ec2).toContain('formatEffectToolResult');
    expect(ec2).toContain('Calendar write access is not authorized');
    expect(ec2).toContain('I did not create anything');
  });

  it('standalone Vapi push script declares the canonical tools instead of preserving drift', () => {
    const src = read('scripts/push-amy-vapi-config.js');

    expect(src).toContain('buildVapiFunctionTools');
    expect(src).toContain('tools: buildVapiFunctionTools()');
    expect(src).toContain('For session/status questions, CALL check_spine FIRST');
    expect(src).toContain('Do NOT dispatch run_claude_code for read-only session lookup');
    expect(src).toContain('VAPI_WEBHOOK_SECRET');
    expect(src).toContain('VAPI_INBOUND_PHONE_NUMBER_ID');
    expect(src).toContain('VAPI_PHONE_NUMBER_ID');
    expect(src).toContain('config.vapiInboundPhoneNumberId');
    expect(src).toContain('config.vapiPhoneNumberId');
    expect(src).toContain('const vapiPhoneNumberIds = [');
    expect(src).toContain('patchPhoneNumberServers(vapiPhoneNumberIds, payload.server)');
    expect(src).toContain('assistantId: config.callbackAssistantId');
    expect(src).toContain("'x-vapi-secret'");
    expect(src).toContain('/phone-number/');
    expect(src).not.toContain('const vapiInboundPhoneNumberId =');
    expect(src).not.toContain('tools: existingTools');
  });

  it('tool registry makes web search routable from the Vapi surface', () => {
    const src = read('src/main/tool-router-registry.ts');
    const webSearchEntry = /name:\s*'web_search'[\s\S]*?surfaces:\s*\[([^\]]+)\]/.exec(src);
    const calendarEntry = /name:\s*'check_calendar'[\s\S]*?surfaces:\s*\[([^\]]+)\]/.exec(src);

    expect(webSearchEntry, 'web_search registry entry missing').not.toBeNull();
    expect(webSearchEntry?.[1]).toContain("'vapi'");
    expect(calendarEntry, 'check_calendar registry entry missing').not.toBeNull();
    expect(calendarEntry?.[1]).toContain("'vapi'");

    const createCalendarEntry = /name:\s*'create_calendar_event'[\s\S]*?surfaces:\s*\[([^\]]+)\]/.exec(src);
    expect(createCalendarEntry, 'create_calendar_event registry entry missing').not.toBeNull();
    expect(createCalendarEntry?.[1]).toContain("'vapi'");
  });
});
