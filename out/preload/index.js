"use strict";
const electron = require("electron");
const electronAPI = {
  ipcRenderer: {
    send(channel, ...args) {
      electron.ipcRenderer.send(channel, ...args);
    },
    sendTo(webContentsId, channel, ...args) {
      const electronVer = process.versions.electron;
      const electronMajorVer = electronVer ? parseInt(electronVer.split(".")[0]) : 0;
      if (electronMajorVer >= 28) {
        throw new Error('"sendTo" method has been removed since Electron 28.');
      } else {
        electron.ipcRenderer.sendTo(webContentsId, channel, ...args);
      }
    },
    sendSync(channel, ...args) {
      return electron.ipcRenderer.sendSync(channel, ...args);
    },
    sendToHost(channel, ...args) {
      electron.ipcRenderer.sendToHost(channel, ...args);
    },
    postMessage(channel, message, transfer) {
      electron.ipcRenderer.postMessage(channel, message, transfer);
    },
    invoke(channel, ...args) {
      return electron.ipcRenderer.invoke(channel, ...args);
    },
    on(channel, listener) {
      electron.ipcRenderer.on(channel, listener);
      return () => {
        electron.ipcRenderer.removeListener(channel, listener);
      };
    },
    once(channel, listener) {
      electron.ipcRenderer.once(channel, listener);
      return () => {
        electron.ipcRenderer.removeListener(channel, listener);
      };
    },
    removeListener(channel, listener) {
      electron.ipcRenderer.removeListener(channel, listener);
      return this;
    },
    removeAllListeners(channel) {
      electron.ipcRenderer.removeAllListeners(channel);
    }
  },
  webFrame: {
    insertCSS(css) {
      return electron.webFrame.insertCSS(css);
    },
    setZoomFactor(factor) {
      if (typeof factor === "number" && factor > 0) {
        electron.webFrame.setZoomFactor(factor);
      }
    },
    setZoomLevel(level) {
      if (typeof level === "number") {
        electron.webFrame.setZoomLevel(level);
      }
    }
  },
  webUtils: {
    getPathForFile(file) {
      return electron.webUtils.getPathForFile(file);
    }
  },
  process: {
    get platform() {
      return process.platform;
    },
    get versions() {
      return process.versions;
    },
    get env() {
      return { ...process.env };
    }
  }
};
const api = {
  config: {
    get: () => electron.ipcRenderer.invoke("config:get"),
    save: (config) => electron.ipcRenderer.invoke("config:save", config)
  },
  briefing: {
    listDays: () => electron.ipcRenderer.invoke("briefing:listDays"),
    get: (date) => electron.ipcRenderer.invoke("briefing:get", date),
    dispatch: (params) => electron.ipcRenderer.invoke("briefing:dispatch", params),
    export: (date) => electron.ipcRenderer.invoke("briefing:export", date),
    openExternal: (url) => electron.ipcRenderer.invoke("briefing:openExternal", url)
  },
  otter: {
    testConnection: () => electron.ipcRenderer.invoke("otter:testConnection"),
    openLoginWindow: () => electron.ipcRenderer.invoke("otter:openLoginWindow")
  },
  import: {
    fetchList: () => electron.ipcRenderer.invoke("import:fetchList"),
    loadCached: () => electron.ipcRenderer.invoke("import:loadCached"),
    processIds: (otterIds) => electron.ipcRenderer.invoke("import:processIds", otterIds),
    onListBatch: (cb) => {
      electron.ipcRenderer.on("import:listBatch", (_e, items) => cb(items));
    },
    offListBatch: () => electron.ipcRenderer.removeAllListeners("import:listBatch"),
    onItemProgress: (cb) => {
      electron.ipcRenderer.on("import:itemProgress", (_e, data) => cb(data));
    },
    offItemProgress: () => electron.ipcRenderer.removeAllListeners("import:itemProgress")
  },
  conversations: {
    list: () => electron.ipcRenderer.invoke("conversations:list"),
    search: (query) => electron.ipcRenderer.invoke("conversations:search", query),
    get: (id) => electron.ipcRenderer.invoke("conversations:get", id)
  },
  chat: {
    send: (question, history) => electron.ipcRenderer.invoke("chat:send", question, history),
    onDelta: (cb) => {
      electron.ipcRenderer.on("chat:delta", (_e, delta) => cb(delta));
    },
    offDelta: () => electron.ipcRenderer.removeAllListeners("chat:delta")
  },
  chats: {
    loadLatest: () => electron.ipcRenderer.invoke("chats:loadLatest"),
    save: (session) => electron.ipcRenderer.invoke("chats:save", session),
    summarize: (session) => electron.ipcRenderer.invoke("chats:summarize", session),
    finish: (session) => electron.ipcRenderer.invoke("chats:finish", session),
    autoTag: (session) => electron.ipcRenderer.invoke("chats:autoTag", session)
  },
  whatsapp: {
    connect: () => electron.ipcRenderer.invoke("whatsapp:connect"),
    status: () => electron.ipcRenderer.invoke("whatsapp:status"),
    chats: () => electron.ipcRenderer.invoke("whatsapp:chats"),
    messages: (chatId, limit) => electron.ipcRenderer.invoke("whatsapp:messages", chatId, limit),
    send: (to, text) => electron.ipcRenderer.invoke("whatsapp:send", to, text),
    search: (query) => electron.ipcRenderer.invoke("whatsapp:search", query),
    disconnect: () => electron.ipcRenderer.invoke("whatsapp:disconnect"),
    onStatusChange: (cb) => {
      electron.ipcRenderer.on("whatsapp:statusChange", (_e, data) => cb(data));
    },
    offStatusChange: () => electron.ipcRenderer.removeAllListeners("whatsapp:statusChange"),
    onMessage: (cb) => {
      electron.ipcRenderer.on("whatsapp:message", (_e, msg) => cb(msg));
    },
    offMessage: () => electron.ipcRenderer.removeAllListeners("whatsapp:message")
  },
  sms: {
    list: (limit) => electron.ipcRenderer.invoke("sms:list", limit),
    search: (query, limit) => electron.ipcRenderer.invoke("sms:search", query, limit),
    send: (to, body, mediaUrl) => electron.ipcRenderer.invoke("sms:send", to, body, mediaUrl),
    ingest: (fields) => electron.ipcRenderer.invoke("sms:ingest", fields),
    onInbound: (cb) => {
      electron.ipcRenderer.on("sms:inbound", (_e, msg) => cb(msg));
    },
    offInbound: () => electron.ipcRenderer.removeAllListeners("sms:inbound")
  },
  personas: {
    list: () => electron.ipcRenderer.invoke("personas:list"),
    save: (persona) => electron.ipcRenderer.invoke("personas:save", persona),
    delete: (id) => electron.ipcRenderer.invoke("personas:delete", id),
    summarize: (id) => electron.ipcRenderer.invoke("personas:summarize", id)
  },
  diag: {
    writeAudio: (line, firstFrameHex) => electron.ipcRenderer.invoke("diag:writeAudio", line, firstFrameHex)
  },
  profile: {
    list: () => electron.ipcRenderer.invoke("profile:list"),
    save: (fact) => electron.ipcRenderer.invoke("profile:save", fact),
    delete: (id) => electron.ipcRenderer.invoke("profile:delete", id)
  },
  calls: {
    initiate: (phoneNumber, instructions, personalContext, personaId, leaveVoicemail, options) => electron.ipcRenderer.invoke(
      "calls:initiate",
      phoneNumber,
      instructions,
      personalContext,
      personaId,
      leaveVoicemail,
      options
    ),
    refresh: (callId) => electron.ipcRenderer.invoke("calls:refresh", callId),
    get: (callId) => electron.ipcRenderer.invoke("calls:get", callId),
    list: () => electron.ipcRenderer.invoke("calls:list"),
    markComplete: (callId, completed) => electron.ipcRenderer.invoke("calls:markComplete", callId, completed),
    syncCallback: (phoneNumber) => electron.ipcRenderer.invoke("calls:syncCallback", phoneNumber),
    syncInbound: () => electron.ipcRenderer.invoke("calls:syncInbound"),
    hangUp: (callId) => electron.ipcRenderer.invoke("calls:hangUp", callId),
    // Push-based status updates , eliminates renderer polling for active calls.
    // Fires whenever any call record changes (initiated, status refresh, ended).
    onStatusPush: (cb) => {
      electron.ipcRenderer.on("calls:statusPush", (_e, record) => cb(record));
    },
    offStatusPush: () => electron.ipcRenderer.removeAllListeners("calls:statusPush")
  },
  projects: {
    list: () => electron.ipcRenderer.invoke("projects:list"),
    get: (id) => electron.ipcRenderer.invoke("projects:get", id),
    create: (data) => electron.ipcRenderer.invoke("projects:create", data),
    update: (id, updates) => electron.ipcRenderer.invoke("projects:update", id, updates),
    delete: (id) => electron.ipcRenderer.invoke("projects:delete", id),
    addTask: (projectId, data) => electron.ipcRenderer.invoke("projects:addTask", projectId, data),
    updateTask: (projectId, taskId, updates) => electron.ipcRenderer.invoke("projects:updateTask", projectId, taskId, updates),
    deleteTask: (projectId, taskId) => electron.ipcRenderer.invoke("projects:deleteTask", projectId, taskId)
  },
  todos: {
    list: () => electron.ipcRenderer.invoke("todos:list"),
    add: (data) => electron.ipcRenderer.invoke("todos:add", data),
    update: (id, updates) => electron.ipcRenderer.invoke("todos:update", id, updates),
    delete: (id) => electron.ipcRenderer.invoke("todos:delete", id),
    reorder: (ids) => electron.ipcRenderer.invoke("todos:reorder", ids)
  },
  backups: {
    create: () => electron.ipcRenderer.invoke("backups:create"),
    list: () => electron.ipcRenderer.invoke("backups:list"),
    get: (id) => electron.ipcRenderer.invoke("backups:get", id),
    inspect: (id, subPath) => electron.ipcRenderer.invoke("backups:inspect", id, subPath),
    readFile: (id, relativePath) => electron.ipcRenderer.invoke("backups:readFile", id, relativePath),
    queryDb: (id, sql) => electron.ipcRenderer.invoke("backups:queryDb", id, sql),
    testRestore: (id) => electron.ipcRenderer.invoke("backups:testRestore", id),
    commitRestore: (id) => electron.ipcRenderer.invoke("backups:commitRestore", id),
    rollForward: () => electron.ipcRenderer.invoke("backups:rollForward"),
    prune: () => electron.ipcRenderer.invoke("backups:prune"),
    runDaily: () => electron.ipcRenderer.invoke("backups:runDaily")
  },
  pii: {
    scan: (text, source) => electron.ipcRenderer.invoke("pii:scan", text, source)
  },
  claude: {
    sendCommand: (prompt, context) => electron.ipcRenderer.invoke("claude:sendCommand", prompt, context),
    captureScreenshot: () => electron.ipcRenderer.invoke("claude:captureScreenshot")
  },
  agent: {
    readMemory: () => electron.ipcRenderer.invoke("agent:readMemory"),
    writeMemory: (content) => electron.ipcRenderer.invoke("agent:writeMemory", content),
    postCallReflection: (input) => electron.ipcRenderer.invoke("agent:postCallReflection", input)
  },
  amy: {
    listVersions: () => electron.ipcRenderer.invoke("amy:listVersions"),
    getVersion: (version) => electron.ipcRenderer.invoke("amy:getVersion", version),
    getActiveVersion: () => electron.ipcRenderer.invoke("amy:getActiveVersion"),
    saveVersion: (version) => electron.ipcRenderer.invoke("amy:saveVersion", version),
    setActiveVersion: (version) => electron.ipcRenderer.invoke("amy:setActiveVersion", version)
  },
  social: {
    getPosts: (status) => electron.ipcRenderer.invoke("social:getPosts", status),
    createDraft: (post) => electron.ipcRenderer.invoke("social:createDraft", post),
    approvePost: (id, scheduledFor) => electron.ipcRenderer.invoke("social:approvePost", id, scheduledFor),
    rejectPost: (id, note) => electron.ipcRenderer.invoke("social:rejectPost", id, note),
    editPost: (id, content) => electron.ipcRenderer.invoke("social:editPost", id, content),
    publishPost: (id) => electron.ipcRenderer.invoke("social:publishPost", id),
    trashPost: (id) => electron.ipcRenderer.invoke("social:trashPost", id),
    refreshEngagement: (id) => electron.ipcRenderer.invoke("social:refreshEngagement", id)
  },
  studio: {
    config: {
      get: () => electron.ipcRenderer.invoke("studio:config:get"),
      save: (config) => electron.ipcRenderer.invoke("studio:config:save", config)
    },
    detectDevices: () => electron.ipcRenderer.invoke("studio:detectDevices"),
    checkNvenc: () => electron.ipcRenderer.invoke("studio:checkNvenc"),
    start: () => electron.ipcRenderer.invoke("studio:start"),
    stop: () => electron.ipcRenderer.invoke("studio:stop"),
    marker: (type, label) => electron.ipcRenderer.invoke("studio:marker", type, label),
    active: () => electron.ipcRenderer.invoke("studio:active"),
    list: () => electron.ipcRenderer.invoke("studio:list"),
    get: (id) => electron.ipcRenderer.invoke("studio:get", id),
    delete: (id) => electron.ipcRenderer.invoke("studio:delete", id),
    process: (id) => electron.ipcRenderer.invoke("studio:process", id),
    onProgress: (cb) => {
      electron.ipcRenderer.on("studio:progress", (_e, data) => cb(data));
    },
    offProgress: () => electron.ipcRenderer.removeAllListeners("studio:progress")
  },
  timemachine: {
    start: () => electron.ipcRenderer.invoke("tm:start"),
    stop: () => electron.ipcRenderer.invoke("tm:stop"),
    pause: () => electron.ipcRenderer.invoke("tm:pause"),
    resume: () => electron.ipcRenderer.invoke("tm:resume"),
    status: () => electron.ipcRenderer.invoke("tm:status"),
    config: {
      get: () => electron.ipcRenderer.invoke("tm:config:get"),
      save: (config) => electron.ipcRenderer.invoke("tm:config:save", config)
    },
    frames: {
      recent: (limit) => electron.ipcRenderer.invoke("tm:frames:recent", limit),
      range: (start, end) => electron.ipcRenderer.invoke("tm:frames:range", start, end)
    },
    audio: {
      range: (start, end) => electron.ipcRenderer.invoke("tm:audio:range", start, end)
    },
    search: (query, limit) => electron.ipcRenderer.invoke("tm:search", query, limit),
    stats: () => electron.ipcRenderer.invoke("tm:stats"),
    prune: () => electron.ipcRenderer.invoke("tm:prune"),
    screenshot: (localPath, s3Key) => electron.ipcRenderer.invoke("tm:screenshot", localPath, s3Key)
  }
};
if (process.contextIsolated) {
  try {
    electron.contextBridge.exposeInMainWorld("electron", electronAPI);
    electron.contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  window.electron = electronAPI;
  window.api = api;
}
