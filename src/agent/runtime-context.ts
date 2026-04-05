// RuntimeContext: everything the agent needs to know about its own situation
// at the start of a completion. Assembled fresh per call so it reflects
// current features, session state, project, etc.

import os from "node:os";
import type { PermissionMode, Project, Session } from "../server/sessions.js";
import type { FeatureId } from "../server/features.js";

export interface RuntimeContext {
  // Identity
  agentName: "qcode";
  modelId: string | null;     // the GGUF file name currently loaded
  modelFamily: string | null; // parsed family e.g. "qwen2.5-coder-3b"

  // Environment
  os: string;
  arch: string;
  hostname: string;
  nodeVersion: string;
  availableBinaries: string[];

  // Project + session
  project: Project;
  session: Session;
  turnIndex: number;
  isFirstTurn: boolean;
  sessionUptimeSec: number;

  // Capabilities (features enabled by the user)
  features: Record<FeatureId, boolean>;

  // Permission mode
  mode: PermissionMode;
}

export interface BuildRuntimeContextArgs {
  project: Project;
  session: Session;
  turnIndex: number;
  currentModelName: string | null;
  features: Record<FeatureId, boolean>;
}

// Cache: binary availability is checked once per process (not per completion)
let cachedBinaries: string[] | null = null;
function detectAvailableBinaries(): string[] {
  if (cachedBinaries) return cachedBinaries;
  // We just report a static list of things we assume exist on macOS.
  // Detection via `which` would add latency per request; not worth it.
  cachedBinaries = ["git", "rg", "node", "bash"];
  return cachedBinaries;
}

function parseFamily(modelName: string | null): string | null {
  if (!modelName) return null;
  const m = modelName.match(/(qwen[\d.]*-coder-\d+b|qwen[\d.]*-\d+b|llama-[\d.]+-\d+b)/i);
  return m ? m[1].toLowerCase() : modelName.replace(/\.gguf$/i, "").slice(0, 40);
}

export function buildRuntimeContext(args: BuildRuntimeContextArgs): RuntimeContext {
  return {
    agentName: "qcode",
    modelId: args.currentModelName,
    modelFamily: parseFamily(args.currentModelName),
    os: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    nodeVersion: process.version,
    availableBinaries: detectAvailableBinaries(),
    project: args.project,
    session: args.session,
    turnIndex: args.turnIndex,
    isFirstTurn: args.turnIndex === 0 && !args.session.docsLoaded,
    sessionUptimeSec: Math.floor((Date.now() - args.session.startedAt) / 1000),
    features: args.features,
    mode: args.session.mode,
  };
}

// Render the runtime context as a compact preamble to be injected into the
// system prompt. Target budget: <200 tokens.
export function renderRuntimeContextBlock(ctx: RuntimeContext): string {
  const featureList = (Object.keys(ctx.features) as FeatureId[])
    .filter(k => ctx.features[k])
    .join(", ") || "none";
  const modelLabel = ctx.modelFamily ?? ctx.modelId ?? "unknown";
  return `## Runtime context
- model: ${modelLabel} via @qvac/sdk
- project: ${ctx.project.name} (${ctx.project.absolutePath})
- session: #${ctx.turnIndex} turn, ${ctx.sessionUptimeSec}s uptime
- host: ${ctx.os}/${ctx.arch}
- features enabled: ${featureList}
- permission mode: ${ctx.mode}`;
}
