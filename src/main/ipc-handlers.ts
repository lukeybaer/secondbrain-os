import { ipcMain, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getConfig, saveConfig } from './config';
import { streamAllSpeeches, getSpeech, getTranscript, login, invalidateSession } from './otter';
import { tagConversation } from './tagger';
import {
  saveConversation,
  listAllConversations,
  loadConversation,
  conversationExists,
  saveOtterListCache,
  loadOtterListCache,
  updateOtterListCacheStatus,
  OtterListItem,
} from './storage';
import { upsertConversation, searchConversations } from './database';
import { sendMessage as sendTelegramMessage } from './telegram';
import { chat, ChatMessage } from './chat';
import {
  createSession,
  loadLatestSession,
  saveSession,
  summarizeSession,
  saveSessionAsConversation,
  ChatSession,
} from './chat-sessions';
import {
  allowQRWindow as waAllowQR,
  initClient as waInit,
  getStatus as waGetStatus,
  getAllChats as waGetChats,
  getChatHistory as waGetHistory,
  sendWhatsAppMessage as waSend,
  searchWhatsAppMessages as waSearch,
  disconnectWhatsApp as waDisconnect,
  onStatusChange as waOnStatus,
  onNewMessage as waOnMessage,
} from './whatsapp-web';
import {
  initiateCall,
  refreshCallStatus,
  loadCallRecord,
  listCallRecords,
  markCallCompleted,
  hangUpCall,
  syncCallbackAssistant,
  linkCallbackAssistantToPhoneNumber,
  fetchAndSyncInboundCalls,
} from './calls';
import { listPersonas, savePersona, deletePersona, summarizePersona } from './personas';
import { listFacts, saveFact, deleteFact } from './user-profile';
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  addTask,
  updateTask,
  deleteTask,
} from './projects';
import { scanAndAlert } from './pii-scanner';
import { readMemory, writeMemory, runPostCallReflection, ensureMemoryFile } from './agent-memory';
import { sendSms, listSmsMessages, searchSmsMessages, ingestSmsWebhook } from './twilio-sms';
import { listTodos, addTodo, updateTodo, deleteTodo, reorderTodos } from './todos';
import {
  listAmyVersions,
  getAmyVersion,
  getActiveAmyVersion,
  saveAmyVersion,
} from './amy-versions';
import { injectContext, injectSpeech, getActiveCallControls } from './live-call-control';
import {
  startRecording as studioStartRecording,
  stopRecording as studioStopRecording,
  addMarker,
  getActiveRecording,
  listRecordings,
  loadRecording,
  deleteRecording,
  processRecording,
  loadStudioConfig,
  saveStudioConfig,
  detectDevices,
  clearDeviceCache,
  checkNvenc,
} from './studio';
import {
  startTimeMachine,
  stopTimeMachine,
  pauseTimeMachine,
  resumeTimeMachine,
  getTimeMachineStatus,
  loadTimeMachineConfig,
  saveTimeMachineConfig,
} from './timemachine';
import {
  getRecentFrames,
  getFramesInRange,
  getAudioInRange,
  searchAll,
  getStorageStats,
} from './timemachine-db';
import { pruneTimeMachineData } from './timemachine-pruner';
import {
  createSnapshot,
  listSnapshots,
  getSnapshot,
  inspectSnapshot,
  readSnapshotFile,
  querySnapshotDb,
  testRestore,
  commitRestore,
  rollForward,
  cleanupTestRestores,
  pruneSnapshots,
  runDailyBackup,
} from './backups';
import { processRejectionLearning } from './rejection-skill-learning';

