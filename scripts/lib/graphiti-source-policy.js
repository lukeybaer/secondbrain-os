const HARD_EXCLUDED_PEOPLE = [
  /\bAndrea\b/i,
  /\bJulia\b/i,
  /\bMarie[-\s]?Louise\b/i,
];

const SOURCE_SLA_MINUTES = {
  'gmail-inbound': 15,
  'gmail-outbound': 15,
  'telegram-message': 5,
  'telegram-voice': 5,
  'vapi-call': 5,
  'vapi-inline-command': 5,
  'call-transcript': 5,
  'call-outcome': 5,
  'otter-transcript': 60,
  'voice-arc': 60,
  'archive-lifetime-gmail': 1440,
  'archive-lifetime-sms': 1440,
  'archive-lifetime-otter': 1440,
  'archive-lifetime-vapi': 1440,
  'archive-lifetime-linkedin': 1440,
  'archive-lifetime-linkedin-dm': 1440,
  'archive-lifetime-whatsapp': 1440,
  'archive-lifetime-codex-session': 1440,
  'archive-lifetime-claude-session': 1440,
  'archive-lifetime-dispatch': 1440,
  'archive-lifetime-generic-file': 1440,
  'linkedin-profile': 1440,
  'linkedin-message': 60,
  'sms-inbound': 1440,
  'sms-outbound': 1440,
  'whatsapp-inbound': 60,
  'whatsapp-outbound': 60,
  'dispatch': 5,
  'prompt': 5,
  'codex-session': 60,
  'claude-session': 60,
  'briefing-daily': 1440,
  'briefing-evening': 1440,
  'memory-file': 1440,
};

const GRAPHITI_SOURCE_FAMILIES = {
  gmail: ['gmail-inbound', 'gmail-outbound'],
  telegram: ['telegram-message', 'telegram-voice'],
  phone: ['vapi-call', 'vapi-inline-command', 'call-transcript', 'call-outcome'],
  otter: ['otter-transcript'],
  'voice-arc': ['voice-arc'],
  'archive-lifetime': [
    'archive-lifetime-gmail',
    'archive-lifetime-sms',
    'archive-lifetime-otter',
    'archive-lifetime-vapi',
    'archive-lifetime-linkedin',
    'archive-lifetime-linkedin-dm',
    'archive-lifetime-whatsapp',
    'archive-lifetime-codex-session',
    'archive-lifetime-claude-session',
    'archive-lifetime-dispatch',
    'archive-lifetime-generic-file',
  ],
  linkedin: ['linkedin-profile', 'linkedin-message'],
  sms: ['sms-inbound', 'sms-outbound'],
  whatsapp: ['whatsapp-inbound', 'whatsapp-outbound'],
  dispatches: ['dispatch', 'prompt'],
  sessions: ['codex-session', 'claude-session'],
  briefings: ['briefing-daily', 'briefing-evening'],
  memory: ['memory-file'],
};

function sourceFamily(source) {
  for (const [family, sources] of Object.entries(GRAPHITI_SOURCE_FAMILIES)) {
    if (sources.includes(source)) return family;
  }
  return source || 'ExampleCo';
}

function shouldSkipForPrivacy(event) {
  const text = [event.name, event.body, event.contact_name, event.source_description]
    .filter(Boolean)
    .join('\n');
  for (const re of HARD_EXCLUDED_PEOPLE) {
    if (re.test(text)) return { skip: true, reason: 'hard_excluded_person' };
  }
  return { skip: false };
}

function isLowSignalEmail(event) {
  if (!/^gmail-/.test(event.source || '')) return false;
  if (process.env.GRAPHITI_SKIP_LOW_SIGNAL_EMAIL !== '1') return false;
  const text = [event.name, event.body].join('\n').toLowerCase();
  return /\bunsubscribe\b|view in browser|privacy policy|shipment|order #|receipt|invoice/.test(text);
}

function shouldDrainEvent(event) {
  if (!event || !event.body || String(event.body).trim().length < 10) {
    return { ok: false, reason: 'body_too_short' };
  }
  const privacy = shouldSkipForPrivacy(event);
  if (privacy.skip) return { ok: false, reason: privacy.reason };
  if (isLowSignalEmail(event)) return { ok: false, reason: 'low_signal_email' };
  return { ok: true };
}

function providerOrder() {
  return ['codex', 'claude-proxy', 'claude-cli', 'api'];
}

module.exports = {
  GRAPHITI_SOURCE_FAMILIES,
  HARD_EXCLUDED_PEOPLE,
  SOURCE_SLA_MINUTES,
  providerOrder,
  shouldDrainEvent,
  shouldSkipForPrivacy,
  sourceFamily,
};
