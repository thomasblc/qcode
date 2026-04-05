import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { markDirty } from "../state/persistence.js";

export type SessionStatus = "running" | "done" | "error" | "awaiting_approval" | "stopped";

export type PermissionMode = "ask" | "plan-first" | "auto-writes" | "yolo";

export const DEFAULT_MODE: PermissionMode = "ask";
export const ALL_MODES: PermissionMode[] = ["ask", "plan-first", "auto-writes", "yolo"];

// ─── Project ───────────────────────────────────────────────────────
// A Project is a folder on disk. Sessions are children of projects.
// Switching to a new folder = new project (or re-use if same path).

export interface Project {
  id: string;            // sha256(absolutePath).slice(0, 12)
  name: string;          // last path segment
  absolutePath: string;
  createdAt: number;
  lastOpenedAt: number;
  defaultMode: PermissionMode;
}

const projects = new Map<string, Project>();

function projectIdFor(absolutePath: string): string {
  return createHash("sha256").update(absolutePath).digest("hex").slice(0, 12);
}

export function getOrCreateProject(absolutePath: string): Project {
  const normalized = path.resolve(absolutePath);
  const id = projectIdFor(normalized);
  const existing = projects.get(id);
  if (existing) {
    existing.lastOpenedAt = Date.now();
    markDirty();
    return existing;
  }
  const proj: Project = {
    id,
    name: path.basename(normalized) || normalized,
    absolutePath: normalized,
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
    defaultMode: DEFAULT_MODE,
  };
  projects.set(id, proj);
  markDirty();
  return proj;
}

export function getProject(id: string): Project | undefined {
  return projects.get(id);
}

export function listProjects(): Project[] {
  return Array.from(projects.values()).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export function snapshotProjects(): Project[] {
  return Array.from(projects.values());
}

export function restoreProjects(loaded: Project[]): void {
  for (const p of loaded) projects.set(p.id, p);
}

// ─── Session ───────────────────────────────────────────────────────

export interface Session {
  id: string;
  projectId: string;     // FK → Project.id
  prompt: string;
  projectRoot: string;   // kept for back-compat + convenience
  mode: PermissionMode;
  status: SessionStatus;
  startedAt: number;
  endedAt: number | null;
  summary: string | null;
  error: string | null;
  // true once the user approves the initial plan in plan-first mode
  planApproved?: boolean;
  // message history for continue conversation (debugging only, not used for context).
  // The "tool" role is used by the SDK native tool calling path for tool results.
  messages?: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  // Turn log: one entry per user task + its outcome. Used to build
  // condensed context on continues (avoids Qwen 3B pattern-repeat bug).
  turns?: Array<{ task: string; summary: string }>;
  // true once the agent has completed the session boot protocol
  // (read qcode.md / README.md). Prevents repeat-reads on continue.
  docsLoaded?: boolean;
}

const sessions = new Map<string, Session>();

export function newSessionId(): string {
  return randomBytes(6).toString("base64url");
}

export function createSession(prompt: string, projectRoot: string, mode: PermissionMode = DEFAULT_MODE): Session {
  const project = getOrCreateProject(projectRoot);
  const s: Session = {
    id: newSessionId(),
    projectId: project.id,
    prompt,
    projectRoot: project.absolutePath,
    mode,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    summary: null,
    error: null,
    planApproved: mode === "plan-first" ? false : true,
    turns: [{ task: prompt, summary: "" }],
    docsLoaded: false,
  };
  sessions.set(s.id, s);
  markDirty();
  return s;
}

// Back-compat: old sessions without projectId get auto-migrated on restore.
export function restoreSessionsCompat(loaded: Session[]): void {
  for (const s of loaded) {
    if (!s.projectId && s.projectRoot) {
      const p = getOrCreateProject(s.projectRoot);
      s.projectId = p.id;
    }
    sessions.set(s.id, s);
  }
}

export function listSessionsByProject(projectId: string): Session[] {
  return Array.from(sessions.values())
    .filter(s => s.projectId === projectId)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function restoreSessions(loaded: Session[]): void {
  for (const s of loaded) sessions.set(s.id, s);
}

export function snapshotSessions(): Session[] {
  return Array.from(sessions.values());
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function listSessions(): Session[] {
  return Array.from(sessions.values()).sort((a, b) => b.startedAt - a.startedAt);
}

export function updateSession(id: string, patch: Partial<Session>): void {
  const s = sessions.get(id);
  if (!s) return;
  Object.assign(s, patch);
  markDirty();
}

// Remove a session from the in-memory store and persist. Returns true if
// the session existed and was removed. Callers should also call
// deleteChannel(id) from sse.ts to release the SSE subscribers. Running
// sessions should be stopped via setStopRequested before delete.
export function deleteSession(id: string): boolean {
  const existed = sessions.delete(id);
  if (existed) markDirty();
  return existed;
}
