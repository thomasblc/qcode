import { promises as fs } from "node:fs";
import path from "node:path";
import { createPatch } from "diff";
import { resolveInProjectRoot } from "../utils/paths.js";
import type { Tool } from "./types.js";

export const write_file: Tool = {
  name: "write_file",
  description: "Write content to a file (creates or overwrites). REQUIRES USER APPROVAL. args: { path: string, content: string }",
  needsApproval: true,
  async run(args, ctx) {
    const targetPath = String(args.path ?? "");
    const content = String(args.content ?? "");
    if (!targetPath) return { ok: false, error: "missing arg: path" };

    const full = resolveInProjectRoot(targetPath);
    const existed = await fs.stat(full).then(() => true).catch(() => false);
    const oldContent = existed ? await fs.readFile(full, "utf-8") : "";
    const diffText = createPatch(targetPath, oldContent, content, "", "");

    const approved = await ctx.requestApproval({ action: "write_file", path: targetPath, diff: diffText });
    if (!approved.ok) {
      return { ok: false, error: `write rejected: ${approved.reason}`, rejected: true };
    }

    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf-8");
    return { ok: true, path: targetPath, bytesWritten: Buffer.byteLength(content, "utf-8"), created: !existed };
  },
};
