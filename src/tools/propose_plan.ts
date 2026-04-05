import type { Tool } from "./types.js";

// In plan-first mode, the agent MUST call propose_plan before any other tool.
// The plan is surfaced to the user for approval. Once approved, subsequent
// writes are auto-approved for the rest of the session.
export const propose_plan: Tool = {
  name: "propose_plan",
  description: "Propose a plan of steps. User approves the whole plan, then writes are auto-approved. args: { steps: string[], rationale: string }",
  needsApproval: true,
  async run(args, ctx) {
    const steps = Array.isArray(args.steps) ? args.steps.map(s => String(s)) : [];
    const rationale = String(args.rationale ?? "");
    if (steps.length === 0) return { ok: false, error: "missing arg: steps (non-empty array of strings)" };
    const approved = await ctx.requestApproval({ action: "plan", steps, rationale });
    if (!approved.ok) return { ok: false, error: `plan rejected: ${approved.reason}`, rejected: true };
    return { ok: true, approved: true, steps, rationale };
  },
};
