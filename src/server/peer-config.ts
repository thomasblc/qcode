// Peer configuration + runtime operations for the delegated-inference
// backend. Persists the topic, provider public key, and location label
// to .qcode-state/peer-config.json. Model selection is NOT persisted
// here — that happens at runtime via the main model picker (see
// /models/switch in models-routes.ts), so the config modal is purely
// about "is the P2P channel up?".
//
// Exports:
//  - loadPeerConfig()      read the file
//  - savePeerConfig()      atomic write
//  - probePeer()           verify peer reachability by doing a tiny
//                          loadModel + unloadModel cycle (smallest
//                          registry model). Sets ref.status.
//  - switchPeerModel()     actually load a model on the peer and keep
//                          it loaded in ref.ref for completions. Called
//                          by POST /models/switch with a peer model id.
//                          Aborts any stale in-flight load.
//  - unloadPeerBackend()   clean teardown

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  QWEN3_1_7B_INST_Q4,
  QWEN3_4B_INST_Q4_K_M,
  QWEN3_8B_INST_Q4_K_M,
  loadModel,
  unloadModel,
} from "@qvac/sdk";
import { QvacSdkBackend } from "../agent/models.js";
import { log } from "../utils/logger.js";

// Peer model keys. Registry constants + "path" for an absolute file
// path on the peer (custom GGUF).
export type PeerModelKey = "qwen3-1.7b" | "qwen3-4b" | "qwen3-8b" | "path";

export interface PeerConfig {
  enabled: boolean;
  topic: string;
  providerPublicKey: string;
  /** Human label shown in the model picker (e.g. "home server"). */
  location: string;
  /** Peer model keys we know are cached on the peer (i.e. already
   *  downloaded into ~/.qvac/models/). Populated opportunistically:
   *  probePeer adds "qwen3-1.7b" on success (probe uses that model),
   *  switchPeerModel adds the target key on success. Persisted across
   *  restarts so the UI can distinguish "ready on peer" from "will
   *  download on first switch". */
  cachedPeerModels: PeerModelKey[];
}

export type PeerStatus = "idle" | "connecting" | "connected" | "error";
export type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface PeerBackendRef {
  /** Currently-loaded peer backend. null until switchPeerModel succeeds. */
  ref: QvacSdkBackend | null;
  /** Handshake reachability status. Flipped by probePeer(). */
  status: PeerStatus;
  error: string | null;
  connectedAt: number | null;
  /** When true, the router forces every completion through the peer. */
  forcePeer: boolean;
  /** Which peer model is currently loaded (or loading). */
  activeModelKey: PeerModelKey | null;
  activeModelPath: string | null;
  /** Load status of the active peer model (separate from the handshake status). */
  loadStatus: LoadStatus;
  loadError: string | null;
  /** Monotonic id to abandon stale in-flight loads. */
  loadAttemptId: number;
}

export function newPeerBackendRef(): PeerBackendRef {
  return {
    ref: null, status: "idle", error: null, connectedAt: null,
    forcePeer: false,
    activeModelKey: null, activeModelPath: null,
    loadStatus: "idle", loadError: null, loadAttemptId: 0,
  };
}

const STATE_PATH = path.join(process.cwd(), ".qcode-state", "peer-config.json");

export function defaultConfig(): PeerConfig {
  return {
    enabled: false,
    topic: "",
    providerPublicKey: "",
    location: "Remote peer",
    cachedPeerModels: [],
  };
}

/** Add a peer model key to the cached list if not already there, and
 *  persist. Silent on error. */
async function markCached(key: PeerModelKey): Promise<void> {
  try {
    const cfg = await loadPeerConfig();
    if (cfg.cachedPeerModels.includes(key)) return;
    cfg.cachedPeerModels = [...cfg.cachedPeerModels, key];
    await savePeerConfig(cfg);
  } catch (e) {
    log.warn(`peer: failed to persist cached list: ${e instanceof Error ? e.message : e}`);
  }
}

export async function loadPeerConfig(): Promise<PeerConfig> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PeerConfig>;
    return { ...defaultConfig(), ...parsed };
  } catch {
    return defaultConfig();
  }
}

export async function savePeerConfig(config: PeerConfig): Promise<void> {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(config, null, 2), "utf-8");
}

function resolveModelSrc(modelKey: PeerModelKey, modelPath?: string): unknown {
  if (modelKey === "path") {
    if (!modelPath) throw new Error("modelPath required when modelKey='path'");
    return modelPath;
  }
  if (modelKey === "qwen3-1.7b") return QWEN3_1_7B_INST_Q4;
  if (modelKey === "qwen3-4b")   return QWEN3_4B_INST_Q4_K_M;
  return QWEN3_8B_INST_Q4_K_M;
}

/** Env var fallback: returns config from env if set, null otherwise. */
export function configFromEnv(): PeerConfig | null {
  if (process.env.QCODE_PEER_ENABLED !== "1") return null;
  const topic = process.env.QCODE_PEER_TOPIC ?? "";
  const pubkey = process.env.QCODE_PEER_PUBKEY ?? "";
  if (!topic || !pubkey) return null;
  return {
    enabled: true,
    topic,
    providerPublicKey: pubkey,
    location: process.env.QCODE_PEER_LOCATION ?? "Remote peer",
    cachedPeerModels: [],
  };
}

/**
 * Handshake probe: does a minimal loadModel + unloadModel cycle against
 * the peer to verify reachability. Uses the smallest registry constant
 * (Qwen3 1.7B). If the peer has it cached, probe is ~5s. If not, the
 * SDK will download it (~1 GB) which is unavoidable but sets up a
 * useful baseline for subsequent work.
 *
 * Does NOT store the backend in ref.ref — the model is unloaded after
 * the probe. Use switchPeerModel() to actually keep a model loaded.
 *
 * Fire-and-forget: ref.status transitions idle → connecting → connected
 * | error asynchronously.
 */
