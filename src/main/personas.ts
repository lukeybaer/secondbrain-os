import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import OpenAI from "openai";
import { getConfig } from "./config";

export interface Persona {
  id: string;
  name: string;
  instructions: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

function getPersonasFile(): string {
  return path.join(getConfig().dataDir, "personas.json");
}

function ensureDataDir(): void {
  const dir = getConfig().dataDir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function listPersonas(): Persona[] {
  ensureDataDir();
  const file = getPersonasFile();
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Persona[];
  } catch {
    return [];
  }
}

function writePersonas(personas: Persona[]): void {
  ensureDataDir();
  fs.writeFileSync(getPersonasFile(), JSON.stringify(personas, null, 2), "utf-8");
}

export function savePersona(persona: Omit<Persona, "id" | "createdAt" | "updatedAt"> & { id?: string }): Persona {
  const personas = listPersonas();
  const now = new Date().toISOString();

  if (persona.id) {
    const idx = personas.findIndex((p) => p.id === persona.id);
    const updated: Persona = {
      ...(idx >= 0 ? personas[idx] : {}),
      ...persona,
      id: persona.id,
      updatedAt: now,
      createdAt: idx >= 0 ? personas[idx].createdAt : now,
    } as Persona;
    if (idx >= 0) {
      personas[idx] = updated;
    } else {
      personas.push(updated);
    }
    writePersonas(personas);
    return updated;
  } else {
    const created: Persona = {
      ...persona,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    } as Persona;
    personas.push(created);
    writePersonas(personas);
    return created;
  }
}

export function deletePersona(id: string): boolean {
  const personas = listPersonas();
  const filtered = personas.filter((p) => p.id !== id);
  if (filtered.length === personas.length) return false;
  writePersonas(filtered);
  return true;
}

export async function summarizePersona(id: string): Promise<{ success: boolean; summary?: string; error?: string }> {
  const personas = listPersonas();
  const persona = personas.find((p) => p.id === id);
  if (!persona) return { success: false, error: "Persona not found" };

  const config = getConfig();
  const openai = new OpenAI({ apiKey: config.openaiApiKey });

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Summarize the following AI persona instructions in 1–2 concise sentences. Describe the persona's role, tone, and key behaviors. Be specific and direct — no filler phrases.",
        },
        { role: "user", content: persona.instructions },
      ],
      max_tokens: 120,
      temperature: 0.3,
    });

    const summary = completion.choices[0]?.message?.content?.trim() ?? "";
    const updated = savePersona({ ...persona, summary });
    return { success: true, summary: updated.summary };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
