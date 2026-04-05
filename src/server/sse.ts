import type { Response } from "express";
import { markDirty } from "../state/persistence.js";

// A single event pushed through a session's stream. Shape is broadcast to both
// SSE consumers (PWA, curl) and long-pollers (iOS Shortcut via /snapshot).
export interface SessionEvent {
  id: number;
  type:
    | "iteration"
    | "token"
    | "assistant_text"
    | "tool_call"
    | "tool_result"
    | "approval_request"
    | "approval_resolved"
    | "state"
    | "user_msg"
    | "done"
    | "error";
  data: unknown;
  at: number;
}

export interface SessionChannel {
  sessionId: string;
  events: SessionEvent[];
  subscribers: Set<Response>;
  closed: boolean;
  nextEventId: number;
}

const channels = new Map<string, SessionChannel>();

export function createChannel(sessionId: string): SessionChannel {
  const ch: SessionChannel = {
    sessionId,
    events: [],
    subscribers: new Set(),
    closed: false,
    nextEventId: 1,
  };
  channels.set(sessionId, ch);
  return ch;
}

export function getChannel(sessionId: string): SessionChannel | undefined {
  return channels.get(sessionId);
}

export function pushEvent(
  ch: SessionChannel,
  type: SessionEvent["type"],
  data: unknown,
): SessionEvent {
  const evt: SessionEvent = { id: ch.nextEventId++, type, data, at: Date.now() };
  ch.events.push(evt);
  // trim history so a long chat session doesn't eat RAM
  if (ch.events.length > 2000) ch.events.splice(0, ch.events.length - 2000);
  const payload = `id: ${evt.id}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const sub of ch.subscribers) {
    try { sub.write(payload); } catch { /* dead subscriber */ }
  }
  if (type === "done" || type === "error") {
    ch.closed = true;
    for (const sub of ch.subscribers) { try { sub.end(); } catch { /* noop */ } }
    ch.subscribers.clear();
  }
  // Persist only the "shape" events to keep the JSON file small; skip per-token noise.
  if (type !== "token") markDirty();
  return evt;
}

export function restoreChannels(loaded: Record<string, SessionEvent[]>): void {
  for (const [sessionId, events] of Object.entries(loaded)) {
    const ch: SessionChannel = {
      sessionId,
      events: events.slice(),
      subscribers: new Set(),
      closed: true,
      nextEventId: events.length > 0 ? events[events.length - 1].id + 1 : 1,
    };
    channels.set(sessionId, ch);
  }
}

export function snapshotChannels(): Record<string, SessionEvent[]> {
  const out: Record<string, SessionEvent[]> = {};
  for (const [id, ch] of channels) {
    // Drop per-token events from the on-disk copy to keep the file small.
    out[id] = ch.events.filter(e => e.type !== "token").slice(-500);
  }
  return out;
}

export function attachSubscriber(ch: SessionChannel, res: Response, sinceId = 0): void {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders?.();
  // Replay any events the client missed
  for (const evt of ch.events) {
    if (evt.id <= sinceId) continue;
    res.write(`id: ${evt.id}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
  }
  if (ch.closed) {
    res.end();
    return;
  }
  ch.subscribers.add(res);
  res.on("close", () => ch.subscribers.delete(res));
}

export function snapshotSince(ch: SessionChannel, sinceId: number): SessionEvent[] {
  return ch.events.filter(e => e.id > sinceId);
}

// Remove a channel from the in-memory map. Called from routes.ts when a
// session is explicitly deleted or when the daemon shuts down. Does not
// touch disk. The channels map otherwise grows unbounded over long-running
// daemon lifetimes because no caller ever unregisters.
export function deleteChannel(sessionId: string): void {
  channels.delete(sessionId);
}

// Hint for future callers: consider calling deleteChannel() when the session
// transitions to a terminal state AND no subscriber has reattached for N
// minutes. We don't auto-GC on every done event because the PWA reconnects
// via /stream?since=N on continue, which needs the channel to still exist.
