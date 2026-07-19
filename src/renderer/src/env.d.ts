/// <reference types="vite/client" />

interface Window {
  api: {
    config: {
      get: () => Promise<any>;
      save: (config: any) => Promise<any>;
    };
    import: {
      fetchList: () => Promise<{
        success: boolean;
        items?: Array<{
          otterId: string;
          title: string;
          date: string;
          durationMinutes: number;
          status: "remote" | "tagged";
        }>;
        error?: string;
      }>;
      processIds: (otterIds: string[]) => Promise<{
        success: boolean;
        processed?: number;
        failed?: number;
      }>;
      onItemProgress: (
        cb: (e: { otterId: string; status: string; message?: string }) => void
      ) => void;
      offItemProgress: () => void;
    };
    conversations: {
      list: () => Promise<any[]>;
      search: (query: string) => Promise<any[]>;
      get: (id: string) => Promise<{ meta: any; transcript: string } | null>;
    };
    chat: {
      send: (
        question: string,
        history: Array<{ role: "user" | "assistant"; content: string }>,
        conversationId?: string
      ) => Promise<{ success: boolean; response?: string; error?: string }>;
      onDelta: (cb: (delta: string) => void) => void;
      offDelta: () => void;
    };
    chats: {
      loadLatest: () => Promise<any>;
      save: (session: any) => Promise<any>;
      summarize: (session: any) => Promise<any>;
      finish: (session: any) => Promise<any>;
      autoTag: (session: any) => Promise<any>;
    };
    whatsapp: {
      list: (limit?: number) => Promise<any[]>;
      send: (to: string, body: string) => Promise<{ success: boolean; messageId?: string; error?: string }>;
      ingest: (payload: ExampleCo) => Promise<number>;
    };
    projects: {
      list: () => Promise<import("./pages/Projects").Project[]>;
      create: (project: { name: string; description: string }) => Promise<import("./pages/Projects").Project>;
      update: (id: string, updates: Partial<Omit<import("./pages/Projects").Project, "id" | "createdAt" | "tasks">>) => Promise<import("./pages/Projects").Project>;
      delete: (id: string) => Promise<boolean>;
      createTask: (projectId: string, task: { title: string; phoneNumber?: string; priority: import("./pages/Projects").Task["priority"] }) => Promise<import("./pages/Projects").Task>;
      updateTask: (projectId: string, taskId: string, updates: Partial<Omit<import("./pages/Projects").Task, "id" | "createdAt">>) => Promise<import("./pages/Projects").Task>;
      deleteTask: (projectId: string, taskId: string) => Promise<boolean>;
    };
    tasks: {
      list: (filter?: object) => Promise<import("./pages/Tasks").TaskRecord[]>;
      get: (id: string) => Promise<import("./pages/Tasks").TaskRecord | null>;
      run: (input: {
        kind?: string;
        origin?: string;
        prompt: string;
        title?: string;
      }) => Promise<import("./pages/Tasks").TaskRecord>;
      cancel: (id: string) => Promise<import("./pages/Tasks").TaskRecord>;
      approve: (id: string, approved?: boolean) => Promise<import("./pages/Tasks").TaskRecord>;
      reply: (id: string, reply: string) => Promise<import("./pages/Tasks").TaskRecord>;
      onPush: (cb: (task: import("./pages/Tasks").TaskRecord) => void) => void;
      offPush: () => void;
    };
  };
}
