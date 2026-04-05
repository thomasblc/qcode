// AbortController registry: one per running session, used by /stop endpoint.
const controllers = new Map<string, AbortController>();

export function registerController(sessionId: string, controller: AbortController): void {
  controllers.set(sessionId, controller);
}

export function getController(sessionId: string): AbortController | undefined {
  return controllers.get(sessionId);
}

export function removeController(sessionId: string): void {
  controllers.delete(sessionId);
}

export function abortSession(sessionId: string): boolean {
  const c = controllers.get(sessionId);
  if (!c) return false;
  c.abort();
  controllers.delete(sessionId);
  return true;
}
