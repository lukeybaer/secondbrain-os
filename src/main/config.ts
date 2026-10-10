import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

// ── API Cost Policy ───────────────────────────────────────────────────────────
// OWNER POLICY 2026-08-05: all paid model API token access is disabled.
// Codex and Claude subscription runtimes remain allowed. Historical model
// fields stay in the schema for migration compatibility but credentials are
// stripped on every config read and write.
//
// What remains allowed via subscriptions:
//   - All Claude Code agent sessions (command queue tasks)
//   - Claude calls made through the Claude Code CLI or subscription proxy
//   - Codex CLI calls authenticated by the Codex subscription login
// ─────────────────────────────────────────────────────────────────────────────

export interface AppConfig {
  otterEmail: string;
  otterPassword: string;
  openaiApiKey: string;
  dataDir: string;
  openaiModel: string; // LLM model for Vapi voice (keep gpt-4o for quality)
  openaiLightModel: string; // Cheap LLM for automated tasks (gpt-4o-mini)
  openaiEmbeddingModel: string; // Embedding model for Graphiti (text-embedding-3-small)
  maxContextConversations: number;
  whatsappPhoneNumberId: string;
  whatsappAccessToken: string;
  vapiApiKey: string;
  vapiPhoneNumberId: string;
  vapiInboundPhoneNumberId: string; // Dynamic inbound phone number that uses /vapi/webhook assistant-request
  callbackAssistantId: string; // Vapi assistant ID used for inbound callbacks
  vapiWebhookSecret: string; // Secret sent by Vapi as x-vapi-secret to the EC2 webhook
  vapiLlmSecret: string; // Separate secret Vapi sends only to the custom LLM endpoint
  vapiServerUrl: string; // Canonical Vapi webhook URL, overrides ec2BaseUrl-derived default
  telegramBotToken: string;
  telegramChatId: string;
  ownerPrivateSim: string; // Owner's private phone number known only to the EA
  ec2BaseUrl: string; // SecondBrain EC2 server base URL
  commandToken: string; // Bearer token for the authed /commands surface on EC2
  anthropicApiKey: string; // Anthropic API key for Claude (behaviour-adjustment, reflections)
  groqApiKey: string; // Groq API key for fast LLM inference (news summaries)
  newsApiKey: string; // NewsAPI.org key for headlines (optional)
  youtubeClientId: string; // YouTube Data API OAuth client ID
  youtubeClientSecret: string; // YouTube Data API OAuth client secret
  otterSessionCookie: string; // Otter session cookies — Google SSO alternative to password
  otterUserId: string; // Otter numeric user ID — captured alongside session cookie
  twilioAccountSid: string; // Twilio Account SID for SMS
  twilioAuthToken: string; // Twilio Auth Token for SMS
  twilioPhoneNumber: string; // Twilio phone number (e.g. +15551234567)
  amyVersion: number; // Active Amy version (1=Classic, 2=Skill-Aware, 3=Claude-Powered)
  xApiKey: string; // X (Twitter) API Consumer Key
  xApiSecret: string; // X (Twitter) API Consumer Secret
  xAccessToken: string; // X (Twitter) Access Token
  xAccessTokenSecret: string; // X (Twitter) Access Token Secret
  ownerName: string; // Display name for the owner, used in prompt templates; leave blank for anonymous default
  ownerEmail: string; // Owner's email address for briefing delivery; read from config, never hardcoded
}

const DEFAULTS: AppConfig = {
  otterEmail: '',
  otterPassword: '',
  openaiApiKey: '',
  dataDir: path.join(app.getPath('userData'), 'data'),
  openaiModel: 'gpt-4o', // Vapi voice only — justified by quality requirement
  openaiLightModel: 'gpt-4o-mini', // All automated OpenAI LLM calls (15x cheaper)
  openaiEmbeddingModel: 'text-embedding-3-small', // Graphiti embeddings (cheapest)
  maxContextConversations: 10,
  whatsappPhoneNumberId: '',
  whatsappAccessToken: '',
  vapiApiKey: '',
  vapiPhoneNumberId: '',
  vapiInboundPhoneNumberId: '',
  callbackAssistantId: '',
  vapiWebhookSecret: '',
  vapiLlmSecret: '',
  vapiServerUrl: '',
  telegramBotToken: '',
  telegramChatId: '',
  ownerPrivateSim: '',
  ec2BaseUrl: '',
  commandToken: '',
  groqApiKey: '',
  newsApiKey: '',
  youtubeClientId: '',
  youtubeClientSecret: '',
  anthropicApiKey: '',
  otterSessionCookie: '',
  otterUserId: '',
  twilioAccountSid: '',
  twilioAuthToken: '',
  twilioPhoneNumber: '',
  amyVersion: 2, // Default to v2 (Skill-Aware)
  xApiKey: '',
  xApiSecret: '',
  xAccessToken: '',
  xAccessTokenSecret: '',
  ownerName: '',
  ownerEmail: '',
};

let _config: AppConfig | null = null;

function applyPaidModelApiOwnerPolicy(config: AppConfig): AppConfig {
  return {
    ...config,
    openaiApiKey: '',
    anthropicApiKey: '',
    groqApiKey: '',
    vapiApiKey: '',
  };
}

export function loadConfig(): AppConfig {
  if (_config) return _config;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      _config = applyPaidModelApiOwnerPolicy({ ...DEFAULTS, ...saved });
    } else {
      _config = applyPaidModelApiOwnerPolicy({ ...DEFAULTS });
      saveConfig(_config);
    }
  } catch {
    _config = applyPaidModelApiOwnerPolicy({ ...DEFAULTS });
  }
  return _config!;
}

export function saveConfig(config: Partial<AppConfig>): AppConfig {
  const current = loadConfig();
  _config = applyPaidModelApiOwnerPolicy({ ...current, ...config });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(_config, null, 2), 'utf-8');
  return _config;
}

export function getConfig(): AppConfig {
  return loadConfig();
}

export function getVapiLlmSecret(config: AppConfig = getConfig()): string {
  const dedicated = process.env.VAPI_LLM_SECRET || config.vapiLlmSecret || '';
  if (dedicated) return dedicated;
  if (process.env.VAPI_LLM_SECRET_ALLOW_WEBHOOK_FALLBACK !== '1') return '';
  return process.env.VAPI_WEBHOOK_SECRET || config.vapiWebhookSecret || '';
}

export function getVapiWebhookUrl(config: AppConfig = getConfig()): string | undefined {
  return (
    config.vapiServerUrl ||
    (config.ec2BaseUrl ? `${config.ec2BaseUrl}/vapi/webhook` : undefined)
  );
}

export function getVapiWebhookServer(
  config: AppConfig = getConfig(),
): { url: string; headers?: Record<string, string> } | undefined {
  const url = getVapiWebhookUrl(config);
  if (!url) return undefined;

  const secret = process.env.VAPI_WEBHOOK_SECRET || config.vapiWebhookSecret || '';
  return secret ? { url, headers: { 'x-vapi-secret': secret } } : { url };
}
