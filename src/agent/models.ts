// Model backend abstraction. Two implementations:
// 1. QvacSdkBackend - uses @qvac/sdk (in-process, native addon, preferred)
// 2. LlamaServerBackend - uses llama-server HTTP API (legacy fallback)

import { loadModel, completion, unloadModel, cancel } from "@qvac/sdk";
import { log } from "../utils/logger.js";
import type { ToolInput } from "./tool-schemas.js";

// "tool" role is the SDK's native role for tool results in the conversation.
// Prior versions of qcode shoved tool results into user messages wrapped in
// <tool_result> tags, which confuses any model trained on a real chat template.
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CompletionOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  stopOnToolCallClose?: boolean;
  signal?: AbortSignal;
  // Native tool calling: pass the tool catalog each completion. The SDK
  // injects them into the model's native chat template and surfaces
  // structured tool calls via toolCallStream.
  tools?: ToolInput[];
  // Sampling knobs (passed through to @qvac/sdk generationParams)
  topP?: number;
  topK?: number;
  repeatPenalty?: number;    // >1.0 discourages token repetition
  frequencyPenalty?: number; // >0 discourages repeated tokens in output
  presencePenalty?: number;  // >0 discourages repeated topics
}

export interface CompletionResult {
  text: string;
  stoppedOn: "eos" | "stop_sequence" | "tool_call_close" | "max_tokens" | "aborted" | "error";
  // Structured tool calls parsed by the SDK from the model's native output.
  // Empty array when no tool calls were made (the text is the final answer).
  toolCalls: ParsedToolCall[];
}

export interface ModelBackend {
  complete(options: CompletionOptions, onToken?: (t: string) => void): Promise<CompletionResult>;
  health(): Promise<boolean>;
}

const TOOL_CALL_CLOSE = "</tool_call>";

// ─── PRIMARY: @qvac/sdk (in-process, no child process needed) ───

export class QvacSdkBackend implements ModelBackend {
  private modelId: string | null = null;
  private currentModelSrc: string | null = null;

  async health(): Promise<boolean> {
    return this.modelId !== null;
  }

