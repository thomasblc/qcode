import { spawn } from "node:child_process";
import { getProjectRoot, resolveInProjectRoot } from "../utils/paths.js";
import type { Tool } from "./types.js";

function runRg(args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  return new Promise(resolve => {
    const child = spawn("rg", args, { cwd, env: process.env });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.on("close", code => resolve({ stdout, code: code ?? 1 }));
    child.on("error", () => resolve({ stdout: "", code: 127 }));
  });
}

export const grep: Tool = {
  name: "grep",
  description: "Search for a regex pattern in files (ripgrep). args: { pattern: string, path?: string }",
  needsApproval: false,
  async run(args) {
    const pattern = String(args.pattern ?? "");
    if (!pattern) return { ok: false, error: "missing arg: pattern" };
    const targetPath = args.path ? String(args.path) : ".";
    const full = resolveInProjectRoot(targetPath);
    // `--` before the pattern prevents rg from interpreting a pattern that
    // starts with `-` as a flag (argument confusion). Keep the limits low
    // so a pathological regex can't burn too much CPU.
    const { stdout, code } = await runRg(
      ["-n", "--max-count", "50", "--max-columns", "300", "--", pattern, full],
      getProjectRoot(),
    );
    if (code === 127) return { ok: false, error: "ripgrep (rg) not installed" };
    if (code === 1) return { ok: true, pattern, path: targetPath, matches: "(no matches)" };
    return { ok: true, pattern, path: targetPath, matches: stdout.trim() || "(no matches)" };
  },
};
