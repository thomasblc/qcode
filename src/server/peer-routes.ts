// HTTP endpoints for configuring + probing the delegated peer.
//
// Scope: connection only. Model selection + loading is handled by the
// main model picker (see models-routes.ts, POST /models/switch).
//
//  - GET  /features/delegated/config
//      Returns the saved config + handshake status + currently-loaded
//      peer model (if any).
//
//  - POST /features/delegated/config
//      Body: { enabled, topic, providerPublicKey, location? }.
//      Persists and triggers a handshake probe (loadModel + unload on
//      the smallest registry constant, just to verify the peer is
//      reachable). Status becomes "connecting" immediately, flips to
//      "connected" or "error" asynchronously.
//
//  - POST /features/delegated/disconnect
//      Tear down any loaded peer model, reset status to idle, save
//      enabled=false.

import type { Express, Request, Response } from "express";
import { requireAuth } from "./auth.js";
import {
  loadPeerConfig,
  savePeerConfig,
  probePeer,
  unloadPeerBackend,
  defaultConfig,
  type PeerConfig,
  type PeerBackendRef,
} from "./peer-config.js";
import { log } from "../utils/logger.js";

function validateConfig(raw: unknown): { ok: true; config: PeerConfig } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "body must be a PeerConfig object" };
  const body = raw as Record<string, unknown>;
  const topic = String(body.topic ?? "").trim();
  const providerPublicKey = String(body.providerPublicKey ?? "").trim();
  const enabled = body.enabled === true;
  if (enabled) {
    if (!/^[0-9a-f]{64}$/i.test(topic)) {
      return { ok: false, reason: "topic must be 64 hex characters" };
    }
    if (!/^[0-9a-f]{64}$/i.test(providerPublicKey)) {
      return { ok: false, reason: "providerPublicKey must be 64 hex characters" };
    }
  }
  const config: PeerConfig = {
    enabled,
    topic,
    providerPublicKey,
    location: String(body.location ?? "Remote peer").slice(0, 80),
    cachedPeerModels: [],
  };
  return { ok: true, config };
}

export function registerPeerRoutes(
  app: Express,
  peerBackendRef: PeerBackendRef,
  ctx: number,
): void {
  app.get("/features/delegated/config", requireAuth, async (_req: Request, res: Response) => {
    const config = await loadPeerConfig();
    res.json({
      config,
      status: peerBackendRef.status,
      error: peerBackendRef.error,
      connectedAt: peerBackendRef.connectedAt,
      forcePeer: peerBackendRef.forcePeer,
      activeModelKey: peerBackendRef.activeModelKey,
      activeModelPath: peerBackendRef.activeModelPath,
      loadStatus: peerBackendRef.loadStatus,
      loadError: peerBackendRef.loadError,
    });
  });

  app.post("/features/delegated/config", requireAuth, async (req: Request, res: Response) => {
    const result = validateConfig(req.body);
    if (!result.ok) { res.status(400).json({ error: result.reason }); return; }
    const config = result.config;
    try { await savePeerConfig(config); }
    catch (e) {
      res.status(500).json({ error: `failed to persist config: ${e instanceof Error ? e.message : e}` });
      return;
    }
    // Drop any previous state cleanly before probing.
    try { await unloadPeerBackend(peerBackendRef); }
    catch (e) { log.warn(`peer-routes: teardown warning: ${e instanceof Error ? e.message : e}`); }
    if (config.enabled) {
      probePeer(config, peerBackendRef, ctx);
    }
    res.json({
      ok: true,
      config,
      status: peerBackendRef.status,
      error: peerBackendRef.error,
    });
  });

  app.post("/features/delegated/disconnect", requireAuth, async (_req: Request, res: Response) => {
    try { await unloadPeerBackend(peerBackendRef); }
    catch { /* noop */ }
    const current = await loadPeerConfig();
    const next: PeerConfig = { ...defaultConfig(), ...current, enabled: false };
    try { await savePeerConfig(next); }
    catch (e) {
      res.status(500).json({ error: `failed to persist: ${e instanceof Error ? e.message : e}` });
      return;
    }
    res.json({ ok: true, config: next, status: peerBackendRef.status });
  });
}
