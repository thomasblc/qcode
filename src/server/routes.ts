import type { Express, Request, Response } from "express";
import path from "node:path";
import os from "node:os";
import { type ModelBackend } from "../agent/models.js";
import { setProjectRoot } from "../utils/paths.js";
import { log } from "../utils/logger.js";

// The user's home directory. projectRoot values from the HTTP body are
// normalized and REQUIRED to resolve inside $HOME. Without this, a malicious
// caller (or a misconfigured PWA) could set projectRoot to "/" and let the
// agent read/write anywhere on the filesystem. Environment overrides are
// allowed via QCODE_ROOT_ALLOWLIST (comma-separated absolute paths) for
// testing or CI scenarios where $HOME is not the intended sandbox.
const HOME_DIR = path.resolve(os.homedir());
const EXTRA_ROOTS = (process.env.QCODE_ROOT_ALLOWLIST ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(p => path.resolve(p));

function normalizeProjectRoot(raw: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (!raw) return { ok: false, reason: "missing projectRoot" };
  let abs: string;
  try { abs = path.resolve(raw); } catch { return { ok: false, reason: "invalid projectRoot" }; }
  // Must be under HOME or in the explicit allowlist. Use path.sep on the
  // prefix check so /Users/thomas_attacker doesn't pass as /Users/thomas.
  const inHome = abs === HOME_DIR || abs.startsWith(HOME_DIR + path.sep);
  const inAllowlist = EXTRA_ROOTS.some(root => abs === root || abs.startsWith(root + path.sep));
  if (!inHome && !inAllowlist) {
    return { ok: false, reason: `projectRoot must be under ${HOME_DIR} (or QCODE_ROOT_ALLOWLIST)` };
  }
  return { ok: true, path: abs };
}
import { requireAuth } from "./auth.js";
import { createChannel, pushEvent, attachSubscriber, getChannel, snapshotSince, deleteChannel } from "./sse.js";
import { parkApproval, resolveApproval } from "./approvals.js";
import { createSession, deleteSession, getSession, listSessions, updateSession, ALL_MODES, type PermissionMode } from "./sessions.js";
import { registerController, removeController, abortSession } from "./controllers.js";
import { wrapToolContextWithMode } from "../agent/permissions.js";
import { buildPriorContext } from "../agent/condense.js";
import { readProjectMemory } from "../agent/memory.js";
import { getOrCreateProject } from "./sessions.js";
import { listFeatureStates } from "./features.js";
import { createDefaultRouter } from "../agent/backends/index.js";
import type { FeatureId } from "./features.js";
import type { ModelProvider } from "./model-provider.js";
import type { Router } from "../agent/router.js";

// One router per daemon. Backends are registered once at startup.
let sharedRouter: Router | null = null;
function getRouter(): Router {
  if (!sharedRouter) sharedRouter = createDefaultRouter();
  return sharedRouter;
}
import type { ApprovalRequest, ToolContext } from "../tools/index.js";

// Build the feature state map the runtime context needs.
async function getFeatureMap(): Promise<Record<FeatureId, boolean>> {
  const states = await listFeatureStates();
  const map = { voice: false, vision: false, delegated: false } as Record<FeatureId, boolean>;
  for (const s of states) {
    map[s.id] = s.enabled && s.status === "ready";
  }
  return map;
}

// peerBackendRef is a mutable holder, not a value. server/index.ts flips its
// .ref from null to a loaded QvacSdkBackend when the async peer load finishes.
// routes.ts resolves it at request-time, not at registration time.
import type { PeerBackendRef } from "./peer-config.js";
export type { PeerBackendRef };

export function registerRoutes(
  app: Express,
  backend: ModelBackend,
  modelProvider?: ModelProvider,
  peerBackendRef?: PeerBackendRef | null,
): void {
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "qcode" });
  });

  // POST /sessions: kick off a new agent task
  app.post("/sessions", requireAuth, (req: Request, res: Response) => {
    const body = req.body as { prompt?: string; projectRoot?: string; mode?: string };
    const prompt = String(body.prompt ?? "").trim();
    const projectRootRaw = String(body.projectRoot ?? "").trim();
    const modeRaw = String(body.mode ?? "ask");
    const mode = (ALL_MODES as readonly string[]).includes(modeRaw) ? (modeRaw as PermissionMode) : "ask";
    if (!prompt) { res.status(400).json({ error: "missing prompt" }); return; }
    // Sandbox: reject projectRoot values outside $HOME or the allowlist.
    // Without this check, a caller could set projectRoot: "/" and let the
    // agent roam the whole filesystem with `read_file`/`write_file`/`bash`.
    const norm = normalizeProjectRoot(projectRootRaw);
    if (!norm.ok) { res.status(400).json({ error: norm.reason }); return; }
    const projectRoot = norm.path;

    const session = createSession(prompt, projectRoot, mode);
    const channel = createChannel(session.id);
    // Broadcast the initial user prompt as an SSE event so other devices
    // subscribed to this session see it live. Without this event, a device
    // that joined after the session started only gets the prompt by
    // reading session.prompt via /snapshot; live viewers would miss it.
    pushEvent(channel, "user_msg", { content: prompt });

    // Run in background; events flow through the channel
    void runSessionInBackground(session.id, prompt, projectRoot, backend, modelProvider, peerBackendRef)
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`session ${session.id} crashed: ${msg}`);
        updateSession(session.id, { status: "error", error: msg, endedAt: Date.now() });
        pushEvent(channel, "error", { message: msg });
      });

    res.status(201).json({ sessionId: session.id, status: "running", mode });
  });

  // POST /sessions/:id/messages: continue an existing session with a follow-up
  app.post("/sessions/:id/messages", requireAuth, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const body = req.body as { content?: string; mode?: string };
    const content = String(body.content ?? "").trim();
    if (!content) { res.status(400).json({ error: "missing content" }); return; }
    const session = getSession(id);
    if (!session) { res.status(404).json({ error: "session not found" }); return; }
    if (session.status === "running" || session.status === "awaiting_approval") {
      res.status(409).json({ error: "session still active" }); return;
    }
    // Allow the client to switch modes on the fly.
    const modeRaw = String(body.mode ?? "");
    const modePatch: Partial<typeof session> = {};
    if ((ALL_MODES as readonly string[]).includes(modeRaw)) {
      modePatch.mode = modeRaw as PermissionMode;
      // Reset planApproved when switching into plan-first mid-conversation
      if (modeRaw === "plan-first") modePatch.planApproved = false;
      else modePatch.planApproved = true;
    }
    updateSession(id, { status: "running", endedAt: null, error: null, summary: null, ...modePatch });
    const channel = getChannel(id);
    if (!channel) { res.status(500).json({ error: "channel missing" }); return; }
    // Reopen the channel for new events
    channel.closed = false;
    // Broadcast the follow-up user message first so every subscribed
    // device (not just the one that typed) sees the input. Before this
    // fix, device A typed, device A rendered the bubble locally, but
    // device B listening on the same session only saw the agent reply,
    // not the user's question that triggered it.
    pushEvent(channel, "user_msg", { content });
    pushEvent(channel, "iteration", { iter: "continue", note: "continuing conversation" });
    void continueSession(id, content, backend, modelProvider, peerBackendRef)
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`continue session ${id} crashed: ${msg}`);
        updateSession(id, { status: "error", error: msg, endedAt: Date.now() });
        pushEvent(channel, "error", { message: msg });
      });
    res.status(202).json({ ok: true });
  });

  // GET /sessions/:id/stream: Server-Sent Events (PWA, curl)
  app.get("/sessions/:id/stream", requireAuth, (req: Request, res: Response) => {
    const ch = getChannel(String(req.params.id));
    if (!ch) { res.status(404).json({ error: "session not found" }); return; }
    const sinceId = Number(req.query.since ?? "0") || 0;
    attachSubscriber(ch, res, sinceId);
  });

  // GET /sessions/:id/snapshot?since=N: long-poll fallback (iOS Shortcut)
  app.get("/sessions/:id/snapshot", requireAuth, (req: Request, res: Response) => {
    const ch = getChannel(String(req.params.id));
    if (!ch) { res.status(404).json({ error: "session not found" }); return; }
    const sinceId = Number(req.query.since ?? "0") || 0;
    const events = snapshotSince(ch, sinceId);
    const session = getSession(String(req.params.id));
    res.json({
      sessionId: String(req.params.id),
      status: session?.status ?? "unknown",
      closed: ch.closed,
      events,
    });
  });

  // POST /sessions/:id/stop: interrupt a running session
  app.post("/sessions/:id/stop", requireAuth, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const ok = abortSession(id);
    if (!ok) { res.status(404).json({ error: "session not running" }); return; }
    res.json({ ok: true });
  });

  // POST /sessions/:id/approvals: client resolves a pending approval
  app.post("/sessions/:id/approvals", requireAuth, (req: Request, res: Response) => {
    const body = req.body as { approvalId?: string; decision?: "approve" | "reject"; reason?: string };
    if (!body.approvalId || !body.decision) { res.status(400).json({ error: "missing approvalId or decision" }); return; }
    const decision = body.decision === "approve"
      ? { ok: true as const }
      : { ok: false as const, reason: body.reason ?? "user rejected" };
    const resolved = resolveApproval(body.approvalId, decision);
    if (!resolved) { res.status(404).json({ error: "approval not found or expired" }); return; }
    const ch = getChannel(String(req.params.id));
    if (ch) pushEvent(ch, "approval_resolved", { approvalId: body.approvalId, decision: body.decision });
    res.json({ ok: true });
  });

  // GET /sessions: list
  app.get("/sessions", requireAuth, (_req, res) => {
    res.json({ sessions: listSessions() });
  });

  // GET /sessions/:id: single session details
  app.get("/sessions/:id", requireAuth, (req: Request, res: Response) => {
    const s = getSession(String(req.params.id));
    if (!s) { res.status(404).json({ error: "session not found" }); return; }
    res.json({ session: s });
  });

  // DELETE /sessions/:id: remove a session from history.
  // If the session is running or awaiting approval, we abort it first so
  // the background loop stops cleanly before we drop its state.
  app.delete("/sessions/:id", requireAuth, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const s = getSession(id);
    if (!s) { res.status(404).json({ error: "session not found" }); return; }
    if (s.status === "running" || s.status === "awaiting_approval") {
      abortSession(id);
    }
    const removed = deleteSession(id);
    deleteChannel(id);
    res.json({ ok: removed });
  });
}

