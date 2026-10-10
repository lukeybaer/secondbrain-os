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
  return "Known facts about the user:\n" + facts.map(f => `- ${f.text}${f.phone ? ` (phone: ${f.phone})` : ""}`).join("\n");
}

/**
 * Fire-and-forget: extract personal facts from a user message and save any new ones.
 * Skips if no personal indicators or key is missing.
 */
export async function extractAndLearnFromMessage(
  userMessage: string,
  openaiApiKey: string,
): Promise<void> {
  void userMessage;
  void openaiApiKey;
  // 2026-07-08: this used a direct charged OpenAI chat call. It is disabled
  // until it is rebuilt through the subscription-first ladder with ExampleCo's
  // explicit charged-usage approval gate.
  return;
}
