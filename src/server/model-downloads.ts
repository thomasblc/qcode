// Curated list of GGUF models users can download from the PWA.
// Kept small + demo-ready; sizes match what fits on a 16GB Mac with headroom.

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import type { Express, Request, Response } from "express";
import { requireAuth } from "./auth.js";

export interface DownloadableModel {
  id: string;
  name: string;
  sizeGB: number;
  url: string;
  filename: string;
  // RAM requirements for running the model smoothly (Q4 quant + KV cache)
  minRamGB: number;        // below this → won't load
  recommendedRamGB: number;// below this → tight, may swap
  quality: "fast" | "balanced" | "strong"; // coding HumanEval pass@1 tier
  description: string;
}

// Only models that work with @qvac/sdk native tool calling via the Qwen
// chat template. Qwen 2.5 Coder 1.5B/3B/7B and Llama 3.2 3B are removed
// because they do NOT produce correct tool calls with the SDK's chat
// template in v0.8.3 (tested: they emit tool calls as raw JSON in reply
// text instead of using the structured tool_call stream). Adding them back
// would waste the user's bandwidth on models that break the agent loop.
//
// The primary local model is Qwen3 1.7B (loaded from SDK registry at boot,
// not from this catalog). This catalog is for ADDITIONAL models the user
// can download from the UI.
export const CATALOG: DownloadableModel[] = [
  {
    id: "qwen3-4b-q4",
    name: "Qwen3 4B",
    sizeGB: 2.5,
    url: "https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf?download=true",
    filename: "qwen3-4b-instruct-q4_k_m.gguf",
    minRamGB: 4, recommendedRamGB: 6,
    quality: "balanced",
    description: "Best local model for 8GB Macs. Native tool calling via SDK. Stronger than 1.7B for coding tasks.",
  },
  {
    id: "qwen3-8b-q4",
    name: "Qwen3 8B",
    sizeGB: 4.9,
    url: "https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf?download=true",
    filename: "qwen3-8b-instruct-q4_k_m.gguf",
    minRamGB: 8, recommendedRamGB: 12,
    quality: "strong",
    description: "Strong reasoning + tool calling. Fits on 16GB Macs or as a delegated peer model.",
  },
];

interface DownloadJob {
  id: string;
  filename: string;
  sizeBytes: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  status: "downloading" | "done" | "error";
}

const jobs = new Map<string, DownloadJob>();

export function registerDownloadRoutes(app: Express, modelsDir: string): void {
  // GET /downloads/catalog: list of available downloads + RAM fit recommendations
  app.get("/downloads/catalog", requireAuth, async (_req: Request, res: Response) => {
    const present = new Set<string>();
    try {
      const entries = await fs.readdir(modelsDir);
      for (const e of entries) present.add(e);
    } catch { /* dir may not exist */ }
    const active = jobs.get("_active");
    const totalRamGB = Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10;
    res.json({
      catalog: CATALOG.map(m => {
        let fit: "recommended" | "tight" | "wont-fit" = "recommended";
        if (totalRamGB < m.minRamGB) fit = "wont-fit";
        else if (totalRamGB < m.recommendedRamGB) fit = "tight";
        return { ...m, installed: present.has(m.filename), fit };
      }),
      active: active && active.status === "downloading" ? active : null,
      system: { totalRamGB },
    });
  });

  // POST /downloads/start { id }: start a download
  app.post("/downloads/start", requireAuth, async (req: Request, res: Response) => {
    const body = req.body as { id?: string };
    const entry = CATALOG.find(m => m.id === body.id);
    if (!entry) { res.status(404).json({ error: "unknown model id" }); return; }
    const existing = jobs.get("_active");
    if (existing && existing.status === "downloading") {
      res.status(409).json({ error: "another download is in progress", active: existing }); return;
    }
    await fs.mkdir(modelsDir, { recursive: true });
    const out = path.join(modelsDir, entry.filename);
    const job: DownloadJob = { id: entry.id, filename: entry.filename, sizeBytes: 0, startedAt: Date.now(), finishedAt: null, error: null, status: "downloading" };
    jobs.set("_active", job);

    const child = spawn("curl", ["-L", "-sS", "--fail", "-o", out, entry.url], { stdio: ["ignore", "pipe", "pipe"] });
    child.on("exit", async code => {
      if (code === 0) {
        try { const stat = await fs.stat(out); job.sizeBytes = stat.size; } catch { /* noop */ }
        job.status = "done"; job.finishedAt = Date.now();
      } else {
        job.status = "error"; job.finishedAt = Date.now(); job.error = `curl exit ${code}`;
        try { await fs.unlink(out); } catch { /* noop */ }
      }
    });

    // Poll file size periodically to track progress
    const progressPoll = setInterval(async () => {
      if (job.status !== "downloading") { clearInterval(progressPoll); return; }
      try { const stat = await fs.stat(out); job.sizeBytes = stat.size; } catch { /* file not yet created */ }
    }, 1000);

    res.status(202).json({ ok: true, job });
  });

  // GET /downloads/status: progress of the current/most-recent download
  app.get("/downloads/status", requireAuth, (_req: Request, res: Response) => {
    const active = jobs.get("_active");
    res.json({ active: active ?? null });
  });
}
