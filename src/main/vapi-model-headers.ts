import voicePrimary from '../../scripts/lib/voice-primary.js';
import voicePolicy from '../../config/voice-runtime-policy.json';
import contract from '../../scripts/lib/vapi-call-correlation-contract.json';

// Use the bundled canonical policy; the compiled directory is not the source root.
export function resolveVoicePrimary(options: { env?: NodeJS.ProcessEnv } = {}) {
  return voicePrimary.resolveVoicePrimary({ ...options, policy: voicePolicy });
}

export const VAPI_SUBSCRIPTION_VOICE_MODEL = contract.voiceModel;

function normalizeCallId(value = ''): string {
  const candidate = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    candidate,
  )
    ? candidate
    : '';
}

function markerValue(callId = '', allowUnresolvedTemplate = false): string {
  const normalized = normalizeCallId(callId);
  if (normalized) return normalized;
  if (allowUnresolvedTemplate) return contract.callIdTemplate;
  throw new Error('Vapi model configuration requires a literal call correlation UUID.');
}

export function buildVapiModelHeaders(
  authSecret = '',
  callId = '',
  options: { allowUnresolvedTemplate?: boolean } = {},
): Record<string, string> {
  return {
    [contract.callIdHeader]: markerValue(callId, options.allowUnresolvedTemplate === true),
    ...(authSecret ? { [contract.modelAuthHeader]: authSecret } : {}),
  };
}

export function withVapiCallIdMarker(
  prompt = '',
  callId = '',
  options: { allowUnresolvedTemplate?: boolean } = {},
): string {
  const marker = `AMY_CALL_ID=${markerValue(callId, options.allowUnresolvedTemplate === true)}`;
  const lines = String(prompt || '').split(/\r?\n/);
  const alreadyMarked = lines[0]?.trim() === marker;
  const withoutTemplate = (alreadyMarked ? lines.slice(1) : lines)
    .map((line) =>
      /^\s*AMY_CALL_ID=/.test(line) ? '[correlation-like prompt line removed]' : line,
    )
    .join('\n')
    .replace(/^\n+/, '');
  return `${marker}${withoutTemplate ? `\n${withoutTemplate}` : ''}`;
}
