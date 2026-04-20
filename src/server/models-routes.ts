import type { Express, Request, Response } from "express";
import os from "node:os";
import { requireAuth } from "./auth.js";
import type { ModelProvider } from "./model-provider.js";
import {
  loadPeerConfig,
  switchPeerModel,
  type PeerBackendRef,
  type PeerModelKey,
} from "./peer-config.js";

// True when the host has at least one non-loopback, non-link-local IPv4
// interface. If false (e.g. WiFi toggled off and no ethernet), the peer
// is unreachable regardless of what peerBackendRef.status says —
// Hyperswarm doesn't flip status back to "disconnected" on its own.
function hasExternalNetwork(): boolean {
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family !== "IPv4") continue;
      if (a.internal) continue;
      if (a.address.startsWith("169.254.")) continue;
      return true;
    }
  }
  return false;
}

// Peer model catalog: the set of models the UI can offer for a
// connected peer. The peer may or may not have them cached — switching
// to one that isn't cached triggers a registry download on the peer
// automatically (first-time slow, thereafter fast).
interface PeerModelOption {
  key: PeerModelKey;
  modelName: string;
  approxSizeGB: number;
}
const PEER_MODEL_OPTIONS: PeerModelOption[] = [
  { key: "qwen3-1.7b", modelName: "Qwen3 1.7B", approxSizeGB: 1.0 },
  { key: "qwen3-4b",   modelName: "Qwen3 4B",   approxSizeGB: 2.3 },
  { key: "qwen3-8b",   modelName: "Qwen3 8B",   approxSizeGB: 4.8 },
];

// Stable peer-model id used in /models/switch requests and rendered
// in the UI. We prefix with "peer:" so it can't collide with a local
// model filename.
function peerModelId(key: PeerModelKey): string {
  return `peer:${key}`;
}

export function registerModelRoutes(
  app: Express,
  provider: ModelProvider,
  peerBackendRef?: PeerBackendRef | null,
): void {
  // GET /models: list available local models + peer model options (if
  // the peer's handshake has succeeded).
  app.get("/models", requireAuth, async (_req: Request, res: Response) => {
    const models = await provider.listAvailableModels();
    const state = provider.getState();
    const config = await loadPeerConfig();

    const rawPeerStatus = peerBackendRef?.status ?? "idle";
    const networkUp = hasExternalNetwork();
    const peerStatus = networkUp ? rawPeerStatus : "disconnected";
    const peerConnected = networkUp && rawPeerStatus === "connected";
    const activePeerKey = peerBackendRef?.activeModelKey ?? null;
    const forcePeer = peerBackendRef?.forcePeer === true;
    const loadStatus = peerBackendRef?.loadStatus ?? "idle";

    const cached = new Set(config.cachedPeerModels ?? []);
    const peers = (config.enabled && peerConnected)
      ? PEER_MODEL_OPTIONS.map(opt => {
          const isActive = forcePeer && activePeerKey === opt.key;
          const isLoading = loadStatus === "loading" && activePeerKey === opt.key;
          return {
            id: peerModelId(opt.key),
            modelName: opt.modelName,
            location: config.location || "Remote peer",
            approxSizeGB: opt.approxSizeGB,
            transport: "hyperswarm-p2p",
            status: peerConnected ? "connected" : "not_connected",
            active: isActive,
            loading: isLoading,
            cached: cached.has(opt.key),
          };
        })
      : [];

    res.json({
      models: models.map(m => ({
        name: m.name,
        displayName: m.displayName,
        sizeBytes: m.sizeBytes,
        sizeGB: Math.round((m.sizeBytes / 1e9) * 10) / 10,
        active: m.active && !forcePeer, // local is "active" only if peer isn't force-routed
        location: "local",
      })),
      peers,
      peerConnected,
      peerStatus,
      state,
    });
  });

  // POST /models/switch: swap the active model. Accepts:
  //   - a local model filename ("qwen3-1.7b-instruct-q4_0.gguf")  →  provider.switchModel, forcePeer=false
  //   - a peer model id ("peer:qwen3-8b")                          →  switchPeerModel, forcePeer=true
  app.post("/models/switch", requireAuth, async (req: Request, res: Response) => {
    const body = req.body as { model?: string; modelPath?: string };
    const model = String(body.model ?? "").trim();
    if (!model) { res.status(400).json({ error: "missing model name" }); return; }

    // Peer-model branch: id shaped "peer:<key>".
    if (model.startsWith("peer:")) {
      if (!peerBackendRef) {
        res.status(400).json({ error: "peer not wired in this daemon" }); return;
      }
      if (peerBackendRef.status !== "connected") {
        res.status(400).json({ error: `peer not connected (status=${peerBackendRef.status}), connect first from Settings` });
        return;
      }
      const keyStr = model.slice("peer:".length);
      const allowed: PeerModelKey[] = ["qwen3-1.7b", "qwen3-4b", "qwen3-8b", "path"];
      if (!(allowed as string[]).includes(keyStr)) {
        res.status(400).json({ error: `unknown peer model '${keyStr}'` }); return;
      }
      const modelKey = keyStr as PeerModelKey;
      const modelPath = typeof body.modelPath === "string" ? body.modelPath : undefined;
      if (modelKey === "path" && !modelPath) {
        res.status(400).json({ error: "modelPath required for peer:path" }); return;
      }
      const config = await loadPeerConfig();
      // Respond 202 immediately: the peer load can take seconds to
      // minutes (first-time download). UI polls /models to see the
      // loadStatus flip from "loading" to "ready".
      res.status(202).json({ ok: true, target: model, active: "peer", message: "loading on peer" });
      void switchPeerModel(config, modelKey, modelPath, peerBackendRef, 8192)
        .catch(() => { /* state captured in ref */ });
      return;
    }

    // Local branch: fall through to provider.switchModel.
    const available = await provider.listAvailableModels();
    if (!available.some(m => m.name === model)) {
      res.status(404).json({ error: "model not found" }); return;
    }
    if (peerBackendRef) peerBackendRef.forcePeer = false;
    res.status(202).json({ ok: true, message: "switching", target: model, active: "local" });
    void provider.switchModel(model).catch(() => { /* state already updated */ });
  });

  // SSE state stream for live UI
  app.get("/models/state-stream", requireAuth, (req: Request, res: Response) => {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders?.();
    const send = (s: unknown) => res.write(`data: ${JSON.stringify(s)}\n\n`);
    send(provider.getState());
    const unsub = provider.onStateChange(s => send(s));
    req.on("close", unsub);
  });
}
