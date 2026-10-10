'use strict';

const {
  VAPI_SUBSCRIPTION_VOICE_MODEL,
  buildVapiModelHeaders,
  withVapiCallIdMarker,
} = require('./vapi-call-correlation');
const { resolveVoicePrimary } = require('./voice-primary');

const VAPI_SUBSCRIPTION_LLM_URL =
  'https://your-api-id.execute-api.us-east-1.amazonaws.com/prod/chat/completions';
function buildStaticVapiModel({ systemPrompt, tools = [], authSecret = '', voicePrimary } = {}) {
  const primary = voicePrimary || resolveVoicePrimary();
  const basePrompt = String(systemPrompt || '');
  const templateOptions = { allowUnresolvedTemplate: true };
  const correlatedPrompt = withVapiCallIdMarker(basePrompt, '', templateOptions);
  return {
    provider: 'custom-llm',
    model: primary.model,
    url: VAPI_SUBSCRIPTION_LLM_URL,
    headers: buildVapiModelHeaders(authSecret, '', templateOptions),
    messages: [{ role: 'system', content: correlatedPrompt }],
    tools,
    maxTokens: 2200,
  };
}

module.exports = {
  VAPI_SUBSCRIPTION_LLM_URL,
  VAPI_SUBSCRIPTION_VOICE_MODEL,
  buildStaticVapiModel,
};
