import { createPatch } from "diff";
import type { Tool } from "./types.js";

export const diff_tool: Tool = {
  name: "diff",
  description: "Generate a unified diff between two strings. args: { old: string, new: string, path?: string }",
  needsApproval: false,
  async run(args) {
    const oldText = String(args.old ?? "");
    const newText = String(args.new ?? "");
    const path = String(args.path ?? "file");
    const patch = createPatch(path, oldText, newText, "", "");
    return { ok: true, diff: patch };
  },
};
