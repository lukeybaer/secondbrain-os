import OpenAI from 'openai';
import { getConfig } from './config';
import { ConversationMeta } from './storage';

function getOpenAI(): OpenAI {
  return new OpenAI({ apiKey: getConfig().openaiApiKey });
}

const SYSTEM_PROMPT = `You are an expert meeting analyst. Given a meeting transcript, extract structured metadata.

Return a JSON object with exactly these fields:
{
  "speakers": string[],            // names of people who spoke
  "myRole": string,                // the user's role: "facilitator", "participant", "presenter", "interviewer", "interviewee", "observer"
  "meetingType": string,           // e.g. "internal_planning", "client_call", "1on1", "team_standup", "sales_call", "interview", "workshop", "brainstorm", "retrospective", "demo", "other"
  "summary": string,               // 2-3 sentence summary
  "topics": string[],              // main topics discussed (5-10 items)
  "keywords": string[],            // specific terms, projects, metrics, acronyms (10-20 items)
  "peopleMentioned": string[],     // names mentioned (present or not)
  "companiesMentioned": string[],  // company/org names mentioned
  "decisions": string[],           // concrete decisions made
  "sentiment": string              // "productive", "tense", "exploratory", "routine", "problematic", "positive", "mixed"
}

IMPORTANT ANCHORING RULE: If the transcript contains a phrase like "this meeting is about X", "this meeting was about X", "this is a meeting about X", or "this call is about X", treat X as the authoritative subject. It must appear prominently in topics and summary.

Return ONLY valid JSON, no markdown, no explanation.`;

export async function tagConversation(
  otterId: string,
  title: string,
  date: string,
  durationMinutes: number,
  transcript: string,
): Promise<ConversationMeta> {
  const openai = getOpenAI();
  const config = getConfig();

  // Truncate to avoid token limits (~80k chars ≈ ~20k tokens)
  const truncated =
    transcript.length > 80000
      ? transcript.slice(0, 80000) + '\n[transcript truncated]'
      : transcript;

  const userMessage = `Meeting title: ${title}
Date: ${date}
Duration: ${durationMinutes} minutes

Transcript:
${truncated}`;

  const completion = await openai.chat.completions.create({
    model: config.openaiModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  });

  const content = completion.choices[0].message.content || '{}';
  let parsed: any = {};
  try {
    parsed = JSON.parse(content);
  } catch {
    // fallback to empty
  }

  return {
    id: `otter_${otterId}`,
    otterId,
    title,
    date,
    durationMinutes,
    speakers: parsed.speakers || [],
    myRole: parsed.myRole || 'participant',
    meetingType: parsed.meetingType || 'other',
    summary: parsed.summary || '',
    topics: parsed.topics || [],
    keywords: parsed.keywords || [],
    peopleMentioned: parsed.peopleMentioned || [],
    companiesMentioned: parsed.companiesMentioned || [],
    decisions: parsed.decisions || [],
    sentiment: parsed.sentiment || 'routine',
    transcriptFile: 'transcript.txt',
    taggedAt: new Date().toISOString(),
  };
}

// ── WhatsApp conversation tagger ─────────────────────────────────────────────

const WHATSAPP_SYSTEM_PROMPT = `You are an expert communication analyst. Given a WhatsApp text conversation, extract structured metadata.

This is a personal WhatsApp conversation for Luke Baer. Extract EVERYTHING relevant about the people, relationships, and context discussed.

Return a JSON object with exactly these fields:
{
  "speakers": string[],            // names of people in the conversation
  "myRole": string,                // Luke's role: "friend", "colleague", "family", "business_partner", "acquaintance", "mentor", "mentee"
  "meetingType": string,           // "direct_message", "group_chat", "family_chat", "business_chat", "social_chat"
  "summary": string,               // 2-4 sentence summary of what was discussed
  "topics": string[],              // main topics discussed (5-10 items)
  "keywords": string[],            // specific terms, projects, names, places (10-20 items)
  "peopleMentioned": string[],     // ALL names mentioned (in conversation or about)
  "companiesMentioned": string[],  // company/org names mentioned
  "decisions": string[],           // concrete decisions, plans, or commitments made
  "sentiment": string,             // "friendly", "professional", "tense", "excited", "routine", "supportive", "mixed"
  "relationshipType": string,      // "close_friend", "family", "business", "acquaintance", "professional_contact", "service_provider"
  "personalDetails": string[],     // ANY personal info about contacts: kids' names, spouse, birthday, hobbies, health issues, pets, hometown, job, school
  "goalsPlans": string[],          // goals, aspirations, plans, predictions, future intentions mentioned by anyone
  "preferences": string[],        // preferences, likes, dislikes, opinions expressed by anyone
  "personalityTraits": string[]   // personality traits, communication style, values observed
}

CRITICAL RULES:
- Extract EVERY personal detail mentioned — kids' names, spouse names, birthdays, anniversaries, health conditions, hobbies, pets, vehicles, addresses
- Extract ALL goals, predictions, and plans — even casual ones like "I'm thinking about getting a new car"
- Note personality traits and communication style — "always responds quickly", "tends to be formal", "uses lots of emojis"
- If someone mentions their work/career, extract job title, company, responsibilities
- If someone mentions family members, extract names and relationships
- Return ONLY valid JSON, no markdown, no explanation.`;

export async function tagWhatsAppConversation(
  convId: string,
  chatName: string,
  date: string,
  messageCount: number,
  transcript: string,
  isGroup = false,
): Promise<
  ConversationMeta & {
    personalDetails?: string[];
    goalsPlans?: string[];
    preferences?: string[];
    personalityTraits?: string[];
    relationshipType?: string;
  }
> {
  const openai = getOpenAI();
  const config = getConfig();

  // Truncate to avoid token limits
  const truncated =
    transcript.length > 80000
      ? transcript.slice(0, 80000) + '\n[conversation truncated]'
      : transcript;

  const userMessage = `WhatsApp ${isGroup ? 'group' : 'conversation'}: ${chatName}
Date: ${date}
Messages: ${messageCount}

${truncated}`;

  const completion = await openai.chat.completions.create({
    model: config.openaiModel,
    messages: [
      { role: 'system', content: WHATSAPP_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  });

  const content = completion.choices[0].message.content || '{}';
  let parsed: any = {};
  try {
    parsed = JSON.parse(content);
  } catch {
    // fallback to empty
  }

  return {
    id: convId,
    otterId: convId,
    title: `WhatsApp: ${chatName}`,
    date,
    durationMinutes: messageCount, // proxy
    speakers: parsed.speakers || [chatName, 'Luke'],
    myRole: parsed.myRole || 'participant',
    meetingType: parsed.meetingType || (isGroup ? 'group_chat' : 'direct_message'),
    summary: parsed.summary || '',
    topics: parsed.topics || [],
    keywords: parsed.keywords || [],
    peopleMentioned: parsed.peopleMentioned || [chatName],
    companiesMentioned: parsed.companiesMentioned || [],
    decisions: parsed.decisions || [],
    sentiment: parsed.sentiment || 'routine',
    transcriptFile: 'transcript.txt',
    taggedAt: new Date().toISOString(),
    // Extended WhatsApp-specific fields
    personalDetails: parsed.personalDetails || [],
    goalsPlans: parsed.goalsPlans || [],
    preferences: parsed.preferences || [],
    personalityTraits: parsed.personalityTraits || [],
    relationshipType: parsed.relationshipType || 'acquaintance',
  };
}
