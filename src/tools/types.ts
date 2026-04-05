export type ApprovalRequest =
  | { action: "write_file"; path: string; diff: string }
  | { action: "bash"; command: string }
  | { action: "plan"; steps: string[]; rationale: string };

export type ApprovalDecision =
  | { ok: true }
  | { ok: false; reason: string };

export interface ToolContext {
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

export type ToolResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string; rejected?: boolean };

export interface Tool {
  name: string;
  description: string;
  needsApproval: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}
