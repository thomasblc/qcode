// System prompt builder for the native-tool-calling agent loop.
//
// With @qvac/sdk native tool calling, the tool catalog is passed via
// completion({ tools }) and embedded in the model's chat template by
// the SDK. We DO NOT describe tools in the system prompt anymore: that
// was fighting a losing battle on weak models. Our system prompt is
// now compact (~500 tokens target) and describes: identity, mode,
// conversation rules, project memory.

import type { PermissionMode } from "../server/sessions.js";
import type { RuntimeContext } from "./runtime-context.js";
import { renderRuntimeContextBlock } from "./runtime-context.js";

const BASE_RULES = `You are qcode, a local coding agent running on the user's Mac via @qvac/sdk.

Your job is to help with coding tasks inside the current project. You have tools for reading, writing, listing, searching, and running shell commands. Use them to do real work when the user asks. For greetings, small-talk, or conversational questions, call the reply tool and say something natural.

Rules:
1. One task per turn. Do ONLY what the user asked. No uninvited exploration.
2. Read a file before modifying it. Never invent file contents.
3. Keep tool calls minimal. Stop as soon as the task is complete.
4. For greetings ("hi", "hello", "how are you"), call reply() with a short natural response.
5. CRITICAL: When the user asks you to CREATE or MODIFY a file, you MUST call write_file with the FULL file content. NEVER reply with code in text. NEVER say "here is how to do it" without actually writing the file. DO the work, don't describe it.
6. If read_file fails with "not found", DO NOT conclude the file is missing. Call list_dir(".") or list_dir of the likely parent directory to see what actually exists, THEN retry with the correct path. Only answer "file does not exist" after you have verified with list_dir.
7. When the user asks for a file by name without a path (e.g. "the README", "package.json"), try the project root first (README.md). The same filename may also exist in subdirectories; if the user mentions one, honour it.
8. Keep <think> blocks under 200 tokens. No long reasoning. Decide quickly, then act.
9. For complex tasks (50+ lines of code), break into steps: write HTML structure first, then CSS, then JS. Call write_file for each step, reading the file before each modification.
10. After writing a file, ALWAYS call reply() confirming what you wrote: "Created game.html with a tic-tac-toe game (150 lines)."
11. When the user asks about a previous action ("where is the file?", "did you do it?"), check project files with list_dir or read_file BEFORE answering. Never guess.`;

const MODE_INSTRUCTIONS: Record<PermissionMode, string> = {
  "ask": "Permission mode: ASK. Write and destructive bash tools require user approval.",
  "plan-first": "Permission mode: PLAN-FIRST. Start by calling propose_plan with steps and rationale. After approval, writes auto-execute.",
  "auto-writes": "Permission mode: AUTO-WRITES. Writes are auto-approved. Destructive bash still asks.",
  "yolo": "Permission mode: YOLO. All tool calls auto-approved. Act fast.",
};

export function buildAgentSystemPrompt(
  ctx: RuntimeContext | null,
  projectMemory?: string | null,
): string {
  const sections: string[] = [BASE_RULES];
  if (ctx) {
    sections.push(renderRuntimeContextBlock(ctx));
    sections.push(MODE_INSTRUCTIONS[ctx.mode]);
  } else {
    sections.push(MODE_INSTRUCTIONS.ask);
  }
  if (projectMemory) {
    sections.push(`---\n\n## Project context\n\n${projectMemory}`);
  }
  return sections.join("\n\n");
}

// Back-compat shims for CLI and legacy callers that still expect the old
// names. They just delegate to the new builder.
export function buildSystemPromptWithContext(
  ctx: RuntimeContext,
  projectMemory?: string | null,
): string {
  return buildAgentSystemPrompt(ctx, projectMemory);
}

export function buildSystemPrompt(_mode: PermissionMode, projectMemory?: string | null): string {
  return buildAgentSystemPrompt(null, projectMemory);
}

export function buildInitialMessages(
  userTask: string,
  mode: PermissionMode = "ask",
  projectMemory?: string | null,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  return [
    { role: "system", content: buildSystemPrompt(mode, projectMemory) },
    { role: "user", content: userTask },
  ];
}

export const SYSTEM_PROMPT = buildSystemPrompt("ask");
