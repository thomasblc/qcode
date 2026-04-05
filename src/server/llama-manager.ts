// Manages the QVAC Fabric LLM child process (llama-server).
// The daemon spawns it on boot, can kill + respawn it on model switch,
// and exposes its lifecycle to the PWA via /models endpoints.

import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "../utils/logger.js";

export interface ModelInfo {
  name: string;           // filename, e.g. "qwen2.5-coder-3b-instruct-q4_k_m.gguf"
  displayName: string;    // human label, e.g. "Qwen 2.5 Coder 3B"
  sizeBytes: number;
  path: string;
}

export type ManagerStatus = "idle" | "starting" | "ready" | "error" | "stopping";

export interface ManagerState {
  status: ManagerStatus;
  currentModel: string | null;
  error: string | null;
}

interface ManagerConfig {
  projectRoot: string;
  port: number;           // llama-server port (default 8080)
  ctx: number;            // context size
  vendorDir: string;      // where llama-server binary lives
  modelsDir: string;      // where .gguf files live
}

export class LlamaManager {
  private child: ChildProcess | null = null;
  private state: ManagerState = { status: "idle", currentModel: null, error: null };
  private cfg: ManagerConfig;
  private stateListeners = new Set<(s: ManagerState) => void>();

  constructor(cfg: Partial<ManagerConfig> = {}) {
    const root = cfg.projectRoot ?? process.cwd();
    this.cfg = {
      projectRoot: root,
      port: cfg.port ?? 8080,
      ctx: cfg.ctx ?? 16384,
      vendorDir: cfg.vendorDir ?? path.join(root, "vendor"),
      modelsDir: cfg.modelsDir ?? path.join(root, "models"),
    };
  }

  getState(): ManagerState { return { ...this.state }; }
  getBaseUrl(): string { return `http://127.0.0.1:${this.cfg.port}`; }

  onStateChange(fn: (s: ManagerState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
  private setState(patch: Partial<ManagerState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.stateListeners) fn(this.state);
  }

  async listAvailableModels(): Promise<ModelInfo[]> {
    try {
      const entries = await fs.readdir(this.cfg.modelsDir, { withFileTypes: true });
      const ggufs = entries.filter(e => e.isFile() && e.name.endsWith(".gguf"));
      const results: ModelInfo[] = [];
      for (const e of ggufs) {
        const full = path.join(this.cfg.modelsDir, e.name);
        const stat = await fs.stat(full);
        results.push({
          name: e.name,
          displayName: humanizeModelName(e.name),
          sizeBytes: stat.size,
          path: full,
        });
      }
      return results.sort((a, b) => a.sizeBytes - b.sizeBytes);
    } catch {
      return [];
    }
  }

  private async healthCheck(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.getBaseUrl()}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          const body = await res.json().catch(() => ({}));
          if ((body as { status?: string }).status === "ok") return true;
        }
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  // Pick a safe context size based on model file size.
  // RAM budget guidance (8GB unified memory target):
  //   3B Q4 + 32k ctx  ≈ 3.6 GB  → fits
  //   7B Q4 + 12k ctx  ≈ 6.4 GB  → tight, close browsers
  //   7B Q4 + 8k  ctx  ≈ 5.8 GB  → safe default
  //   14B Q4 + 8k ctx  ≈ 11 GB   → needs 16GB+ machine
  // Users with more RAM can push higher via QCODE_LLAMA_CTX env.
  private safeContextFor(modelSizeGB: number, requested: number): number {
    if (modelSizeGB < 2.5) return Math.min(requested, 32768); // 1.5-3B: up to 32k
    if (modelSizeGB < 5)   return Math.min(requested, 12288); // 7B: up to 12k
    if (modelSizeGB < 10)  return Math.min(requested, 8192);  // 14B: up to 8k
    return Math.min(requested, 4096);
  }

  // Spawn llama-server with the given model. Kills any existing process first.
  async startModel(modelName: string): Promise<void> {
    const binary = path.join(this.cfg.vendorDir, "llama-server");
    const modelPath = path.join(this.cfg.modelsDir, modelName);

    await this.stop();

    try { await fs.access(binary); } catch {
      this.setState({ status: "error", error: `llama-server binary missing at ${binary}. Run ./scripts/download-fabric.sh` });
      return;
    }
    let modelStat;
    try { modelStat = await fs.stat(modelPath); } catch {
      this.setState({ status: "error", error: `model missing: ${modelName}` });
      return;
    }
    const sizeGB = modelStat.size / 1e9;
    const ctx = this.safeContextFor(sizeGB, this.cfg.ctx);

    this.setState({ status: "starting", currentModel: modelName, error: null });
    log.info(`llama-manager: starting ${modelName} (${sizeGB.toFixed(1)}GB, ctx=${ctx}) on :${this.cfg.port}`);

    const args = [
      "-m", modelPath,
      "--host", "127.0.0.1",
      "--port", String(this.cfg.port),
      "-c", String(ctx),
      "-ngl", "99",
      "--jinja",
    ];
    this.child = spawn(binary, args, { cwd: this.cfg.vendorDir, stdio: ["ignore", "pipe", "pipe"] });

    // Buffer a bit of output for diagnostics; don't let it flood our logs.
    const TAIL = 4000;
    let tailBuf = "";
    const capture = (chunk: Buffer) => {
      tailBuf += chunk.toString();
      if (tailBuf.length > TAIL) tailBuf = tailBuf.slice(-TAIL);
    };
    this.child.stdout?.on("data", capture);
    this.child.stderr?.on("data", capture);

    this.child.on("exit", (code, sig) => {
      const wasRunning = this.state.status === "ready" || this.state.status === "starting";
      this.child = null;
      if (wasRunning) {
        log.warn(`llama-manager: process exited (code=${code}, signal=${sig})`);
        this.setState({
          status: "error",
          error: `llama-server exited (code ${code ?? "?"}, signal ${sig ?? "none"})\n` + tailBuf.slice(-1000),
        });
      }
    });

    const healthy = await this.healthCheck(120_000);
    if (!healthy) {
      await this.stop();
      this.setState({ status: "error", error: "llama-server failed health check\n" + tailBuf.slice(-1000) });
      return;
    }
    this.setState({ status: "ready", error: null });
    log.ok(`llama-manager: ready (${modelName})`);
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    // Remove the error-setting exit listener. This is an INTENTIONAL stop.
    child.removeAllListeners("exit");
    this.setState({ status: "stopping" });
    log.info("llama-manager: stopping current model");
    return new Promise<void>(resolve => {
      const kill = () => { try { child.kill("SIGKILL"); } catch { /* noop */ } resolve(); };
      const timer = setTimeout(kill, 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      try { child.kill("SIGTERM"); } catch { clearTimeout(timer); kill(); }
    });
  }
}

// Turn "qwen2.5-coder-3b-instruct-q4_k_m.gguf" into "Qwen 2.5 Coder 3B (Q4_K_M)"
function humanizeModelName(filename: string): string {
  const base = filename.replace(/\.gguf$/i, "");
  // Try to extract size suffix (e.g. q4_k_m)
  const quantMatch = base.match(/(q\d(?:_\w)?(?:_\w)?)$/i);
  const quant = quantMatch ? `(${quantMatch[1].toUpperCase()})` : "";
  const stem = quantMatch ? base.slice(0, -quantMatch[1].length - 1) : base;
  const pretty = stem
    .replace(/-instruct$/i, "")
    .replace(/-/g, " ")
    .split(" ")
    .map(w => {
      if (/^\d/.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
  return `${pretty} ${quant}`.trim();
}