const AUDIO_DIAG_FILE = path.join(app.getPath('userData'), 'audio-diag.log');

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  const send = (channel: string, data: any) => mainWindow.webContents.send(channel, data);

  ipcMain.handle('diag:writeAudio', (_e, line: string, firstFrameHex?: string) => {
    const timestamp = new Date().toISOString();
    let entry = `[${timestamp}] ${line}\n`;
    if (firstFrameHex) entry += `  first frame (hex): ${firstFrameHex}\n`;
    fs.appendFileSync(AUDIO_DIAG_FILE, entry, 'utf-8');
  });

  // Config
  ipcMain.handle('config:get', () => getConfig());
  ipcMain.handle('config:save', (_e, config) => saveConfig(config));

  // Otter: test authentication
  ipcMain.handle('otter:testConnection', async () => {
    try {
      await login();
      return { ok: true, message: 'Connected successfully' };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  });

  // Otter: open in-app browser for Google SSO login — captures session cookies + userId
  ipcMain.handle('otter:openLoginWindow', async () => {
    return new Promise<{ ok: boolean; message: string }>((resolve) => {
      const win = new BrowserWindow({
        width: 1000,
        height: 720,
        title: 'Sign in to Otter.ai',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      let resolved = false;

      const finish = (result: { ok: boolean; message: string }) => {
        if (resolved) return;
        resolved = true;
        try {
          win.destroy();
        } catch {
          /* already closed */
        }
        resolve(result);
      };

      win.on('closed', () => {
        finish({ ok: false, message: 'Window closed before login completed.' });
      });

      // Detect successful login: Otter redirects to /home, /my-notes, or /dashboard
      win.webContents.on('did-navigate', async (_, url) => {
        if (!url.includes('otter.ai')) return;
        if (url.includes('/login') || url.includes('accounts.google') || url.includes('oauth'))
          return;

        // Looks like a post-login page — grab cookies
        try {
          const cookies = await win.webContents.session.cookies.get({ domain: '.otter.ai' });
          const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

          if (!cookieStr) {
            // Not logged in yet — wait for more navigation
            return;
          }

          // Try to discover userId from the Otter user-info endpoint
          let foundUserId = '';
          try {
            const infoRes = await fetch('https://otter.ai/forward/api/v1/user', {
              headers: {
                Cookie: cookieStr,
                'x-origin': 'https://otter.ai',
                Referer: 'https://otter.ai/',
              },
            });
            if (infoRes.ok) {
              const data = await infoRes.json();
              foundUserId = String(data.userid ?? data.user_id ?? data.id ?? '');
            }
          } catch {
            /* will fall back to speeches endpoint below */
          }

          // Fallback: fetch first page of speeches to extract userid from response
          if (!foundUserId) {
            try {
              const speechRes = await fetch(
                'https://otter.ai/forward/api/v1/speeches?page_size=1',
                {
                  headers: {
                    Cookie: cookieStr,
                    'x-origin': 'https://otter.ai',
                    Referer: 'https://otter.ai/',
                  },
                },
              );
              if (speechRes.ok) {
                const data = await speechRes.json();
                foundUserId = String(data.userid ?? data.user_id ?? '');
              }
            } catch {
              /* ignore */
            }
          }

          if (!foundUserId) {
            finish({ ok: false, message: "Logged in but couldn't retrieve user ID. Try again." });
            return;
          }

          // Persist to config and invalidate in-memory session so next poll re-auths
          saveConfig({ otterSessionCookie: cookieStr, otterUserId: foundUserId });
          invalidateSession();

          finish({
            ok: true,
            message: `Authenticated as user ${foundUserId}. Polling will resume shortly.`,
          });
        } catch (e: any) {
          finish({ ok: false, message: `Login capture failed: ${e.message}` });
        }
      });

      win.loadURL('https://otter.ai/login');
    });
  });

  // Fetch list from Otter — streams batches back via import:listBatch events
  ipcMain.handle('import:fetchList', async () => {
    try {
      const local = listAllConversations();
      const taggedIds = new Set(
        local.filter((c) => c.meetingType !== 'OpenBrainChat').map((c) => c.otterId),
      );

      const accumulated: OtterListItem[] = [];

      await streamAllSpeeches((speeches) => {
        const items: OtterListItem[] = speeches.map((s) => ({
          otterId: s.id,
          title: s.title,
          date: s.createdAt ? new Date(s.createdAt * 1000).toISOString().split('T')[0] : 'unknown',
          durationMinutes:
            s.endTime && s.createdAt ? Math.round((s.endTime - s.createdAt) / 60) : 0,
          status: taggedIds.has(s.id) ? 'tagged' : 'remote',
        }));

        // Merge into accumulated (dedupe by otterId)
        for (const item of items) {
          const idx = accumulated.findIndex((i) => i.otterId === item.otterId);
          if (idx >= 0) {
            accumulated[idx] = item;
          } else {
            accumulated.push(item);
          }
        }

        saveOtterListCache(accumulated);
        send('import:listBatch', items);
      });

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Load cached Otter list (with fresh tagged status)
  ipcMain.handle('import:loadCached', () => {
    const cached = loadOtterListCache();
    if (cached.length === 0) return [];
    const local = listAllConversations();
    const taggedIds = new Set(
      local.filter((c) => c.meetingType !== 'OpenBrainChat').map((c) => c.otterId),
    );
    return cached.map((item) => ({
      ...item,
      status: taggedIds.has(item.otterId) ? 'tagged' : item.status,
    }));
  });

  // Process specific conversations (download transcript + AI tag)
  ipcMain.handle('import:processIds', async (_e, otterIds: string[]) => {
    let processed = 0;
    let failed = 0;

    for (const otterId of otterIds) {
      send('import:itemProgress', { otterId, status: 'downloading' });
      try {
        const speech = await getSpeech(otterId);
        const transcript = await getTranscript(otterId);

        const durationMinutes =
          speech.endTime && speech.createdAt
            ? Math.round((speech.endTime - speech.createdAt) / 60)
            : 0;
        const date = speech.createdAt
          ? new Date(speech.createdAt * 1000).toISOString().split('T')[0]
          : new Date().toISOString().split('T')[0];

        send('import:itemProgress', { otterId, status: 'tagging' });

        const meta = await tagConversation(
          otterId,
          speech.title,
          date,
          durationMinutes,
          transcript,
        );
        saveConversation(meta, transcript);
        upsertConversation(meta);
        updateOtterListCacheStatus(otterId, 'tagged');

        send('import:itemProgress', { otterId, status: 'done' });
        processed++;

        await sleep(300);
      } catch (err: any) {
        send('import:itemProgress', { otterId, status: 'error', message: err.message });
        failed++;
      }
    }

    return { success: true, processed, failed };
  });

  // Conversations
  ipcMain.handle('conversations:list', () => listAllConversations());
  ipcMain.handle('conversations:search', (_e, query: string) => searchConversations(query, 50));
  ipcMain.handle('conversations:get', (_e, id: string) => loadConversation(id));

  // Chat
  ipcMain.handle('chat:send', async (_e, question: string, history: ChatMessage[]) => {
    try {
      const result = await chat(question, history, (delta) => {
        send('chat:delta', delta);
      });
      return { success: true, response: result.response, action: result.action };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Chat sessions
  ipcMain.handle('chats:loadLatest', () => {
    return loadLatestSession();
  });

  ipcMain.handle('chats:save', (_e, sessionData: ChatSession) => {
    saveSession(sessionData);
    return { success: true };
  });

  ipcMain.handle('chats:summarize', async (_e, sessionData: ChatSession) => {
    try {
      const summary = await summarizeSession(sessionData);
      return { success: true, summary };
    } catch (err: any) {
      return { success: false, summary: '', error: err.message };
    }
  });

  ipcMain.handle('chats:finish', async (_e, sessionData: ChatSession) => {
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
  ipcMain.handle('chats:autoTag', (_e, sessionData: ChatSession) => {
    // Fire-and-forget: don't await, don't block the renderer
    saveSessionAsConversation(sessionData).catch(() => {});
    return { success: true };
  });

  // WhatsApp (whatsapp-web.js — personal account)
  ipcMain.handle('whatsapp:connect', () => {
    waAllowQR();
    return waInit();
  });
  ipcMain.handle('whatsapp:status', () => ({ status: waGetStatus() }));
  ipcMain.handle('whatsapp:chats', () => waGetChats());
  ipcMain.handle('whatsapp:messages', (_e, chatId: string, limit?: number) =>
    waGetHistory(chatId, limit),
  );
  ipcMain.handle('whatsapp:send', async (_e, to: string, text: string) => waSend(to, text));
  ipcMain.handle('whatsapp:search', (_e, query: string) => waSearch(query));
  ipcMain.handle('whatsapp:disconnect', () => waDisconnect());
  ipcMain.handle('whatsapp:ingestAll', async () => {
    const { ingestAllWhatsAppHistory } = await import('./whatsapp-ingest');
    return ingestAllWhatsAppHistory((progress) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('whatsapp:ingestProgress', progress);
      }
    });
  });

  // Forward status changes and new messages to renderer
  waOnStatus((status, qrDataUrl) => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('whatsapp:statusChange', { status, qrDataUrl });
  });
  waOnMessage((msg) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('whatsapp:message', msg);
  });

  // SMS (Twilio)
  ipcMain.handle('sms:list', (_e, limit?: number) => listSmsMessages(limit ?? 500));
  ipcMain.handle('sms:search', (_e, query: string, limit?: number) =>
    searchSmsMessages(query, limit),
  );
  ipcMain.handle('sms:send', async (_e, to: string, body: string, mediaUrl?: string) =>
    sendSms(to, body, mediaUrl),
  );
  ipcMain.handle('sms:ingest', async (_e, fields: Record<string, string>) =>
    ingestSmsWebhook(fields),
  );

  // Personas
  ipcMain.handle('personas:list', () => listPersonas());
  ipcMain.handle('personas:save', (_e, persona: any) => savePersona(persona));
  ipcMain.handle('personas:delete', (_e, id: string) => deletePersona(id));
  ipcMain.handle('personas:summarize', async (_e, id: string) => summarizePersona(id));

  // Phone calls (Vapi)
  ipcMain.handle(
    'calls:initiate',
    async (
      _e,
      phoneNumber: string,
      instructions: string,
      personalContext: string,
      personaId?: string,
      leaveVoicemail?: boolean,
      options?: {
        silenceTimeoutSeconds?: number;
        maxDurationSeconds?: number;
        amyVersion?: number;
      },
    ) =>
      initiateCall(phoneNumber, instructions, personalContext, personaId, leaveVoicemail, options),
  );
  ipcMain.handle('calls:refresh', async (_e, callId: string) => refreshCallStatus(callId));
  ipcMain.handle('calls:get', (_e, callId: string) => loadCallRecord(callId));
  ipcMain.handle('calls:list', () => listCallRecords());
  ipcMain.handle('calls:markComplete', (_e, callId: string, completed: boolean) =>
    markCallCompleted(callId, completed),
  );
  ipcMain.handle('calls:hangUp', (_e, callId: string) => hangUpCall(callId));

  ipcMain.handle('calls:syncCallback', async (_e, phoneNumber: string) => {
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
  ipcMain.handle('profile:list', () => listFacts());
  ipcMain.handle('profile:save', (_e, fact: any) => saveFact(fact));
  ipcMain.handle('profile:delete', (_e, id: string) => {
    deleteFact(id);
    return { success: true };
  });

  ipcMain.handle('calls:syncInbound', async () => {
    try {
      await fetchAndSyncInboundCalls();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Projects
  ipcMain.handle('projects:list', () => listProjects());
  ipcMain.handle('projects:get', (_e, id: string) => getProject(id));
  ipcMain.handle('projects:create', (_e, data: Parameters<typeof createProject>[0]) =>
    createProject(data),
  );
  ipcMain.handle(
    'projects:update',
    (_e, id: string, updates: Parameters<typeof updateProject>[1]) => updateProject(id, updates),
  );
  ipcMain.handle('projects:delete', (_e, id: string) => deleteProject(id));
  ipcMain.handle('projects:addTask', (_e, projectId: string, data: Parameters<typeof addTask>[1]) =>
    addTask(projectId, data),
  );
  ipcMain.handle(
    'projects:updateTask',
    (_e, projectId: string, taskId: string, updates: Parameters<typeof updateTask>[2]) =>
      updateTask(projectId, taskId, updates),
  );
  ipcMain.handle('projects:deleteTask', (_e, projectId: string, taskId: string) =>
    deleteTask(projectId, taskId),
  );

  // Empire / Content Pipeline
  // In dev, app.getAppPath() returns the project root. In production (packaged),
  // it points inside app.asar which doesn't contain content-review/.
  // Use the SECONDBRAIN_ROOT env var if set, otherwise resolve from __dirname
  // (out/main → project root in dev) or fall back to the known repo path.
  const contentRoot =
    process.env.SECONDBRAIN_ROOT ??
    (app.isPackaged ? 'C:/Users/luked/secondbrain' : path.resolve(app.getAppPath()));
  ipcMain.handle('empire:getPendingVideos', () => {
    const pendingDir = path.join(contentRoot, 'content-review', 'pending');
    const manifestPath = path.join(pendingDir, 'manifest.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return manifest.videos.map((v: any) => {
        const vp = v.video_file ? path.join(pendingDir, v.video_file) : null;
        const tp = v.thumbnail_file ? path.join(pendingDir, v.thumbnail_file) : null;
        let transcript = null;
        if (v.transcript_file) {
          const tfp = path.join(pendingDir, v.transcript_file);
          if (fs.existsSync(tfp)) {
            try {
              transcript = JSON.parse(fs.readFileSync(tfp, 'utf8'));
            } catch {
              /* skip */
            }
          }
        }
        return {
          ...v,
          video_path: vp && fs.existsSync(vp) ? vp : null,
          thumbnail_path: tp && fs.existsSync(tp) ? tp : null,
          transcript,
        };
      });
    } catch {
      return [];
    }
  });

  ipcMain.handle('empire:approveVideo', (_e, id: string) => {
    const pendingDir = path.join(contentRoot, 'content-review', 'pending');
    const manifestPath = path.join(pendingDir, 'manifest.json');
    const queuePath = path.join(contentRoot, 'content-review', 'upload-queue.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const video = manifest.videos.find((v: any) => v.id === id);
      if (!video) return { success: false, error: 'Video not found' };
      video.status = 'approved';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      const queue = fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, 'utf8')) : [];
      queue.push({ ...video, approved_at: new Date().toISOString() });
      fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('empire:rejectVideo', (_e, id: string, target: string, note: string) => {
    const pendingDir = path.join(contentRoot, 'content-review', 'pending');
    const manifestPath = path.join(pendingDir, 'manifest.json');
    const rejectionsLog = path.join(contentRoot, 'content-review', 'rejections.jsonl');
    const learningsFile = path.join(contentRoot, 'content-review', 'LEARNINGS.md');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const video = manifest.videos.find((v: any) => v.id === id);
      if (!video) return { success: false, error: 'Video not found' };
      if (!note) {
        // No note = trash it
        video.status = 'trashed';
        video[`${target}_trashed`] = true;
      } else {
        // Has note = re-queue for regeneration with feedback
        video.status = target === 'both' ? 'rejected' : `${target}_rejected`;
        video[`${target}_rejection_note`] = note;
        video[`${target}_needs_regen`] = true;

        // ── Append to rejections.jsonl ────────────────────────────────────
        const logEntry = JSON.stringify({
          id,
          title: video.title,
          channel: video.channel,
          target,
          note,
          rejectedAt: new Date().toISOString(),
        });
        fs.appendFileSync(rejectionsLog, logEntry + '\n', 'utf8');

        // ── Append to LEARNINGS.md (read by video pipeline on GCP) ────────
        const date = new Date().toISOString().split('T')[0];
        const learningLine = `- [${date}] **${video.title}** (${target}): ${note}\n`;
        if (!fs.existsSync(learningsFile)) {
          fs.writeFileSync(
            learningsFile,
            `# Content Production Learnings\n\nFeedback from review sessions — read this before generating new videos.\n\n## Rejection Feedback\n\n`,
            'utf8',
          );
        }
        fs.appendFileSync(learningsFile, learningLine, 'utf8');

        // ── Append to agent EA memory ─────────────────────────────────────
        try {
          const memResult = readMemory('ea');
          memResult
            .then(({ content }) => {
              const memLine = `\n## Content Learning [${date}]\n**${video.title}** (${target} rejected): ${note}\n`;
              writeMemory('ea', content + memLine).catch(() => {
                /* best-effort */
              });
            })
            .catch(() => {
              /* best-effort */
            });
        } catch {
          /* best-effort */
        }
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      // Telegram notification on rejection
      if (note) {
        const cfg = getConfig();
        if (cfg.telegramBotToken && cfg.telegramChatId) {
          sendTelegramMessage(
            cfg.telegramChatId,
            `Video rejected: ${video.title}\nTarget: ${target}\nFeedback: ${note}\nWill fix and re-present.`,
          ).catch(() => {
            /* best-effort */
          });
        }
      }

      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // RSL — Rejection-Skill-Learning: classify feedback, update rubric, append LEARNINGS.md
  // Also called fire-and-forget from ContentPipeline.tsx after handleReject
  ipcMain.handle(
    'empire:processRejectionLearning',
    async (
      _e,
      input: { videoId: string; videoTitle: string; channel: string; target: string; note: string },
    ) => {
      try {
        await processRejectionLearning(input);
        return { success: true };
      } catch (e: any) {
        console.error('[rsl] IPC handler error:', e);
        return { success: false, error: e.message };
      }
    },
  );

  // Published videos — historical OpenClaw published videos
  ipcMain.handle('empire:getPublishedVideos', () => {
    const publishedDir = path.join(contentRoot, 'content-review', 'published');
    const manifestPath = path.join(publishedDir, 'manifest.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return (manifest.videos ?? []).map((v: any) => {
        const vp = v.video_file ? path.join(publishedDir, v.video_file) : null;
        const tp = v.thumbnail_file ? path.join(publishedDir, v.thumbnail_file) : null;
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

  // Upload queue management
  ipcMain.handle('empire:getUploadQueue', () => {
    const queuePath = path.join(contentRoot, 'content-review', 'upload-queue.json');
    try {
      if (!fs.existsSync(queuePath)) return [];
      return JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    } catch {
      return [];
    }
  });

  // Queue video for YouTube upload via EC2
  ipcMain.handle('empire:queueForUpload', async (_e, id: string) => {
    const { execSync } = require('child_process');
    const queuePath = path.join(contentRoot, 'content-review', 'upload-queue.json');
    const pendingDir = path.join(contentRoot, 'content-review', 'pending');
    const SSH_KEY = '/c/Users/luked/.ssh/secondbrain-backend-key.pem';
    const EC2_HOST = 'ec2-user@98.80.164.16';
    const EC2_VIDEO_DIR = '/opt/secondbrain/data/youtube';

    try {
      const queue = fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, 'utf8')) : [];
      const item = queue.find((v: Record<string, unknown>) => v.id === id);
      if (!item) return { success: false, error: 'Item not found in upload queue' };

      const config = getConfig();
      const ec2 = config.ec2BaseUrl;
      if (!ec2) return { success: false, error: 'ec2BaseUrl not configured' };

      // Resolve local file paths
      const videoFile = item.video_file as string | undefined;
      const thumbFile = item.thumbnail_file as string | undefined;
      const videoPath = videoFile ? path.join(pendingDir, videoFile) : null;
      const thumbPath = thumbFile ? path.join(pendingDir, thumbFile) : null;

      if (!videoPath || !fs.existsSync(videoPath)) {
        return { success: false, error: 'Video file not found: ' + (videoPath ?? 'none') };
      }

      // SCP video to EC2
      const remoteVideoPath = `${EC2_VIDEO_DIR}/${id}.mp4`;
      const scpOpts = `-i ${SSH_KEY} -o StrictHostKeyChecking=no`;
      console.log(`[upload] SCP ${videoPath} → ${EC2_HOST}:${remoteVideoPath}`);
      execSync(
        `ssh ${scpOpts} ${EC2_HOST} "mkdir -p ${EC2_VIDEO_DIR}" && scp ${scpOpts} "${videoPath.replace(/\\/g, '/')}" ${EC2_HOST}:${remoteVideoPath}`,
        { timeout: 120000 },
      );

      // SCP thumbnail if present
      let remoteThumbnailPath: string | undefined;
      if (thumbPath && fs.existsSync(thumbPath)) {
        remoteThumbnailPath = `${EC2_VIDEO_DIR}/${id}_thumb.jpg`;
        execSync(
          `scp ${scpOpts} "${thumbPath.replace(/\\/g, '/')}" ${EC2_HOST}:${remoteThumbnailPath}`,
          { timeout: 30000 },
        );
      }

      // POST metadata to EC2 YouTube queue
      const res = await fetch(`${ec2}/youtube/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: item.id,
          title: item.title,
          channel: item.channel || 'AILifeHacks',
          description: (item.description as string) || '',
          tags: (item.tags as string[]) || [],
          videoPath: remoteVideoPath,
          thumbnailPath: remoteThumbnailPath,
        }),
      });

      const result = await res.json();
      if (!result.ok) return { success: false, error: JSON.stringify(result) };

      // Mark as uploading in local queue
      item.upload_status = 'uploading';
      item.queued_at = new Date().toISOString();
      fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));

      return { success: true, position: result.position };
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('empire:markUploaded', (_e, id: string, youtubeUrl?: string) => {
    const queuePath = path.join(contentRoot, 'content-review', 'upload-queue.json');
    const manifestPath = path.join(contentRoot, 'content-review', 'pending', 'manifest.json');
    try {
      const queue = fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, 'utf8')) : [];
      const item = queue.find((v: any) => v.id === id);
      if (!item) return { success: false, error: 'Item not found in upload queue' };
      item.upload_status = 'posted';
      item.uploadedAt = new Date().toISOString();
      if (youtubeUrl) item.youtube_url = youtubeUrl;
      fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));

      // Also update manifest
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const video = manifest.videos?.find((v: any) => v.id === id);
        if (video) {
          video.upload_status = 'posted';
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

  // Reject a video from the upload queue back to needs-regen
  ipcMain.handle('empire:rejectUploadedVideo', (_e, id: string, note: string) => {
    const queuePath = path.join(contentRoot, 'content-review', 'upload-queue.json');
    const manifestPath = path.join(contentRoot, 'content-review', 'pending', 'manifest.json');
    const learningsFile = path.join(contentRoot, 'content-review', 'LEARNINGS.md');
    const rejectionsLog = path.join(contentRoot, 'content-review', 'rejections.jsonl');
    try {
      // Remove from upload queue
      const queue = fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, 'utf8')) : [];
      const idx = queue.findIndex((v: Record<string, unknown>) => v.id === id);
      const item = idx >= 0 ? queue[idx] : null;
      if (idx >= 0) {
        queue.splice(idx, 1);
        fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
      }

      // Update manifest to rejected
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const video = (manifest.videos || manifest).find
          ? (manifest.videos || manifest).find((v: Record<string, unknown>) => v.id === id)
          : null;
        if (video) {
          video.status = 'rejected';
          video.video_rejection_note = note;
          video.video_needs_regen = true;
          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        }
      }

      // Log rejection
      const logEntry = JSON.stringify({
        id,
        title: item?.title ?? id,
        note,
        source: 'upload_queue_reject',
        rejectedAt: new Date().toISOString(),
      });
      fs.appendFileSync(rejectionsLog, logEntry + '\n', 'utf8');

      // Append to LEARNINGS.md
      const date = new Date().toISOString().split('T')[0];
      const learningLine = `- [${date}] **${item?.title ?? id}** (upload queue reject): ${note}\n`;
      if (!fs.existsSync(learningsFile)) {
        fs.writeFileSync(
          learningsFile,
          `# Content Production Learnings\n\nFeedback from review sessions.\n\n## Rejection Feedback\n\n`,
          'utf8',
        );
      }
      fs.appendFileSync(learningsFile, learningLine, 'utf8');

      // Telegram notification
      const cfg = getConfig();
      if (cfg.telegramBotToken && cfg.telegramChatId) {
        sendTelegramMessage(
          cfg.telegramChatId,
          `Video rejected from upload queue: ${item?.title ?? id}\nFeedback: ${note}\nWill fix and re-present.`,
        ).catch(() => {
          /* best-effort */
        });
      }

      return { success: true };
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // ── Social Posts (X / LinkedIn content approval pipeline) ─────────────────
  const socialDir = path.join(contentRoot, 'content-review', 'social-posts');
  const socialQueuePath = path.join(socialDir, 'queue.json');
  const socialLearningsPath = path.join(socialDir, 'learnings.md');

  function readSocialQueue(): any[] {
    try {
      if (!fs.existsSync(socialQueuePath)) return [];
      return JSON.parse(fs.readFileSync(socialQueuePath, 'utf8'));
    } catch {
      return [];
    }
  }

  function writeSocialQueue(queue: any[]): void {
    if (!fs.existsSync(socialDir)) fs.mkdirSync(socialDir, { recursive: true });
    fs.writeFileSync(socialQueuePath, JSON.stringify(queue, null, 2));
  }

  ipcMain.handle('social:getPosts', (_e, statusFilter?: string) => {
    const queue = readSocialQueue();
    if (!statusFilter) return queue;
    return queue.filter((p: any) => p.status === statusFilter);
  });

  ipcMain.handle('social:createDraft', async (_e, post: any) => {
    try {
      const queue = readSocialQueue();
      const id = post.id || `post_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const entry = {
        id,
        platform: post.platform || 'x',
        status: post.status || 'pending_approval',
        content: post.content || '',
        source_idea: post.source_idea || '',
        media_paths: post.media_paths || [],
        created_at: new Date().toISOString(),
      };
      queue.push(entry);
      writeSocialQueue(queue);

      // Telegram is daily-briefing-only — social post drafts visible in Content Pipeline UI
      console.log(`[social] New ${entry.platform.toUpperCase()} post draft ready for review`);

      return { success: true, post: entry };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('social:approvePost', (_e, id: string, scheduledFor?: string) => {
    try {
      const queue = readSocialQueue();
      const post = queue.find((p: any) => p.id === id);
      if (!post) return { success: false, error: 'Post not found' };
      post.status = 'approved';
      post.approved_at = new Date().toISOString();
      if (scheduledFor) post.scheduled_for = scheduledFor;
      writeSocialQueue(queue);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('social:rejectPost', (_e, id: string, note: string) => {
    try {
      const queue = readSocialQueue();
      const post = queue.find((p: any) => p.id === id);
      if (!post) return { success: false, error: 'Post not found' };
      if (!note) {
        post.status = 'trashed';
      } else {
        post.status = 'rejected';
        post.rejection_note = note;
        // Append to learnings
        const date = new Date().toISOString().split('T')[0];
        const line = `- [${date}] **Rejected** (${post.platform}): ${note}\n`;
        if (!fs.existsSync(socialLearningsPath)) {
          fs.writeFileSync(
            socialLearningsPath,
            '# Social Post Learnings\n\n## Rejection Feedback\n\n',
            'utf8',
          );
        }
        fs.appendFileSync(socialLearningsPath, line, 'utf8');
      }
      writeSocialQueue(queue);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('social:editPost', (_e, id: string, content: string) => {
    try {
      const queue = readSocialQueue();
      const post = queue.find((p: any) => p.id === id);
      if (!post) return { success: false, error: 'Post not found' };
      post.content = content;
      writeSocialQueue(queue);
      return { success: true, post };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('social:publishPost', async (_e, id: string) => {
    try {
      const { publishTweet } = await import('./x-publisher');
      const queue = readSocialQueue();
      const post = queue.find((p: any) => p.id === id);
      if (!post) return { success: false, error: 'Post not found' };
      if (post.platform !== 'x')
        return { success: false, error: `Publishing to ${post.platform} not yet supported` };

      const result = await publishTweet(post.content);
      if (!result.success) return result;

      post.status = 'posted';
      post.posted_at = new Date().toISOString();
      post.post_url = result.postUrl;
      post.tweet_id = result.tweetId;
      writeSocialQueue(queue);
      return { success: true, postUrl: result.postUrl };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('social:trashPost', (_e, id: string) => {
    try {
      const queue = readSocialQueue();
      const post = queue.find((p: any) => p.id === id);
      if (!post) return { success: false, error: 'Post not found' };
      post.status = 'trashed';
      writeSocialQueue(queue);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('social:refreshEngagement', async (_e, id: string) => {
    try {
      const { getTweetEngagement } = await import('./x-publisher');
      const queue = readSocialQueue();
      const post = queue.find((p: any) => p.id === id);
      if (!post) return { success: false, error: 'Post not found' };
      if (!post.tweet_id)
        return { success: false, error: 'No tweet ID — post may not have been published' };

      const engagement = await getTweetEngagement(post.tweet_id);
      if (!engagement) return { success: false, error: 'Could not fetch engagement' };

      post.engagement = engagement;
      writeSocialQueue(queue);
      return { success: true, engagement };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // PII scan on demand
  ipcMain.handle('pii:scan', async (_e, text: string, source: string) => {
    try {
      const detections = await scanAndAlert(text, source);
      return { success: true, detections };
    } catch (e: any) {
      return { success: false, detections: [], error: e.message };
    }
  });

  // Agent memory
  ipcMain.handle('agent:readMemory', async () => {
    try {
      await ensureMemoryFile();
      const content = await readMemory();
      return { success: true, content };
    } catch (e: any) {
      return { success: false, content: '', error: e.message };
    }
  });

  ipcMain.handle('agent:writeMemory', async (_e, content: string) => {
    try {
      await writeMemory(content);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle(
    'agent:postCallReflection',
    async (
      _e,
      input: {
        callId: string;
        phoneNumber: string;
        contactName?: string;
        instructions: string;
        outcome: string;
        transcript?: string;
        durationSeconds?: number;
        userFeedback?: string;
      },
    ) => {
      try {
        const reflection = await runPostCallReflection(input);
        return { success: true, reflection };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },
  );

  // ── Backups ──────────────────────────────────────────────────────────────────
  ipcMain.handle('backups:create', async () => {
    try {
      const meta = await createSnapshot();
      return { success: true, snapshot: meta };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('backups:list', () => listSnapshots());

  ipcMain.handle('backups:get', (_e, id: string) => getSnapshot(id));

  ipcMain.handle('backups:inspect', async (_e, id: string, subPath?: string) => {
    try {
      const result = await inspectSnapshot(id, subPath);
      return { success: true, ...result };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('backups:readFile', async (_e, id: string, relativePath: string) => {
    try {
      const content = await readSnapshotFile(id, relativePath);
      return { success: true, content };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('backups:queryDb', (_e, id: string, sql: string) => {
    try {
      const rows = querySnapshotDb(id, sql);
      return { success: true, rows };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('backups:testRestore', async (_e, id: string) => {
    try {
      const tempPath = await testRestore(id);
      return { success: true, tempPath };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('backups:commitRestore', async (_e, id: string) => {
    try {
      const result = await commitRestore(id);
      return { success: true, ...result };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('backups:rollForward', async () => {
    try {
      const result = await rollForward();
      return { success: true, ...result };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('backups:prune', async () => {
    try {
      const deleted = await pruneSnapshots();
      return { success: true, deleted };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('backups:runDaily', async () => {
    try {
      const result = await runDailyBackup();
      return { success: true, ...result };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // Todos
  ipcMain.handle('todos:list', () => listTodos());
  ipcMain.handle('todos:add', (_e, data: Parameters<typeof addTodo>[0]) => addTodo(data));
  ipcMain.handle('todos:update', (_e, id: string, updates: Parameters<typeof updateTodo>[1]) =>
    updateTodo(id, updates),
  );
  ipcMain.handle('todos:delete', (_e, id: string) => {
    deleteTodo(id);
    return { success: true };
  });
  ipcMain.handle('todos:reorder', (_e, ids: string[]) => {
    reorderTodos(ids);
    return { success: true };
  });

  // Amy Versions
  ipcMain.handle('amy:listVersions', () => listAmyVersions());
  ipcMain.handle('amy:getVersion', (_e, version: number) => getAmyVersion(version));
  ipcMain.handle('amy:getActiveVersion', () => getActiveAmyVersion());
  ipcMain.handle('amy:saveVersion', (_e, version: any) => {
    saveAmyVersion(version);
    return { success: true };
  });
  ipcMain.handle('amy:setActiveVersion', (_e, version: number) => {
    const config = getConfig();
    saveConfig({ ...config, amyVersion: version } as any);
    return { success: true, activeVersion: version };
  });

  // Live Call Control
  ipcMain.handle(
    'liveCall:injectContext',
    async (_e, callId: string, content: string, triggerResponse?: boolean) =>
      injectContext(callId, content, triggerResponse),
  );
  ipcMain.handle('liveCall:injectSpeech', async (_e, callId: string, text: string) =>
    injectSpeech(callId, text),
  );
  ipcMain.handle('liveCall:getActive', () => getActiveCallControls());

  // Studio
  ipcMain.handle('studio:config:get', () => loadStudioConfig());
  ipcMain.handle('studio:config:save', (_e, config: any) => saveStudioConfig(config));
  ipcMain.handle('studio:detectDevices', async () => {
    // Use cached devices if available — dshow hangs on repeated ffmpeg -list_devices calls
    let devices: { name: string; type: string }[] = [];
    try {
      devices = await detectDevices();
    } catch {
      /* ffmpeg may not be on PATH */
    }
    const hasVideoDevice = devices.some((d) => d.type === 'video');
    if (!hasVideoDevice) {
      // Use detectCameras which has the built-in camera fallback probe
      const { detectCameras } = await import('./studio');
      const cameras = await detectCameras();
      devices.push(...cameras);
    }
    return devices;
  });
  ipcMain.handle('studio:refreshDevices', async () => {
    clearDeviceCache();
    return detectDevices();
  });
  ipcMain.handle('studio:checkNvenc', async () => checkNvenc());
  ipcMain.handle('studio:start', async () => {
    // Resolve devices HERE using the cached list, then pass to startRecording
    // so it never calls detectDevices/detectCameras itself (those hang on repeat calls).
    let devices: { name: string; type: string }[] = [];
    try {
      devices = await detectDevices();
    } catch {
      /* */
    }
    const cameras = devices
      .filter((d) => d.type === 'video' && !d.name.includes('OBS'))
      .map((d, i) => ({
        id: `cam_${i}`,
        name: d.name,
        position: (['front', 'side', 'overhead', 'extra'] as const)[i] || 'extra',
        enabled: true,
      }));
    const audioDevice = devices.find((d) => d.type === 'audio')?.name;
    return studioStartRecording({ cameras, audioDevice });
  });
  ipcMain.handle('studio:stop', async () => studioStopRecording());
  ipcMain.handle('studio:marker', (_e, type: string, label?: string) =>
    addMarker(type as any, label),
  );
  ipcMain.handle('studio:active', () => getActiveRecording());
  ipcMain.handle('studio:list', () => listRecordings());
  ipcMain.handle('studio:get', (_e, id: string) => loadRecording(id));
  ipcMain.handle('studio:delete', async (_e, id: string) => deleteRecording(id));
  ipcMain.handle('studio:process', async (_e, id: string) => {
    try {
      const result = await processRecording(id, (stage, pct) => {
        send('studio:progress', { id, stage, pct });
      });
      return result;
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // Time Machine
  ipcMain.handle('tm:start', async () => startTimeMachine());
  ipcMain.handle('tm:stop', async () => stopTimeMachine());
  ipcMain.handle('tm:pause', () => pauseTimeMachine());
  ipcMain.handle('tm:resume', () => resumeTimeMachine());
  ipcMain.handle('tm:status', () => getTimeMachineStatus());
  ipcMain.handle('tm:config:get', () => loadTimeMachineConfig());
  ipcMain.handle('tm:config:save', (_e, config: any) => saveTimeMachineConfig(config));
  ipcMain.handle('tm:frames:recent', (_e, limit?: number) => getRecentFrames(limit));
  ipcMain.handle('tm:frames:range', (_e, start: string, end: string) =>
    getFramesInRange(start, end),
  );
  ipcMain.handle('tm:audio:range', (_e, start: string, end: string) => getAudioInRange(start, end));
  ipcMain.handle('tm:search', (_e, query: string, limit?: number) => searchAll(query, limit));
  ipcMain.handle('tm:stats', () => getStorageStats());
  ipcMain.handle('tm:prune', async () => pruneTimeMachineData());
  ipcMain.handle('tm:screenshot', async (_e, localPath: string | null, s3Key: string | null) => {
    // Try local file first
    if (localPath && fs.existsSync(localPath)) {
      const data = fs.readFileSync(localPath);
      return { success: true, dataUrl: `data:image/jpeg;base64,${data.toString('base64')}` };
    }
    // Try S3
    if (s3Key) {
      try {
        const { loadTimeMachineConfig: loadTmCfg } = await import('./timemachine');
        const tmCfg = loadTmCfg();
        const { execFileSync } = await import('child_process');
        const url = execFileSync(
          'aws',
          [
            's3',
            'presign',
            `s3://${tmCfg.s3Bucket}/${s3Key}`,
            '--expires-in',
            '300',
            '--region',
            'us-east-1',
          ],
          { timeout: 10000 },
        )
          .toString()
          .trim();
        return { success: true, url };
      } catch {
        return { success: false, error: 'S3 presign failed' };
      }
    }
    return { success: false, error: 'No file available' };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
