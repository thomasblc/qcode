#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { LlamaServerBackend } from "./agent/models.js";
import { runAgentLoop } from "./agent/loop.js";
import { setProjectRoot } from "./utils/paths.js";
import { log } from "./utils/logger.js";
import type { ApprovalRequest, ApprovalDecision, ToolContext } from "./tools/index.js";

function parseArgs(argv: string[]): { task: string; projectRoot: string; autoApprove: boolean } {
  const args = argv.slice(2);
  let projectRoot = process.cwd();
  let autoApprove = false;
  const taskParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--root" && i + 1 < args.length) { projectRoot = args[++i]; continue; }
    if (a === "--yes" || a === "-y") { autoApprove = true; continue; }
    if (a === "--help" || a === "-h") {
      console.log(`qcode: local coding agent built on QVAC Fabric LLM

usage:
  qcode [--root <path>] [--yes] "<task>"

flags:
  --root <path>   project directory the agent can read/write in (default: cwd)
  --yes, -y       auto-approve all writes and unsafe bash (demo mode, be careful)
  --help, -h      show this help

the agent expects llama-server running on http://127.0.0.1:8080
start it with: npm run llama:start
`);
      process.exit(0);
    }
    taskParts.push(a);
  }
  return { task: taskParts.join(" ").trim(), projectRoot, autoApprove };
}

async function askHuman(question: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function buildCliToolContext(autoApprove: boolean): ToolContext {
  return {
    async requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
      if (autoApprove) {
        log.warn(`auto-approving ${req.action}`);
        return { ok: true };
      }
      console.log("\n" + "─".repeat(60));
      if (req.action === "write_file") {
        console.log(`approval needed: write_file ${req.path}`);
        console.log("─".repeat(60));
        console.log(req.diff);
      } else if (req.action === "bash") {
        console.log(`approval needed: bash`);
        console.log("─".repeat(60));
        console.log(`$ ${req.command}`);
      } else if (req.action === "plan") {
        console.log(`approval needed: plan`);
        console.log("─".repeat(60));
        console.log(`rationale: ${req.rationale}`);
        console.log("steps:");
        for (const [i, step] of req.steps.entries()) console.log(`  ${i + 1}. ${step}`);
      }
      console.log("─".repeat(60));
      const answer = (await askHuman("approve? [y/N] ")).toLowerCase();
      if (answer === "y" || answer === "yes") return { ok: true };
      return { ok: false, reason: "user rejected" };
    },
  };
}

async function main() {
  const { task, projectRoot, autoApprove } = parseArgs(process.argv);
  if (!task) {
    console.error('usage: qcode "<task description>"');
    process.exit(1);
  }

  setProjectRoot(projectRoot);
  log.info(`project root: ${projectRoot}`);

  const backend = new LlamaServerBackend();
  const healthy = await backend.health();
  if (!healthy) {
    log.error("llama-server not reachable at http://127.0.0.1:8080");
    log.error("start it with: npm run llama:start");
    process.exit(1);
  }
  log.ok("connected to QVAC Fabric LLM (llama-server)");
  log.info(`task: ${task}`);

  const ctx = buildCliToolContext(autoApprove);

  const result = await runAgentLoop(task, backend, ctx, {
    onEvent: (event) => {
      switch (event.type) {
        case "iteration":
          console.log(`\n── iteration ${(event.data as { iter: number }).iter} ──`);
          break;
        case "token":
          log.raw(String(event.data));
          break;
        case "assistant_text":
          console.log();
          break;
        case "tool_call": {
          const c = event.data as { tool: string; args: Record<string, unknown> };
          log.info(`tool → ${c.tool}(${JSON.stringify(c.args).slice(0, 120)})`);
          break;
        }
        case "tool_result": {
          const r = event.data as { tool: string; result: { ok: boolean } | null };
          if (r.tool === "done" || r.result === null) break;
          log.info(`tool ← ${r.tool} [${r.result.ok ? "ok" : "fail"}]`);
          break;
        }
        case "done":
          log.ok(`done: ${(event.data as { summary: string }).summary}`);
          break;
        case "error":
          log.error(String((event.data as { message: string }).message));
          break;
      }
    },
  });

  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  log.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