  // Accepts either a local file path (string) or an SDK registry constant
  // object (e.g. QWEN3_4B_INST_Q4_K_M). The SDK handles download via its
  // registry when given a constant. Pass `delegate` to route model loading
  // and subsequent completions to a P2P peer via Hyperswarm.
  async load(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelSrc: string | Record<string, any>,
    ctxSize = 8192,
    onProgress?: (p: unknown) => void,
    delegate?: {
      topic: string;
      providerPublicKey: string;
      timeout?: number;
      fallbackToLocal?: boolean;
    },
  ): Promise<void> {
    const srcKey = typeof modelSrc === "string" ? modelSrc : String(modelSrc.name ?? modelSrc.src ?? "unknown");
    const fullKey = delegate ? `${srcKey}@peer:${delegate.providerPublicKey.slice(0, 12)}` : srcKey;
    if (this.modelId && this.currentModelSrc === fullKey) return;
    if (this.modelId) await this.unload();
    log.info(`qvac-sdk: loading ${fullKey}`);
    // Native tool calling is enabled at load time via modelConfig.tools.
    // This lets the SDK's llama.cpp backend parse structured tool_calls
    // out of the model output.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loadOpts: any = {
      modelSrc,
      modelType: "llm",
      modelConfig: { ctx_size: ctxSize, gpu_layers: 99, tools: true },
      onProgress: onProgress ?? ((p: unknown) => {
        const prog = p as { percent?: number; percentage?: number };
        const pct = prog.percent ?? prog.percentage;
        if (pct != null) log.info(`qvac-sdk: download ${Math.round(pct)}%`);
      }),
    };
    if (delegate) {
      loadOpts.delegate = {
        topic: delegate.topic,
        providerPublicKey: delegate.providerPublicKey,
        timeout: delegate.timeout ?? 30_000,
        fallbackToLocal: delegate.fallbackToLocal ?? true,
      };
      log.info(`qvac-sdk: delegating to peer ${delegate.providerPublicKey.slice(0, 16)}... on topic ${delegate.topic.slice(0, 16)}...`);
    }
    this.modelId = await loadModel(loadOpts);
    this.currentModelSrc = fullKey;
    log.ok(`qvac-sdk: loaded (modelId=${this.modelId}${delegate ? ", delegated" : ", local"})`);
  }

  async unload(): Promise<void> {
    if (!this.modelId) return;
    log.info("qvac-sdk: unloading model");
    await unloadModel({ modelId: this.modelId });
    this.modelId = null;
    this.currentModelSrc = null;
  }

  getModelId(): string | null { return this.modelId; }
  getCurrentModelSrc(): string | null { return this.currentModelSrc; }

  async complete(opts: CompletionOptions, onToken?: (t: string) => void): Promise<CompletionResult> {
    if (!this.modelId) throw new Error("no model loaded, call load() first");

    let text = "";
    let stoppedOn: CompletionResult["stoppedOn"] = "eos";
    const toolCalls: ParsedToolCall[] = [];

    const genParams: Record<string, unknown> = {
      temp: opts.temperature ?? 0.2,
      predict: opts.maxTokens ?? 2048,
    };
    if (opts.topP != null) genParams.top_p = opts.topP;
    if (opts.topK != null) genParams.top_k = opts.topK;
    if (opts.repeatPenalty != null) genParams.repeat_penalty = opts.repeatPenalty;
    if (opts.frequencyPenalty != null) genParams.frequency_penalty = opts.frequencyPenalty;
    if (opts.presencePenalty != null) genParams.presence_penalty = opts.presencePenalty;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const completionParams: any = {
      modelId: this.modelId,
      history: opts.messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
      generationParams: genParams,
    };
    if (opts.tools && opts.tools.length > 0) {
      // The SDK accepts ToolInput[] (Zod schemas auto-converted) OR Tool[]
      // (JSON-Schema). We use ToolInput for ergonomics.
      completionParams.tools = opts.tools;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = completion(completionParams as any);

    // Listen for abort
    const abortHandler = () => { cancel({ modelId: this.modelId!, operation: "inference" }); };
    opts.signal?.addEventListener("abort", abortHandler, { once: true });

    // Consume the token stream and the tool-call stream concurrently.
    // Both streams complete when the generation finishes.
    const tokensTask = (async () => {
      try {
        for await (const token of result.tokenStream) {
          if (opts.signal?.aborted) {
            stoppedOn = "aborted";
            break;
          }
          text += token;
          onToken?.(token);
          if (opts.stopOnToolCallClose && text.includes(TOOL_CALL_CLOSE)) {
            stoppedOn = "tool_call_close";
            break;
          }
        }
      } catch (e) {
        if (opts.signal?.aborted) { stoppedOn = "aborted"; return; }
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(`qvac-sdk: tokenStream error: ${msg}`);
        stoppedOn = "error";
      }
    })();

    const toolsTask = (async () => {
      if (!opts.tools || opts.tools.length === 0) return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolCallStream = (result as any).toolCallStream;
        if (!toolCallStream) return;
        for await (const evt of toolCallStream) {
          if (evt?.type === "toolCall" && evt.call) {
            toolCalls.push({
              id: String(evt.call.id ?? `call_${toolCalls.length}`),
              name: String(evt.call.name),
              arguments: (evt.call.arguments ?? {}) as Record<string, unknown>,
            });
          } else if (evt?.type === "toolCallError") {
            log.warn(`qvac-sdk: toolCallError ${evt.error?.code}: ${evt.error?.message}`);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(`qvac-sdk: toolCallStream error: ${msg}`);
      }
    })();

    try {
      await Promise.all([tokensTask, toolsTask]);
    } finally {
      opts.signal?.removeEventListener("abort", abortHandler);
    }

    // Non-blocking stats
    result.stats?.then(s => {
      if (s) log.info(`qvac-sdk: ${s.tokensPerSecond?.toFixed(1)} tok/s, ttft=${s.timeToFirstToken}ms`);
    }).catch(() => {});

    return { text, stoppedOn, toolCalls };
  }
}


// ─── LEGACY FALLBACK: llama-server HTTP ───

export class LlamaServerBackend implements ModelBackend {
  constructor(
    private baseUrl: string = process.env.QCODE_LLAMA_URL ?? "http://127.0.0.1:8080",
  ) {}

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async complete(opts: CompletionOptions, onToken?: (t: string) => void): Promise<CompletionResult> {
    const body = {
      model: "qwen2.5-coder",
      messages: opts.messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 2048,
      stream: true,
      stop: opts.stop,
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) return { text: "", stoppedOn: "aborted", toolCalls: [] };
      throw e;
    }
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      throw new Error(`llama-server HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let text = "";
    let finishReason: string | null = null;
    let stoppedOn: CompletionResult["stoppedOn"] = "eos";

    outer: while (true) {
      if (opts.signal?.aborted) {
        stoppedOn = "aborted";
        try { await reader.cancel(); } catch { /* noop */ }
        break;
      }
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch {
        if (opts.signal?.aborted) { stoppedOn = "aborted"; break; }
        throw new Error("stream read failed");
      }
      const { done, value } = readResult;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") break outer;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            onToken?.(delta);
            if (opts.stopOnToolCallClose && text.includes(TOOL_CALL_CLOSE)) {
              stoppedOn = "tool_call_close";
              try { await reader.cancel(); } catch { /* noop */ }
              break outer;
            }
          }
          const fr = parsed.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr;
        } catch {
          // ignore malformed chunks
        }
      }
    }

    if (stoppedOn !== "tool_call_close") {
      if (finishReason === "stop") stoppedOn = "stop_sequence";
      else if (finishReason === "length") stoppedOn = "max_tokens";
    }

    return { text, stoppedOn, toolCalls: [] };
  }
}
