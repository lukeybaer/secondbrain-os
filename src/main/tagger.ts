import OpenAI from "openai";
import { getConfig } from "./config";
import { ConversationMeta } from "./storage";

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
  const truncated = transcript.length > 80000
    ? transcript.slice(0, 80000) + "\n[transcript truncated]"
    : transcript;

  const userMessage = `Meeting title: ${title}
Date: ${date}
Duration: ${durationMinutes} minutes

Transcript:
${truncated}`;

  const completion = await openai.chat.completions.create({
    model: config.openaiModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    temperature: 0.1,
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0].message.content || "{}";
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
    myRole: parsed.myRole || "participant",
    meetingType: parsed.meetingType || "other",
    summary: parsed.summary || "",
    topics: parsed.topics || [],
    keywords: parsed.keywords || [],
    peopleMentioned: parsed.peopleMentioned || [],
    companiesMentioned: parsed.companiesMentioned || [],
    decisions: parsed.decisions || [],
    sentiment: parsed.sentiment || "routine",
    transcriptFile: "transcript.txt",
    taggedAt: new Date().toISOString(),
  };
}