async function runSessionInBackground(
  sessionId: string,
  prompt: string,
  projectRoot: string,
  backend: ModelBackend,
  modelProvider?: ModelProvider,
  peerBackendRef?: PeerBackendRef | null,
): Promise<void> {
  const channel = getChannel(sessionId);
  if (!channel) return;

  // Each session gets its own view of the project root.
  // NOTE: the process-global setProjectRoot means sessions are NOT concurrent-safe
  // for different roots. Day 3 will move path resolution into ToolContext.
  setProjectRoot(projectRoot);

  const controller = new AbortController();
  registerController(sessionId, controller);

  const baseCtx: ToolContext = {
    async requestApproval(req: ApprovalRequest) {
      updateSession(sessionId, { status: "awaiting_approval" });
      const { approvalId, wait } = parkApproval(sessionId, req);
      pushEvent(channel, "approval_request", { approvalId, ...req });
      const decision = await wait;
      updateSession(sessionId, { status: "running" });
      return decision;
    },
  };

  const session = getSession(sessionId);
  const toolCtx = wrapToolContextWithMode(
    baseCtx,
    sessionId,
    () => getSession(sessionId)?.mode ?? "ask",
    () => getSession(sessionId)?.planApproved ?? false,
  );

  const projectMemory = await readProjectMemory(projectRoot);
  const sessForCtx = getSession(sessionId) ?? session;
  const project = getOrCreateProject(projectRoot);
  const features = await getFeatureMap();
  // If the user has flipped to a peer model, the agent is actually
  // running on the peer, not the local model. Surface that in the
  // runtime context so the model self-reports correctly (otherwise it
  // says "I'm Qwen3 1.7B" even when it's Qwen3 8B on Debian).
  const peerActive = peerBackendRef?.forcePeer && peerBackendRef?.status === "connected" && peerBackendRef?.activeModelKey;
  const currentModelName = peerActive
    ? `${peerBackendRef!.activeModelKey} (peer)`
    : modelProvider?.getState().currentModel ?? null;

  // Route the request through the capability router. It picks the right
  // backend (hardcoded greeter / local LLM / delegated peer) and dispatches.
  const router = getRouter();
  const result = await router.route({
    userTask: prompt,
    session: sessForCtx!,
    project,
    projectRoot,
    mode: session?.mode ?? "ask",
    projectMemory,
    features,
    currentModelName,
    signal: controller.signal,
    toolCtx,
    backend,
    // Resolve at request-time, not registration time, so the .then callback
    // on server/index.ts's async peer load flips the real value into place
    // between daemon start and the first request.
    peerBackend: peerBackendRef?.ref ?? null,
    forcePeer: peerBackendRef?.forcePeer ?? false,
    onEvent: (event) => {
      switch (event.type) {
        case "iteration":
        case "token":
        case "assistant_text":
        case "tool_call":
        case "tool_result":
        case "state":
        case "done":
        case "error":
          pushEvent(channel, event.type, event.data);
          break;
      }
    },
  });

  removeController(sessionId);
  // Record the outcome of the CURRENT (last) turn in the turn log.
  // CRITICAL: if the result is replyOnly (chat reply, no real work), we
  // store the turn with EMPTY summary so buildPriorContext skips it on
  // future turns. Without this, a "hi" -> "hello back" reply contaminates
  // every subsequent turn's prompt with "Previously completed: 1. hello back".
  const sessionAfter = getSession(sessionId);
  const turns = sessionAfter?.turns ?? [];
  const persistedSummary = result.replyOnly
    ? ""
    : (result.summary ?? result.error ?? "(incomplete)");
  // Capture the last turn's task from `turns[turns.length - 1]` defensively.
  // Using the original `prompt` as a fallback means if the turns array was
  // mutated concurrently (e.g. client-triggered reset), we still write a
  // sensible record instead of crashing on undefined.task access.
  const lastTurnTask = turns[turns.length - 1]?.task ?? prompt;
  const updatedTurns = turns.length > 0
    ? [...turns.slice(0, -1), { task: lastTurnTask, summary: persistedSummary }]
    : turns;
  updateSession(sessionId, {
    status: result.aborted ? "stopped" : result.ok ? "done" : "error",
    summary: result.summary ?? null,
    error: result.error ?? null,
    endedAt: Date.now(),
    messages: result.messages,
    turns: updatedTurns,
    docsLoaded: true, // boot protocol satisfied once the loop completes
  });
}

