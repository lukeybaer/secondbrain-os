import * as fs from "fs";
import * as path from "path";
import { getConfig } from "./config";

export interface ProfileFact {
  id: string;
  text: string;
  category: "contact" | "relationship" | "preference" | "note";
  tags: string[];
  phone?: string;
  name?: string;
  relation?: string;
  source: "manual" | "extracted";
  createdAt: string;
  updatedAt: string;
}

function getProfilePath(): string {
  return path.join(getConfig().dataDir, "user-profile.json");
}

export function listFacts(): ProfileFact[] {
  const file = getProfilePath();
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as ProfileFact[];
  } catch {
    return [];
  }
}

export function saveFact(fact: Partial<ProfileFact> & { text: string; category: ProfileFact["category"]; source: ProfileFact["source"] }): ProfileFact {
  const facts = listFacts();
  const now = new Date().toISOString();

  if (fact.id) {
    const idx = facts.findIndex(f => f.id === fact.id);
    if (idx >= 0) {
      const updated: ProfileFact = { ...facts[idx], ...fact, updatedAt: now };
      facts[idx] = updated;
      fs.writeFileSync(getProfilePath(), JSON.stringify(facts, null, 2), "utf-8");
      return updated;
    }
  }

  const newFact: ProfileFact = {
    id: `fact_${Date.now().toString(36)}`,
    text: fact.text,
    category: fact.category,
    tags: fact.tags ?? [],
    phone: fact.phone,
    name: fact.name,
    relation: fact.relation,
    source: fact.source,
    createdAt: now,
    updatedAt: now,
  };
  facts.push(newFact);
  fs.writeFileSync(getProfilePath(), JSON.stringify(facts, null, 2), "utf-8");
  return newFact;
}

export function deleteFact(id: string): void {
  const facts = listFacts().filter(f => f.id !== id);
  fs.writeFileSync(getProfilePath(), JSON.stringify(facts, null, 2), "utf-8");
}

export function getProfileAsText(): string {
  const facts = listFacts();
  if (facts.length === 0) return "";
  return "Known facts about the user (Luke):\n" + facts.map(f => `- ${f.text}${f.phone ? ` (phone: ${f.phone})` : ""}`).join("\n");
}

/**
 * Fire-and-forget: extract personal facts from a user message and save any new ones.
 * Skips if no personal indicators or key is missing.
 */
export async function extractAndLearnFromMessage(
  userMessage: string,
  openaiApiKey: string,
): Promise<void> {
  if (!openaiApiKey || userMessage.length < 10) return;

  // Only bother if there are personal indicators
  if (!/\b(my |i |i'm |i am |i like |i love |i hate |i prefer |wife|husband|mom|dad|friend|brother|sister)\b/i.test(userMessage)) return;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Extract personal facts about the user (named Luke) from this message. Look for:
- Relationships: "my wife Emily", "my friend Abdullah", "my mom"
- Contact info attached to a name/relationship
- Preferences: "I like blue", "I prefer email over phone"
- Personal facts worth remembering for future interactions

Return JSON: {"facts": [{"text": "Luke's wife is named Emily", "category": "relationship", "tags": ["wife", "Emily"], "phone": null, "name": "Emily", "relation": "wife"}]}
Return empty facts array if nothing personal worth saving. category must be: contact | relationship | preference | note.
"text" must be a complete sentence starting with "Luke". phone should be E.164 or null.`,
          },
          { role: "user", content: userMessage },
        ],
        response_format: { type: "json_object" },
        max_tokens: 400,
        temperature: 0,
      }),
    });

    if (!res.ok) return;
    const data = await res.json();
    const parsed = JSON.parse(data.choices[0]?.message?.content ?? "{}");
    const extracted: any[] = parsed.facts ?? [];
    if (extracted.length === 0) return;

    const existing = listFacts();

    for (const e of extracted) {
      if (!e.text || !e.category) continue;
      const tags: string[] = e.tags ?? [];

      // Dedup: skip if a fact with overlapping tags+category already exists
      const alreadyKnown = existing.some(
        f => f.category === e.category && tags.some(t => f.tags.includes(t)),
      );
      if (alreadyKnown) continue;

      const fact = saveFact({
        text: e.text,
        category: e.category,
        tags,
        phone: e.phone || undefined,
        name: e.name || undefined,
        relation: e.relation || undefined,
        source: "extracted",
      });
      existing.push(fact); // Prevent duplicates within the same batch
    }
  } catch {
    // Best-effort
  }
}
