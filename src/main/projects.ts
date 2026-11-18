import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { app } from "electron";

const PROJECTS_DIR = () => path.join(app.getPath("userData"), "data", "projects");

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

async function ensureDir(): Promise<void> {
  await fs.mkdir(PROJECTS_DIR(), { recursive: true });
}

function projectPath(id: string): string {
  return path.join(PROJECTS_DIR(), `${id}.json`);
}

export async function listProjects(): Promise<Project[]> {
  await ensureDir();
  const files = await fs.readdir(PROJECTS_DIR());
  const projects: Project[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(PROJECTS_DIR(), f), "utf-8");
      projects.push(JSON.parse(raw));
    } catch {}
  }
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProject(id: string): Promise<Project | null> {
  try {
    const raw = await fs.readFile(projectPath(id), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function createProject(data: Pick<Project, "name" | "description" | "strategy" | "tags">): Promise<Project> {
  await ensureDir();
  const project: Project = {
    id: randomUUID(),
    name: data.name,
    description: data.description,
    strategy: data.strategy ?? "",
    status: "open",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: data.tags ?? [],
    tasks: [],
  };
  await fs.writeFile(projectPath(project.id), JSON.stringify(project, null, 2));
  return project;
}

export async function updateProject(
  id: string,
  updates: Partial<Pick<Project, "name" | "description" | "strategy" | "status" | "tags">>
): Promise<Project | null> {
  const project = await getProject(id);
  if (!project) return null;
  const updated: Project = { ...project, ...updates, updatedAt: new Date().toISOString() };
  await fs.writeFile(projectPath(id), JSON.stringify(updated, null, 2));
  return updated;
}

export async function deleteProject(id: string): Promise<boolean> {
  try {
    await fs.unlink(projectPath(id));
    return true;
  } catch {
    return false;
  }
}

export async function addTask(
  projectId: string,
  data: Pick<Task, "title" | "description" | "priority" | "notes"> & { phoneNumber?: string }
): Promise<Project | null> {
  const project = await getProject(projectId);
  if (!project) return null;
  const task: Task = {
    id: randomUUID(),
    title: data.title,
    description: data.description ?? "",
    status: "todo",
    phoneNumber: data.phoneNumber,
    notes: data.notes ?? "",
    priority: data.priority ?? "medium",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  project.tasks.push(task);
  project.updatedAt = new Date().toISOString();
  await fs.writeFile(projectPath(projectId), JSON.stringify(project, null, 2));
  return project;
}

export async function updateTask(
  projectId: string,
  taskId: string,
  updates: Partial<Omit<Task, "id" | "createdAt">>
): Promise<Project | null> {
  const project = await getProject(projectId);
  if (!project) return null;
  const taskIdx = project.tasks.findIndex((t) => t.id === taskId);
  if (taskIdx === -1) return null;
  project.tasks[taskIdx] = {
    ...project.tasks[taskIdx],
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  project.updatedAt = new Date().toISOString();
  await fs.writeFile(projectPath(projectId), JSON.stringify(project, null, 2));
  return project;
}

export async function deleteTask(projectId: string, taskId: string): Promise<Project | null> {
  const project = await getProject(projectId);
  if (!project) return null;
  project.tasks = project.tasks.filter((t) => t.id !== taskId);
  project.updatedAt = new Date().toISOString();
  await fs.writeFile(projectPath(projectId), JSON.stringify(project, null, 2));
  return project;
}
