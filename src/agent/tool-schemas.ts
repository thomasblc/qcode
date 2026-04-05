// Zod schemas for each qcode tool, wrapped as SDK ToolInput[].
//
// Passed to @qvac/sdk's completion({ tools }) so the model's native chat
// template handles tool calling. No more custom <tool_call> JSON parsing.
//
// These schemas MUST match the runtime validation in src/tools/*.ts. When
// a tool gains or loses a parameter, update both sides.

import { z } from "zod";

// The SDK's ToolInput type expects { name, description, parameters: ZodObject }.
// We don't import ToolInput directly because that pulls in SDK internals;
// instead we shape objects that structurally match.
export interface ToolInput {
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters: z.ZodObject<any>;
}

export const readFileSchema = z.object({
  path: z.string().describe("Path relative to project root"),
  limit: z.number().int().positive().optional().describe("Max number of lines to read"),
  offset: z.number().int().nonnegative().optional().describe("Line number to start from (0-indexed)"),
});

export const writeFileSchema = z.object({
  path: z.string().describe("Path relative to project root"),
  content: z.string().describe("Full file content to write"),
});

export const listDirSchema = z.object({
  path: z.string().describe("Directory path relative to project root"),
});

export const grepSchema = z.object({
  pattern: z.string().describe("Regex pattern to search for"),
  path: z.string().optional().describe("Optional path or glob to limit the search"),
});

export const bashSchema = z.object({
  command: z.string().describe("Shell command to execute from the project root"),
});

export const diffSchema = z.object({
  old: z.string().describe("Old content"),
  new: z.string().describe("New content"),
  path: z.string().optional().describe("Optional file path for header"),
});

export const proposePlanSchema = z.object({
  steps: z.array(z.string()).describe("Ordered list of steps the agent will take"),
  rationale: z.string().describe("One-paragraph rationale for this plan"),
});

export const replySchema = z.object({
  text: z.string().describe("The plain-text reply shown to the user. Ends the turn."),
});

// Catalog of all tools. The loop filters this per mode (e.g. propose_plan
// is only included in plan-first mode).
export const ALL_TOOL_INPUTS: ToolInput[] = [
  {
    name: "reply",
    description: "Reply to the user with plain text. Use for greetings, small-talk, explanations, clarification questions. Ends the turn.",
    parameters: replySchema,
  },
  {
    name: "read_file",
    description: "Read a file from the project. Returns its text content.",
    parameters: readFileSchema,
  },
  {
    name: "write_file",
    description: "Write a complete file. Creates it if missing, overwrites if present.",
    parameters: writeFileSchema,
  },
  {
    name: "list_dir",
    description: "List entries of a directory (files and subdirectories).",
    parameters: listDirSchema,
  },
  {
    name: "grep",
    description: "Search file contents with ripgrep. Returns matching lines with line numbers.",
    parameters: grepSchema,
  },
  {
    name: "bash",
    description: "Run a shell command from the project root. Use for git, npm, tests, and similar. May require approval.",
    parameters: bashSchema,
  },
  {
    name: "diff",
    description: "Produce a unified diff between two strings.",
    parameters: diffSchema,
  },
  {
    name: "propose_plan",
    description: "Propose a plan to the user before touching files. Used only in plan-first mode.",
    parameters: proposePlanSchema,
  },
];

// Filter the catalog by mode and available features.
export function toolInputsForMode(mode: "ask" | "plan-first" | "auto-writes" | "yolo"): ToolInput[] {
  if (mode === "plan-first") return ALL_TOOL_INPUTS;
  return ALL_TOOL_INPUTS.filter(t => t.name !== "propose_plan");
}