async function continueSession(
  sessionId: string,
  followUp: string,
  backend: ModelBackend,
  modelProvider?: ModelProvider,
  peerBackendRef?: PeerBackendRef | null,
): Promise<void> {
  const channel = getChannel(sessionId);
  if (!channel) return;
  const session = getSession(sessionId);
  if (!session) return;

  setProjectRoot(session.projectRoot);

  // Append the new turn (empty summary filled at end of run)
  const existingTurns = session.turns ?? [];
  updateSession(sessionId, { turns: [...existingTurns, { task: followUp, summary: "" }] });

  const controller = new AbortController();
  registerController(sessionId, controller);

  const baseCtx: ToolContext = {
    async requestApproval(req: ApprovalRequest) {
      updateSession(sessionId, { status: "awaiting_approval" });
      const { approvalId, wait } = parkApproval(sessionId, req);
      pushEvent(channel, "approval_request", { approvalId, ...req });
      const decision = await wait;
      updateSession(sessionId, { status: "running" });
      return decision;
    },
  };
  const toolCtx = wrapToolContextWithMode(
    baseCtx,
    sessionId,
    () => getSession(sessionId)?.mode ?? "ask",
    () => getSession(sessionId)?.planApproved ?? false,
  );

  const latestSession = getSession(sessionId) ?? session;
  const priorContext = buildPriorContext(latestSession.turns ?? []);
  const projectMemory = await readProjectMemory(latestSession.projectRoot);
  const project = getOrCreateProject(latestSession.projectRoot);
  const features = await getFeatureMap();
  // If the user has flipped to a peer model, the agent is actually
  // running on the peer, not the local model. Surface that in the
  // runtime context so the model self-reports correctly (otherwise it
  // says "I'm Qwen3 1.7B" even when it's Qwen3 8B on Debian).
  const peerActive = peerBackendRef?.forcePeer && peerBackendRef?.status === "connected" && peerBackendRef?.activeModelKey;
  const currentModelName = peerActive
    ? `${peerBackendRef!.activeModelKey} (peer)`
    : modelProvider?.getState().currentModel ?? null;

  const router = getRouter();
  const result = await router.route({
    userTask: followUp,
    session: latestSession,
    project,
    projectRoot: latestSession.projectRoot,
    mode: latestSession.mode,
    priorContext,
    projectMemory,
    features,
    currentModelName,
    signal: controller.signal,
    toolCtx,
    backend,
    // Resolve at request-time, not registration time, so the .then callback
    // on server/index.ts's async peer load flips the real value into place
    // between daemon start and the first request.
    peerBackend: peerBackendRef?.ref ?? null,
    forcePeer: peerBackendRef?.forcePeer ?? false,
    // Pass accumulated message history so the agent loop has conversational
    // memory across turns. The loop applies sliding-window truncation to
    // stay within Qwen3's 8192 token context.
    existingHistory: latestSession.messages,
    onEvent: (event) => {
      switch (event.type) {
        case "iteration":
        case "token":
        case "assistant_text":
        case "tool_call":
        case "tool_result":
        case "state":
        case "done":
        case "error":
          pushEvent(channel, event.type, event.data);
          break;
      }
    },
  });

  removeController(sessionId);
  // Same replyOnly gate as runSessionInBackground: don't let a chat reply
  // pollute priorContext for the NEXT follow-up turn.
  const sessionAfter = getSession(sessionId);
  const turns = sessionAfter?.turns ?? [];
  const persistedSummary = result.replyOnly
    ? ""
    : (result.summary ?? result.error ?? "(incomplete)");
  // Capture defensively; fallback to the followUp text if the turn record
  // is missing (shouldn't happen but prevents a crash on undefined access).
  const lastTurnTask = turns[turns.length - 1]?.task ?? followUp;
  const updatedTurns = turns.length > 0
    ? [...turns.slice(0, -1), { task: lastTurnTask, summary: persistedSummary }]
    : turns;
  updateSession(sessionId, {
    status: result.aborted ? "stopped" : result.ok ? "done" : "error",
    summary: result.summary ?? null,
    error: result.error ?? null,
    endedAt: Date.now(),
    messages: result.messages,
    turns: updatedTurns,
  });
}
