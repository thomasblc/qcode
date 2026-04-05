import { TOOLS, type ToolContext, type ToolResult } from "../tools/index.js";

// Structural shape the executor accepts. Compatible with both the legacy
// parser output and the new SDK native tool calls (which come through
// loop.ts mapped onto this shape).
export interface ExecutorCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ExecutorResult {
  observation: string;
  done: boolean;
  summary?: string;
  toolName: string;
  toolResult: ToolResult | null;
  // True when the terminal tool was `reply` (conversational). Lets callers
  // distinguish "the model said something" from "the model did real work",
  // which matters for prior-context filtering (a chat reply must NOT be
  // persisted as 'previously completed work' for future turns).
  replyOnly?: boolean;
}

export async function executeToolCall(call: ExecutorCall, ctx: ToolContext): Promise<ExecutorResult> {
  if (call.tool === "done") {
    const summary = String((call.args as Record<string, unknown>).summary ?? "done");
    return { observation: "", done: true, summary, toolName: "done", toolResult: null };
  }

  const tool = TOOLS[call.tool];
  if (!tool) {
    return {
      observation: `<tool_error>unknown tool: "${call.tool}". Available: ${Object.keys(TOOLS).join(", ")}, done</tool_error>`,
      done: false,
      toolName: call.tool,
      toolResult: null,
    };
  }

  let result: ToolResult;
  try {
    result = await tool.run(call.args, ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result = { ok: false, error: msg };
  }

  // reply() is terminal: it ends the turn with the user-facing text as the
  // summary, marked as replyOnly so the router/persistence layer knows this
  // turn didn't do real work.
  if (call.tool === "reply" && result.ok) {
    const text = String((result as { ok: true; text?: unknown }).text ?? "").trim();
    return {
      observation: "",
      done: true,
      summary: text || "(empty reply)",
      toolName: "reply",
      toolResult: result,
      replyOnly: true,
    };
  }

  return {
    observation: formatObservation(call.tool, result),
    done: false,
    toolName: call.tool,
    toolResult: result,
  };
}

function formatObservation(toolName: string, result: ToolResult): string {
  // Keep observations compact. The model pays for every token.
  // read_file gets aggressive truncation since it dominates context usage.
  const maxLen = toolName === "read_file" ? 2500 : 3000;
  const payload = truncateLongStrings(result, maxLen);
  return `<tool_result tool="${toolName}">\n${JSON.stringify(payload, null, 2)}\n</tool_result>`;
}

function truncateLongStrings(value: unknown, maxLen: number): unknown {
  if (typeof value === "string") {
    if (value.length <= maxLen) return value;
    return value.slice(0, maxLen) + `\n…[truncated ${value.length - maxLen} chars]`;
  }
  if (Array.isArray(value)) return value.map(v => truncateLongStrings(v, maxLen));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateLongStrings(v, maxLen);
    return out;
  }
  return value;
}
