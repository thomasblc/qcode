// Opt-in feature system.
// Features are optional capabilities (voice, vision, delegated inference, ...)
// that the user enables explicitly. Enabling triggers any required model
// downloads via the SDK and persists the state to disk so it sticks across
// restarts.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { requireAuth } from "./auth.js";
import { log } from "../utils/logger.js";

export type FeatureId =
  | "voice"         // whisper speech-to-text
  | "vision"        // multimodal image understanding
  | "delegated";    // P2P delegated inference to a peer

export type FeatureStatus = "off" | "installing" | "ready" | "error";

export interface FeatureDef {
  id: FeatureId;
  name: string;
  description: string;
  icon: string;
  models: Array<{
    id: string;                 // SDK constant name, e.g. "WHISPER_BASE_Q8_0"
    displayName: string;
    sizeBytes: number;
  }>;
  requiresBinary?: string[];    // e.g. ["ffmpeg"] for voice
}

export interface FeatureState {
  id: FeatureId;
  status: FeatureStatus;
  enabled: boolean;
  error: string | null;
  downloadProgress: number | null; // 0..1
}

export const FEATURE_CATALOG: FeatureDef[] = [
  {
    id: "voice",
    name: "Voice input",
    description: "Speak your tasks. Whisper transcribes on-device in your language.",
    icon: "🎤",
    models: [
      { id: "WHISPER_BASE_Q8_0", displayName: "Whisper Base (Q8)", sizeBytes: 82 * 1024 * 1024 },
    ],
    requiresBinary: ["ffmpeg"],
  },
  {
    id: "vision",
    name: "Vision",
    description: "Show qcode a screenshot or photo of an error. It reads and reasons about it.",
    icon: "👁",
    models: [
      { id: "QWEN3VL_2B_MULTIMODAL_Q4_K", displayName: "Qwen3-VL 2B (Q4)", sizeBytes: 1_110_000_000 },
      { id: "MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K", displayName: "Qwen3-VL Projector", sizeBytes: 445_000_000 },
    ],
  },
  {
    id: "delegated",
    name: "Delegated inference",
    description: "Offload heavy tasks to a more powerful peer over P2P. Your laptop stays cool.",
    icon: "🔗",
    models: [],
  },
];

// ─── Persistence ───

interface FeaturesFile {
  version: 1;
  features: Record<FeatureId, { enabled: boolean; status: FeatureStatus; error: string | null }>;
}

function defaultFile(): FeaturesFile {
  return {
    version: 1,
    features: {
      voice: { enabled: false, status: "off", error: null },
      vision: { enabled: false, status: "off", error: null },
      delegated: { enabled: false, status: "off", error: null },
    },
  };
}

const STATE_PATH = path.join(process.cwd(), ".qcode-state", "features.json");

let cache: FeaturesFile | null = null;
const progress: Record<FeatureId, number | null> = { voice: null, vision: null, delegated: null };

async function loadFile(): Promise<FeaturesFile> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as FeaturesFile;
    cache = parsed.version === 1 ? parsed : defaultFile();
  } catch { cache = defaultFile(); }
  return cache;
}

async function saveFile(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(cache, null, 2), "utf-8");
}

export async function getFeatureState(id: FeatureId): Promise<FeatureState> {
  const f = (await loadFile()).features[id];
  return { id, status: f.status, enabled: f.enabled, error: f.error, downloadProgress: progress[id] };
}

export async function listFeatureStates(): Promise<FeatureState[]> {
  const file = await loadFile();
  return (Object.keys(file.features) as FeatureId[]).map(id => ({
    id,
    status: file.features[id].status,
    enabled: file.features[id].enabled,
    error: file.features[id].error,
    downloadProgress: progress[id],
  }));
}

export async function isFeatureEnabled(id: FeatureId): Promise<boolean> {
  const f = (await loadFile()).features[id];
  return f.enabled && f.status === "ready";
}

// Download all models for a feature via SDK downloadAsset onProgress.
// downloadAsset caches the weights on disk without initializing them. This
// is the right API for projector models (e.g. MMPROJ_*) that cannot run as
// standalone LLMs and fail loadModel with "Failed to initialize model".
async function downloadFeatureModels(def: FeatureDef, onProg: (pct: number) => void): Promise<void> {
  if (def.models.length === 0) { onProg(1); return; }
  const sdk = await import("@qvac/sdk");
  const total = def.models.length;
  for (let i = 0; i < def.models.length; i++) {
    const m = def.models[i];
    const constant = (sdk as unknown as Record<string, unknown>)[m.id];
    if (!constant) {
      log.warn(`features: SDK constant ${m.id} not found, skipping`);
      continue;
    }
    log.info(`features: downloading ${m.displayName} (${Math.round(m.sizeBytes / 1e6)} MB)`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sdk.downloadAsset as any)({
      assetSrc: constant,
      onProgress: (p: unknown) => {
        const prog = p as { percentage?: number; percent?: number };
        const pct = (prog.percentage ?? prog.percent ?? 0) / 100;
        onProg((i + pct) / total);
      },
    });
  }
  onProg(1);
}

export async function enableFeature(id: FeatureId): Promise<FeatureState> {
  const file = await loadFile();
  const def = FEATURE_CATALOG.find(f => f.id === id);
  if (!def) throw new Error(`unknown feature: ${id}`);

  file.features[id].enabled = true;
  file.features[id].status = "installing";
  file.features[id].error = null;
  progress[id] = 0;
  await saveFile();

  // Kick off download in background, don't block the response
  void downloadFeatureModels(def, (p) => { progress[id] = p; })
    .then(async () => {
      const f = await loadFile();
      f.features[id].status = "ready";
      progress[id] = 1;
      await saveFile();
      log.ok(`features: ${id} ready`);
    })
    .catch(async e => {
      const f = await loadFile();
      f.features[id].status = "error";
      f.features[id].error = e instanceof Error ? e.message : String(e);
      progress[id] = null;
      await saveFile();
      log.error(`features: ${id} failed: ${f.features[id].error}`);
    });

  return getFeatureState(id);
}

export async function disableFeature(id: FeatureId): Promise<FeatureState> {
  const file = await loadFile();
  file.features[id].enabled = false;
  file.features[id].status = "off";
  file.features[id].error = null;
  progress[id] = null;
  await saveFile();
  return getFeatureState(id);
}

// ─── HTTP routes ───

export function registerFeatureRoutes(app: Express): void {
  // GET /features: catalog + state
  app.get("/features", requireAuth, async (_req: Request, res: Response) => {
    const states = await listFeatureStates();
    res.json({
      catalog: FEATURE_CATALOG,
      states,
    });
  });

  // POST /features/:id/enable
  app.post("/features/:id/enable", requireAuth, async (req: Request, res: Response) => {
    const id = String(req.params.id) as FeatureId;
    try {
      const state = await enableFeature(id);
      res.json({ ok: true, state });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // POST /features/:id/disable
  app.post("/features/:id/disable", requireAuth, async (req: Request, res: Response) => {
    const id = String(req.params.id) as FeatureId;
    try {
      const state = await disableFeature(id);
      res.json({ ok: true, state });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
