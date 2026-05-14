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
  ownerPrivateSim: string; // Owner's private phone number known only to the EA
  ec2BaseUrl: string; // SecondBrain EC2 server base URL
  anthropicApiKey: string; // Anthropic API key for Claude (behaviour-adjustment, reflections)
  groqApiKey: string; // Groq API key for fast LLM inference (news summaries)
  newsApiKey: string; // NewsAPI.org key for headlines (optional)
  youtubeClientId: string; // YouTube Data API OAuth client ID
  youtubeClientSecret: string; // YouTube Data API OAuth client secret
  otterSessionCookie: string; // Otter session cookies , Google SSO alternative to password
  otterUserId: string; // Otter numeric user ID , captured alongside session cookie
  twilioAccountSid: string; // Twilio Account SID for SMS
  twilioAuthToken: string; // Twilio Auth Token for SMS
  twilioPhoneNumber: string; // Twilio phone number (e.g. +15551234567)
  amyVersion: number; // Active Amy version (1=Classic, 2=Skill-Aware, 3=Claude-Powered)
  xApiKey: string; // X (Twitter) API Consumer Key
  xApiSecret: string; // X (Twitter) API Consumer Secret
  xAccessToken: string; // X (Twitter) Access Token
  xAccessTokenSecret: string; // X (Twitter) Access Token Secret
  ownerName: string; // Display name for the owner, used in prompt templates; leave blank for anonymous default
  ownerEmail: string; // Owner's email address — used for briefing dispatch and Amy self-send emails

  // Onboarding state. Persists what the first-run wizard collected so it
  // doesn't re-prompt and so the rest of the app knows what to surface.
  onboarding: {
    completedAt: string | null;        // ISO timestamp when the wizard was finished. null = not done.
    currentStep: number;               // 0-indexed step the user is on. Lets them resume mid-wizard.
    skippedTour: boolean;              // True if they hit "Skip tour" instead of clicking through every step.
    briefingSections: Record<string, boolean>;  // Which of the 13 briefing sections they enabled. See DEFAULT_BRIEFING_SECTIONS.
    secretsDeferred: string[];         // AppConfig keys (e.g. 'vapiApiKey') the user said "remind me later" about.
    lastReminderShownAt: string | null; // ISO timestamp the deferred-secrets banner was last shown. Throttles to weekly.
  };
}

// 13 briefing sections from docs/DAILY_BRIEFING_TEMPLATE.md. The wizard
// shows this as a checkbox list so the user can prune what they don't want.
// All default to true; toggling off means the briefing skips the section.
export const DEFAULT_BRIEFING_SECTIONS: Record<string, boolean> = {
  header: true,                  // 1. Date + greeting
  topDecisions: true,            // 2. Decisions waiting on you
  calendarToday: true,           // 3. Today's schedule
  pendingApprovals: true,        // 4. Approvals queued
  people: true,                  // 5. People needing attention
  communicationsSummary: true,   // 6. Inbox summary
  projectsDoneTogether: true,    // 7. What you and the EA shipped
  contentPipeline: true,         // 8. Content queue
  news: true,                    // 9. Curated news
  systemHealth: true,            // 10. Operational health
  tokenUsageYesterday: true,     // 11. Confirms free-tier claim
  awsCosts: false,               // 12. Off by default (only useful if you run AWS)
  footerLinks: true,             // 13. Dashboard + repo links
};

const DEFAULTS: AppConfig = {
  otterEmail: '',
  otterPassword: '',
  openaiApiKey: '',
  dataDir: path.join(app.getPath('userData'), 'data'),
  openaiModel: 'gpt-4o', // Vapi voice only , justified by quality requirement
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
  ownerPrivateSim: '',
  ec2BaseUrl: '',
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
  ownerName: '',
  ownerEmail: '',
  onboarding: {
    completedAt: null,
    currentStep: 0,
    skippedTour: false,
    briefingSections: { ...DEFAULT_BRIEFING_SECTIONS },
    secretsDeferred: [],
    lastReminderShownAt: null,
  },
};

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (_config) return _config;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      // Don't let empty-string saved values override env-derived defaults for API keys
      if (!saved.anthropicApiKey && DEFAULTS.anthropicApiKey) {
        delete saved.anthropicApiKey;
      }
      _config = { ...DEFAULTS, ...saved };
      // Merge nested onboarding object so older configs (saved before
      // onboarding existed) get the default state added without losing
      // whatever they had.
      _config.onboarding = {
        ...DEFAULTS.onboarding,
        ...(saved.onboarding || {}),
        briefingSections: {
          ...DEFAULT_BRIEFING_SECTIONS,
          ...(saved.onboarding?.briefingSections || {}),
        },
      };
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
