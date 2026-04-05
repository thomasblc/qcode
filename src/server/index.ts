import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces, hostname } from "node:os";
import { execSync } from "node:child_process";
import { log } from "../utils/logger.js";
import { QvacSdkBackend } from "../agent/models.js";
import {
  close as closeSdk,
  LLAMA_TOOL_CALLING_1B_INST_Q4_K,
  QWEN3_1_7B_INST_Q4,
  QWEN3_4B_INST_Q4_K_M,
} from "@qvac/sdk";
import {
  loadPeerConfig,
  savePeerConfig,
  configFromEnv,
  probePeer,
  unloadPeerBackend,
  newPeerBackendRef,
  type PeerConfig,
  type PeerBackendRef,
} from "./peer-config.js";
import { initAuthKey } from "./auth.js";
import { registerRoutes } from "./routes.js";
import { registerFsRoutes } from "./fs-browse.js";
import { registerModelRoutes } from "./models-routes.js";
import { registerPreviewRoutes } from "./preview-routes.js";
import { registerDownloadRoutes } from "./model-downloads.js";
import { registerFeatureRoutes } from "./features.js";
import { registerPeerRoutes } from "./peer-routes.js";
import { registerSystemRoutes } from "./system-info.js";
import { registerVoiceRoutes } from "./voice.js";
import { registerVisionRoutes } from "./vision.js";
import { LlamaManager } from "./llama-manager.js";
import { SdkModelProvider, LegacyModelProvider, type ModelProvider } from "./model-provider.js";
import { listSessions } from "./sessions.js";
import { initPersistence, flushNow } from "../state/persistence.js";
import { restoreSessionsCompat, snapshotSessions, restoreProjects, snapshotProjects } from "./sessions.js";
import { restoreChannels, snapshotChannels } from "./sse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../../public");

const PORT = Number(process.env.QCODE_PORT ?? 3000);
// Bind to 0.0.0.0 so iPhone on same LAN can reach us. Auth key is still required.
const HOST = process.env.QCODE_HOST ?? "0.0.0.0";

