// Capability router: decides which backend handles a user request.
//
// Not an intent classifier (chat vs code). The real axis is CAPABILITY:
//   Tier 1: LocalLLMBackend, @qvac/sdk on this machine (daily driver)
//   Tier 2: DelegatedPeerBackend, @qvac/sdk P2P to a peer (heavy tasks)
//
// Each backend self-declares via canHandle(). The router tries them in
// priority order (lower first) and dispatches to the first match. Adding
// new backends (cloud, another peer, bigger local model) is a matter of
// implementing AgentBackend and calling router.register().

import type { ModelBackend } from "./models.js";
import type { ToolContext, ApprovalRequest, ApprovalDecision } from "../tools/index.js";
import type { PermissionMode, Session, Project } from "../server/sessions.js";
import type { FeatureId } from "../server/features.js";
import type { LoopEvent, LoopResult } from "./loop.js";

export interface RouterRequest {
  userTask: string;
  session: Session;
  project: Project;
  projectRoot: string;
  mode: PermissionMode;
  priorContext?: string;
  projectMemory?: string | null;
  features: Record<FeatureId, boolean>;
  currentModelName: string | null;
  signal?: AbortSignal;
  onEvent?: (e: LoopEvent) => void;
  toolCtx: ToolContext;
  // Primary backend (local @qvac/sdk, e.g. Qwen3 1.7B on the Mac).
  backend: ModelBackend;
  // Optional peer backend for delegated inference (loaded with
  // delegate: { topic, providerPublicKey } against a running
  // peer-provider.mjs instance on another machine, e.g. the Debian
  // mini PC running Qwen3 4B). When set AND the task is "heavy",
  // DelegatedPeerBackend routes the completion to this peer.
  peerBackend?: ModelBackend | null;
  /** User opt-in from the model picker: when true, DelegatedPeerBackend
   *  handles every request regardless of looksHeavy(). Set via
   *  POST /models/switch with a peer model id. */
  forcePeer?: boolean;
  /** Accumulated message history from previous turns. Passed through to
   *  the agent loop so it can maintain conversational memory across turns. */
  existingHistory?: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
}

export interface RouterResult extends LoopResult {
  backendId: string;
  backendLabel: string;
}

export interface AgentBackend {
  id: string;
  displayName: string;
  priority: number; // lower = tried first
  canHandle(request: RouterRequest): Promise<boolean>;
  run(request: RouterRequest): Promise<Omit<RouterResult, "backendId" | "backendLabel">>;
}

export class Router {
  private backends: AgentBackend[] = [];

  register(backend: AgentBackend): void {
    this.backends.push(backend);
    this.backends.sort((a, b) => a.priority - b.priority);
  }

  async route(request: RouterRequest): Promise<RouterResult> {
    for (const backend of this.backends) {
      try {
        if (await backend.canHandle(request)) {
          // Only surface a "routing via …" hint when the chosen backend
          // is the non-default one (peer). For the default local backend
          // there is no routing decision worth showing, so we stay on
          // the generic "thinking…" label until the first real event.
          if (backend.id !== "local-llm") {
            request.onEvent?.({ type: "state", data: { state: "thinking", hint: `routing via ${backend.displayName}` } });
          }
          const result = await backend.run(request);
          return { ...result, backendId: backend.id, backendLabel: backend.displayName };
        }
      } catch (e) {
        // canHandle or run threw, log and try the next backend
        const msg = e instanceof Error ? e.message : String(e);
        request.onEvent?.({ type: "error", data: { message: `backend ${backend.id} failed: ${msg}` } });
      }
    }
    // No backend handled it. Should never happen since LocalLLMBackend
    // always returns true from canHandle. But just in case:
    throw new Error("no backend could handle the request");
  }

  list(): Array<{ id: string; displayName: string; priority: number }> {
    return this.backends.map(b => ({ id: b.id, displayName: b.displayName, priority: b.priority }));
  }
}

// Shared base ToolContext helper. Backends that want to surface approvals
// through the normal flow use this. Backends that don't need tools (like the
// hardcoded greeter) ignore it.
export function makeNoopToolContext(): ToolContext {
  return {
    async requestApproval(_req: ApprovalRequest): Promise<ApprovalDecision> {
      return { ok: false, reason: "no tools in this backend" };
    },
  };
}
