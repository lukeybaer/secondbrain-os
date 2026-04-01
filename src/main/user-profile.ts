import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import OpenAI from "openai";
import { getConfig } from "./config";

export interface Fact {
  id: string;
  text: string;
  category: "contact" | "relationship" | "preference" | "note";
  phone?: string;
  source: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

function getProfileFile(): string {
  return path.join(getConfig().dataDir, "profile.json");
}

function ensureDataDir(): void {
  const dir = getConfig().dataDir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function listFacts(): Fact[] {
  ensureDataDir();
  const file = getProfileFile();
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Fact[];
  } catch {
    return [];
  }
}

function writeFacts(facts: Fact[]): void {
  ensureDataDir();
  fs.writeFileSync(getProfileFile(), JSON.stringify(facts, null, 2), "utf-8");
}

export function saveFact(fact: Omit<Fact, "id" | "createdAt" | "updatedAt"> & { id?: string }): Fact {
  const facts = listFacts();
  const now = new Date().toISOString();

  if (fact.id) {
    const idx = facts.findIndex((f) => f.id === fact.id);
    const updated: Fact = {
      ...(idx >= 0 ? facts[idx] : {}),
      ...fact,
      id: fact.id,
      updatedAt: now,
      createdAt: idx >= 0 ? facts[idx].createdAt : now,
    } as Fact;
    if (idx >= 0) {
      facts[idx] = updated;
    } else {
      facts.push(updated);
    }
    writeFacts(facts);
    return updated;
  } else {
    const created: Fact = {
      ...fact,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    } as Fact;
    facts.push(created);
    writeFacts(facts);
    return created;
  }
}

export function deleteFact(id: string): void {
  const facts = listFacts();
  const filtered = facts.filter((f) => f.id !== id);
  if (filtered.length !== facts.length) writeFacts(filtered);
}

export function getProfileAsText(): string {
  try {
    const facts = listFacts();
    if (facts.length === 0) return "";
    return facts
      .map((f) => {
        const phone = f.phone ? ` (${f.phone})` : "";
        return `- [${f.category}] ${f.text}${phone}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

export async function extractAndLearnFromMessage(
  question: string,
  openaiApiKey: string,
): Promise<void> {
  try {
    if (!openaiApiKey || !question.trim()) return;

    const openai = new OpenAI({ apiKey: openaiApiKey });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Extract factual information about the user from this message. Look for:
- Names and relationships (wife, boss, friend, etc.)
- Phone numbers or contact info
- Preferences and habits
- Professional details (job title, company)
- Location information

Return a JSON object with a "facts" array. Each fact has:
- "text": concise fact statement
- "category": one of "contact", "relationship", "preference", "note"
- "phone": phone number if mentioned (string or null)

If no facts can be extracted, return {"facts": []}.
Only extract clear, explicit facts — do not infer or guess.`,
        },
        { role: "user", content: question },
      ],
      response_format: { type: "json_object" },
      max_tokens: 300,
      temperature: 0,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return;

    const parsed = JSON.parse(content);
    const extracted: Array<{ text: string; category: string; phone?: string }> =
      Array.isArray(parsed.facts) ? parsed.facts : [];

    for (const item of extracted) {
      if (!item.text) continue;
      saveFact({
        text: item.text,
        category: (["contact", "relationship", "preference", "note"].includes(item.category)
          ? item.category
          : "note") as Fact["category"],
        phone: item.phone || undefined,
        source: "extracted",
        tags: [],
      });
    }
  } catch {
    // fire-and-forget — caller uses .catch(() => {})
  }
}
