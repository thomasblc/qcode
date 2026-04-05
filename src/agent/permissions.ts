import type { PermissionMode, Session } from "../server/sessions.js";
import type { ToolContext, ApprovalRequest, ApprovalDecision } from "../tools/index.js";
import { updateSession } from "../server/sessions.js";

// Wraps a base ToolContext with mode-aware approval logic.
// The base context is responsible for ACTUALLY surfacing the approval request to
// the user (via SSE event in the server, via terminal prompt in the CLI).
// This wrapper decides whether to ask at all based on the mode + plan state.
export function wrapToolContextWithMode(
  base: ToolContext,
  sessionId: string,
  getMode: () => PermissionMode,
  getPlanApproved: () => boolean,
): ToolContext {
  return {
    async requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
      const mode = getMode();

      // YOLO: approve everything
      if (mode === "yolo") return { ok: true };

      // Plan approvals always go through (user must see the plan)
      if (req.action === "plan") {
        const decision = await base.requestApproval(req);
        if (decision.ok) {
          updateSession(sessionId, { planApproved: true });
        }
        return decision;
      }

      // Plan-first mode: once the plan is approved, auto-approve writes & bash
      if (mode === "plan-first" && getPlanApproved()) {
        return { ok: true };
      }

      // auto-writes: write_file goes through, bash still asks
      if (mode === "auto-writes" && req.action === "write_file") {
        return { ok: true };
      }

      // Default: delegate to base (which asks the user)
      return base.requestApproval(req);
    },
  };
}
