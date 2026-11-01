import React, { useState, useEffect, useCallback, useRef } from "react";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in-progress" | "done" | "cancelled" | "needs-follow-up";
  phoneNumber?: string;
  callId?: string;
  callOutcome?: "agreed" | "declined" | "no-answer" | "voicemail" | "wrong-number";
  inWorkflow?: boolean;
  notes: string;
  priority: "low" | "medium" | "high";
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  strategy: string;
  status: "open" | "in-progress" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  tags: string[];
  tasks: Task[];
}

interface Persona {
  id: string;
  name: string;
  instructions: string;
  summary?: string;
}

export interface ProjectsProps {
  onCallNow?: (phoneNumber: string, instructions: string, personaId?: string) => void;
  onNavigateTo?: (page: string) => void;
  onSetAutoListen?: (v: boolean) => void;
}

type WorkflowLogEntry = { text: string; ts: string };
interface WorkflowState {
  running: boolean;
  currentTask: string;
  callStatus: string;
  currentCallId?: string;
  log: WorkflowLogEntry[];
}

const TERMINAL_STATUSES = new Set(["ended", "error"]);

const TASK_STATUS_COLORS: Record<Task["status"], string> = {
  "todo": "#facc15",
  "in-progress": "#60a5fa",
  "done": "#4ade80",
  "cancelled": "#555",
  "needs-follow-up": "#f97316",
};
const PRIORITY_COLORS: Record<Task["priority"], string> = {
  high: "#f87171",
  medium: "#facc15",
  low: "#6ee7b7",
};
const PROJECT_STATUS_COLORS: Record<Project["status"], string> = {
  open: "#60a5fa",
  "in-progress": "#f97316",
  completed: "#4ade80",
  cancelled: "#555",
};
const TASK_STATUS_CYCLE: Task["status"][] = ["todo", "in-progress", "done", "needs-follow-up"];
const CALL_OUTCOME_LABELS: Record<NonNullable<Task["callOutcome"]>, string> = {
  agreed: "Agreed",
  declined: "Declined",
  "no-answer": "No Answer",
  voicemail: "Voicemail",
  "wrong-number": "Wrong Number",
};

const s = {
  input: { width: "100%", padding: "7px 10px", background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 5, color: "#e0e0e0", fontSize: 12, outline: "none", boxSizing: "border-box" as const, fontFamily: "inherit" },
  textarea: { width: "100%", padding: "7px 10px", background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 5, color: "#e0e0e0", fontSize: 12, outline: "none", resize: "vertical" as const, boxSizing: "border-box" as const, fontFamily: "inherit", lineHeight: 1.5 },
  btn: { padding: "7px 14px", background: "#7c3aed", border: "none", borderRadius: 5, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 },
  btnSmall: { padding: "3px 9px", background: "#2a2a2a", border: "1px solid #333", borderRadius: 4, color: "#e0e0e0", cursor: "pointer", fontSize: 11 },
  btnDanger: { padding: "3px 9px", background: "none", border: "1px solid #3a1a1a", borderRadius: 4, color: "#f87171", cursor: "pointer", fontSize: 11 },
  btnLink: { background: "none", border: "none", color: "#7c3aed", cursor: "pointer", fontSize: 11, padding: 0 },
  label: { fontSize: 11, color: "#888", marginBottom: 4, display: "block" as const },
};

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

function detectCallOutcome(record: any): Task["callOutcome"] {
  if (!record) return "no-answer";
  const duration = record.durationSeconds ?? 0;
  const transcript = (record.transcript ?? "").toLowerCase();
  const summary = (record.summary ?? "").toLowerCase();
  const endedReason = (record.endedReason ?? "").toLowerCase();
  const text = transcript + " " + summary;

  // After-hours / automated systems — detect before anything else
  const afterHours = ["after hours", "after-hours", "office is closed", "currently closed",
    "outside of our office hours", "our hours are", "please call back during",
    "automated", "press 1", "press 2", "for more options", "directory"];
  if (afterHours.some((kw) => text.includes(kw))) return "no-answer";

  // No answer / short call
  if (endedReason === "no-answer" || duration < 8) return "no-answer";

  // Voicemail — AI left a message
  if (text.includes("voicemail") || text.includes("leave a message") || text.includes("not available") || text.includes("at the beep")) return "voicemail";

  // Declined — checked before "agreed" so false positives in GPT don't override clear rejections
  const declineSignals = ["require x-ray", "require new x-ray", "cannot see", "won't be able", "we can't", "our policy", "we require", "cannot onboard", "must have x-ray", "x-rays are required"];
  if (declineSignals.some((kw) => text.includes(kw))) return "declined";

  // Agreed — only if GPT confirmed AND no decline signals
  if (record.completed === true) return "agreed";

  // Summary-level signals
  if (summary.includes("agreed") || summary.includes("cleaning without") || summary.includes("scheduled")) return "agreed";
  if (summary.includes("declined") || summary.includes("cannot") || summary.includes("refused")) return "declined";

  return "needs-follow-up";
}

function buildCallInstructions(project: Project, task: Task): string {
  const strategy = project.strategy.trim();
  const taskContext = [task.description?.trim(), task.notes?.trim()].filter(Boolean).join("\n");
  const base = strategy || project.description.trim();
  return taskContext ? `${base}\n\n---\nTarget: ${task.title}\n${taskContext}` : `${base}\n\nTarget: ${task.title}`;
}

// ─── NewProjectForm ────────────────────────────────────────────────────────────

