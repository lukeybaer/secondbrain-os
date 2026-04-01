import { contextBridge, ipcRenderer } from "electron";
import { electronAPI } from "@electron-toolkit/preload";

const api = {
  config: {
    get: (): Promise<any> => ipcRenderer.invoke("config:get"),
    save: (config: any): Promise<any> => ipcRenderer.invoke("config:save", config),
  },

  import: {
    fetchList: (): Promise<any> => ipcRenderer.invoke("import:fetchList"),
    loadCached: (): Promise<any[]> => ipcRenderer.invoke("import:loadCached"),
    processIds: (otterIds: string[]): Promise<any> =>
      ipcRenderer.invoke("import:processIds", otterIds),
    onListBatch: (cb: (items: any[]) => void) => {
      ipcRenderer.on("import:listBatch", (_e, items) => cb(items));
    },
    offListBatch: () => ipcRenderer.removeAllListeners("import:listBatch"),
    onItemProgress: (cb: (e: { otterId: string; status: string; message?: string }) => void) => {
      ipcRenderer.on("import:itemProgress", (_e, data) => cb(data));
    },
    offItemProgress: () => ipcRenderer.removeAllListeners("import:itemProgress"),
  },

  conversations: {
    list: (): Promise<any[]> => ipcRenderer.invoke("conversations:list"),
    search: (query: string): Promise<any[]> => ipcRenderer.invoke("conversations:search", query),
    get: (id: string): Promise<any> => ipcRenderer.invoke("conversations:get", id),
  },

  chat: {
    send: (question: string, history: any[]): Promise<any> =>
      ipcRenderer.invoke("chat:send", question, history),
    onDelta: (cb: (delta: string) => void) => {
      ipcRenderer.on("chat:delta", (_e, delta) => cb(delta));
    },
    offDelta: () => ipcRenderer.removeAllListeners("chat:delta"),
  },

  chats: {
    loadLatest: (): Promise<any> => ipcRenderer.invoke("chats:loadLatest"),
    save: (session: any): Promise<any> => ipcRenderer.invoke("chats:save", session),
    summarize: (session: any): Promise<any> => ipcRenderer.invoke("chats:summarize", session),
    finish: (session: any): Promise<any> => ipcRenderer.invoke("chats:finish", session),
    autoTag: (session: any): Promise<any> => ipcRenderer.invoke("chats:autoTag", session),
  },

  whatsapp: {
    list: (limit?: number): Promise<any[]> => ipcRenderer.invoke("whatsapp:list", limit),
    send: (to: string, body: string): Promise<{ success: boolean; messageId?: string; error?: string }> =>
      ipcRenderer.invoke("whatsapp:send", to, body),
    ingest: (payload: unknown): Promise<number> => ipcRenderer.invoke("whatsapp:ingest", payload),
  },

  personas: {
    list: (): Promise<any[]> => ipcRenderer.invoke("personas:list"),
    save: (persona: any): Promise<any> => ipcRenderer.invoke("personas:save", persona),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke("personas:delete", id),
    summarize: (id: string): Promise<{ success: boolean; summary?: string; error?: string }> =>
      ipcRenderer.invoke("personas:summarize", id),
  },

  diag: {
    writeAudio: (line: string, firstFrameHex?: string): Promise<void> =>
      ipcRenderer.invoke("diag:writeAudio", line, firstFrameHex),
  },

  profile: {
    list: (): Promise<any[]> => ipcRenderer.invoke("profile:list"),
    save: (fact: any): Promise<any> => ipcRenderer.invoke("profile:save", fact),
    delete: (id: string): Promise<any> => ipcRenderer.invoke("profile:delete", id),
  },

  calls: {
    initiate: (phoneNumber: string, instructions: string, personalContext: string, personaId?: string, leaveVoicemail?: boolean): Promise<{ success: boolean; callId?: string; listenUrl?: string; error?: string }> =>
      ipcRenderer.invoke("calls:initiate", phoneNumber, instructions, personalContext, personaId, leaveVoicemail),
    refresh: (callId: string): Promise<{ success: boolean; record?: any; error?: string }> =>
      ipcRenderer.invoke("calls:refresh", callId),
    get: (callId: string): Promise<any> =>
      ipcRenderer.invoke("calls:get", callId),
    list: (): Promise<any[]> =>
      ipcRenderer.invoke("calls:list"),
    markComplete: (callId: string, completed: boolean): Promise<any> =>
      ipcRenderer.invoke("calls:markComplete", callId, completed),
    syncCallback: (phoneNumber: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("calls:syncCallback", phoneNumber),
    syncInbound: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("calls:syncInbound"),
    hangUp: (callId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("calls:hangUp", callId),
  },

  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    get: (id: string) => ipcRenderer.invoke("projects:get", id),
    create: (data: { name: string; description: string; strategy: string; tags: string[] }) =>
      ipcRenderer.invoke("projects:create", data),
    update: (id: string, updates: object) =>
      ipcRenderer.invoke("projects:update", id, updates),
    delete: (id: string) => ipcRenderer.invoke("projects:delete", id),
    addTask: (projectId: string, data: object) =>
      ipcRenderer.invoke("projects:addTask", projectId, data),
    updateTask: (projectId: string, taskId: string, updates: object) =>
      ipcRenderer.invoke("projects:updateTask", projectId, taskId, updates),
    deleteTask: (projectId: string, taskId: string) =>
      ipcRenderer.invoke("projects:deleteTask", projectId, taskId),
  },

  pii: {
    scan: (text: string, source: string): Promise<{ success: boolean; detections: any[]; error?: string }> =>
      ipcRenderer.invoke("pii:scan", text, source),
  },

  claude: {
    sendCommand: (prompt: string, context: string): Promise<{ success: boolean; commandId?: string; error?: string }> =>
      ipcRenderer.invoke("claude:sendCommand", prompt, context),
    captureScreenshot: (): Promise<{ success: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke("claude:captureScreenshot"),
  },

  agent: {
    readMemory: (): Promise<{ success: boolean; content: string; error?: string }> =>
      ipcRenderer.invoke("agent:readMemory"),
    writeMemory: (content: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("agent:writeMemory", content),
    postCallReflection: (input: {
      callId: string;
      phoneNumber: string;
      contactName?: string;
      instructions: string;
      outcome: string;
      transcript?: string;
      durationSeconds?: number;
      userFeedback?: string;
    }): Promise<{ success: boolean; reflection?: string; error?: string }> =>
      ipcRenderer.invoke("agent:postCallReflection", input),
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  (window as any).electron = electronAPI;
  (window as any).api = api;
}
