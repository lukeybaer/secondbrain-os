'use strict';

const {
  DEFAULT_VAPI_ASSISTANT_ID,
  DEFAULT_VAPI_INBOUND_PHONE_NUMBER_ID,
  DEFAULT_VAPI_OUTBOUND_PHONE_NUMBER_ID,
} = require('./outbound-call-broker');
const { resolveCredential } = require('./credential-broker');

function resolveVapiRuntimeConfig({
  diskConfig = {},
  env = process.env,
  credentialResolver = resolveCredential,
} = {}) {
  let brokerApiKey = '';
  if (!diskConfig.vapiApiKey && !env.VAPI_API_KEY) {
    try {
      brokerApiKey = credentialResolver('vapi', 'apiKey')?.value || '';
    } catch {
      // The caller reports a missing credential below. A broken broker must
      // not crash an otherwise valid desktop-config or environment path.
    }
  }
  return {
    ...diskConfig,
    vapiApiKey: diskConfig.vapiApiKey || env.VAPI_API_KEY || brokerApiKey,
    callbackAssistantId:
      diskConfig.callbackAssistantId || env.VAPI_ASSISTANT_ID || DEFAULT_VAPI_ASSISTANT_ID,
    vapiPhoneNumberId:
      diskConfig.vapiPhoneNumberId ||
      env.VAPI_OUTBOUND_PHONE_NUMBER_ID ||
      env.VAPI_PHONE_NUMBER_ID ||
      DEFAULT_VAPI_OUTBOUND_PHONE_NUMBER_ID,
    vapiInboundPhoneNumberId:
      diskConfig.vapiInboundPhoneNumberId ||
      env.VAPI_INBOUND_PHONE_NUMBER_ID ||
      DEFAULT_VAPI_INBOUND_PHONE_NUMBER_ID,
  };
}

module.exports = { resolveVapiRuntimeConfig };