export function probePeer(
  config: PeerConfig,
  ref: PeerBackendRef,
  ctx: number,
  timeoutMs: number = 2 * 60 * 1000,
): void {
  if (!config.topic || !config.providerPublicKey) {
    ref.status = "error";
    ref.error = "topic and providerPublicKey are required";
    return;
  }
  ref.status = "connecting";
  ref.error = null;
  log.info(`peer-probe: handshake via ${config.providerPublicKey.slice(0, 12)}... on ${config.topic.slice(0, 16)}...`);
  void (async () => {
    let modelId: string | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const loadOpts: any = {
        modelSrc: QWEN3_1_7B_INST_Q4,
        modelType: "llm",
        modelConfig: { ctx_size: Math.min(ctx, 2048), tools: true },
        delegate: {
          topic: config.topic,
          providerPublicKey: config.providerPublicKey,
          fallbackToLocal: false,
          timeout: timeoutMs,
        },
      };
      modelId = await loadModel(loadOpts);
      ref.status = "connected";
      ref.error = null;
      ref.connectedAt = Date.now();
      log.ok(`peer-probe: handshake OK, peer reachable at ${config.location}`);
      // Probe uses qwen3-1.7b; if it succeeded, that model is cached on
      // the peer (or was just downloaded). Persist so UI can flag it
      // as ready on next open.
      void markCached("qwen3-1.7b");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ref.status = "error";
      ref.error = msg;
      ref.connectedAt = null;
      log.warn(`peer-probe: failed: ${msg}`);
    } finally {
      if (modelId) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await unloadModel({ modelId, clearStorage: false } as any);
        } catch { /* ignore */ }
      }
    }
  })();
}

/**
 * Load a specific model on the peer and keep the backend in ref.ref
 * so the router / DelegatedPeerBackend can call complete() on it.
 *
 * Aborts any stale in-flight load: concurrent calls get unique
 * attemptIds; when a new one supersedes an old one, the old promise's
 * result is ignored (it may still complete on the peer but we'll unload
 * it opportunistically).
 *
 * Sets ref.ref to the new backend on success. Previous ref.ref is
 * unloaded before the new one is installed.
 */
export async function switchPeerModel(
  config: PeerConfig,
  modelKey: PeerModelKey,
  modelPath: string | undefined,
  ref: PeerBackendRef,
  ctx: number,
  timeoutMs: number = 2 * 60 * 60 * 1000,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (ref.status !== "connected") {
    return { ok: false, error: `peer not connected (status=${ref.status})` };
  }
  let modelSrc: unknown;
  try { modelSrc = resolveModelSrc(modelKey, modelPath); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ref.loadStatus = "error";
    ref.loadError = msg;
    return { ok: false, error: msg };
  }

  // Tear down any previously-loaded peer model before we start a new
  // one. Do this BEFORE bumping attemptId so ongoing unload doesn't
  // collide with the new load.
  const prev = ref.ref;
  ref.ref = null;
  if (prev) {
    try { await prev.unload(); }
    catch (e) {
      log.warn(`peer-switch: previous unload errored (ignored): ${e instanceof Error ? e.message : e}`);
    }
  }

  const attemptId = ref.loadAttemptId + 1;
  ref.loadAttemptId = attemptId;
  ref.activeModelKey = modelKey;
  ref.activeModelPath = modelPath ?? null;
  ref.loadStatus = "loading";
  ref.loadError = null;

  const label = modelKey === "path" ? (modelPath ?? "unknown") : modelKey;
  log.info(`peer-switch: loading ${label} on peer`);

  const peer = new QvacSdkBackend();
  const isCurrent = () => ref.loadAttemptId === attemptId;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await peer.load(modelSrc as any, ctx, undefined, {
      topic: config.topic,
      providerPublicKey: config.providerPublicKey,
      fallbackToLocal: false,
      timeout: timeoutMs,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    if (!isCurrent()) {
      // A newer switch came in. Silently unload this stale load.
      try { await peer.unload(); } catch { /* ignore */ }
      log.info(`peer-switch: stale attempt for ${label} completed (unloaded)`);
      return { ok: false, error: "superseded by a newer switch request" };
    }
    ref.ref = peer;
    ref.loadStatus = "ready";
    ref.loadError = null;
    ref.forcePeer = true;
    log.ok(`peer-switch: ${label} ready on peer, forcePeer=true`);
    // Model successfully loaded via delegate = cached on peer. Track
    // so next time UI shows it as ready instead of "will download".
    if (modelKey !== "path") void markCached(modelKey);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isCurrent()) {
      ref.loadStatus = "error";
      ref.loadError = msg;
      log.warn(`peer-switch: failed for ${label}: ${msg}`);
    }
    return { ok: false, error: msg };
  }
}

/**
 * Tear down the currently-loaded peer backend. Safe to call when no
 * peer is loaded. Resets status + forcePeer so the router stops
 * delegating to a gone backend.
 */
export async function unloadPeerBackend(ref: PeerBackendRef): Promise<void> {
  const current = ref.ref;
  ref.ref = null;
  ref.status = "idle";
  ref.error = null;
  ref.connectedAt = null;
  ref.forcePeer = false;
  ref.activeModelKey = null;
  ref.activeModelPath = null;
  ref.loadStatus = "idle";
  ref.loadError = null;
  ref.loadAttemptId++;
  if (!current) return;
  try { await current.unload(); }
  catch (e) {
    log.warn(`peer: unload errored (ignored): ${e instanceof Error ? e.message : e}`);
  }
}
