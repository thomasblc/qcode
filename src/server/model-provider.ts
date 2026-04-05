// Abstraction over model lifecycle, shared between @qvac/sdk backend and legacy llama-manager.
// The PWA's /models endpoints call into one of these implementations.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { QvacSdkBackend } from "../agent/models.js";
import { LlamaManager } from "./llama-manager.js";
import { log } from "../utils/logger.js";

export interface ModelInfo {
  name: string;             // filename or SDK constant id
  displayName: string;
  sizeBytes: number;
  path: string;
  active: boolean;
}

export interface ProviderState {
  status: "idle" | "starting" | "ready" | "error" | "stopping";
  currentModel: string | null;
  backend: "qvac-sdk" | "llama-server";
  error: string | null;
}

export interface ModelProvider {
  listAvailableModels(): Promise<ModelInfo[]>;
  getState(): ProviderState;
  switchModel(name: string): Promise<void>;
  onStateChange(fn: (s: ProviderState) => void): () => void;
}

// ─── SDK-backed provider ───

export class SdkModelProvider implements ModelProvider {
  private state: ProviderState = { status: "idle", currentModel: null, backend: "qvac-sdk", error: null };
  private listeners = new Set<(s: ProviderState) => void>();
  private modelsDir: string;

  constructor(private backend: QvacSdkBackend, modelsDir: string) {
    this.modelsDir = modelsDir;
  }

  private setState(patch: Partial<ProviderState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  markReady(modelName: string): void {
    this.setState({ status: "ready", currentModel: modelName, error: null });
  }

  async listAvailableModels(): Promise<ModelInfo[]> {
    try {
      const entries = await fs.readdir(this.modelsDir, { withFileTypes: true });
      // Accept both regular files AND symlinks. Dirent.isFile() returns false
      // for symlinks even if the target is a regular file; fs.stat below
      // resolves the symlink and validates the real file type and size.
      const ggufs = entries.filter(e => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".gguf"));
      const results: ModelInfo[] = [];
      // Normalise helper so we can match a registry constant like
      // "QWEN3_1_7B_INST_Q4" against a disk file like
      // "qwen3-1.7b-instruct-q4_0.gguf". Strip case, underscores,
      // dashes, dots and the .gguf suffix, then substring match.
      const norm = (s: string | null) => (s ?? "")
        .toLowerCase()
        .replace(/\.gguf$/i, "")
        .replace(/[_\-.]/g, "");
      const currentKey = norm(this.state.currentModel);
      for (const e of ggufs) {
        const full = path.join(this.modelsDir, e.name);
        const stat = await fs.stat(full);
        if (!stat.isFile()) continue; // broken symlink
        const entryKey = norm(e.name);
        // Active if exact filename match, or if the registry constant
        // key is a prefix/substring of the filename key (covers
        // "qwen317binstq4" vs "qwen317binstructq40").
        const isActive = !!this.state.currentModel && (
          e.name === this.state.currentModel ||
          entryKey === currentKey ||
          (currentKey.length >= 8 && entryKey.includes(currentKey)) ||
          (entryKey.length >= 8 && currentKey.includes(entryKey))
        );
        results.push({
          name: e.name,
          displayName: humanizeModelName(e.name),
          sizeBytes: stat.size,
          path: full,
          active: isActive,
        });
      }
      return results.sort((a, b) => a.sizeBytes - b.sizeBytes);
    } catch { return []; }
  }

  getState(): ProviderState { return { ...this.state }; }

  async switchModel(name: string): Promise<void> {
    const modelPath = path.join(this.modelsDir, name);
    try { await fs.access(modelPath); } catch {
      this.setState({ status: "error", error: `model not found: ${name}` });
      return;
    }
    this.setState({ status: "starting", currentModel: name, error: null });
    try {
      await this.backend.load(modelPath, Number(process.env.QCODE_LLAMA_CTX ?? 8192));
      this.setState({ status: "ready", error: null });
      log.ok(`model provider: switched to ${name}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setState({ status: "error", error: msg });
    }
  }

  onStateChange(fn: (s: ProviderState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

// ─── Legacy llama-manager adapter ───

export class LegacyModelProvider implements ModelProvider {
  constructor(private manager: LlamaManager) {}

  async listAvailableModels(): Promise<ModelInfo[]> {
    const models = await this.manager.listAvailableModels();
    const state = this.manager.getState();
    return models.map(m => ({
      name: m.name,
      displayName: m.displayName,
      sizeBytes: m.sizeBytes,
      path: m.path,
      active: m.name === state.currentModel,
    }));
  }

  getState(): ProviderState {
    const s = this.manager.getState();
    return { status: s.status, currentModel: s.currentModel, backend: "llama-server", error: s.error };
  }

  async switchModel(name: string): Promise<void> {
    await this.manager.startModel(name);
  }

  onStateChange(fn: (s: ProviderState) => void): () => void {
    return this.manager.onStateChange(ms => fn({
      status: ms.status, currentModel: ms.currentModel, backend: "llama-server", error: ms.error,
    }));
  }
}

function humanizeModelName(filename: string): string {
  const base = filename.replace(/\.gguf$/i, "");
  const quantMatch = base.match(/(q\d(?:_\w)?(?:_\w)?)$/i);
  const quant = quantMatch ? `(${quantMatch[1].toUpperCase()})` : "";
  const stem = quantMatch ? base.slice(0, -quantMatch[1].length - 1) : base;
  const pretty = stem.replace(/-instruct$/i, "").replace(/-/g, " ").split(" ")
    .map(w => /^\d/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return `${pretty} ${quant}`.trim();
}
