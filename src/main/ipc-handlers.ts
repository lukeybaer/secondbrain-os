import { ipcMain, BrowserWindow } from "electron";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { getConfig, saveConfig } from "./config";
import { streamAllSpeeches, getSpeech, getTranscript, login } from "./otter";
import { tagConversation } from "./tagger";
import {
  saveConversation, listAllConversations, loadConversation, conversationExists,
  saveOtterListCache, loadOtterListCache, updateOtterListCacheStatus, OtterListItem,
} from "./storage";
import { upsertConversation, searchConversations } from "./database";
import { chat, ChatMessage } from "./chat";
import {
  createSession, loadLatestSession, saveSession, summarizeSession,
  saveSessionAsConversation, ChatSession,
} from "./chat-sessions";
import { sendMessage, listWhatsAppMessages, ingestWebhookPayload } from "./whatsapp";
import { initiateCall, refreshCallStatus, loadCallRecord, listCallRecords, markCallCompleted, hangUpCall, syncCallbackAssistant, linkCallbackAssistantToPhoneNumber, fetchAndSyncInboundCalls } from "./calls";
import { listPersonas, savePersona, deletePersona, summarizePersona } from "./personas";
import { listFacts, saveFact, deleteFact } from "./user-profile";
import { listProjects, getProject, createProject, updateProject, deleteProject, addTask, updateTask, deleteTask } from "./projects";
import { scanAndAlert } from "./pii-scanner";
import { readMemory, writeMemory, runPostCallReflection, ensureMemoryFile } from "./agent-memory";

