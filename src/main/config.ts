import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

// ── API Cost Policy ───────────────────────────────────────────────────────────
// PRINCIPLE: Maximize Claude Max plan usage (zero marginal cost). All external
// API calls must use the cheapest available model. NEVER use expensive models
// for routine/automated tasks. Violations waste real money.
//
// Model cost hierarchy (cheapest first):
//   OpenAI LLM:    gpt-4o-mini > gpt-4o (mini is ~15x cheaper per token)
//   OpenAI embed:  text-embedding-3-small (cheapest, use this ALWAYS)
//   Anthropic:     claude-haiku > claude-sonnet > claude-opus
//   Vapi calls:    use Haiku for function routing, gpt-4o only for voice conversation
//
// What runs FREE via Claude Max plan:
//   - All Claude Code agent sessions (command queue tasks)
//   - Claude API calls made through the Claude Code CLI
//
// What costs money (external API keys required):
//   - OpenAI: Vapi voice conversation (gpt-4o), completion detection (gpt-4o-mini),
//             Graphiti knowledge graph embeddings (text-embedding-3-small)
//   - Anthropic SDK: direct Haiku calls for summaries in claude-runner.ts
//   - Vapi: per-minute call charges
//   - Telegram: free
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
  callbackAssistantId: string; // Vapi assistant ID used for inbound callbacks
  telegramBotToken: string;
  telegramChatId: string;
  lukeyPrivateSim: string; // Owner's private phone number known only to the EA
  ec2BaseUrl: string; // SecondBrain EC2 server base URL
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
  callbackAssistantId: '',
  telegramBotToken: '',
  telegramChatId: '',
  lukeyPrivateSim: '',
  ec2BaseUrl: 'https://ea.pixseat.com',
  groqApiKey: '',
  newsApiKey: '',
  youtubeClientId: '',
  youtubeClientSecret: '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
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
};

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (_config) return _config;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      _config = { ...DEFAULTS, ...JSON.parse(raw) };
    } else {
      _config = { ...DEFAULTS };
      saveConfig(_config);
    }
  } catch {
    _config = { ...DEFAULTS };
  }
  return _config!;
}

export function saveConfig(config: Partial<AppConfig>): AppConfig {
  const current = loadConfig();
  _config = { ...current, ...config };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(_config, null, 2), 'utf-8');
  return _config;
}

export function getConfig(): AppConfig {
  return loadConfig();
}
