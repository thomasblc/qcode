import { promises as fs } from "node:fs";
import path from "node:path";
import type { Session, Project } from "../server/sessions.js";
import type { SessionEvent } from "../server/sse.js";
import { log } from "../utils/logger.js";

// Simple JSON-on-disk persistence. NOT concurrent-safe, we accept that for MVP
// since only one daemon writes at a time. Debounced to avoid thrashing.

interface DiskState {
  version: 1;
  sessions: Session[];
  projects?: Project[];  // introduced in v2.5, optional for backward compat
  // events keyed by sessionId, capped at 500 per session on load
  events: Record<string, SessionEvent[]>;
}

let STATE_DIR: string | null = null;
let STATE_FILE: string | null = null;
let writeTimer: NodeJS.Timeout | null = null;
let dirty = false;
let getState: (() => DiskState) | null = null;

export async function initPersistence(
  projectDir: string,
  snapshot: () => DiskState,
): Promise<DiskState | null> {
  STATE_DIR = path.join(projectDir, ".qcode-state");
  STATE_FILE = path.join(STATE_DIR, "sessions.json");
  getState = snapshot;
  try {
    // mode 0700: only the current user can read/list this directory, since
    // it holds the auth key + full conversation history + tool outputs that
    // may include sensitive paths, env vars, or command results.
    await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  } catch (e) {
    log.warn(`persistence: could not create ${STATE_DIR}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as DiskState;
    if (parsed.version !== 1) { log.warn(`persistence: unknown version ${parsed.version}, ignoring`); return null; }
    log.info(`persistence: loaded ${parsed.sessions.length} sessions from disk`);
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    log.warn(`persistence: read failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export function markDirty(): void {
  if (!getState || !STATE_FILE) return;
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; void flush(); }, 500);
}

async function flush(): Promise<void> {
  if (!dirty || !getState || !STATE_FILE) return;
  dirty = false;
  try {
    // compact JSON (no indent) to save ~30% on disk size and write time for
    // large session histories. Also mode 0600: user-only read/write, since
    // sessions.json may hold shell output, paths, and other sensitive bits.
    const payload = JSON.stringify(getState());
    const tmp = STATE_FILE + ".tmp";
    await fs.writeFile(tmp, payload, { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tmp, STATE_FILE);
  } catch (e) {
    log.warn(`persistence: write failed: ${e instanceof Error ? e.message : e}`);
    dirty = true;
  }
}

export async function flushNow(): Promise<void> {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  await flush();
}
