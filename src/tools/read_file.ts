import { promises as fs } from "node:fs";
import { resolveInProjectRoot } from "../utils/paths.js";
import type { Tool } from "./types.js";

const MAX_BYTES = 256 * 1024; // refuse to read files > 256KB in one shot

export const read_file: Tool = {
  name: "read_file",
  description: "Read a text file from the project. args: { path: string }",
  needsApproval: false,
  async run(args) {
    const path = String(args.path ?? "");
    if (!path) return { ok: false, error: "missing arg: path" };
    const full = resolveInProjectRoot(path);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) return { ok: false, error: `file not found: ${path}` };
    if (stat.isDirectory()) return { ok: false, error: `not a file (directory): ${path}` };
    if (stat.size > MAX_BYTES) {
      return { ok: false, error: `file too large (${stat.size} bytes, max ${MAX_BYTES}). Use grep instead.` };
    }
    const content = await fs.readFile(full, "utf-8");
    return { ok: true, path, bytes: stat.size, content };
  },
};