function getLanAddress(): string | null {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

// Prefer the stable .local Bonjour hostname when available (doesn't change
// when DHCP reassigns the LAN IP). Falls back to os.hostname().
function getLocalHostname(): string | null {
  if (process.platform === "darwin") {
    try {
      const name = execSync("scutil --get LocalHostName", { encoding: "utf-8" }).trim();
      if (name) return `${name}.local`;
    } catch { /* noop */ }
  }
  const h = hostname();
  return h && h.includes(".") ? h : h ? `${h}.local` : null;
}

async function main() {
  // Boot QVAC via the official @qvac/sdk (in-process, no child process needed).
  // Falls back to llama-server manager if QCODE_LEGACY=1 is set.
  const useLegacy = process.env.QCODE_LEGACY === "1";

  const backend = new QvacSdkBackend();
  // Optional second backend for delegated inference to a P2P peer. Loaded
  // only if QCODE_PEER_ENABLED=1 and the topic+pubkey env vars are set.
  // The peer runs scripts/peer-provider.mjs on its side.
  //
  // CRITICAL: this is a MUTABLE HOLDER object, not a plain variable. We
  // pass it to registerRoutes BEFORE the async peer load has resolved, and
  // routes.ts captures .ref through a closure. Earlier code passed the
  // value directly, which meant routes.ts captured `null` forever: the
  // .then callback would flip the local variable, but the routes closure
  // still saw null. The delegation feature was silently dead at runtime.
  const peerBackendRef: PeerBackendRef = newPeerBackendRef();
  const manager = new LlamaManager({
    projectRoot: process.cwd(),
    port: Number(process.env.QCODE_LLAMA_PORT ?? 8080),
    ctx: Number(process.env.QCODE_LLAMA_CTX ?? 16384),
  });

  let provider: ModelProvider;
  if (useLegacy) {
    log.info("QCODE_LEGACY=1 → using llama-server child process (legacy mode)");
    const available = await manager.listAvailableModels();
    if (available.length === 0) { log.error("no .gguf models in models/"); process.exit(1); }
    const defaultModel = available[0].name;
    await manager.startModel(defaultModel);
    if (manager.getState().status !== "ready") { log.error("llama-server failed"); process.exit(1); }
    provider = new LegacyModelProvider(manager);
  } else {
    // Load default model via @qvac/sdk.
    // PIVOT v3: the primary model is LLAMA_TOOL_CALLING_1B_INST_Q4_K, a 1B
    // Llama 3.2 fine-tuned specifically for native tool calling and shipped
    // in the Tether registry. The SDK downloads it on first load from the
    // registry core-key, cached under ~/.qvac after that.
    //
    // Local .gguf files in models/ stay as fallbacks, switchable from the UI.
    const modelsDir = path.join(process.cwd(), "models");
    const sdkProvider = new SdkModelProvider(backend, modelsDir);
    const available = await sdkProvider.listAvailableModels();
    const preferred = process.env.QCODE_MODEL;
    const preferredBasename = preferred ? path.basename(preferred) : null;

    const useRegistry = !preferred && process.env.QCODE_SKIP_REGISTRY !== "1";
    const ctx = Number(process.env.QCODE_LLAMA_CTX ?? 8192);

    if (useRegistry) {
      // Primary: Qwen3 1.7B Q4 is the model the SDK's native-tools example
      // uses and the SDK's chat template has first-class support for Qwen's
      // <tool_call>...</tool_call> native format. LLAMA_TOOL_CALLING_1B is
      // a solid alternative but its chat template isn't recognized by the
      // SDK in 0.8.3, so it falls back to a raw JSON dump that the parser
      // can't read. Keep it as QCODE_MODEL=llama-tool-calling override.
      const registryChoice = process.env.QCODE_REGISTRY_MODEL === "llama-tool-calling"
        ? LLAMA_TOOL_CALLING_1B_INST_Q4_K
        : process.env.QCODE_REGISTRY_MODEL === "qwen3-4b"
          ? QWEN3_4B_INST_Q4_K_M
          : QWEN3_1_7B_INST_Q4;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const label = (registryChoice as any).name ?? "qwen3-1.7b";
      log.info(`loading primary model: ${label} (SDK registry)`);
      try {
        await backend.load(registryChoice, ctx);
        sdkProvider.markReady(String(label));
        provider = sdkProvider;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(`SDK registry load failed: ${msg}`);
        log.warn("falling back to local .gguf files in models/");
        // fall through to local file selection below
      }
    }

    if (!provider!) {
      // Preference order for local .gguf fallback:
      // 1. explicit QCODE_MODEL env var if set
      // 2. Llama 3.2 (general-purpose)
      // 3. smallest available (last resort)
      const findByMatch = (pattern: RegExp) => available.find(m => pattern.test(m.name));
      const defaultModelInfo =
        (preferredBasename && available.find(m => m.name === preferredBasename))
          ?? findByMatch(/llama-3\.2-3b/i)
          ?? findByMatch(/llama-3\.2/i)
          ?? available[0];
      if (!defaultModelInfo) {
        log.error("no .gguf models found in models/ and SDK registry load failed");
        log.error("run: ./scripts/download-model.sh");
        process.exit(1);
      }
      await backend.load(defaultModelInfo.path, ctx);
      sdkProvider.markReady(defaultModelInfo.name);
      provider = sdkProvider;
    }

    // Delegated peer: config is read from .qcode-state/peer-config.json
    // (managed via the PWA Settings > Features > Delegated inference
    // panel). Env vars QCODE_PEER_ENABLED/TOPIC/PUBKEY/... still work
    // as a legacy override for scripted demos; when set they take
    // precedence over the file and are written back so the UI stays
    // in sync.
    const fileCfg = await loadPeerConfig();
    const envCfg = configFromEnv();
    const peerCfg: PeerConfig = envCfg ?? fileCfg;
    if (envCfg) {
      // Persist the env-derived config so the UI reflects it.
      try { await savePeerConfig(envCfg); } catch { /* noop */ }
    }
    if (peerCfg.enabled && peerCfg.topic && peerCfg.providerPublicKey) {
      log.info("peer probe starting in background, daemon will boot local-only until ready");
      probePeer(peerCfg, peerBackendRef, ctx);
    } else {
      log.info("peer: not configured, running local-only (configure in Settings > Features)");
    }
  }
  log.ok(`connected to QVAC ${useLegacy ? "(legacy llama-server)" : "(@qvac/sdk)"}`);

  const key = initAuthKey();

  // Restore past sessions + projects + events from disk (if any)
  const loaded = await initPersistence(process.cwd(), () => ({
    version: 1,
    sessions: snapshotSessions(),
    projects: snapshotProjects(),
    events: snapshotChannels(),
  }));
  if (loaded) {
    if (loaded.projects) restoreProjects(loaded.projects);
    restoreSessionsCompat(loaded.sessions); // back-compat: migrates old sessions to projects
    restoreChannels(loaded.events);
  }

  // Flush to disk and stop llama-server on Ctrl+C
  const shutdown = async () => {
    log.info("shutting down...");
    await flushNow();
    if (useLegacy) await manager.stop();
    else {
      await unloadPeerBackend(peerBackendRef);
      await backend.unload();
      closeSdk();
    }
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // PWA static assets (index.html, app.js, style.css).
  // The PWA is open: only the /sessions* API is auth-gated.
  app.use(express.static(PUBLIC_DIR, { index: "index.html", extensions: ["html"] }));

  registerRoutes(app, backend, provider, peerBackendRef);
  registerFsRoutes(app);
  registerModelRoutes(app, provider, peerBackendRef);
  registerFeatureRoutes(app);
  registerPeerRoutes(app, peerBackendRef, Number(process.env.QCODE_LLAMA_CTX ?? 8192));
  registerSystemRoutes(app);
  registerVoiceRoutes(app);
  registerVisionRoutes(app);
  registerDownloadRoutes(app, path.join(process.cwd(), "models"));
  // Preview needs to know the currently-active project root. Since sessions
  // carry their own projectRoot, we use the most recent session's root.
  registerPreviewRoutes(app, () => {
    const recent = listSessions()[0];
    return recent?.projectRoot ?? null;
  });

  app.listen(PORT, HOST, () => {
    const lan = getLanAddress();
    const mdns = getLocalHostname();
    const projectRoot = process.cwd();
    // Prefer .local (stable) over LAN IP (changes with DHCP).
    const host = mdns ?? lan ?? "127.0.0.1";
    const suffix = `#key=${encodeURIComponent(key)}&root=${encodeURIComponent(projectRoot)}`;
    const stableUrl = `http://${host}:${PORT}/`;
    const deepLink = `http://${host}:${PORT}/${suffix}`;
    const border = "─".repeat(64);
    console.log(`\n${border}`);
    console.log("qcode daemon ready");
    console.log(border);
    console.log(`  local:     http://127.0.0.1:${PORT}`);
    if (lan) console.log(`  LAN IP:    http://${lan}:${PORT}  (can change with DHCP)`);
    if (mdns) console.log(`  Bonjour:   ${stableUrl}  ← stable URL, add this to home screen`);
    console.log(`  auth key:  ${key}`);
    console.log(`  env:       QCODE_KEY=${key}  (reuse this key across restarts)`);
    console.log(border);
    console.log(`  📱 iPhone, first time (auto-fills key, then saves to localStorage):`);
    console.log(`    ${deepLink}`);
    console.log(`  📱 iPhone, after that, just open:`);
    console.log(`    ${stableUrl}`);
    console.log(border);
    console.log(`  curl example:`);
    console.log(`    curl -N -H "x-qcode-key: ${key}" \\`);
    console.log(`      -H "content-type: application/json" \\`);
    console.log(`      -d '{"prompt":"list files in src/","projectRoot":"${projectRoot}"}' \\`);
    console.log(`      http://127.0.0.1:${PORT}/sessions`);
    console.log(`${border}\n`);
  });
}

main().catch(e => {
  log.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
