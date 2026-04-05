import React, { useState, useEffect, useRef } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

type Priority = "high" | "medium" | "low";
type Assignee = "Luke" | "Amy" | "Claude Code";

interface Todo {
  id: string;
  text: string;
  completed: boolean;
  dueDate?: string;
  priority: Priority;
  assignee: Assignee;
  tags: string[];
  notes?: string;
  createdAt: string;
  order: number;
}

type FilterStatus = "all" | "active" | "completed";
type SortKey = "order" | "dueDate" | "priority" | "createdAt";

// ── Constants ─────────────────────────────────────────────────────────────────

const PRIORITY_COLORS: Record<Priority, string> = {
  high: "#f87171",
  medium: "#facc15",
  low: "#4ade80",
};

const ASSIGNEES: Assignee[] = ["Luke", "Amy", "Claude Code"];
const PRIORITIES: Priority[] = ["high", "medium", "low"];

const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDueDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(iso + "T00:00:00");
  const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isDueSoon(iso?: string): boolean {
  if (!iso) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(iso + "T00:00:00");
  const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
  return diff <= 1;
}

function isOverdue(iso?: string): boolean {
  if (!iso) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(iso + "T00:00:00");
  return due < today;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Todos() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("all");
  const [filterPriority, setFilterPriority] = useState<Priority | "all">("all");
  const [filterAssignee, setFilterAssignee] = useState<Assignee | "all">("all");
  const [filterTag, setFilterTag] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("order");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteBuffer, setNoteBuffer] = useState<string>("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Add form state
  const [addText, setAddText] = useState("");
  const [addPriority, setAddPriority] = useState<Priority>("medium");
  const [addAssignee, setAddAssignee] = useState<Assignee>("Luke");
  const [addDueDate, setAddDueDate] = useState("");
  const [addTags, setAddTags] = useState("");
  const [addNotes, setAddNotes] = useState("");
  const [addExpanded, setAddExpanded] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);

  // Inline tag editing
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [tagBuffer, setTagBuffer] = useState<string>("");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      const list = await (window.api as any).todos.list();
      setTodos(list);
    } catch (e) {
      console.error("Failed to load todos", e);
    }
  }

  // ── All unique tags across all todos ──────────────────────────────────────
  const allTags = Array.from(new Set(todos.flatMap(t => t.tags))).sort();

  // ── Filtering + sorting ───────────────────────────────────────────────────
  const visible = todos
    .filter(t => {
      if (filterStatus === "active" && t.completed) return false;
      if (filterStatus === "completed" && !t.completed) return false;
      if (filterPriority !== "all" && t.priority !== filterPriority) return false;
      if (filterAssignee !== "all" && t.assignee !== filterAssignee) return false;
      if (filterTag !== "all" && !t.tags.includes(filterTag)) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortKey === "order") return a.order - b.order;
      if (sortKey === "dueDate") {
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate);
      }
      if (sortKey === "priority") return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (sortKey === "createdAt") return b.createdAt.localeCompare(a.createdAt);
      return 0;
    });

  // ── Add todo ──────────────────────────────────────────────────────────────
  async function handleAdd() {
    const text = addText.trim();
    if (!text) return;
    const tags = addTags.split(",").map(t => t.trim()).filter(Boolean);
    try {
      const todo = await (window.api as any).todos.add({
        text,
        completed: false,
        dueDate: addDueDate || undefined,
        priority: addPriority,
        assignee: addAssignee,
        tags,
        notes: addNotes || undefined,
      });
      setTodos(prev => [...prev, todo]);
      setAddText("");
      setAddDueDate("");
      setAddTags("");
      setAddNotes("");
      setAddPriority("medium");
      setAddAssignee("Luke");
      setAddExpanded(false);
      addInputRef.current?.focus();
    } catch (e) {
      console.error("Failed to add todo", e);
    }
  }

  // ── Toggle complete ───────────────────────────────────────────────────────
  async function toggleComplete(id: string) {
    const todo = todos.find(t => t.id === id);
    if (!todo) return;
    try {
      const updated = await (window.api as any).todos.update(id, { completed: !todo.completed });
      if (updated) setTodos(prev => prev.map(t => t.id === id ? updated : t));
    } catch {}
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  async function handleDelete(id: string) {
    try {
      await (window.api as any).todos.delete(id);
      setTodos(prev => prev.filter(t => t.id !== id));
    } catch {}
  }

  // ── Update field ──────────────────────────────────────────────────────────
  async function updateField(id: string, updates: Partial<Todo>) {
    try {
      const updated = await (window.api as any).todos.update(id, updates);
      if (updated) setTodos(prev => prev.map(t => t.id === id ? updated : t));
    } catch {}
  }

  // ── Save notes ────────────────────────────────────────────────────────────
  async function saveNote(id: string) {
    await updateField(id, { notes: noteBuffer });
    setEditingNoteId(null);
  }

  // ── Drag-to-reorder ───────────────────────────────────────────────────────
  function handleDragStart(id: string) {
    setDraggingId(id);
  }

  function handleDragOver(e: React.DragEvent, id: string) {
    e.preventDefault();
    if (id !== draggingId) setDragOverId(id);
  }

  async function handleDrop(targetId: string) {
    if (!draggingId || draggingId === targetId) {
      setDraggingId(null);
      setDragOverId(null);
      return;
    }
    // Reorder: move dragging item to position of target
    const currentOrder = [...todos].sort((a, b) => a.order - b.order);
    const fromIdx = currentOrder.findIndex(t => t.id === draggingId);
    const toIdx = currentOrder.findIndex(t => t.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const reordered = [...currentOrder];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    const ids = reordered.map(t => t.id);
    // Optimistic update
    setTodos(prev => {
      const map = new Map(prev.map(t => [t.id, t]));
      ids.forEach((id, idx) => {
        const t = map.get(id);
        if (t) map.set(id, { ...t, order: idx });
      });
      return Array.from(map.values());
    });
    try {
      await (window.api as any).todos.reorder(ids);
    } catch {}
    setDraggingId(null);
    setDragOverId(null);
  }

  function toggleExpand(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const completedCount = todos.filter(t => t.completed).length;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      background: "#0f0f0f", color: "#e0e0e0", overflow: "hidden",
      fontFamily: "system-ui, sans-serif",
    }}>
      {/* Header */}
      <div style={{
        padding: "16px 20px 12px",
        borderBottom: "1px solid #1e1e1e",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: "#fff" }}>To-Dos</div>
          <div style={{ fontSize: 12, color: "#444" }}>
            {todos.length - completedCount} active · {completedCount} done
          </div>
        </div>
      </div>

      {/* Add form */}
      <div style={{
        padding: "12px 20px",
        borderBottom: "1px solid #1e1e1e",
        flexShrink: 0,
        background: "#111",
      }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            ref={addInputRef}
            value={addText}
            onChange={e => setAddText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleAdd(); }}
            onFocus={() => setAddExpanded(true)}
            placeholder="Add a task… (Enter to save)"
            style={{
              flex: 1, background: "#1a1a1a", border: "1px solid #2a2a2a",
              borderRadius: 6, padding: "7px 11px", color: "#e0e0e0",
              fontSize: 13, outline: "none",
            }}
          />
          <button
            onClick={handleAdd}
            disabled={!addText.trim()}
            style={{
              background: addText.trim() ? "#7c3aed" : "#2a2a2a",
              border: "none", borderRadius: 6, padding: "7px 14px",
              color: addText.trim() ? "#fff" : "#555", fontSize: 12,
              cursor: addText.trim() ? "pointer" : "default", fontWeight: 600,
            }}
          >
            Add
          </button>
        </div>

        {addExpanded && (
          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select
              value={addPriority}
              onChange={e => setAddPriority(e.target.value as Priority)}
              style={selectStyle}
            >
              {PRIORITIES.map(p => (
                <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
              ))}
            </select>
            <select
              value={addAssignee}
              onChange={e => setAddAssignee(e.target.value as Assignee)}
              style={selectStyle}
            >
              {ASSIGNEES.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <input
              type="date"
              value={addDueDate}
              onChange={e => setAddDueDate(e.target.value)}
              style={{ ...selectStyle, width: 130 }}
            />
            <input
              value={addTags}
              onChange={e => setAddTags(e.target.value)}
              placeholder="Tags (comma-separated)"
              style={{ ...selectStyle, width: 180 }}
            />
            <input
              value={addNotes}
              onChange={e => setAddNotes(e.target.value)}
              placeholder="Notes"
              style={{ ...selectStyle, flex: 1, minWidth: 200 }}
            />
          </div>
        )}
      </div>

      {/* Filters + sort */}
      <div style={{
        padding: "8px 20px",
        borderBottom: "1px solid #1e1e1e",
        display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
        flexShrink: 0,
        background: "#0d0d0d",
      }}>
        {/* Status filter */}
        <div style={{ display: "flex", gap: 4 }}>
          {(["all", "active", "completed"] as FilterStatus[]).map(s => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              style={{
                background: filterStatus === s ? "#7c3aed" : "#1a1a1a",
                border: "1px solid " + (filterStatus === s ? "#7c3aed" : "#2a2a2a"),
                borderRadius: 5, padding: "4px 10px",
                color: filterStatus === s ? "#fff" : "#666",
                fontSize: 11, cursor: "pointer", fontWeight: 500,
              }}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        <div style={{ width: 1, background: "#2a2a2a", alignSelf: "stretch" }} />

        <select value={filterPriority} onChange={e => setFilterPriority(e.target.value as any)} style={filterSelectStyle}>
          <option value="all">All priorities</option>
          {PRIORITIES.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
        </select>

        <select value={filterAssignee} onChange={e => setFilterAssignee(e.target.value as any)} style={filterSelectStyle}>
          <option value="all">All assignees</option>
          {ASSIGNEES.map(a => <option key={a} value={a}>{a}</option>)}
        </select>

        <select value={filterTag} onChange={e => setFilterTag(e.target.value)} style={filterSelectStyle}>
          <option value="all">All tags</option>
          {allTags.map(t => <option key={t} value={t}>{t}</option>)}
        </select>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11, color: "#555" }}>Sort:</span>
          <select value={sortKey} onChange={e => setSortKey(e.target.value as SortKey)} style={filterSelectStyle}>
            <option value="order">Manual</option>
            <option value="dueDate">Due date</option>
            <option value="priority">Priority</option>
            <option value="createdAt">Created</option>
          </select>
        </div>
      </div>

      {/* Todo list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 20px 20px" }}>
        {visible.length === 0 && (
          <div style={{ color: "#333", fontSize: 13, marginTop: 24, textAlign: "center" }}>
            {todos.length === 0 ? "No tasks yet. Add one above." : "No tasks match the current filter."}
          </div>
        )}

        {visible.map(todo => {
          const expanded = expandedIds.has(todo.id);
          const dueDateColor = isOverdue(todo.dueDate) && !todo.completed
            ? "#f87171"
            : isDueSoon(todo.dueDate) && !todo.completed
            ? "#facc15"
            : "#666";
          const isDragOver = dragOverId === todo.id;

          return (
            <div
              key={todo.id}
              draggable={sortKey === "order"}
              onDragStart={() => handleDragStart(todo.id)}
              onDragOver={e => handleDragOver(e, todo.id)}
              onDrop={() => handleDrop(todo.id)}
              onDragEnd={() => { setDraggingId(null); setDragOverId(null); }}
              style={{
                background: draggingId === todo.id ? "#1a1a2e" : "#141414",
                border: "1px solid " + (isDragOver ? "#7c3aed" : "#1e1e1e"),
                borderRadius: 7,
                marginBottom: 6,
                opacity: draggingId === todo.id ? 0.5 : 1,
                transition: "border-color 0.1s",
              }}
            >
              {/* Main row */}
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "9px 10px 9px 8px",
              }}>
                {/* Drag handle (only when manual sort) */}
                {sortKey === "order" && (
                  <div style={{
                    cursor: "grab", color: "#333", fontSize: 14,
                    padding: "0 4px", flexShrink: 0, lineHeight: 1,
                  }}>
                    ⠿
                  </div>
                )}

                {/* Checkbox */}
                <input
                  type="checkbox"
                  checked={todo.completed}
                  onChange={() => toggleComplete(todo.id)}
                  style={{ width: 15, height: 15, cursor: "pointer", flexShrink: 0, accentColor: "#7c3aed" }}
                />

                {/* Text */}
                <div style={{
                  flex: 1, fontSize: 13,
                  color: todo.completed ? "#444" : "#e0e0e0",
                  textDecoration: todo.completed ? "line-through" : "none",
                  minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {todo.text}
                </div>

                {/* Priority dot */}
                <div style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: PRIORITY_COLORS[todo.priority],
                  flexShrink: 0,
                  title: todo.priority,
                }} title={todo.priority} />

                {/* Assignee */}
                <select
                  value={todo.assignee}
                  onChange={e => updateField(todo.id, { assignee: e.target.value as Assignee })}
                  style={{
                    background: "#1a1a1a", border: "1px solid #2a2a2a",
                    borderRadius: 4, color: "#888", fontSize: 10,
                    padding: "2px 4px", cursor: "pointer",
                  }}
                  onClick={e => e.stopPropagation()}
                >
                  {ASSIGNEES.map(a => <option key={a} value={a}>{a}</option>)}
                </select>

                {/* Due date */}
                {todo.dueDate ? (
                  <span style={{ fontSize: 10, color: dueDateColor, flexShrink: 0 }}>
                    {formatDueDate(todo.dueDate)}
                  </span>
                ) : null}

                {/* Tags */}
                {todo.tags.length > 0 && (
                  <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                    {todo.tags.slice(0, 3).map(tag => (
                      <span key={tag} style={{
                        background: "#1e1e40", border: "1px solid #2a2a6a",
                        borderRadius: 3, padding: "1px 5px",
                        fontSize: 9, color: "#7c9ed9",
                      }}>
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                {/* Expand toggle */}
                <button
                  onClick={() => toggleExpand(todo.id)}
                  style={{
                    background: "none", border: "none",
                    color: expanded ? "#7c3aed" : "#333",
                    cursor: "pointer", fontSize: 11, padding: "0 2px",
                    flexShrink: 0, lineHeight: 1,
                  }}
                  title="Notes & details"
                >
                  {expanded ? "▲" : "▼"}
                </button>

                {/* Delete */}
                <button
                  onClick={() => handleDelete(todo.id)}
                  style={{
                    background: "none", border: "none",
                    color: "#333", cursor: "pointer",
                    fontSize: 13, padding: "0 2px", flexShrink: 0, lineHeight: 1,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = "#f87171")}
                  onMouseLeave={e => (e.currentTarget.style.color = "#333")}
                  title="Delete"
                >
                  ✕
                </button>
              </div>

              {/* Expanded detail panel */}
              {expanded && (
                <div style={{
                  padding: "0 12px 12px 36px",
                  borderTop: "1px solid #1e1e1e",
                }}>
                  <div style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
                    {/* Row: priority + due date */}
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#666" }}>
                        Priority
                        <select
                          value={todo.priority}
                          onChange={e => updateField(todo.id, { priority: e.target.value as Priority })}
                          style={detailSelectStyle}
                        >
                          {PRIORITIES.map(p => (
                            <option key={p} value={p} style={{ color: PRIORITY_COLORS[p] }}>
                              {p.charAt(0).toUpperCase() + p.slice(1)}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#666" }}>
                        Due
                        <input
                          type="date"
                          value={todo.dueDate || ""}
                          onChange={e => updateField(todo.id, { dueDate: e.target.value || undefined })}
                          style={detailSelectStyle}
                        />
                      </label>
                    </div>

                    {/* Tags editor */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, color: "#666" }}>Tags</span>
                      {editingTagId === todo.id ? (
                        <input
                          autoFocus
                          value={tagBuffer}
                          onChange={e => setTagBuffer(e.target.value)}
                          onBlur={() => {
                            const tags = tagBuffer.split(",").map(t => t.trim()).filter(Boolean);
                            updateField(todo.id, { tags });
                            setEditingTagId(null);
                          }}
                          onKeyDown={e => {
                            if (e.key === "Enter") {
                              const tags = tagBuffer.split(",").map(t => t.trim()).filter(Boolean);
                              updateField(todo.id, { tags });
                              setEditingTagId(null);
                            }
                            if (e.key === "Escape") setEditingTagId(null);
                          }}
                          placeholder="tag1, tag2"
                          style={{ ...detailSelectStyle, width: 200 }}
                        />
                      ) : (
                        <div
                          onClick={() => { setEditingTagId(todo.id); setTagBuffer(todo.tags.join(", ")); }}
                          style={{ display: "flex", gap: 4, cursor: "pointer", alignItems: "center", minWidth: 60 }}
                        >
                          {todo.tags.length === 0
                            ? <span style={{ fontSize: 11, color: "#333" }}>add tags…</span>
                            : todo.tags.map(tag => (
                              <span key={tag} style={{
                                background: "#1e1e40", border: "1px solid #2a2a6a",
                                borderRadius: 3, padding: "1px 5px", fontSize: 10, color: "#7c9ed9",
                              }}>
                                {tag}
                              </span>
                            ))
                          }
                        </div>
                      )}
                    </div>

                    {/* Notes */}
                    <div>
                      <div style={{ fontSize: 11, color: "#666", marginBottom: 4 }}>Notes</div>
                      {editingNoteId === todo.id ? (
                        <div>
                          <textarea
                            autoFocus
                            value={noteBuffer}
                            onChange={e => setNoteBuffer(e.target.value)}
                            rows={4}
                            style={{
                              width: "100%", background: "#1a1a1a",
                              border: "1px solid #2a2a2a", borderRadius: 5,
                              color: "#ccc", fontSize: 12, padding: "8px",
                              resize: "vertical", fontFamily: "inherit",
                              outline: "none", boxSizing: "border-box",
                            }}
                          />
                          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                            <button
                              onClick={() => saveNote(todo.id)}
                              style={{
                                background: "#7c3aed", border: "none", borderRadius: 4,
                                padding: "5px 12px", color: "#fff", fontSize: 11,
                                cursor: "pointer", fontWeight: 600,
                              }}
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditingNoteId(null)}
                              style={{
                                background: "#1a1a1a", border: "1px solid #2a2a2a",
                                borderRadius: 4, padding: "5px 12px",
                                color: "#666", fontSize: 11, cursor: "pointer",
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div
                          onClick={() => { setEditingNoteId(todo.id); setNoteBuffer(todo.notes || ""); }}
                          style={{
                            background: "#1a1a1a", border: "1px solid #1e1e1e",
                            borderRadius: 5, padding: "8px 10px",
                            fontSize: 12, color: todo.notes ? "#aaa" : "#333",
                            cursor: "text", minHeight: 36,
                            whiteSpace: "pre-wrap", lineHeight: 1.5,
                          }}
                        >
                          {todo.notes || "Click to add notes…"}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  background: "#1a1a1a",
  border: "1px solid #2a2a2a",
  borderRadius: 5,
  padding: "5px 8px",
  color: "#aaa",
  fontSize: 11,
  outline: "none",
  cursor: "pointer",
};

const filterSelectStyle: React.CSSProperties = {
  background: "#1a1a1a",
  border: "1px solid #2a2a2a",
  borderRadius: 5,
  padding: "4px 7px",
  color: "#777",
  fontSize: 11,
  outline: "none",
  cursor: "pointer",
};

const detailSelectStyle: React.CSSProperties = {
  background: "#1a1a1a",
  border: "1px solid #2a2a2a",
  borderRadius: 4,
  padding: "3px 6px",
  color: "#aaa",
  fontSize: 11,
  outline: "none",
  cursor: "pointer",
};
