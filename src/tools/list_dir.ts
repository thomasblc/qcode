import { promises as fs } from "node:fs";
import { resolveInProjectRoot } from "../utils/paths.js";
import type { Tool } from "./types.js";

const IGNORE = new Set(["node_modules", ".git", "dist", ".next", "vendor", "models", ".qcode-state"]);

export const list_dir: Tool = {
  name: "list_dir",
  description: "List entries of a directory. args: { path: string }",
  needsApproval: false,
  async run(args) {
    const target = String(args.path ?? ".");
    const full = resolveInProjectRoot(target);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) return { ok: false, error: `not found: ${target}` };
    if (!stat.isDirectory()) return { ok: false, error: `not a directory: ${target}` };
    const entries = await fs.readdir(full, { withFileTypes: true });
    const result = entries
      .filter(e => !IGNORE.has(e.name))
      .map(e => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" as const }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { ok: true, path: target, entries: result };
  },
};
