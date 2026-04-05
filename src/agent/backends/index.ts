import { Router } from "../router.js";
import { LocalLLMBackend } from "./local-llm.js";
import { DelegatedPeerBackend } from "./delegated-peer.js";

// Build and return the default router with all shipped backends registered.
// Add new backends here as they land.
//
// NOTE: HardcodedGreeterBackend was removed. It was returning identical
// canned responses for "hello", "how are you", "what's up", which made
// qcode feel like a stupid bot. We now route everything through the local
// LLM, which handles both chat and tasks via a chat-vs-task heuristic
// inside LocalLLMBackend.
export function createDefaultRouter(): Router {
  const router = new Router();
  router.register(new DelegatedPeerBackend());
  router.register(new LocalLLMBackend());
  return router;
}
