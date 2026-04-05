import { spawn } from "node:child_process";
import { getProjectRoot } from "../utils/paths.js";
import type { Tool } from "./types.js";

// Binaries that can run WITHOUT the user approval prompt. The allowlist only
// applies when the command is a plain invocation of one of these binaries
// with simple arguments. If the command contains ANY shell metacharacter, we
// always require approval. This closes the bypass where the model emitted
// `ls ; rm -rf ~` and the first token `ls` was on the allowlist.
const ALLOWLIST = new Set([
  "pwd", "ls", "cat", "head", "tail", "wc", "grep", "find", "file", "stat",
  "git", "npm", "node", "which", "echo", "date",
]);

// Any of these characters indicates shell composition (chaining, pipes,
// redirection, substitution, globs, newlines). If they appear in the
// command, the allowlist is bypassed and approval is mandatory.
//
// Rejected metacharacters: ; | & > < ` $ ( ) { } [ ] * ? \ ' " \n \r
const META_RE = /[;|&<>`$(){}[\]*?\\'"\n\r]/;

function binaryOf(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

function hasShellMetachars(command: string): boolean {
  return META_RE.test(command);
}

function execBash(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(resolve => {
    // stdio: ignore stdin so commands that read from stdin (cat with no args,
    // git commit without -m, etc.) don't hang until SIGKILL fires.
    const child = spawn("bash", ["-c", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout?.on("data", c => { stdout += String(c); });
    child.stderr?.on("data", c => { stderr += String(c); });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.slice(0, 32_000),
        stderr: killed ? `${stderr}\n(killed after ${timeoutMs}ms)` : stderr.slice(0, 4_000),
        code: code ?? 1,
      });
    });
  });
}

export const bash: Tool = {
  name: "bash",
  description: "Run a shell command. Non-allowlisted commands OR commands with shell metacharacters (;, |, &&, `, $(), >, etc) REQUIRE USER APPROVAL. args: { command: string }",
  needsApproval: true, // runtime-checks the allowlist
  async run(args, ctx) {
    const command = String(args.command ?? "");
    if (!command) return { ok: false, error: "missing arg: command" };
    const binary = binaryOf(command);
    // Allowlist ONLY applies to simple commands. If the model tries to chain
    // or substitute via metachars, approval is mandatory even if the first
    // token is on the allowlist.
    const needsApproval = !ALLOWLIST.has(binary) || hasShellMetachars(command);
    if (needsApproval) {
      const approved = await ctx.requestApproval({ action: "bash", command });
      if (!approved.ok) return { ok: false, error: `bash rejected: ${approved.reason}`, rejected: true };
    }
    const { stdout, stderr, code } = await execBash(command, getProjectRoot(), 30_000);
    if (code === 0) {
      return { ok: true, stdout, stderr, exitCode: code };
    }
    return { ok: false, error: stderr || `exit ${code}`, stdout, stderr, exitCode: code };
  },
};
