// Tier 1: default backend. Handles ALL requests via the local model loaded
// by @qvac/sdk. Everything flows through a SINGLE path: runAgentLoop with
// the full tool catalog. The model itself decides when to call reply()
// (conversation) vs read_file / write_file / bash / etc (real work).
//
// There is NO chat fast-path. There is NO few-shot. There is NO
// looksLikeChat heuristic. Those were all band-aids on v1 that created
// a "Hi back" contamination bug where greetings from earlier turns
// bled into later work. One loop, one set of rules, one persistence
// model. Turns
// that end with a reply() (or auto-done without real work) are marked
// replyOnly by the loop and skipped in buildPriorContext so they never
// pollute future turns.

import type { AgentBackend, RouterRequest, RouterResult } from "../router.js";
import { runAgentLoop } from "../loop.js";
import { buildRuntimeContext } from "../runtime-context.js";

export class LocalLLMBackend implements AgentBackend {
  id = "local-llm";
  displayName = "local";
  priority = 10; // tier 1, fallback

  async canHandle(_request: RouterRequest): Promise<boolean> {
    return true;
  }

  async run(request: RouterRequest): Promise<Omit<RouterResult, "backendId" | "backendLabel">> {
    const runtimeContext = buildRuntimeContext({
      project: request.project,
      session: request.session,
      turnIndex: (request.session.turns?.length ?? 1) - 1,
      currentModelName: request.currentModelName,
      features: request.features,
    });

    return runAgentLoop(request.userTask, request.backend, request.toolCtx, {
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
