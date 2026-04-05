// Voice input backend. Lazy-loads a whisper model via @qvac/sdk, transcodes
// browser audio (WebM/Opus from MediaRecorder) to f32le PCM 16kHz mono via
// ffmpeg, then transcribes. Gated by the voice feature being enabled.

import { spawn } from "node:child_process";
import type { Express, Request, Response } from "express";
import { requireAuth } from "./auth.js";
import { isFeatureEnabled } from "./features.js";
import { log } from "../utils/logger.js";

interface WhisperState {
  modelId: string | null;
  loading: Promise<string> | null;
}

const whisper: WhisperState = { modelId: null, loading: null };

async function ensureWhisperLoaded(): Promise<string> {
  if (whisper.modelId) return whisper.modelId;
  if (whisper.loading) return whisper.loading;
  whisper.loading = (async () => {
    log.info("voice: loading whisper model (first use)");
    const sdk = await import("@qvac/sdk");
    const constant = (sdk as unknown as Record<string, unknown>)["WHISPER_BASE_Q8_0"];
    if (!constant) throw new Error("WHISPER_BASE_Q8_0 not exported by @qvac/sdk");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = await (sdk.loadModel as any)({
      modelSrc: constant,
      modelType: "whispercpp-transcription",
      modelConfig: {
        audio_format: "f32le",
        language: "en",
        strategy: "greedy",
        n_threads: 4,
        no_timestamps: true,
        suppress_blank: true,
        suppress_nst: true,
      },
    });
    whisper.modelId = id;
    log.ok(`voice: whisper ready (modelId=${id})`);
    return id;
  })();
  try { return await whisper.loading; }
  finally { whisper.loading = null; }
}

// Transcode browser audio (WebM/Opus) to raw f32le PCM 16kHz mono via ffmpeg.
function transcodeToF32LE(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-ar", "16000",
      "-ac", "1",
      "-sample_fmt", "flt",
      "-f", "f32le",
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    let stderr = "";
    ff.stdout.on("data", c => chunks.push(c));
    ff.stderr.on("data", c => { stderr += String(c); });
    ff.on("close", code => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 300)}`));
    });
    ff.on("error", e => reject(e));
    ff.stdin.end(input);
  });
}

export function registerVoiceRoutes(app: Express): void {
  app.post("/transcribe", requireAuth, async (req: Request, res: Response) => {
    const enabled = await isFeatureEnabled("voice");
    if (!enabled) {
      res.status(400).json({ error: "voice feature not enabled. enable it in settings." });
      return;
    }

    // Read the raw audio bytes from the request body.
    // We use a chunked approach so express.raw's 1mb limit doesn't bite.
    const chunks: Buffer[] = [];
    let bytes = 0;
    const maxBytes = 20 * 1024 * 1024; // 20 MB safety cap
    try {
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
        bytes += (chunk as Buffer).length;
        if (bytes > maxBytes) {
          res.status(413).json({ error: "audio too large (>20 MB)" });
          return;
        }
      }
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "read failed" });
      return;
    }
    if (bytes === 0) {
      res.status(400).json({ error: "empty audio body" });
      return;
    }
    const webm = Buffer.concat(chunks);
    log.info(`voice: received ${bytes} bytes, transcoding…`);

    try {
      const pcm = await transcodeToF32LE(webm);
      if (pcm.length < 16000 * 4) {
        // less than ~1 second of audio, whisper emits [BLANK_AUDIO]
        res.json({ text: "" });
        return;
      }
      const modelId = await ensureWhisperLoaded();
      const sdk = await import("@qvac/sdk");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text: string = await (sdk.transcribe as any)({ modelId, audioChunk: pcm });
      log.ok(`voice: transcribed ${Math.round(pcm.length / (16000 * 4))}s of audio → "${text.slice(0, 80)}"`);
      res.json({ text: text.trim() });
    } catch (e) {
      log.error(`voice: transcription failed: ${e instanceof Error ? e.message : e}`);
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
