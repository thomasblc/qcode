// Core agent loop using @qvac/sdk native tool calling.
//
// Flow:
//   1. Build system prompt + user message + tool catalog
//   2. Call completion({ history, tools }) and get back { text, toolCalls[] }
//   3. If toolCalls.length === 0:
//        - text is the model's final answer. Emit it as an implicit reply()
//          and terminate. This turn is replyOnly (no real work).
//   4. For each toolCall, execute it. Special-case reply() as terminal.
//   5. Push assistant + tool result messages and loop.
//   6. Safety: max iterations, duplicate-call guard, Reflexion-style nudge
//      after 2 consecutive failures.
//
// This replaces the old <tool_call> text-parsing loop. The SDK handles all
// the formatting via the model's native chat template, so we never have to
// worry about the model emitting tags in the wrong format.

import { buildAgentSystemPrompt } from "./prompt.js";
import { toolInputsForMode } from "./tool-schemas.js";
import type { ToolInput } from "./tool-schemas.js";
import { executeToolCall } from "./executor.js";
import type { ChatMessage, ModelBackend, ParsedToolCall } from "./models.js";
import type { ToolContext } from "../tools/index.js";
import type { RuntimeContext } from "./runtime-context.js";
import { log } from "../utils/logger.js";

export type AgentState =
  | "idle"
  | "reading_docs"
  | "thinking"
  | "planning"
  | "executing_tool"
  | "writing_code"
  | "waiting_approval"
  | "error_reflecting"
  | "done";

export interface LoopEvent {
  type: "token" | "assistant_text" | "tool_call" | "tool_result" | "done" | "error" | "iteration" | "state";
  data: unknown;
}

export interface LoopOptions {
  maxIterations?: number;
  onEvent?: (event: LoopEvent) => void;
  signal?: AbortSignal;
  priorContext?: string;
  mode?: "ask" | "plan-first" | "auto-writes" | "yolo";
  projectMemory?: string | null;
  runtimeContext?: RuntimeContext;
  /** Accumulated message history from previous turns. When provided, the
   *  loop prepends these messages (minus duplicate system prompts) before
   *  the new user message. Combined with a sliding-window truncation so
   *  we stay within Qwen3's 8192 token context. */
  existingHistory?: ChatMessage[];
}

export interface LoopResult {
  ok: boolean;
  summary?: string;
  iterations: number;
  error?: string;
  aborted?: boolean;
  messages: ChatMessage[];
  replyOnly?: boolean;
}

const MAX_ITER_DEFAULT = 8;
const MAX_DUPLICATE_CALLS = 2;
/** Rough token count: ~4 chars per token for English/code. */
const TOKEN_BUDGET = 6000;
const SLIDING_WINDOW_SIZE = 20;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build the message array for this turn. When existingHistory is provided
 * (continue turns), we merge it with the new system prompt + user message,
 * dedup system prompts, and apply a sliding-window + token-budget truncation
 * so the total stays within Qwen3's 8192 token context.
 */
function buildMessages(
  systemPrompt: string,
  userContent: string,
  existingHistory?: ChatMessage[],
): ChatMessage[] {
  const newSystem: ChatMessage = { role: "system", content: systemPrompt };
  const newUser: ChatMessage = { role: "user", content: userContent };

  if (!existingHistory || existingHistory.length === 0) {
    return [newSystem, newUser];
  }

  // Strip any existing system messages from history (we always use the fresh one).
  const historyNoSystem = existingHistory.filter(m => m.role !== "system");

  // Combine: fresh system + old conversation + new user message.
  let combined: ChatMessage[] = [newSystem, ...historyNoSystem, newUser];

  // Sliding window: keep system (index 0) + last N messages.
  if (combined.length > SLIDING_WINDOW_SIZE + 1) {
    combined = [combined[0], ...combined.slice(combined.length - SLIDING_WINDOW_SIZE)];
  }

  // Token budget: drop oldest non-system messages until we fit.
  let totalTokens = combined.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  while (totalTokens > TOKEN_BUDGET && combined.length > 2) {
    // Remove the second element (oldest non-system message).
    const removed = combined.splice(1, 1)[0];
    totalTokens -= estimateTokens(removed.content);
  }

  return combined;
}

/**
 * Fallback parser: extract tool calls from assistant text when the SDK's
 * native toolCallStream returns nothing. Some models (Qwen2.5 Coder 3B,
 * smaller Qwen3 variants) emit tool calls as <tool_call>JSON</tool_call>
 * text or as bare JSON objects in the reply. This catches those cases.
 */
function extractFallbackToolCalls(text: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  // Pattern 1: <tool_call>{ "name": "...", "arguments": {...} }</tool_call>
  const tagPattern = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(text)) !== null) {
    const parsed = tryParseToolCallJson(match[1].trim());
    if (parsed) results.push(parsed);
  }
  if (results.length > 0) return results;

  // Pattern 2: bare JSON object with "name" and "arguments" keys.
  // Use brace-balanced extraction to handle nested objects.
  const barePattern = /\{\s*"name"\s*:\s*"/g;
  while ((match = barePattern.exec(text)) !== null) {
    const jsonStr = extractBalancedBraces(text, match.index);
    if (jsonStr) {
      const parsed = tryParseToolCallJson(jsonStr);
      if (parsed) results.push(parsed);
    }
  }
  return results;
}