function NewProjectForm({ onSave, onCancel }: { onSave: (name: string, description: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try { await onSave(name.trim(), description.trim()); } finally { setSaving(false); }
  }
  return (
    <form onSubmit={handleSubmit} style={{ padding: "12px 14px", borderBottom: "1px solid #1e1e1e" }}>
      <div style={{ fontSize: 11, color: "#7c3aed", marginBottom: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>New Project</div>
      <label style={s.label}>Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" style={{ ...s.input, marginBottom: 8 }} autoFocus />
      <label style={s.label}>Description</label>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this project about?" rows={2} style={{ ...s.textarea, marginBottom: 10 }} />
      <div style={{ display: "flex", gap: 6 }}>
        <button type="submit" style={{ ...s.btn, opacity: saving || !name.trim() ? 0.5 : 1, fontSize: 11, padding: "5px 12px" }} disabled={saving || !name.trim()}>{saving ? "Saving…" : "Create"}</button>
        <button type="button" style={s.btnSmall} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ─── ProjectList ───────────────────────────────────────────────────────────────

function ProjectList({ projects, selectedId, onSelect, onNewProject, showingNewForm, newFormNode }: {
  projects: Project[]; selectedId: string | null; onSelect: (id: string) => void;
  onNewProject: () => void; showingNewForm: boolean; newFormNode: React.ReactNode;
}) {
  return (
    <div style={{ width: 280, flexShrink: 0, background: "#111", borderRight: "1px solid #1e1e1e", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid #1e1e1e", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Projects</div>
        {!showingNewForm && <button style={{ ...s.btn, fontSize: 11, padding: "4px 10px" }} onClick={onNewProject}>+ New</button>}
      </div>
      {showingNewForm && newFormNode}
      <div style={{ flex: 1, overflowY: "auto" as const }}>
        {projects.length === 0 && !showingNewForm && (
          <div style={{ padding: "20px 14px", fontSize: 12, color: "#444", lineHeight: 1.6 }}>No projects yet.</div>
        )}
        {projects.map((project) => (
          <button key={project.id} onClick={() => onSelect(project.id)} style={{
            display: "block", width: "100%", padding: "10px 14px",
            background: selectedId === project.id ? "#1a1a2e" : "none",
            border: "none", borderLeft: `3px solid ${selectedId === project.id ? "#7c3aed" : "transparent"}`,
            borderBottom: "1px solid #161616", color: selectedId === project.id ? "#e0e0e0" : "#999",
            textAlign: "left" as const, cursor: "pointer",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
              <div style={{ fontSize: 13, fontWeight: selectedId === project.id ? 600 : 400, color: selectedId === project.id ? "#fff" : "#ccc" }}>{project.name}</div>
              <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase" as const, color: PROJECT_STATUS_COLORS[project.status], flexShrink: 0, marginLeft: 6 }}>{project.status}</span>
            </div>
            {project.description && <div style={{ fontSize: 11, color: "#555", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{project.description}</div>}
            <div style={{ fontSize: 10, color: "#444", marginTop: 4 }}>
              {project.tasks.length} task{project.tasks.length !== 1 ? "s" : ""}
              {project.tasks.filter(t => t.inWorkflow).length > 0 && (
                <span style={{ color: "#7c3aed", marginLeft: 6 }}>· {project.tasks.filter(t => t.inWorkflow).length} in workflow</span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── NewTaskForm ───────────────────────────────────────────────────────────────

function NewTaskForm({ onSave, onCancel }: { onSave: (title: string, phoneNumber: string, priority: Task["priority"]) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("medium");
  const [saving, setSaving] = useState(false);
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try { await onSave(title.trim(), phoneNumber.trim(), priority); } finally { setSaving(false); }
  }
  return (
    <form onSubmit={handleSubmit} style={{ background: "#161616", border: "1px solid #2a1a4a", borderRadius: 6, padding: 12, marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: "#7c3aed", marginBottom: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>New Task</div>
      <label style={s.label}>Title</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" style={{ ...s.input, marginBottom: 8 }} autoFocus />
      <label style={s.label}>Phone number <span style={{ color: "#444" }}>(optional)</span></label>
      <input type="tel" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} placeholder="+1 (555) 123-4567" style={{ ...s.input, marginBottom: 8 }} />
      <label style={s.label}>Priority</label>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {(["low", "medium", "high"] as Task["priority"][]).map((p) => (
          <button key={p} type="button" onClick={() => setPriority(p)} style={{ padding: "3px 10px", borderRadius: 12, border: `1px solid ${priority === p ? PRIORITY_COLORS[p] : "#2a2a2a"}`, background: priority === p ? `${PRIORITY_COLORS[p]}22` : "#1a1a1a", color: priority === p ? PRIORITY_COLORS[p] : "#555", cursor: "pointer", fontSize: 11, fontWeight: priority === p ? 600 : 400 }}>{p}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="submit" style={{ ...s.btn, opacity: saving || !title.trim() ? 0.5 : 1, fontSize: 11, padding: "5px 12px" }} disabled={saving || !title.trim()}>{saving ? "Adding…" : "Add Task"}</button>
        <button type="button" style={s.btnSmall} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ─── TaskRow ───────────────────────────────────────────────────────────────────

function TaskRow({ task, isCurrentWorkflowTask, onToggleStatus, onToggleWorkflow, onUpdateOutcome, onUpdateNotes, onDelete, onReset, onCallNow }: {
  task: Task;
  isCurrentWorkflowTask?: boolean;
  onToggleStatus: (task: Task) => void;
  onToggleWorkflow: (task: Task, inWorkflow: boolean) => void;
  onUpdateOutcome: (task: Task, outcome: Task["callOutcome"]) => void;
  onUpdateNotes: (task: Task, notes: string) => void;
  onDelete: (task: Task) => void;
  onReset?: (task: Task) => void;
  onCallNow?: (task: Task) => void;
}) {
  const [notes, setNotes] = useState(task.notes);
  const [copied, setCopied] = useState(false);

  useEffect(() => { setNotes(task.notes); }, [task.notes]);

  const nextStatus = (() => {
    const idx = TASK_STATUS_CYCLE.indexOf(task.status);
    return idx === -1 ? TASK_STATUS_CYCLE[0] : TASK_STATUS_CYCLE[(idx + 1) % TASK_STATUS_CYCLE.length];
  })();

  return (
    <div style={{
      background: isCurrentWorkflowTask ? "#0d1a0d" : "#141414",
      border: `1px solid ${isCurrentWorkflowTask ? "#1a4a1a" : "#1e1e1e"}`,
      borderRadius: 6, padding: "10px 12px", marginBottom: 8,
      transition: "background 0.3s, border-color 0.3s",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 6 }}>
        {/* Workflow checkbox */}
        <label title="Include in workflow loop" style={{ display: "flex", alignItems: "center", flexShrink: 0, cursor: "pointer", marginTop: 2 }} onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={!!task.inWorkflow} onChange={(e) => onToggleWorkflow(task, e.target.checked)} style={{ accentColor: "#7c3aed", width: 13, height: 13, cursor: "pointer" }} />
        </label>
        {/* Status chip */}
        <button onClick={() => onToggleStatus(task)} title={`Click to change to: ${nextStatus}`} style={{ flexShrink: 0, padding: "2px 8px", borderRadius: 10, border: `1px solid ${TASK_STATUS_COLORS[task.status]}44`, background: `${TASK_STATUS_COLORS[task.status]}18`, color: TASK_STATUS_COLORS[task.status], fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.04em", cursor: "pointer", whiteSpace: "nowrap" as const }}>
          {task.status}
        </button>
        {/* Priority */}
        <span style={{ flexShrink: 0, padding: "2px 7px", borderRadius: 10, border: `1px solid ${PRIORITY_COLORS[task.priority]}44`, background: `${PRIORITY_COLORS[task.priority]}14`, color: PRIORITY_COLORS[task.priority], fontSize: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.04em" }}>
          {task.priority}
        </span>
        {isCurrentWorkflowTask && <span style={{ fontSize: 10, color: "#4ade80", fontWeight: 700, animation: "none" }}>● CALLING</span>}
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "#e0e0e0", lineHeight: 1.4 }}>{task.title}</div>
        {onReset && (task.callOutcome || task.status !== "todo") && (
          <button style={{ ...s.btnSmall, fontSize: 10, color: "#888", borderColor: "#2a2a2a" }} onClick={() => onReset(task)} title="Reset task to fresh state">↺ Reset</button>
        )}
        <button style={s.btnDanger} onClick={() => onDelete(task)} title="Delete task">×</button>
      </div>

      {task.phoneNumber && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <button onClick={() => { navigator.clipboard.writeText(task.phoneNumber!); setCopied(true); setTimeout(() => setCopied(false), 1500); }} title="Click to copy" style={{ background: "none", border: "none", color: copied ? "#4ade80" : "#888", cursor: "pointer", fontSize: 12, fontFamily: "monospace", padding: 0 }}>
            {copied ? "Copied!" : task.phoneNumber}
          </button>
          {onCallNow && (
            <button style={{ ...s.btnSmall, color: "#a78bfa", borderColor: "#3a2a5a", fontSize: 11 }} onClick={() => onCallNow(task)}>Call Now</button>
          )}
        </div>
      )}

      {task.phoneNumber && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: "#555" }}>Outcome:</span>
          <select value={task.callOutcome ?? ""} onChange={(e) => onUpdateOutcome(task, (e.target.value as Task["callOutcome"]) || undefined)} style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 4, color: task.callOutcome ? "#e0e0e0" : "#555", fontSize: 11, padding: "2px 6px", outline: "none", cursor: "pointer" }}>
            <option value="">— not set —</option>
            {(Object.entries(CALL_OUTCOME_LABELS) as [NonNullable<Task["callOutcome"]>, string][]).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </div>
      )}

      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => { if (notes !== task.notes) onUpdateNotes(task, notes); }} placeholder="Add notes…" rows={2} style={{ ...s.textarea, fontSize: 11, color: "#888", background: "#111", border: "1px solid #1a1a1a" }} />
      <div style={{ fontSize: 10, color: "#333", marginTop: 2 }}>Updated {new Date(task.updatedAt).toLocaleString()}</div>
    </div>
  );
}

// ─── WorkflowPanel ─────────────────────────────────────────────────────────────

function WorkflowPanel({ state, onSkip, onStop, onDismiss }: { state: WorkflowState; onSkip: () => void; onStop: () => void; onDismiss: () => void }) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [state.log.length]);

  return (
    <div style={{ background: "#0a1a0a", border: "1px solid #1a4a1a", borderRadius: 8, padding: "12px 16px", marginBottom: 16, flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {state.running && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#4ade80", display: "inline-block" }} />}
          <span style={{ fontSize: 13, fontWeight: 700, color: state.running ? "#4ade80" : "#888" }}>
            {state.running ? `Workflow running — ${state.currentTask || "starting…"}` : "Workflow complete"}
          </span>
          {state.running && state.callStatus && (
            <span style={{ fontSize: 11, color: "#555" }}>{state.callStatus}</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {state.running && state.currentCallId && (
            <button onClick={onSkip} style={{ ...s.btnSmall, borderColor: "#3a2a1a", color: "#fb923c" }} title="Hang up this call and move to the next">⏭ Skip call</button>
          )}
          {state.running && (
            <button onClick={onStop} style={{ ...s.btnSmall, borderColor: "#3a1a1a", color: "#f87171" }} title="Hang up and stop the workflow">■ Kill</button>
          )}
          {!state.running && (
            <button onClick={onDismiss} style={s.btnSmall}>Dismiss</button>
          )}
        </div>
      </div>
      <div ref={logRef} style={{ fontFamily: "monospace", fontSize: 11, color: "#6a9a6a", lineHeight: 1.8, maxHeight: 160, overflowY: "auto" as const, background: "#060e06", borderRadius: 5, padding: "8px 10px" }}>
        {state.log.map((entry, i) => (
          <div key={i} style={{ color: entry.text.startsWith("  ❌") ? "#f87171" : entry.text.startsWith("  →") || entry.text.includes("✅") ? "#4ade80" : entry.text.startsWith("  ") ? "#888" : "#b0d0b0" }}>
            <span style={{ color: "#333", marginRight: 8 }}>{entry.ts}</span>{entry.text}
          </div>
        ))}
        {state.running && <div style={{ color: "#555" }}>▋</div>}
      </div>
    </div>
  );
}

// ─── ProjectDetail ─────────────────────────────────────────────────────────────

interface ProjectDetailProps {
  project: Project;
  workflowState: WorkflowState | null;
  listenToWorkflow: boolean;
  onStrategyUpdate: (projectId: string, strategy: string) => void;
  onTaskAdded: (projectId: string, title: string, phoneNumber: string, priority: Task["priority"]) => Promise<void>;
  onTaskStatusToggle: (projectId: string, task: Task) => void;
  onTaskWorkflowToggle: (projectId: string, task: Task, inWorkflow: boolean) => void;
  onTaskOutcomeUpdate: (projectId: string, task: Task, outcome: Task["callOutcome"]) => void;
  onTaskNotesUpdate: (projectId: string, task: Task, notes: string) => void;
  onTaskDelete: (projectId: string, task: Task) => void;
  onTaskReset: (projectId: string, task: Task) => void;
  onCallNow?: (phoneNumber: string, instructions: string, personaId?: string) => void;
  onWorkflowStart: (project: Project, tasks: Task[], personaId: string | undefined) => void;
  onWorkflowSkip: () => void;
  onWorkflowStop: () => void;
  onWorkflowDismiss: () => void;
  onToggleListenToWorkflow: () => void;
  onSelectAllWorkflow: (projectId: string, tasks: Task[], select: boolean) => void;
  onNavigateTo?: (page: string) => void;
}

function ProjectDetail({
  project, workflowState, listenToWorkflow, onStrategyUpdate, onTaskAdded, onTaskStatusToggle, onTaskWorkflowToggle,
  onTaskOutcomeUpdate, onTaskNotesUpdate, onTaskDelete, onTaskReset, onCallNow,
  onWorkflowStart, onWorkflowSkip, onWorkflowStop, onWorkflowDismiss, onToggleListenToWorkflow, onSelectAllWorkflow, onNavigateTo,
}: ProjectDetailProps) {
  const [showingNewTask, setShowingNewTask] = useState(false);
  const [strategy, setStrategy] = useState(project.strategy ?? "");
  const [strategySaved, setStrategySaved] = useState(true);
  const [strategyExpanded, setStrategyExpanded] = useState(true);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string>("");

  useEffect(() => { setStrategy(project.strategy ?? ""); setStrategySaved(true); }, [project.id]);

  useEffect(() => {
    window.api.personas.list().then((list: Persona[]) => {
      setPersonas(list);
      if (!selectedPersonaId && list.length > 0) {
        const exec = list.find((p) => p.name.toLowerCase().includes("executive") || p.name.toLowerCase().includes("assistant"));
        setSelectedPersonaId(exec?.id ?? list[0].id);
      }
    });
  }, [project.id]);

  function handleRunWorkflow() {
    const tasks = project.tasks.filter((t) => t.inWorkflow && t.phoneNumber && t.status !== "done" && t.status !== "cancelled");
    onWorkflowStart(project, tasks, selectedPersonaId || undefined);
  }

  function handleCallNowForTask(task: Task) {
    if (!task.phoneNumber || !onCallNow) return;
    onCallNow(task.phoneNumber, buildCallInstructions(project, task), selectedPersonaId || undefined);
  }

  const workflowCount = project.tasks.filter((t) => t.inWorkflow && t.status !== "done" && t.status !== "cancelled").length;
  const selectedPersona = personas.find((p) => p.id === selectedPersonaId);
  const isWorkflowRunning = workflowState?.running ?? false;

  const tasksByStatus = {
    active: project.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled"),
    done: project.tasks.filter((t) => t.status === "done" || t.status === "cancelled"),
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "16px 20px", borderBottom: "1px solid #1e1e1e", flexShrink: 0, background: "#0f0f0f" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>{project.name}</div>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, color: PROJECT_STATUS_COLORS[project.status], border: `1px solid ${PROJECT_STATUS_COLORS[project.status]}44`, background: `${PROJECT_STATUS_COLORS[project.status]}18`, borderRadius: 10, padding: "2px 8px" }}>
            {project.status}
          </span>
        </div>
        {project.description && <div style={{ fontSize: 12, color: "#666", lineHeight: 1.5 }}>{project.description}</div>}
      </div>

      {/* Persona picker + Workflow runner */}
      <div style={{ padding: "12px 20px", borderBottom: "1px solid #1e1e1e", background: "#0d0d0d", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" as const }}>
          {/* Persona */}
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 11, color: "#555", marginBottom: 6, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Persona for calls</div>
            {personas.length === 0 ? (
              <div style={{ fontSize: 11, color: "#444" }}>No personas — create one in the Personas page.</div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 5 }}>
                <button type="button" onClick={() => { setSelectedPersonaId(""); setEditingPersona(null); }} style={{ padding: "4px 10px", borderRadius: 20, fontSize: 11, cursor: "pointer", border: `1px solid ${!selectedPersonaId ? "#7c3aed" : "#2a2a2a"}`, background: !selectedPersonaId ? "#2a1a4a" : "#1a1a1a", color: !selectedPersonaId ? "#c4b5fd" : "#555" }}>
                  None
                </button>
                {personas.map((p) => (
                  <button key={p.id} type="button" onClick={() => { setSelectedPersonaId(p.id); setEditingPersona(null); }} title={p.summary ?? p.instructions.slice(0, 120)} style={{ padding: "4px 10px", borderRadius: 20, fontSize: 11, cursor: "pointer", border: `1px solid ${selectedPersonaId === p.id ? "#7c3aed" : "#2a2a2a"}`, background: selectedPersonaId === p.id ? "#2a1a4a" : "#1a1a1a", color: selectedPersonaId === p.id ? "#c4b5fd" : "#888" }}>
                    {p.name}
                  </button>
                ))}
              </div>
            )}
            {selectedPersona && (
              <div style={{ marginTop: 5 }}>
                {selectedPersona.summary && <div style={{ fontSize: 11, color: "#555", marginBottom: 4, lineHeight: 1.4 }}>{selectedPersona.summary}</div>}
                <button type="button" style={s.btnLink} onClick={() => onNavigateTo?.("personas")}>
                  Edit / manage personas →
                </button>
              </div>
            )}
            {!selectedPersona && personas.length > 0 && (
              <button type="button" style={{ ...s.btnLink, marginTop: 4 }} onClick={() => onNavigateTo?.("personas")}>
                Manage personas →
              </button>
            )}
          </div>

          {/* Workflow run button */}
          <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "flex-end", gap: 6 }}>
            <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Workflow</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                type="button"
                onClick={() => {
                  const allWithPhone = project.tasks.filter((t) => t.phoneNumber && t.status !== "done" && t.status !== "cancelled");
                  const allSelected = allWithPhone.every((t) => t.inWorkflow);
                  onSelectAllWorkflow(project.id, allWithPhone, !allSelected);
                }}
                style={{ padding: "3px 10px", fontSize: 10, fontWeight: 600, background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 4, color: "#666", cursor: "pointer" }}
                title="Toggle all active tasks with phone numbers in/out of workflow"
              >
                {project.tasks.filter((t) => t.phoneNumber && t.status !== "done" && t.status !== "cancelled").every((t) => t.inWorkflow) ? "Deselect All" : "Select All"}
              </button>
              <span style={{ fontSize: 11, color: workflowCount > 0 ? "#7c3aed" : "#444" }}>{workflowCount} queued</span>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button
                type="button"
                onClick={onToggleListenToWorkflow}
                style={{ padding: "5px 12px", fontSize: 11, fontWeight: 700, background: listenToWorkflow ? "#0d1f1a" : "#1a1a1a", border: `1px solid ${listenToWorkflow ? "#22c55e" : "#2a2a2a"}`, borderRadius: 6, color: listenToWorkflow ? "#4ade80" : "#555", cursor: "pointer" }}
                title={listenToWorkflow ? "Click to mute — stop listening to calls" : "Click to listen live to all workflow calls"}
              >
                {listenToWorkflow ? "🎧 Listening" : "🔇 Listen to calls"}
              </button>
              <button
                type="button"
                onClick={handleRunWorkflow}
                disabled={workflowCount === 0 || isWorkflowRunning}
                style={{ padding: "7px 16px", background: isWorkflowRunning ? "#1a1a1a" : workflowCount > 0 ? "#7c3aed" : "#1a1a1a", border: `1px solid ${isWorkflowRunning ? "#2a2a2a" : workflowCount > 0 ? "#7c3aed" : "#2a2a2a"}`, borderRadius: 6, color: isWorkflowRunning ? "#444" : workflowCount > 0 ? "#fff" : "#444", cursor: workflowCount > 0 && !isWorkflowRunning ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 700 }}
                title={isWorkflowRunning ? "Workflow already running" : workflowCount === 0 ? "Check the ☐ boxes to queue tasks" : `Run ${workflowCount} task${workflowCount !== 1 ? "s" : ""} autonomously`}
              >
                {isWorkflowRunning ? "⚙ Running…" : "▶ Run Workflow"}
              </button>
            </div>
            <div style={{ fontSize: 10, color: "#333", textAlign: "right" as const }}>Calls automatically · no clicking</div>
          </div>
        </div>
      </div>

      {/* Strategy */}
      <div style={{ borderBottom: "1px solid #1e1e1e", flexShrink: 0, background: "#0d0d1a" }}>
        <button onClick={() => setStrategyExpanded((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "10px 20px", background: "none", border: "none", cursor: "pointer", textAlign: "left" as const }}>
          <span style={{ fontSize: 10, color: "#7c3aed" }}>{strategyExpanded ? "▾" : "▸"}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#7c3aed", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>Strategy & Call Plan</span>
          <span style={{ fontSize: 10, color: "#333", marginLeft: 4 }}>— read before every call</span>
        </button>
        {strategyExpanded && (
          <div style={{ padding: "0 20px 14px" }}>
            <textarea value={strategy} onChange={(e) => { setStrategy(e.target.value); setStrategySaved(false); }} placeholder="Define the goal, adaptive strategies, and success criteria." rows={8} style={{ ...s.textarea, fontSize: 12, lineHeight: 1.7, color: "#c0c0d0", background: "#0a0a14", border: "1px solid #2a2a4a", fontFamily: "monospace" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
              <button onClick={() => { onStrategyUpdate(project.id, strategy); setStrategySaved(true); }} disabled={strategySaved} style={{ padding: "4px 14px", fontSize: 11, fontWeight: 700, background: strategySaved ? "#1a1a2a" : "#7c3aed", color: strategySaved ? "#444" : "#fff", border: "none", borderRadius: 4, cursor: strategySaved ? "default" : "pointer" }}>
                {strategySaved ? "Saved" : "Save Strategy"}
              </button>
              {!strategySaved && <span style={{ fontSize: 10, color: "#7c3aed" }}>Unsaved changes</span>}
            </div>
          </div>
        )}
      </div>

      {/* Task area */}
      <div style={{ flex: 1, overflowY: "auto" as const, padding: "16px 20px" }}>
        {/* Workflow status panel */}
        {workflowState && (
          <WorkflowPanel state={workflowState} onSkip={onWorkflowSkip} onStop={onWorkflowStop} onDismiss={onWorkflowDismiss} />
        )}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "#555" }}>
            {project.tasks.length} task{project.tasks.length !== 1 ? "s" : ""}
            {tasksByStatus.active.length > 0 && ` · ${tasksByStatus.active.length} active`}
          </div>
          {!showingNewTask && <button style={s.btn} onClick={() => setShowingNewTask(true)}>+ Add Task</button>}
        </div>

        {showingNewTask && <NewTaskForm onSave={async (title, phone, priority) => { await onTaskAdded(project.id, title, phone, priority); setShowingNewTask(false); }} onCancel={() => setShowingNewTask(false)} />}

        {project.tasks.length === 0 && !showingNewTask && <div style={{ color: "#444", fontSize: 13, lineHeight: 1.7 }}>No tasks yet.</div>}

        {tasksByStatus.active.map((task) => (
          <TaskRow key={task.id} task={task}
            isCurrentWorkflowTask={workflowState?.running && workflowState.currentTask === task.title}
            onToggleStatus={(t) => onTaskStatusToggle(project.id, t)}
            onToggleWorkflow={(t, v) => onTaskWorkflowToggle(project.id, t, v)}
            onUpdateOutcome={(t, o) => onTaskOutcomeUpdate(project.id, t, o)}
            onUpdateNotes={(t, n) => onTaskNotesUpdate(project.id, t, n)}
            onDelete={(t) => onTaskDelete(project.id, t)}
            onReset={(t) => onTaskReset(project.id, t)}
            onCallNow={onCallNow ? handleCallNowForTask : undefined}
          />
        ))}

        {tasksByStatus.done.length > 0 && (
          <>
            <div style={{ fontSize: 11, color: "#333", margin: "12px 0 8px", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Done / Cancelled ({tasksByStatus.done.length})</div>
            {tasksByStatus.done.map((task) => (
              <TaskRow key={task.id} task={task}
                onToggleStatus={(t) => onTaskStatusToggle(project.id, t)}
                onToggleWorkflow={(t, v) => onTaskWorkflowToggle(project.id, t, v)}
                onUpdateOutcome={(t, o) => onTaskOutcomeUpdate(project.id, t, o)}
                onUpdateNotes={(t, n) => onTaskNotesUpdate(project.id, t, n)}
                onDelete={(t) => onTaskDelete(project.id, t)}
                onReset={(t) => onTaskReset(project.id, t)}
                onCallNow={onCallNow ? handleCallNowForTask : undefined}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Projects (root) ───────────────────────────────────────────────────────────

export default function Projects({ onCallNow, onNavigateTo, onSetAutoListen }: ProjectsProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showingNewProject, setShowingNewProject] = useState(false);
  const [workflowState, setWorkflowState] = useState<WorkflowState | null>(null);
  const [listenToWorkflow, setListenToWorkflow] = useState(false);
  const listenToWorkflowRef = useRef(false);
  const workflowStopRef = useRef(false);
  const skipCallRef = useRef(false);
  const skipCallWakeRef = useRef<(() => void) | null>(null);
  const currentCallIdRef = useRef<string | null>(null);

  function wakeSkip() {
    skipCallWakeRef.current?.();
    skipCallWakeRef.current = null;
  }

  function cancellableSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      skipCallWakeRef.current = resolve;
      setTimeout(resolve, ms);
    });
  }

  function handleWorkflowSkip() {
    skipCallRef.current = true;
    wakeSkip();
    if (currentCallIdRef.current) window.api.calls.hangUp(currentCallIdRef.current);
  }

  function handleWorkflowKill() {
    workflowStopRef.current = true;
    skipCallRef.current = true;
    wakeSkip();
    if (currentCallIdRef.current) window.api.calls.hangUp(currentCallIdRef.current);
  }

  function toggleListenToWorkflow() {
    const next = !listenToWorkflow;
    setListenToWorkflow(next);
    listenToWorkflowRef.current = next;
    onSetAutoListen?.(next);
  }

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const list = await window.api.projects.list();
      setProjects(list);
      if (list.length > 0 && !selectedId) setSelectedId(list[0].id);
    } finally {
      setLoading(false);
    }
  }

  async function runWorkflow(project: Project, tasks: Task[], personaId: string | undefined) {
    if (tasks.length === 0) return;
    workflowStopRef.current = false;

    const log: WorkflowLogEntry[] = [];
    function addLog(text: string) {
      log.push({ text, ts: new Date().toLocaleTimeString() });
      setWorkflowState((prev) => prev ? { ...prev, log: [...log] } : null);
    }

    setWorkflowState({ running: true, currentTask: "", callStatus: "", log: [] });

    for (const task of tasks) {
      if (workflowStopRef.current) { addLog("⏹ Stopped by user."); break; }
      if (!task.phoneNumber) { addLog(`⚠ ${task.title} — no phone number, skipping`); continue; }

      skipCallRef.current = false;
      addLog(`📞 ${task.title}  ${task.phoneNumber}`);
      setWorkflowState((prev) => prev ? { ...prev, currentTask: task.title, callStatus: "placing call…", currentCallId: undefined } : null);

      const instructions = buildCallInstructions(project, task);
      const result = await window.api.calls.initiate(task.phoneNumber, instructions, "", personaId, true);

      if (!result.success) {
        addLog(`  ❌ Failed to place call: ${result.error}`);
        continue;
      }

      currentCallIdRef.current = result.callId ?? null;
      setWorkflowState((prev) => prev ? { ...prev, currentCallId: result.callId } : null);
      addLog(`  ▶ Call placed (${result.callId?.slice(0, 8)}…)`);

      // Navigate AFTER placing — so Calls page loads with the call already in the list
      onNavigateTo?.("calls");

      // Poll until the call ends (or user skips/stops)
      let record: any = null;
      let skipped = false;
      for (let i = 0; i < 72; i++) { // max 6 min (72 × 5s)
        if (workflowStopRef.current || skipCallRef.current) { skipped = skipCallRef.current && !workflowStopRef.current; break; }
        await cancellableSleep(5000);
        if (workflowStopRef.current || skipCallRef.current) { skipped = skipCallRef.current && !workflowStopRef.current; break; }
        const refresh = await window.api.calls.refresh(result.callId!);
        if (!refresh.success || !refresh.record) break;
        record = refresh.record;
        setWorkflowState((prev) => prev ? { ...prev, callStatus: record.status } : null);
        if (TERMINAL_STATUSES.has(record.status)) break;
      }
      skipCallRef.current = false;
      currentCallIdRef.current = null;
      setWorkflowState((prev) => prev ? { ...prev, currentCallId: undefined } : null);

      if (skipped) {
        addLog(`  ⏭ Call skipped by user`);
        const updatedProject = await window.api.projects.updateTask(project.id, task.id, {
          status: "needs-follow-up",
          notes: (task.notes ? task.notes + "\n" : "") + "Skipped mid-call by user.",
        });
        if (updatedProject) { setProjects((prev) => prev.map((p) => (p.id === project.id ? updatedProject : p))); project = updatedProject; }
        if (workflowStopRef.current) { addLog("⏹ Workflow killed by user."); break; }
        if (!listenToWorkflowRef.current) onNavigateTo?.("projects");
        await cancellableSleep(3000);
        continue;
      }

      if (workflowStopRef.current) { addLog("⏹ Workflow killed by user."); break; }

      // Detect outcome
      const outcome = detectCallOutcome(record);
      const duration = record?.durationSeconds ? `${record.durationSeconds}s` : "";
      const summaryNote = record?.summary ?? (record?.transcript ? record.transcript.slice(0, 200) : "");
      addLog(`  → ${outcome}${duration ? ` (${duration})` : ""}${summaryNote ? `\n     ${summaryNote.slice(0, 100)}` : ""}`);

      // Update task in project
      const newTaskStatus: Task["status"] = outcome === "agreed" ? "done" : outcome === "declined" ? "done" : "needs-follow-up";
      const updatedProject = await window.api.projects.updateTask(project.id, task.id, {
        callOutcome: outcome,
        status: newTaskStatus,
        notes: summaryNote || task.notes,
      });
      if (updatedProject) {
        setProjects((prev) => prev.map((p) => (p.id === project.id ? updatedProject : p)));
        // Update project reference for subsequent iterations
        project = updatedProject;
      }

      // Stop if goal achieved
      if (outcome === "agreed") {
        addLog("✅ Goal achieved — workflow complete!");
        break;
      }

      if (!workflowStopRef.current && tasks.indexOf(task) < tasks.length - 1) {
        addLog(`  ⏳ Pausing 5s before next call…`);
        await sleep(5000);
      }
    }

    if (!listenToWorkflowRef.current) onNavigateTo?.("projects");
    setWorkflowState((prev) => prev ? { ...prev, running: false, currentTask: "", callStatus: "complete" } : null);
    if (!workflowStopRef.current) addLog("✅ All workflow tasks processed.");
  }

  const handleStrategyUpdate = useCallback((projectId: string, strategy: string) => {
    window.api.projects.update(projectId, { strategy }).then((updated: Project | null) => {
      if (updated) setProjects((prev) => prev.map((p) => (p.id === projectId ? updated : p)));
    });
  }, []);

  async function handleCreateProject(name: string, description: string) {
    const created = await window.api.projects.create({ name, description, strategy: "", tags: [] });
    setProjects((prev) => [...prev, created]);
    setSelectedId(created.id);
    setShowingNewProject(false);
  }

  const handleTaskAdded = useCallback(async (projectId: string, title: string, phoneNumber: string, priority: Task["priority"]) => {
    const updated = await window.api.projects.addTask(projectId, { title, phoneNumber: phoneNumber || undefined, priority });
    if (updated) setProjects((prev) => prev.map((p) => (p.id === projectId ? updated : p)));
  }, []);

  const handleTaskStatusToggle = useCallback((projectId: string, task: Task) => {
    const idx = TASK_STATUS_CYCLE.indexOf(task.status);
    const next: Task["status"] = idx === -1 ? TASK_STATUS_CYCLE[0] : TASK_STATUS_CYCLE[(idx + 1) % TASK_STATUS_CYCLE.length];
    window.api.projects.updateTask(projectId, task.id, { status: next }).then((updated: Project | null) => {
      if (updated) setProjects((prev) => prev.map((p) => (p.id === projectId ? updated : p)));
    });
  }, []);

  const handleTaskWorkflowToggle = useCallback((projectId: string, task: Task, inWorkflow: boolean) => {
    window.api.projects.updateTask(projectId, task.id, { inWorkflow }).then((updated: Project | null) => {
      if (updated) setProjects((prev) => prev.map((p) => (p.id === projectId ? updated : p)));
    });
  }, []);

  const handleTaskOutcomeUpdate = useCallback((projectId: string, task: Task, outcome: Task["callOutcome"]) => {
    window.api.projects.updateTask(projectId, task.id, { callOutcome: outcome }).then((updated: Project | null) => {
      if (updated) setProjects((prev) => prev.map((p) => (p.id === projectId ? updated : p)));
    });
  }, []);

  const handleTaskNotesUpdate = useCallback((projectId: string, task: Task, notes: string) => {
    window.api.projects.updateTask(projectId, task.id, { notes }).then((updated: Project | null) => {
      if (updated) setProjects((prev) => prev.map((p) => (p.id === projectId ? updated : p)));
    });
  }, []);

  const handleSelectAllWorkflow = useCallback(async (projectId: string, tasks: Task[], select: boolean) => {
    let last: Project | null = null;
    for (const t of tasks) {
      last = await window.api.projects.updateTask(projectId, t.id, { inWorkflow: select });
    }
    if (last) setProjects((prev) => prev.map((p) => (p.id === projectId ? last! : p)));
  }, []);

  const handleTaskReset = useCallback((projectId: string, task: Task) => {
    window.api.projects.updateTask(projectId, task.id, {
      status: "todo",
      callOutcome: undefined,
      callId: undefined,
      notes: "",
    }).then((updated: Project | null) => {
      if (updated) setProjects((prev) => prev.map((p) => (p.id === projectId ? updated : p)));
    });
  }, []);

  const handleTaskDelete = useCallback((projectId: string, task: Task) => {
    if (!confirm(`Delete task "${task.title}"?`)) return;
    window.api.projects.deleteTask(projectId, task.id).then(() => {
      setProjects((prev) => prev.map((p) => p.id === projectId ? { ...p, tasks: p.tasks.filter((t) => t.id !== task.id) } : p));
    });
  }, []);

  const selectedProject = projects.find((p) => p.id === selectedId) ?? null;

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", background: "#0f0f0f" }}>
      <ProjectList
        projects={projects}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNewProject={() => setShowingNewProject(true)}
        showingNewForm={showingNewProject}
        newFormNode={<NewProjectForm onSave={handleCreateProject} onCancel={() => setShowingNewProject(false)} />}
      />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 24, fontSize: 13, color: "#555" }}>Loading…</div>
        ) : selectedProject ? (
          <ProjectDetail
            project={selectedProject}
            workflowState={selectedId === selectedProject.id ? workflowState : null}
            onStrategyUpdate={handleStrategyUpdate}
            onTaskAdded={handleTaskAdded}
            onTaskStatusToggle={handleTaskStatusToggle}
            onTaskWorkflowToggle={handleTaskWorkflowToggle}
            onTaskOutcomeUpdate={handleTaskOutcomeUpdate}
            onTaskNotesUpdate={handleTaskNotesUpdate}
            onTaskDelete={handleTaskDelete}
            onTaskReset={handleTaskReset}
            onCallNow={onCallNow}
            listenToWorkflow={listenToWorkflow}
            onToggleListenToWorkflow={toggleListenToWorkflow}
            onSelectAllWorkflow={handleSelectAllWorkflow}
            onWorkflowStart={runWorkflow}
            onWorkflowSkip={handleWorkflowSkip}
            onWorkflowStop={handleWorkflowKill}
            onWorkflowDismiss={() => setWorkflowState(null)}
            onNavigateTo={onNavigateTo}
          />
        ) : (
          <div style={{ padding: 24, fontSize: 13, color: "#444", lineHeight: 1.7 }}>
            {projects.length === 0 ? "No projects yet. Create one in the left panel." : "Select a project to view its tasks."}
          </div>
        )}
      </div>
    </div>
  );
}
