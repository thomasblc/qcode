import { read_file } from "./read_file.js";
import { write_file } from "./write_file.js";
import { list_dir } from "./list_dir.js";
import { grep } from "./grep.js";
import { bash } from "./bash.js";
import { diff_tool } from "./diff.js";
import { propose_plan } from "./propose_plan.js";
import { reply } from "./reply.js";
import type { Tool } from "./types.js";

export const TOOLS: Record<string, Tool> = {
  read_file,
  write_file,
  list_dir,
  grep,
  bash,
  diff: diff_tool,
  propose_plan,
  reply,
};

export type { Tool, ToolContext, ToolResult, ApprovalRequest, ApprovalDecision } from "./types.js";