const AUDIO_DIAG_FILE = path.join(app.getPath("userData"), "audio-diag.log");

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  const send = (channel: string, data: any) => mainWindow.webContents.send(channel, data);

  ipcMain.handle("diag:writeAudio", (_e, line: string, firstFrameHex?: string) => {
    const timestamp = new Date().toISOString();
    let entry = `[${timestamp}] ${line}\n`;
    if (firstFrameHex) entry += `  first frame (hex): ${firstFrameHex}\n`;
    fs.appendFileSync(AUDIO_DIAG_FILE, entry, "utf-8");
  });

  // Config
  ipcMain.handle("config:get", () => getConfig());
  ipcMain.handle("config:save", (_e, config) => saveConfig(config));

  // Fetch list from Otter — streams batches back via import:listBatch events
  ipcMain.handle("import:fetchList", async () => {
    try {
      const local = listAllConversations();
      const taggedIds = new Set(
        local.filter(c => c.meetingType !== "OpenBrainChat").map(c => c.otterId)
      );

      const accumulated: OtterListItem[] = [];

      await streamAllSpeeches((speeches) => {
        const items: OtterListItem[] = speeches.map(s => ({
          otterId: s.id,
          title: s.title,
          date: s.createdAt
            ? new Date(s.createdAt * 1000).toISOString().split("T")[0]
            : "unknown",
          durationMinutes:
            s.endTime && s.createdAt
              ? Math.round((s.endTime - s.createdAt) / 60)
              : 0,
          status: taggedIds.has(s.id) ? "tagged" : "remote",
        }));

        // Merge into accumulated (dedupe by otterId)
        for (const item of items) {
          const idx = accumulated.findIndex(i => i.otterId === item.otterId);
          if (idx >= 0) {
            accumulated[idx] = item;
          } else {
            accumulated.push(item);
          }
        }

        saveOtterListCache(accumulated);
        send("import:listBatch", items);
      });

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Load cached Otter list (with fresh tagged status)
  ipcMain.handle("import:loadCached", () => {
    const cached = loadOtterListCache();
    if (cached.length === 0) return [];
    const local = listAllConversations();
    const taggedIds = new Set(
      local.filter(c => c.meetingType !== "OpenBrainChat").map(c => c.otterId)
    );
    return cached.map(item => ({
      ...item,
      status: taggedIds.has(item.otterId) ? "tagged" : item.status,
    }));
  });

  // Process specific conversations (download transcript + AI tag)
  ipcMain.handle("import:processIds", async (_e, otterIds: string[]) => {
    let processed = 0;
    let failed = 0;

    for (const otterId of otterIds) {
      send("import:itemProgress", { otterId, status: "downloading" });
      try {
        const speech = await getSpeech(otterId);
        const transcript = await getTranscript(otterId);

        const durationMinutes =
          speech.endTime && speech.createdAt
            ? Math.round((speech.endTime - speech.createdAt) / 60)
            : 0;
        const date = speech.createdAt
          ? new Date(speech.createdAt * 1000).toISOString().split("T")[0]
          : new Date().toISOString().split("T")[0];

        send("import:itemProgress", { otterId, status: "tagging" });

        const meta = await tagConversation(otterId, speech.title, date, durationMinutes, transcript);
        saveConversation(meta, transcript);
        upsertConversation(meta);
        updateOtterListCacheStatus(otterId, "tagged");

        send("import:itemProgress", { otterId, status: "done" });
        processed++;

        await sleep(300);
      } catch (err: any) {
        send("import:itemProgress", { otterId, status: "error", message: err.message });
        failed++;
      }
    }

    return { success: true, processed, failed };
  });

  // Conversations
  ipcMain.handle("conversations:list", () => listAllConversations());
  ipcMain.handle("conversations:search", (_e, query: string) => searchConversations(query, 50));
  ipcMain.handle("conversations:get", (_e, id: string) => loadConversation(id));

  // Chat
  ipcMain.handle("chat:send", async (_e, question: string, history: ChatMessage[]) => {
    try {
      const result = await chat(question, history, delta => {
        send("chat:delta", delta);
      });
      return { success: true, response: result.response, action: result.action };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Chat sessions
  ipcMain.handle("chats:loadLatest", () => {
    return loadLatestSession();
  });

  ipcMain.handle("chats:save", (_e, sessionData: ChatSession) => {
    saveSession(sessionData);
    return { success: true };
  });

  ipcMain.handle("chats:summarize", async (_e, sessionData: ChatSession) => {
    try {
      const summary = await summarizeSession(sessionData);
      return { success: true, summary };
    } catch (err: any) {
      return { success: false, summary: "", error: err.message };
    }
  });

  ipcMain.handle("chats:finish", async (_e, sessionData: ChatSession) => {
    try {
      saveSession(sessionData);
      await saveSessionAsConversation(sessionData);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Auto-tag in background after each exchange — first call does AI tagging,
  // subsequent calls just refresh the transcript (no extra OpenAI spend)
  ipcMain.handle("chats:autoTag", (_e, sessionData: ChatSession) => {
    // Fire-and-forget: don't await, don't block the renderer
    saveSessionAsConversation(sessionData).catch(() => {});
    return { success: true };
  });

  // WhatsApp
  ipcMain.handle("whatsapp:list", (_e, limit?: number) => listWhatsAppMessages(limit ?? 500));
  ipcMain.handle("whatsapp:send", async (_e, to: string, body: string) => sendMessage(to, body));
  ipcMain.handle("whatsapp:ingest", (_e, payload: unknown) => ingestWebhookPayload(payload));

  // Personas
  ipcMain.handle("personas:list", () => listPersonas());
  ipcMain.handle("personas:save", (_e, persona: any) => savePersona(persona));
  ipcMain.handle("personas:delete", (_e, id: string) => deletePersona(id));
  ipcMain.handle("personas:summarize", async (_e, id: string) => summarizePersona(id));

  // Phone calls (Vapi)
  ipcMain.handle("calls:initiate", async (_e, phoneNumber: string, instructions: string, personalContext: string, personaId?: string, leaveVoicemail?: boolean) =>
    initiateCall(phoneNumber, instructions, personalContext, personaId, leaveVoicemail));
  ipcMain.handle("calls:refresh", async (_e, callId: string) => refreshCallStatus(callId));
  ipcMain.handle("calls:get", (_e, callId: string) => loadCallRecord(callId));
  ipcMain.handle("calls:list", () => listCallRecords());
  ipcMain.handle("calls:markComplete", (_e, callId: string, completed: boolean) =>
    markCallCompleted(callId, completed));
  ipcMain.handle("calls:hangUp", (_e, callId: string) => hangUpCall(callId));

  ipcMain.handle("calls:syncCallback", async (_e, phoneNumber: string) => {
    try {
      if (phoneNumber) {
        await syncCallbackAssistant(phoneNumber);
      } else {
        // Called from Settings button — only link the phone number, don't wipe assistant context
        await linkCallbackAssistantToPhoneNumber();
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // User profile (knowledge base about Luke)
  ipcMain.handle("profile:list", () => listFacts());
  ipcMain.handle("profile:save", (_e, fact: any) => saveFact(fact));
  ipcMain.handle("profile:delete", (_e, id: string) => { deleteFact(id); return { success: true }; });

  ipcMain.handle("calls:syncInbound", async () => {
    try {
      await fetchAndSyncInboundCalls();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Projects
  ipcMain.handle("projects:list", () => listProjects());
  ipcMain.handle("projects:get", (_e, id: string) => getProject(id));
  ipcMain.handle("projects:create", (_e, data: Parameters<typeof createProject>[0]) => createProject(data));
  ipcMain.handle("projects:update", (_e, id: string, updates: Parameters<typeof updateProject>[1]) => updateProject(id, updates));
  ipcMain.handle("projects:delete", (_e, id: string) => deleteProject(id));
  ipcMain.handle("projects:addTask", (_e, projectId: string, data: Parameters<typeof addTask>[1]) => addTask(projectId, data));
  ipcMain.handle("projects:updateTask", (_e, projectId: string, taskId: string, updates: Parameters<typeof updateTask>[2]) => updateTask(projectId, taskId, updates));
  ipcMain.handle("projects:deleteTask", (_e, projectId: string, taskId: string) => deleteTask(projectId, taskId));

  // Empire / Content Pipeline
  // app.getAppPath() returns the project root (where package.json lives) in
  // both dev and production — do NOT add ".." or you overshoot to the parent.
  ipcMain.handle("empire:getPendingVideos", () => {
    const pendingDir = path.join(app.getAppPath(), "content-review", "pending");
    const manifestPath = path.join(pendingDir, "manifest.json");
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      return manifest.videos.map((v: any) => {
        const vp = v.video_file ? path.join(pendingDir, v.video_file) : null;
        const tp = v.thumbnail_file ? path.join(pendingDir, v.thumbnail_file) : null;
        return {
          ...v,
          video_path: vp && fs.existsSync(vp) ? vp : null,
          thumbnail_path: tp && fs.existsSync(tp) ? tp : null,
        };
      });
    } catch {
      return [];
    }
  });

  ipcMain.handle("empire:approveVideo", (_e, id: string) => {
    const pendingDir = path.join(app.getAppPath(), "content-review", "pending");
    const manifestPath = path.join(pendingDir, "manifest.json");
    const queuePath = path.join(app.getAppPath(), "content-review", "upload-queue.json");
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const video = manifest.videos.find((v: any) => v.id === id);
      if (!video) return { success: false, error: "Video not found" };
      video.status = "approved";
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      const queue = fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, "utf8")) : [];
      queue.push({ ...video, approved_at: new Date().toISOString() });
      fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("empire:rejectVideo", (_e, id: string, target: string, note: string) => {
    const pendingDir = path.join(app.getAppPath(), "content-review", "pending");
    const manifestPath = path.join(pendingDir, "manifest.json");
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const video = manifest.videos.find((v: any) => v.id === id);
      if (!video) return { success: false, error: "Video not found" };
      if (!note) {
        // No note = trash it
        video.status = "trashed";
        video[`${target}_trashed`] = true;
      } else {
        // Has note = re-queue for regeneration with feedback
        video.status = target === "both" ? "rejected" : `${target}_rejected`;
        video[`${target}_rejection_note`] = note;
        video[`${target}_needs_regen`] = true;
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // Upload queue management
  ipcMain.handle("empire:getUploadQueue", () => {
    const queuePath = path.join(app.getAppPath(), "content-review", "upload-queue.json");
    try {
      if (!fs.existsSync(queuePath)) return [];
      return JSON.parse(fs.readFileSync(queuePath, "utf8"));
    } catch {
      return [];
    }
  });

  ipcMain.handle("empire:markUploaded", (_e, id: string, youtubeUrl?: string) => {
    const queuePath = path.join(app.getAppPath(), "content-review", "upload-queue.json");
    const manifestPath = path.join(app.getAppPath(), "content-review", "pending", "manifest.json");
    try {
      const queue = fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, "utf8")) : [];
      const item = queue.find((v: any) => v.id === id);
      if (!item) return { success: false, error: "Item not found in upload queue" };
      item.upload_status = "posted";
      item.uploadedAt = new Date().toISOString();
      if (youtubeUrl) item.youtube_url = youtubeUrl;
      fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));

      // Also update manifest
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const video = manifest.videos?.find((v: any) => v.id === id);
        if (video) {
          video.upload_status = "posted";
          video.uploadedAt = item.uploadedAt;
          if (youtubeUrl) video.youtube_url = youtubeUrl;
          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        }
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // PII scan on demand
  ipcMain.handle("pii:scan", async (_e, text: string, source: string) => {
    try {
      const detections = await scanAndAlert(text, source);
      return { success: true, detections };
    } catch (e: any) {
      return { success: false, detections: [], error: e.message };
    }
  });

  // Agent memory
  ipcMain.handle("agent:readMemory", async () => {
    try {
      await ensureMemoryFile();
      const content = await readMemory();
      return { success: true, content };
    } catch (e: any) {
      return { success: false, content: "", error: e.message };
    }
  });

  ipcMain.handle("agent:writeMemory", async (_e, content: string) => {
    try {
      await writeMemory(content);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("agent:postCallReflection", async (_e, input: {
    callId: string;
    phoneNumber: string;
    contactName?: string;
    instructions: string;
    outcome: string;
    transcript?: string;
    durationSeconds?: number;
    userFeedback?: string;
  }) => {
    try {
      const reflection = await runPostCallReflection(input);
      return { success: true, reflection };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // PII scan wired into WhatsApp ingest
  ipcMain.handle("whatsapp:ingestAndScan", async (_e, payload: unknown) => {
    const count = await ingestWebhookPayload(payload);
    // Extract message text for PII scanning
    const msgs = (payload as any)?.entry?.[0]?.changes?.[0]?.value?.messages ?? [];
    for (const msg of msgs) {
      const text = msg?.text?.body ?? "";
      if (text) {
        scanAndAlert(text, "whatsapp_inbound").catch(() => {});
      }
    }
    return count;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
