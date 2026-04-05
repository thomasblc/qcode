// Tier 2: delegate to a stronger peer over @qvac/sdk P2P (Hyperswarm).
//
// Activated when BOTH:
//   1. request.peerBackend is set (server/index.ts loaded a QvacSdkBackend
//      with delegate: { topic, providerPublicKey } pointing at a running
//      peer-provider.mjs on another machine).
//   2. The task looks "heavy": long prompt OR matches a heavy keyword.
//
// When canHandle returns true, run() executes the full runAgentLoop against
// the peer backend. Tool calls are evaluated on the Mac side (real filesystem
// and shell access), but the LLM completion is served by the peer (Qwen3 4B
// on the Debian mini PC in our setup). This gives qcode a "bigger brain on
// another machine" story without giving up the Mac's filesystem access.

import type { AgentBackend, RouterRequest, RouterResult } from "../router.js";
import { runAgentLoop } from "../loop.js";
import { buildRuntimeContext } from "../runtime-context.js";

// Heuristics for "heavy task" detection. Deliberately conservative: we'd
// rather run on the local model than ping a peer for nothing.
const HEAVY_KEYWORDS = [
  "refactor", "rewrite", "redesign", "migrate", "restructure",
  "explain the entire", "explain this whole", "audit the", "review the whole",
  "generate tests for", "write tests for all",
  // Explicit user opt-in
  "@peer", "delegate this", "use peer", "run on peer", "use the bigger model",
];
const LONG_PROMPT_THRESHOLD = 300; // chars

function looksHeavy(task: string): boolean {
  if (task.length > LONG_PROMPT_THRESHOLD) return true;
  const lower = task.toLowerCase();
  return HEAVY_KEYWORDS.some(kw => lower.includes(kw));
}

export class DelegatedPeerBackend implements AgentBackend {
  id = "delegated-peer";
  displayName = "peer";
  priority = 5; // tier 2, tried BEFORE local-llm when canHandle matches

  async canHandle(request: RouterRequest): Promise<boolean> {
    // Peer backend must be wired at startup AND delegated feature enabled.
    if (!request.peerBackend) return false;
    if (!request.features.delegated) return false;
    // Manual override from the model picker: user flipped to peer, so
    // send every task there regardless of heuristics.
    if (request.forcePeer) return true;
    return looksHeavy(request.userTask);
  }

  async run(request: RouterRequest): Promise<Omit<RouterResult, "backendId" | "backendLabel">> {
    if (!request.peerBackend) {
      // canHandle should have filtered this out, but belt + suspenders.
      return {
        ok: false,
        error: "delegated peer backend not configured",
        iterations: 0,
        messages: [],
      };
    }

    request.onEvent?.({ type: "state", data: { state: "thinking", hint: "routing to peer" } });

    const runtimeContext = buildRuntimeContext({
      project: request.project,
      session: request.session,
      turnIndex: (request.session.turns?.length ?? 1) - 1,
      currentModelName: request.currentModelName,
      features: request.features,
    });

    // Run the full agent loop, but pass the peer backend as the model.
    // Tool execution still happens on the Mac (filesystem, shell, etc.)
    // via toolCtx. Only the LLM completions are remote.
    return runAgentLoop(request.userTask, request.peerBackend, request.toolCtx, {
      runtimeContext,
      mode: request.mode,
      projectMemory: request.projectMemory,
      priorContext: request.priorContext,
      existingHistory: request.existingHistory,
      signal: request.signal,
      onEvent: request.onEvent,
    });
  }
}
