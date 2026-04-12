import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

const api = {
  config: {
    get: (): Promise<any> => ipcRenderer.invoke('config:get'),
    save: (config: any): Promise<any> => ipcRenderer.invoke('config:save', config),
  },

  otter: {
    testConnection: (): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('otter:testConnection'),
    openLoginWindow: (): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('otter:openLoginWindow'),
  },

  import: {
    fetchList: (): Promise<any> => ipcRenderer.invoke('import:fetchList'),
    loadCached: (): Promise<any[]> => ipcRenderer.invoke('import:loadCached'),
    processIds: (otterIds: string[]): Promise<any> =>
      ipcRenderer.invoke('import:processIds', otterIds),
    onListBatch: (cb: (items: any[]) => void) => {
      ipcRenderer.on('import:listBatch', (_e, items) => cb(items));
    },
    offListBatch: () => ipcRenderer.removeAllListeners('import:listBatch'),
    onItemProgress: (cb: (e: { otterId: string; status: string; message?: string }) => void) => {
      ipcRenderer.on('import:itemProgress', (_e, data) => cb(data));
    },
    offItemProgress: () => ipcRenderer.removeAllListeners('import:itemProgress'),
  },

  conversations: {
    list: (): Promise<any[]> => ipcRenderer.invoke('conversations:list'),
    search: (query: string): Promise<any[]> => ipcRenderer.invoke('conversations:search', query),
    get: (id: string): Promise<any> => ipcRenderer.invoke('conversations:get', id),
  },

  chat: {
    send: (question: string, history: any[]): Promise<any> =>
      ipcRenderer.invoke('chat:send', question, history),
    onDelta: (cb: (delta: string) => void) => {
      ipcRenderer.on('chat:delta', (_e, delta) => cb(delta));
    },
    offDelta: () => ipcRenderer.removeAllListeners('chat:delta'),
  },

  chats: {
    loadLatest: (): Promise<any> => ipcRenderer.invoke('chats:loadLatest'),
    save: (session: any): Promise<any> => ipcRenderer.invoke('chats:save', session),
    summarize: (session: any): Promise<any> => ipcRenderer.invoke('chats:summarize', session),
    finish: (session: any): Promise<any> => ipcRenderer.invoke('chats:finish', session),
    autoTag: (session: any): Promise<any> => ipcRenderer.invoke('chats:autoTag', session),
  },

  whatsapp: {
    connect: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('whatsapp:connect'),
    status: (): Promise<{ status: string }> => ipcRenderer.invoke('whatsapp:status'),
    chats: (): Promise<any[]> => ipcRenderer.invoke('whatsapp:chats'),
    messages: (chatId: string, limit?: number): Promise<any[]> =>
      ipcRenderer.invoke('whatsapp:messages', chatId, limit),
    send: (to: string, text: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('whatsapp:send', to, text),
    search: (query: string): Promise<any[]> => ipcRenderer.invoke('whatsapp:search', query),
    disconnect: (): Promise<void> => ipcRenderer.invoke('whatsapp:disconnect'),
    onStatusChange: (cb: (data: { status: string; qrDataUrl?: string }) => void) => {
      ipcRenderer.on('whatsapp:statusChange', (_e, data) => cb(data));
    },
    offStatusChange: () => ipcRenderer.removeAllListeners('whatsapp:statusChange'),
    onMessage: (cb: (msg: any) => void) => {
      ipcRenderer.on('whatsapp:message', (_e, msg) => cb(msg));
    },
    offMessage: () => ipcRenderer.removeAllListeners('whatsapp:message'),
  },

  sms: {
    list: (limit?: number): Promise<any[]> => ipcRenderer.invoke('sms:list', limit),
    search: (query: string, limit?: number): Promise<any[]> =>
      ipcRenderer.invoke('sms:search', query, limit),
    send: (
      to: string,
      body: string,
      mediaUrl?: string,
    ): Promise<{ success: boolean; messageId?: string; error?: string }> =>
      ipcRenderer.invoke('sms:send', to, body, mediaUrl),
    ingest: (fields: Record<string, string>): Promise<any> =>
      ipcRenderer.invoke('sms:ingest', fields),
    onInbound: (cb: (msg: any) => void) => {
      ipcRenderer.on('sms:inbound', (_e, msg) => cb(msg));
    },
    offInbound: () => ipcRenderer.removeAllListeners('sms:inbound'),
  },

  personas: {
    list: (): Promise<any[]> => ipcRenderer.invoke('personas:list'),
    save: (persona: any): Promise<any> => ipcRenderer.invoke('personas:save', persona),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('personas:delete', id),
    summarize: (id: string): Promise<{ success: boolean; summary?: string; error?: string }> =>
      ipcRenderer.invoke('personas:summarize', id),
  },

  diag: {
    writeAudio: (line: string, firstFrameHex?: string): Promise<void> =>
      ipcRenderer.invoke('diag:writeAudio', line, firstFrameHex),
  },

  profile: {
    list: (): Promise<any[]> => ipcRenderer.invoke('profile:list'),
    save: (fact: any): Promise<any> => ipcRenderer.invoke('profile:save', fact),
    delete: (id: string): Promise<any> => ipcRenderer.invoke('profile:delete', id),
  },

  calls: {
    initiate: (
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
    ): Promise<{ success: boolean; callId?: string; listenUrl?: string; error?: string }> =>
      ipcRenderer.invoke(
        'calls:initiate',
        phoneNumber,
        instructions,
        personalContext,
        personaId,
        leaveVoicemail,
        options,
      ),
    refresh: (callId: string): Promise<{ success: boolean; record?: any; error?: string }> =>
      ipcRenderer.invoke('calls:refresh', callId),
    get: (callId: string): Promise<any> => ipcRenderer.invoke('calls:get', callId),
    list: (): Promise<any[]> => ipcRenderer.invoke('calls:list'),
    markComplete: (callId: string, completed: boolean): Promise<any> =>
      ipcRenderer.invoke('calls:markComplete', callId, completed),
    syncCallback: (phoneNumber: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('calls:syncCallback', phoneNumber),
    syncInbound: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('calls:syncInbound'),
    hangUp: (callId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('calls:hangUp', callId),
  },

  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    get: (id: string) => ipcRenderer.invoke('projects:get', id),
    create: (data: { name: string; description: string; strategy: string; tags: string[] }) =>
      ipcRenderer.invoke('projects:create', data),
    update: (id: string, updates: object) => ipcRenderer.invoke('projects:update', id, updates),
    delete: (id: string) => ipcRenderer.invoke('projects:delete', id),
    addTask: (projectId: string, data: object) =>
      ipcRenderer.invoke('projects:addTask', projectId, data),
    updateTask: (projectId: string, taskId: string, updates: object) =>
      ipcRenderer.invoke('projects:updateTask', projectId, taskId, updates),
    deleteTask: (projectId: string, taskId: string) =>
      ipcRenderer.invoke('projects:deleteTask', projectId, taskId),
  },

  todos: {
    list: (): Promise<any[]> => ipcRenderer.invoke('todos:list'),
    add: (data: any): Promise<any> => ipcRenderer.invoke('todos:add', data),
    update: (id: string, updates: any): Promise<any> =>
      ipcRenderer.invoke('todos:update', id, updates),
    delete: (id: string): Promise<any> => ipcRenderer.invoke('todos:delete', id),
    reorder: (ids: string[]): Promise<any> => ipcRenderer.invoke('todos:reorder', ids),
  },

  backups: {
    create: (): Promise<any> => ipcRenderer.invoke('backups:create'),
    list: (): Promise<any[]> => ipcRenderer.invoke('backups:list'),
    get: (id: string): Promise<any> => ipcRenderer.invoke('backups:get', id),
    inspect: (id: string, subPath?: string): Promise<any> =>
      ipcRenderer.invoke('backups:inspect', id, subPath),
    readFile: (id: string, relativePath: string): Promise<any> =>
      ipcRenderer.invoke('backups:readFile', id, relativePath),
    queryDb: (id: string, sql: string): Promise<any> =>
      ipcRenderer.invoke('backups:queryDb', id, sql),
    testRestore: (id: string): Promise<any> => ipcRenderer.invoke('backups:testRestore', id),
    commitRestore: (id: string): Promise<any> => ipcRenderer.invoke('backups:commitRestore', id),
    rollForward: (): Promise<any> => ipcRenderer.invoke('backups:rollForward'),
    prune: (): Promise<any> => ipcRenderer.invoke('backups:prune'),
    runDaily: (): Promise<any> => ipcRenderer.invoke('backups:runDaily'),
  },

  pii: {
    scan: (
      text: string,
      source: string,
    ): Promise<{ success: boolean; detections: any[]; error?: string }> =>
      ipcRenderer.invoke('pii:scan', text, source),
  },

  claude: {
    sendCommand: (
      prompt: string,
      context: string,
    ): Promise<{ success: boolean; commandId?: string; error?: string }> =>
      ipcRenderer.invoke('claude:sendCommand', prompt, context),
    captureScreenshot: (): Promise<{ success: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke('claude:captureScreenshot'),
  },

  agent: {
    readMemory: (): Promise<{ success: boolean; content: string; error?: string }> =>
      ipcRenderer.invoke('agent:readMemory'),
    writeMemory: (content: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('agent:writeMemory', content),
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
      ipcRenderer.invoke('agent:postCallReflection', input),
  },

  amy: {
    listVersions: (): Promise<any[]> => ipcRenderer.invoke('amy:listVersions'),
    getVersion: (version: number): Promise<any> => ipcRenderer.invoke('amy:getVersion', version),
    getActiveVersion: (): Promise<any> => ipcRenderer.invoke('amy:getActiveVersion'),
    saveVersion: (version: any): Promise<any> => ipcRenderer.invoke('amy:saveVersion', version),
    setActiveVersion: (version: number): Promise<any> =>
      ipcRenderer.invoke('amy:setActiveVersion', version),
  },

  social: {
    getPosts: (status?: string): Promise<any[]> => ipcRenderer.invoke('social:getPosts', status),
    createDraft: (post: any): Promise<any> => ipcRenderer.invoke('social:createDraft', post),
    approvePost: (id: string, scheduledFor?: string): Promise<any> =>
      ipcRenderer.invoke('social:approvePost', id, scheduledFor),
    rejectPost: (id: string, note: string): Promise<any> =>
      ipcRenderer.invoke('social:rejectPost', id, note),
    editPost: (id: string, content: string): Promise<any> =>
      ipcRenderer.invoke('social:editPost', id, content),
    publishPost: (id: string): Promise<any> => ipcRenderer.invoke('social:publishPost', id),
    trashPost: (id: string): Promise<any> => ipcRenderer.invoke('social:trashPost', id),
    refreshEngagement: (id: string): Promise<any> =>
      ipcRenderer.invoke('social:refreshEngagement', id),
  },

  studio: {
    config: {
      get: (): Promise<any> => ipcRenderer.invoke('studio:config:get'),
      save: (config: any): Promise<any> => ipcRenderer.invoke('studio:config:save', config),
    },
    detectDevices: (): Promise<any[]> => ipcRenderer.invoke('studio:detectDevices'),
    checkNvenc: (): Promise<boolean> => ipcRenderer.invoke('studio:checkNvenc'),
    start: (): Promise<{ success: boolean; recordingId?: string; error?: string }> =>
      ipcRenderer.invoke('studio:start'),
    stop: (): Promise<{ success: boolean; recording?: any; error?: string }> =>
      ipcRenderer.invoke('studio:stop'),
    marker: (type: string, label?: string): Promise<{ success: boolean; marker?: any }> =>
      ipcRenderer.invoke('studio:marker', type, label),
    active: (): Promise<any> => ipcRenderer.invoke('studio:active'),
    list: (): Promise<any[]> => ipcRenderer.invoke('studio:list'),
    get: (id: string): Promise<any> => ipcRenderer.invoke('studio:get', id),
    delete: (id: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('studio:delete', id),
    process: (id: string): Promise<{ success: boolean; recording?: any; error?: string }> =>
      ipcRenderer.invoke('studio:process', id),
    onProgress: (cb: (data: { id: string; stage: string; pct: number }) => void) => {
      ipcRenderer.on('studio:progress', (_e, data) => cb(data));
    },
    offProgress: () => ipcRenderer.removeAllListeners('studio:progress'),
  },

  timemachine: {
    start: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('tm:start'),
    stop: (): Promise<void> => ipcRenderer.invoke('tm:stop'),
    pause: (): Promise<void> => ipcRenderer.invoke('tm:pause'),
    resume: (): Promise<void> => ipcRenderer.invoke('tm:resume'),
    status: (): Promise<any> => ipcRenderer.invoke('tm:status'),
    config: {
      get: (): Promise<any> => ipcRenderer.invoke('tm:config:get'),
      save: (config: any): Promise<any> => ipcRenderer.invoke('tm:config:save', config),
    },
    frames: {
      recent: (limit?: number): Promise<any[]> => ipcRenderer.invoke('tm:frames:recent', limit),
      range: (start: string, end: string): Promise<any[]> =>
        ipcRenderer.invoke('tm:frames:range', start, end),
    },
    audio: {
      range: (start: string, end: string): Promise<any[]> =>
        ipcRenderer.invoke('tm:audio:range', start, end),
    },
    search: (query: string, limit?: number): Promise<any[]> =>
      ipcRenderer.invoke('tm:search', query, limit),
    stats: (): Promise<any> => ipcRenderer.invoke('tm:stats'),
    prune: (): Promise<any> => ipcRenderer.invoke('tm:prune'),
    screenshot: (
      localPath: string | null,
      s3Key: string | null,
    ): Promise<{ success: boolean; dataUrl?: string; url?: string; error?: string }> =>
      ipcRenderer.invoke('tm:screenshot', localPath, s3Key),
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI);
    contextBridge.exposeInMainWorld('api', api);
  } catch (error) {
    console.error(error);
  }
} else {
  (window as any).electron = electronAPI;
  (window as any).api = api;
}
