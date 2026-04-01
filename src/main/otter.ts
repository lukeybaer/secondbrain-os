// Otter.ai unofficial API client
// Auth: GET /login with HTTP Basic (email:password) → get userid + session cookies
import { app } from "electron";
import { getConfig } from "./config";
import * as fs from "fs";
import * as path from "path";

function debugLog(msg: string): void {
  try {
    fs.appendFileSync(
      path.join(app.getPath("userData"), "error.log"),
      `[${new Date().toISOString()}] OTTER: ${msg}\n`,
      "utf-8",
    );
  } catch { /* best-effort */ }
}

const BASE_URL = "https://otter.ai/forward/api/v1";

let sessionCookies: string | null = null;
let userId: string | null = null;
let groupIds: number[] = [];

// ── Cookie helpers ─────────────────────────────────────────────────────────────

function parseCookies(headers: Headers): string {
  const raw: string[] = (headers as any).getSetCookie?.() ?? [];
  if (raw.length === 0) {
    const single = headers.get("set-cookie");
    if (single) raw.push(...single.split(/,(?=[^ ])/));
  }
  return raw.map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
}

function mergeCookies(existing: string, incoming: string): string {
  const map = new Map<string, string>();
  for (const pair of [...existing.split("; "), ...incoming.split("; ")]) {
    const eq = pair.indexOf("=");
    if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

// ── Core fetch ────────────────────────────────────────────────────────────────

async function otterFetch(path: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE_URL}${path}${qs ? "?" + qs : ""}`;

  const headers: Record<string, string> = {
    "x-origin": "https://otter.ai",
    "Referer": "https://otter.ai/",
  };
  if (sessionCookies) headers["Cookie"] = sessionCookies;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000); // 30s timeout
  const res = await fetch(url, { headers, signal: controller.signal }).finally(() => clearTimeout(timer));

  const newCookies = parseCookies(res.headers);
  if (newCookies) {
    sessionCookies = sessionCookies ? mergeCookies(sessionCookies, newCookies) : newCookies;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Otter API ${res.status} ${path}: ${text.slice(0, 300)}`);
  }

  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function login(): Promise<void> {
  const config = getConfig();
  if (!config.otterEmail || !config.otterPassword) {
    throw new Error("Otter.ai email and password are required. Go to Settings.");
  }

  const credentials = Buffer.from(`${config.otterEmail}:${config.otterPassword}`).toString("base64");

  const res = await fetch(`${BASE_URL}/login?username=${encodeURIComponent(config.otterEmail)}`, {
    headers: {
      "Authorization": `Basic ${credentials}`,
      "x-origin": "https://otter.ai",
      "Referer": "https://otter.ai/",
    },
  });

  const cookies = parseCookies(res.headers);
  if (cookies) sessionCookies = cookies;

  if (!res.ok) {
    throw new Error(`Login failed (${res.status}). Check your email and password in Settings.`);
  }

  const data = await res.json();
  debugLog(`Login response keys: ${Object.keys(data).join(",")}`);
  debugLog(`Login user info: userid=${data.userid}, email=${data.email}, plan_type=${data.subscription?.plan_type ?? data.plan?.type ?? "unknown"}, team_subscription_id=${data.subscription?.team_subscription_id ?? "none"}`);
  if (data.user) {
    debugLog(`Login user object: ${JSON.stringify(data.user).slice(0, 2000)}`);
  }
  if (data.teams || data.groups || data.workspaces || data.orgs) {
    debugLog(`Teams/groups: ${JSON.stringify(data.teams ?? data.groups ?? data.workspaces ?? data.orgs)}`);
  }
  userId = String(data.userid ?? data.user_id ?? "");
  if (!userId) throw new Error("Login succeeded but no userid returned.");

  // For team accounts, fetch group IDs so we can pull workspace speeches
  try {
    const groupsData = await otterFetch("/groups");
    const groups: any[] = groupsData.groups ?? [];
    groupIds = groups.map((g: any) => g.id).filter(Boolean);
    debugLog(`Groups found: ${groups.map((g: any) => `${g.name}(${g.id})`).join(", ")}`);
  } catch (e: any) {
    debugLog(`/groups fetch failed: ${e.message}`);
    groupIds = [];
  }
}