function tryParseToolCallJson(raw: string): ParsedToolCall | null {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj.name !== "string") return null;
    return {
      id: `fallback_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: obj.name,
      arguments: obj.arguments ?? {},
    };
  } catch {
    return null;
  }
}

/** Extract a brace-balanced JSON substring starting at `start`. */
function extractBalancedBraces(text: string, start: number): string | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function callFingerprint(call: ParsedToolCall): string {
  return call.name + "::" + JSON.stringify(call.arguments);
}

// Strip Qwen3-style <think>...</think> reasoning blocks from the visible
// output. Qwen3 is a reasoning model; the chain of thought is not the user
// facing answer.
//
// The regex handles two cases:
//   1. Closed blocks <think>reasoning</think> (normal case)
//   2. UNCLOSED blocks <think>reasoning... (max_tokens cutoff or abort
//      mid-reasoning) where the rest of the text after <think> is ALL
//      reasoning with no final answer. Without this second branch, the
//      raw reasoning leaks into the user-facing reply bubble when the
//      model is cut short.
function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/g, "")
    .trim();
}

// Turn a tool execution result into a plain-text "tool" message for the
// SDK's chat template. No more <tool_result> tags: the SDK wraps this in
// the model's native role/template.
function toolObservation(name: string, ok: boolean, payload: unknown): string {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  const truncated = body.length > 3000 ? body.slice(0, 3000) + `\n...[truncated ${body.length - 3000} chars]` : body;
  return ok
    ? `[${name} ok]\n${truncated}`
    : `[${name} error]\n${truncated}`;
}

export async function runAgentLoop(
  userTask: string,
  backend: ModelBackend,
  toolCtx: ToolContext,
  opts: LoopOptions = {},
): Promise<LoopResult> {
  const emit = opts.onEvent ?? (() => {});
  const maxIter = opts.maxIterations ?? MAX_ITER_DEFAULT;
  const signal = opts.signal;
  const setState = (state: AgentState, hint?: string) => emit({ type: "state", data: { state, hint } });

  const mode = opts.runtimeContext?.mode ?? opts.mode ?? "ask";
  const tools: ToolInput[] = toolInputsForMode(mode);

  const systemPrompt = opts.runtimeContext
    ? buildAgentSystemPrompt(opts.runtimeContext, opts.projectMemory)
    : buildAgentSystemPrompt(null, opts.projectMemory);

  const taskContent = opts.priorContext ? `${opts.priorContext}${userTask}` : userTask;
  const messages: ChatMessage[] = buildMessages(
    systemPrompt,
    taskContent,
    opts.existingHistory,
  );

  const callHistory = new Map<string, number>();
  let successfulCalls = 0;
  let consecutiveFailures = 0;
  // Aider-style reflection: track the last error so we can feed it back
  // into the next turn's user message when a tool fails. This is the
  // single most important robustness pattern for weak local models,
  // per Aider's aider/coders/base_coder.py::run_one.
  let lastError: string | null = null;

  for (let iter = 1; iter <= maxIter; iter++) {
    if (signal?.aborted) {
      emit({ type: "error", data: { message: "stopped by user" } });
      return { ok: false, error: "stopped by user", aborted: true, iterations: iter - 1, messages, replyOnly: successfulCalls === 0 };
    }
    emit({ type: "iteration", data: { iter } });
    setState("thinking");

    const completion = await backend.complete(
      { messages, tools, signal, temperature: 0.2, maxTokens: 8192 },
      token => emit({ type: "token", data: token }),
    );

    if (completion.stoppedOn === "aborted") {
      emit({ type: "error", data: { message: "stopped by user" } });
      return { ok: false, error: "stopped by user", aborted: true, iterations: iter, messages, replyOnly: successfulCalls === 0 };
    }

    // Always record the assistant's text output (may be empty if the model
    // only emitted tool calls).
    if (completion.text || completion.toolCalls.length > 0) {
      messages.push({ role: "assistant", content: completion.text });
      emit({ type: "assistant_text", data: { text: completion.text, stoppedOn: completion.stoppedOn } });
    }

    // No native tool calls from the SDK. Before treating as a final reply,
    // check if the model embedded tool calls as text (common with Qwen2.5
    // Coder 3B and smaller models that don't use the SDK's chat template).
    if (completion.toolCalls.length === 0) {
      const fallbackCalls = extractFallbackToolCalls(completion.text);
      if (fallbackCalls.length > 0) {
        log.warn(`fallback tool-call parser extracted ${fallbackCalls.length} call(s) from text (SDK native path missed them)`);
        // Inject them back as if the SDK had parsed them natively.
        completion.toolCalls.push(...fallbackCalls);
      }
    }

    // Still no tool calls after fallback: the text is the model's final
    // answer. Treat as reply() and terminate. replyOnly only if no real
    // work was done anywhere in this run.
    if (completion.toolCalls.length === 0) {
      const finalText = stripThinking(completion.text).trim() || "(no response)";
      const implicitReplyOnly = successfulCalls === 0;
      emit({ type: "tool_call", data: { tool: "reply", args: { text: finalText } } });
      emit({ type: "tool_result", data: { tool: "reply", result: { ok: true, text: finalText } } });
      setState("done");
      emit({ type: "done", data: { summary: finalText, reply: implicitReplyOnly } });
      return { ok: true, summary: finalText, iterations: iter, messages, replyOnly: implicitReplyOnly };
    }

    // Execute each tool call in order. We stop on the first terminal tool
    // (reply) or on a duplicate-call guard violation.
    let terminal = false;
    let terminalSummary = "";
    let terminalReplyOnly = false;

    for (const call of completion.toolCalls) {
      if (signal?.aborted) {
        return { ok: false, error: "stopped by user", aborted: true, iterations: iter, messages, replyOnly: successfulCalls === 0 };
      }

      emit({ type: "tool_call", data: { tool: call.name, args: call.arguments } });

      const stateHint: Record<string, AgentState> = {
        read_file: "reading_docs",
        list_dir: "reading_docs",
        grep: "reading_docs",
        write_file: "writing_code",
        bash: "executing_tool",
        diff: "executing_tool",
        propose_plan: "planning",
        reply: "done",
      };
      setState(stateHint[call.name] ?? "executing_tool", call.name);

      // Duplicate-call guard
      const fp = callFingerprint(call);
      const prevCount = callHistory.get(fp) ?? 0;
      callHistory.set(fp, prevCount + 1);
      if (prevCount + 1 > MAX_DUPLICATE_CALLS) {
        emit({ type: "error", data: { message: `duplicate tool call: ${call.name} repeated ${prevCount + 1} times with same args` } });
        terminal = true;
        terminalSummary = `stopped after ${call.name} was called ${prevCount + 1} times with identical args`;
        terminalReplyOnly = successfulCalls === 0;
        break;
      }

      const exec = await executeToolCall({ tool: call.name, args: call.arguments as Record<string, unknown> }, toolCtx);
      emit({ type: "tool_result", data: { tool: exec.toolName, result: exec.toolResult } });

      if (exec.done) {
        // A terminal tool (reply) fired. Use its summary and exit.
        terminal = true;
        terminalSummary = stripThinking(exec.summary ?? "");
        terminalReplyOnly = exec.replyOnly === true && successfulCalls === 0;
        break;
      }

      if (exec.toolResult) {
        if (exec.toolResult.ok) {
          successfulCalls++;
          consecutiveFailures = 0;
          lastError = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } else if ((exec.toolResult as any).rejected === true) {
          // User-initiated rejection (e.g. denied plan approval or write
          // approval). NOT a tool failure in the "the model is confused"
          // sense. Don't increment consecutiveFailures, don't trigger the
          // reflection nudge. The model should respond to the user's
          // rejection on its own in the next turn.
          consecutiveFailures = 0;
          lastError = null;
        } else {
          consecutiveFailures++;
          // Pull the error out of ToolResult for the reflection nudge.
          // ToolResult shape: { ok: false, error?: string }.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const errMsg = (exec.toolResult as any).error ?? "tool returned ok=false";
          lastError = `${call.name} failed: ${String(errMsg).slice(0, 300)}`;
        }
      }

      // Push the tool result as a "tool" role message so the SDK formats it
      // with the model's native chat template.
      messages.push({
        role: "tool",
        content: toolObservation(call.name, exec.toolResult?.ok === true, exec.toolResult ?? exec.observation),
      });
    }

    if (terminal) {
      setState("done");
      emit({ type: "done", data: { summary: terminalSummary, reply: terminalReplyOnly } });
      return { ok: true, summary: terminalSummary, iterations: iter, messages, replyOnly: terminalReplyOnly };
    }

    // Aider-style reflection: after 2 consecutive tool failures, inject a
    // reflection prompt that includes the ACTUAL error message and forces
    // the model to change approach. Per Aider's 3-strike reflection loop.
    if (consecutiveFailures >= 2) {
      setState("error_reflecting");
      const errDetail = lastError ? `\n\nLast error: ${lastError}` : "";
      messages.push({
        role: "user",
        content: `Two tool calls failed in a row.${errDetail}\n\nStop and think: what is actually going wrong? Try a DIFFERENT approach. Different tool, different args, or reply() with an explanation of what you could not do.`,
      });
      consecutiveFailures = 0;
      lastError = null;
    }
  }

  log.warn(`max iterations (${maxIter}) reached`);
  emit({ type: "error", data: { message: `max iterations (${maxIter}) reached` } });
  return {
    ok: false,
    error: `max iterations (${maxIter}) reached`,
    iterations: maxIter,
    messages,
    replyOnly: successfulCalls === 0,
  };
}
