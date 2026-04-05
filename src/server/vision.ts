// Vision backend. Lazy-loads a Qwen3-VL multimodal model via @qvac/sdk,
// accepts browser-uploaded images, writes them to tmpfs, and runs a
// single completion with the image as an attachment. Gated by the vision
// feature being enabled.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { requireAuth } from "./auth.js";
import { isFeatureEnabled } from "./features.js";
import { log } from "../utils/logger.js";
import { createSession, getSession, updateSession } from "./sessions.js";
import { createChannel, getChannel, pushEvent } from "./sse.js";

interface VlmState {
  modelId: string | null;
  loading: Promise<string> | null;
}

const vlm: VlmState = { modelId: null, loading: null };

async function ensureVlmLoaded(): Promise<string> {
  if (vlm.modelId) return vlm.modelId;
  if (vlm.loading) return vlm.loading;
  vlm.loading = (async () => {
    log.info("vision: loading Qwen3-VL 2B (first use)");
    const sdk = await import("@qvac/sdk");
    const constant = (sdk as unknown as Record<string, unknown>)["QWEN3VL_2B_MULTIMODAL_Q4_K"];
    const mmproj = (sdk as unknown as Record<string, unknown>)["MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K"];
    if (!constant || !mmproj) {
      throw new Error("QWEN3VL_2B_MULTIMODAL_Q4_K or its projector not exported by @qvac/sdk");
    }
    // ctx_size budgets prompt + image tokens + response. An iPhone photo
    // tokenises to 3500-4000 tokens depending on resolution, plus ~200
    // tokens for the prompt and room for a reply. 4096 overflowed at
    // prefill with full-res iPhone shots, 8192 has plenty of headroom
    // and still fits on an 8 GB Mac (the model itself is ~1.1 GB, the
    // KV cache scales linearly with ctx_size but stays modest at 8k).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = await (sdk.loadModel as any)({
      modelSrc: constant,
      modelType: "llm",
      modelConfig: {
        ctx_size: 8192,
        projectionModelSrc: mmproj,
      },
      onProgress: (p: unknown) => {
        const prog = p as { percentage?: number };
        if (prog.percentage != null) log.info(`vision: download ${Math.round(prog.percentage)}%`);
      },
    });
    vlm.modelId = id;
    log.ok(`vision: Qwen3-VL ready (modelId=${id})`);
    return id;
  })();
  try { return await vlm.loading; }
  finally { vlm.loading = null; }
}

// Tmp dir for incoming images. One per server lifetime.
const tmpDir = path.join(os.tmpdir(), "qcode-vision");
let tmpDirReady: Promise<void> | null = null;
function ensureTmpDir(): Promise<void> {
  if (!tmpDirReady) tmpDirReady = fs.mkdir(tmpDir, { recursive: true }).then(() => undefined);
  return tmpDirReady;
}

export function registerVisionRoutes(app: Express): void {
  // POST /vision
  // Multipart-ish: we accept a raw image body + a prompt via the
  // x-qcode-prompt header. This avoids the multipart parsing overhead
  // for an MVP. The header is URL-encoded so unicode prompts work.
  app.post("/vision", requireAuth, async (req: Request, res: Response) => {
    const enabled = await isFeatureEnabled("vision");
    if (!enabled) {
      res.status(400).json({ error: "vision feature not enabled. enable it in settings." });
      return;
    }

    // Read the prompt from header (URL-encoded to support unicode)
    const rawPrompt = req.header("x-qcode-prompt") ?? "";
    let prompt = "";
    try { prompt = decodeURIComponent(rawPrompt); } catch { prompt = rawPrompt; }
    if (!prompt) prompt = "Describe this image in detail. If it contains text, read it out.";

    // Collect the image bytes
    const chunks: Buffer[] = [];
    let bytes = 0;
    const maxBytes = 20 * 1024 * 1024; // 20 MB cap
    try {
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
        bytes += (chunk as Buffer).length;
        if (bytes > maxBytes) {
          res.status(413).json({ error: "image too large (>20 MB)" });
          return;
        }
      }
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "read failed" });
      return;
    }
    if (bytes === 0) {
      res.status(400).json({ error: "empty image body" });
      return;
    }

    // Determine a safe file extension from the content-type header
    const contentType = (req.header("content-type") ?? "image/png").split(";")[0].trim();
    const ext = contentType.startsWith("image/") ? contentType.slice(6) : "png";
    const safeExt = ["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext.toLowerCase()) ? ext : "png";

    await ensureTmpDir();
    const file = path.join(tmpDir, `${randomUUID()}.${safeExt}`);
    await fs.writeFile(file, Buffer.concat(chunks));
    log.info(`vision: received ${bytes} bytes (${safeExt}), running VLM…`);

    // Persistence and cross-device sync policy for vision calls:
    //
    // - x-qcode-no-session: 1   → purely ephemeral, nothing stored.
    // - x-qcode-session-id: X   → append to an existing session so the
    //   OTHER device currently viewing X sees the user_msg and reply
    //   events live through SSE. Without this, each device only saw its
    //   own vision Q&A because a new session channel was created per
    //   call and the other device wasn't subscribed to it.
    // - neither header → create a fresh session like a new chat.
    const skipSession = req.header("x-qcode-no-session") === "1";
    const sessionIdHeader = (req.header("x-qcode-session-id") ?? "").trim();
    const projectRootHeader = (req.header("x-qcode-project-root") ?? "").trim() || process.cwd();

    try {
      const modelId = await ensureVlmLoaded();
      const sdk = await import("@qvac/sdk");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (sdk.completion as any)({
        modelId,
        history: [{
          role: "user",
          content: prompt,
          attachments: [{ path: file }],
        }],
        stream: false,
      });
      const text: string = await result.text;
      const trimmed = text.trim();
      log.ok(`vision: answered (${trimmed.length} chars)`);

      let sessionId: string | null = null;
      if (!skipSession) {
        try {
          const displayPrompt = `${prompt} [image]`;
          // Prefer the caller-supplied session id so cross-device sync
          // works (both devices are subscribed to the same channel).
          // Fall back to creating a fresh session if the id is unknown
          // (stale localStorage) or missing entirely.
          const existing = sessionIdHeader ? getSession(sessionIdHeader) : undefined;
          if (existing && getChannel(existing.id)) {
            const ch = getChannel(existing.id)!;
            ch.closed = false;
            pushEvent(ch, "user_msg", { content: displayPrompt });
            pushEvent(ch, "done", { summary: trimmed, reply: true });
            updateSession(existing.id, { status: "done", endedAt: Date.now(), summary: trimmed });
            sessionId = existing.id;
          } else {
            const session = createSession(displayPrompt, projectRootHeader, "ask");
            const ch = createChannel(session.id);
            pushEvent(ch, "user_msg", { content: displayPrompt });
            pushEvent(ch, "done", { summary: trimmed, reply: true });
            updateSession(session.id, { status: "done", endedAt: Date.now(), summary: trimmed });
            sessionId = session.id;
          }
        } catch (e) {
          log.warn(`vision: failed to persist session: ${e instanceof Error ? e.message : e}`);
        }
      }

      res.json({ text: trimmed, prompt, sessionId });
    } catch (e) {
      log.error(`vision: inference failed: ${e instanceof Error ? e.message : e}`);
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      // Clean up the temp image file after the call
      fs.unlink(file).catch(() => { /* noop */ });
    }
  });
}