async function ensureLoggedIn(): Promise<string> {
  if (!userId || !sessionCookies) await login();
  return userId!;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OtterSpeech {
  id: string;
  title: string;
  createdAt: number;
  endTime: number;
  summary?: string;
  transcript?: string;
  speakers?: string[];
}

function normalizeSpeech(raw: any): OtterSpeech {
  return {
    id: raw.otid || raw.id || raw.speech_id || String(Math.random()),
    title: raw.title || raw.name || "Untitled",
    createdAt: raw.created_at || raw.createdAt || raw.start_time || 0,
    endTime: raw.end_time || raw.endTime || 0,
    summary: raw.summary || raw.auto_summary || "",
    transcript: extractTranscript(raw),
    speakers: raw.speakers || raw.speaker_names || [],
  };
}

function extractTranscript(raw: any): string {
  // Structured segments — emit speaker labels when they change
  if (Array.isArray(raw.transcripts) && raw.transcripts.length > 0) {
    // Build speaker id → display name map
    const speakerMap = new Map<string, string>();
    if (Array.isArray(raw.speakers)) {
      for (const sp of raw.speakers) {
        const id = String(sp.speaker_id ?? sp.id ?? "");
        const name = sp.speaker_name || sp.name || sp.display_name || "";
        if (id && name) speakerMap.set(id, name);
      }
    }

    const lines: string[] = [];
    let lastSpeakerId = "";

    for (const t of raw.transcripts) {
      const text = (t.transcript || t.text || "").trim();
      if (!text) continue;

      const speakerId = String(t.speaker_id ?? "");
      if (speakerId !== lastSpeakerId) {
        const name = speakerMap.get(speakerId) || (speakerId ? `Speaker ${speakerId}` : null);
        if (name) {
          if (lines.length > 0) lines.push(""); // blank line between speaker turns
          lines.push(`${name}:`);
        }
        lastSpeakerId = speakerId;
      }
      lines.push(text);
    }

    return lines.join("\n");
  }

  if (raw.transcript && typeof raw.transcript === "string") return raw.transcript;

  if (Array.isArray(raw.words)) {
    // Words may have speaker info too
    const speakerMap = new Map<string, string>();
    if (Array.isArray(raw.speakers)) {
      for (const sp of raw.speakers) {
        const id = String(sp.speaker_id ?? sp.id ?? "");
        const name = sp.speaker_name || sp.name || sp.display_name || "";
        if (id && name) speakerMap.set(id, name);
      }
    }

    if (speakerMap.size > 0) {
      const lines: string[] = [];
      let lastSpeakerId = "";
      let segment = "";

      for (const w of raw.words) {
        const word = w.word || w.text || "";
        const speakerId = String(w.speaker_id ?? "");
        if (speakerId !== lastSpeakerId && speakerId) {
          if (segment.trim()) { lines.push(segment.trim()); segment = ""; }
          const name = speakerMap.get(speakerId) || `Speaker ${speakerId}`;
          if (lines.length > 0) lines.push("");
          lines.push(`${name}:`);
          lastSpeakerId = speakerId;
        }
        segment += (segment ? " " : "") + word;
      }
      if (segment.trim()) lines.push(segment.trim());
      return lines.join("\n");
    }

    return raw.words.map((w: any) => w.word || w.text || "").join(" ");
  }

  return "";
}

// ── Streaming fetch — calls onBatch progressively ─────────────────────────────
// Batch sizes: first 1, then 4 more (5 total), then 20s thereafter

function extractId(item: any): string | undefined {
  return item?.otid || item?.id || item?.speech_id || item?.otid_str || undefined;
}

export async function streamAllSpeeches(
  onBatch: (speeches: OtterSpeech[]) => void,
): Promise<number> {
  const uid = await ensureLoggedIn();
  const PAGE_SIZE = 20;
  let totalFetched = 0;
  const seenIds = new Set<string>();

  debugLog(`Starting fetch for uid=${uid} (last_load_ts mode)`);

  let firstDone = false;
  let lastLoadTs: string | null = null;

  while (true) {
    const pageSize = (!firstDone) ? 1 : PAGE_SIZE;
    const params: Record<string, string> = {
      userid: uid,
      page_size: String(pageSize),
    };
    if (lastLoadTs !== null) {
      params["last_load_ts"] = lastLoadTs;
      params["modified_after"] = "1";
    }

    debugLog(`Fetching: last_load_ts=${lastLoadTs ?? "none"}, modified_after=${params["modified_after"] ?? "none"}, page_size=${pageSize}`);

    const data = await otterFetch("/speeches", params);
    const raw: any[] = data.speeches ?? data.data ?? [];
    const endOfList: boolean = !!data.end_of_list;
    const responseTs: string | undefined = data.last_load_ts;

    debugLog(`Got ${raw.length} items, end_of_list=${endOfList}, response last_load_ts=${responseTs}`);

    if (raw.length === 0) { debugLog("Empty, done."); break; }

    if (raw.length > 0) {
      debugLog(`First: otid=${raw[0]?.otid} created_at=${raw[0]?.created_at}`);
      if (raw.length > 1) debugLog(`Last:  otid=${raw[raw.length-1]?.otid} created_at=${raw[raw.length-1]?.created_at}`);
    }

    const newRaw = raw.filter(item => {
      const id = extractId(item);
      return id && !seenIds.has(id);
    });

    debugLog(`${newRaw.length} new, ${raw.length - newRaw.length} dups`);

    if (newRaw.length > 0) {
      newRaw.forEach(item => { const id = extractId(item); if (id) seenIds.add(id); });
      onBatch(newRaw.map(normalizeSpeech));
      totalFetched += newRaw.length;
    }

    if (endOfList) { debugLog("end_of_list=true, done."); break; }
    if (raw.length < pageSize) { debugLog(`${raw.length} < ${pageSize}, done.`); break; }
    if (newRaw.length === 0) { debugLog("All dups, done."); break; }

    if (!firstDone) {
      firstDone = true;
      // Don't set cursor yet — first full page uses no cursor
    } else {
      if (!responseTs) { debugLog("No last_load_ts in response, done."); break; }
      if (responseTs === lastLoadTs) { debugLog("last_load_ts unchanged, done."); break; }
      lastLoadTs = responseTs;
      debugLog(`Next cursor: last_load_ts=${lastLoadTs}`);
    }

    await sleep(300);
  }

  debugLog(`Personal speeches done: ${totalFetched}`);

  // Also fetch speeches from each team group
  for (const groupId of groupIds) {
    debugLog(`Fetching group speeches for group_id=${groupId}`);
    let groupPage = 0;
    let groupFirstDone = false;

    while (true) {
      const pageSize = (!groupFirstDone) ? 1 : PAGE_SIZE;
      const params: Record<string, string> = {
        userid: uid,
        group_id: String(groupId),
        page_size: String(pageSize),
      };
      if (groupFirstDone) params["page"] = String(groupPage);

      debugLog(`Group ${groupId}: page=${groupPage}, page_size=${pageSize}`);
      const data = await otterFetch("/speeches", params);
      const raw: any[] = data.speeches ?? data.data ?? [];
      const endOfList: boolean = !!data.end_of_list;

      debugLog(`Group ${groupId}: got ${raw.length} items, end_of_list=${endOfList}`);
      if (raw.length === 0) break;

      const newRaw = raw.filter(item => {
        const id = extractId(item);
        return id && !seenIds.has(id);
      });

      debugLog(`Group ${groupId}: ${newRaw.length} new, ${raw.length - newRaw.length} dups`);

      if (newRaw.length > 0) {
        newRaw.forEach(item => { const id = extractId(item); if (id) seenIds.add(id); });
        onBatch(newRaw.map(normalizeSpeech));
        totalFetched += newRaw.length;
      }

      if (endOfList) break;
      if (raw.length < pageSize) break;
      if (newRaw.length === 0) break;

      if (!groupFirstDone) {
        groupFirstDone = true;
      } else {
        groupPage++;
      }

      await sleep(300);
    }

    debugLog(`Group ${groupId} done`);
  }

  debugLog(`Fetch complete: ${totalFetched} total`);
  return totalFetched;
}

// Keep for backwards compat with processIds
export async function getSpeech(speechId: string): Promise<OtterSpeech> {
  const uid = await ensureLoggedIn();
  const data = await otterFetch("/speech", { userid: uid, otid: speechId });
  return normalizeSpeech(data.speech ?? data);
}

export async function getTranscript(speechId: string): Promise<string> {
  const speech = await getSpeech(speechId);
  if (speech.transcript && speech.transcript.length > 20) return speech.transcript;
  return speech.summary || "";
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
