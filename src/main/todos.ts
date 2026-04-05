import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Priority = "high" | "medium" | "low";
export type Assignee = "Luke" | "Amy" | "Claude Code";

export interface Todo {
  id: string;
  text: string;
  completed: boolean;
  dueDate?: string;         // ISO date string: "2026-04-04"
  priority: Priority;
  assignee: Assignee;
  tags: string[];
  notes?: string;
  createdAt: string;
  order: number;            // for manual drag-to-reorder
}

// ── Storage ───────────────────────────────────────────────────────────────────

function dataFile(): string {
  return path.join(app.getPath("userData"), "data", "todos.json");
}

function loadAll(): Todo[] {
  const file = dataFile();
  try {
    if (!fs.existsSync(file)) return getDefaultTodos();
    const raw = fs.readFileSync(file, "utf-8");
    return JSON.parse(raw) as Todo[];
  } catch {
    return [];
  }
}

function saveAll(todos: Todo[]): void {
  const file = dataFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(todos, null, 2), "utf-8");
}

function generateId(): string {
  return "todo_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
}

// ── Seed data ─────────────────────────────────────────────────────────────────

function getDefaultTodos(): Todo[] {
  const seed: Todo = {
    id: "todo_seed_twilio",
    text: "Discuss Twilio number port options with Luke",
    completed: false,
    dueDate: "2026-04-04",
    priority: "high",
    assignee: "Amy",
    tags: ["infrastructure"],
    notes: "Decide: port 903-841-0578 to Twilio (Amy owns main number, Luke gets private SIM) vs get separate Twilio number for Amy. Also discuss SMS history import options.",
    createdAt: new Date().toISOString(),
    order: 0,
  };
  saveAll([seed]);
  return [seed];
}

// ── Public API ────────────────────────────────────────────────────────────────

export function listTodos(): Todo[] {
  return loadAll().sort((a, b) => a.order - b.order);
}

export function addTodo(data: Omit<Todo, "id" | "createdAt" | "order">): Todo {
  const todos = loadAll();
  const maxOrder = todos.reduce((max, t) => Math.max(max, t.order), -1);
  const todo: Todo = {
    ...data,
    id: generateId(),
    createdAt: new Date().toISOString(),
    order: maxOrder + 1,
  };
  todos.push(todo);
  saveAll(todos);
  return todo;
}

export function updateTodo(id: string, updates: Partial<Omit<Todo, "id" | "createdAt">>): Todo | null {
  const todos = loadAll();
  const idx = todos.findIndex(t => t.id === id);
  if (idx < 0) return null;
  todos[idx] = { ...todos[idx], ...updates };
  saveAll(todos);
  return todos[idx];
}

export function deleteTodo(id: string): boolean {
  const todos = loadAll();
  const filtered = todos.filter(t => t.id !== id);
  if (filtered.length === todos.length) return false;
  saveAll(filtered);
  return true;
}

/** Accepts an ordered array of todo IDs and updates order values accordingly. */
export function reorderTodos(ids: string[]): void {
  const todos = loadAll();
  ids.forEach((id, idx) => {
    const t = todos.find(t => t.id === id);
    if (t) t.order = idx;
  });
  saveAll(todos);
}
