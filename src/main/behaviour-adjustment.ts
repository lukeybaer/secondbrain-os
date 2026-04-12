// behaviour-adjustment.ts
// Skill evolution runner — after 10+ uses of a skill, a background agent reviews
// usage logs and LLM-merges improvements back into the skill file.
//
// Pattern: frdel/agent-zero's `behaviour_adjustment` tool.
// Bad merge → git revert. Good merge → committed to skills/.

import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "./config";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SkillUsageLog {
  skill_path: string;       // relative path under skills/
  timestamp: string;        // ISO 8601
  context: string;          // what the skill was used for
  outcome: "success" | "failure" | "partial";
  notes?: string;           // what went well or poorly
}

export interface SkillMeta {
  uses: number;
  last_evolved: string;     // ISO date or "never"
  last_evolution_result?: string;
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function skillsDir(): string {
  // In dev: relative to project root
  const candidates = [
    path.join(process.cwd(), "skills"),
    path.join(__dirname, "..", "..", "..", "skills"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

function usageLogPath(): string {
  return path.join(skillsDir(), "usage-log.jsonl");
}

// ── Usage logging ─────────────────────────────────────────────────────────────

export function logSkillUse(entry: SkillUsageLog): void {
  try {
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(usageLogPath(), line, "utf-8");
    updateSkillMeta(entry.skill_path, entry.outcome);
  } catch {
    // Non-critical — don't crash on logging failure
  }
}

function updateSkillMeta(skillRelPath: string, outcome: SkillUsageLog["outcome"]): void {
  const fullPath = path.join(skillsDir(), skillRelPath);
  if (!fs.existsSync(fullPath)) return;

  let content = fs.readFileSync(fullPath, "utf-8");

  // Parse current uses count
  const usesMatch = content.match(/^- uses: (\d+)/m);
  const currentUses = usesMatch ? parseInt(usesMatch[1], 10) : 0;
  const newUses = currentUses + 1;

  content = content.replace(/^- uses: \d+/m, `- uses: ${newUses}`);
  fs.writeFileSync(fullPath, content, "utf-8");

  // Trigger evolution check in background if threshold reached
  if (newUses > 0 && newUses % 10 === 0) {
    evolveSkillInBackground(skillRelPath, newUses).catch((err) =>
      console.error(`[behaviour-adjustment] evolution error for ${skillRelPath}:`, err),
    );
  }
}

// ── Skill evolution ───────────────────────────────────────────────────────────

/**
 * Reviews recent usage logs for a skill and LLM-merges improvements back in.
 * Runs as a background task — does not block the caller.
 */
export async function evolveSkillInBackground(skillRelPath: string, useCount: number): Promise<void> {
  const config = getConfig();
  if (!config.anthropicApiKey) return;

  const fullPath = path.join(skillsDir(), skillRelPath);
  if (!fs.existsSync(fullPath)) return;

  console.log(`[behaviour-adjustment] Evolving ${skillRelPath} (${useCount} uses)`);

  // Load current skill content
  const currentSkill = fs.readFileSync(fullPath, "utf-8");

  // Load recent usage logs for this skill (last 20 uses)
  const usageLogs = loadRecentUsageLogs(skillRelPath, 20);
  if (usageLogs.length < 5) {
    console.log(`[behaviour-adjustment] Not enough usage data for ${skillRelPath} — skipping`);
    return;
  }

  const failures = usageLogs.filter((l) => l.outcome === "failure");
  const successes = usageLogs.filter((l) => l.outcome === "success");

  const logsText = usageLogs
    .map((l) => `[${l.timestamp.slice(0, 10)}] ${l.outcome.toUpperCase()}: ${l.context}${l.notes ? ` — ${l.notes}` : ""}`)
    .join("\n");

  const prompt = `You are improving an AI skill file based on real-world usage logs.

## Current Skill File
\`\`\`markdown
${currentSkill}
\`\`\`

## Usage Logs (${usageLogs.length} uses, ${failures.length} failures, ${successes.length} successes)
${logsText}

## Your Task
Review the usage logs and produce an improved version of the skill file.

Rules:
1. Keep the same structure and format
2. Add or refine steps where failures occurred
3. Add notes on what patterns lead to success
4. Update the "Usage Count Tracking" section: set uses to ${useCount}, last_evolved to today
5. Do NOT remove working content — only add or refine
6. Keep the skill concise — max 150% of original length
7. Start directly with the updated skill content (no preamble)

Today's date: ${new Date().toISOString().slice(0, 10)}`;

  let evolved: string;
  try {
    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });
    const block = msg.content[0];
    if (block.type !== "text") return;
    evolved = block.text.trim();
  } catch (err) {
    console.error(`[behaviour-adjustment] LLM error:`, err);
    return;
  }

  // Write evolved skill and commit
  try {
    const backup = `${fullPath}.bak`;
    fs.copyFileSync(fullPath, backup);
    fs.writeFileSync(fullPath, evolved, "utf-8");

    // Git commit the evolution
    const relPath = path.relative(process.cwd(), fullPath);
    cp.execSync(
      `git add "${relPath}" && git commit -m "skill: evolve ${path.basename(skillRelPath)} (${useCount} uses)"`,
      { cwd: process.cwd(), timeout: 30_000 },
    );

    // Remove backup on success
    fs.unlinkSync(backup);
    console.log(`[behaviour-adjustment] Evolved and committed: ${skillRelPath}`);
  } catch (err: any) {
    console.error(`[behaviour-adjustment] Commit failed — reverting:`, err.message);
    // Restore backup
    const backup = `${fullPath}.bak`;
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, fullPath);
      fs.unlinkSync(backup);
    }
  }
}

// ── Usage log reader ──────────────────────────────────────────────────────────

function loadRecentUsageLogs(skillRelPath: string, limit: number): SkillUsageLog[] {
  const logPath = usageLogPath();
  if (!fs.existsSync(logPath)) return [];

  const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
  const all: SkillUsageLog[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as SkillUsageLog;
      if (entry.skill_path === skillRelPath) all.push(entry);
    } catch { /* skip malformed lines */ }
  }

  // Return most recent `limit` entries
  return all.slice(-limit);
}

// ── All skills inventory ──────────────────────────────────────────────────────

export interface SkillSummary {
  path: string;
  name: string;
  category: string;
  uses: number;
  last_evolved: string;
}

export function listSkills(): SkillSummary[] {
  const base = skillsDir();
  if (!fs.existsSync(base)) return [];

  const skills: SkillSummary[] = [];

  function walk(dir: string, category: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), e.name);
      } else if (e.name.endsWith(".md") && e.name !== "usage-log.jsonl") {
        const fullPath = path.join(dir, e.name);
        const content = fs.readFileSync(fullPath, "utf-8");
        const usesMatch = content.match(/^- uses: (\d+)/m);
        const evolvedMatch = content.match(/^- last_evolved: (.+)/m);
        skills.push({
          path: path.relative(base, fullPath),
          name: e.name.replace(".md", ""),
          category,
          uses: usesMatch ? parseInt(usesMatch[1], 10) : 0,
          last_evolved: evolvedMatch ? evolvedMatch[1].trim() : "never",
        });
      }
    }
  }

  walk(base, "root");
  return skills;
}
