import { randomBytes } from "node:crypto";
import type { ApprovalRequest, ApprovalDecision } from "../tools/index.js";

// An approval request parked in memory until the user hits /approvals.
interface PendingApproval {
  approvalId: string;
  sessionId: string;
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  createdAt: number;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingApproval>();
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // spec §9 risk 7: 5-min timeout

export function newApprovalId(): string {
  return randomBytes(9).toString("base64url");
}

export function parkApproval(
  sessionId: string,
  request: ApprovalRequest,
): { approvalId: string; wait: Promise<ApprovalDecision> } {
  const approvalId = newApprovalId();
  const wait = new Promise<ApprovalDecision>(resolve => {
    const timer = setTimeout(() => {
      pending.delete(approvalId);
      resolve({ ok: false, reason: "timeout (5 min)" });
    }, APPROVAL_TIMEOUT_MS);
    pending.set(approvalId, { approvalId, sessionId, request, resolve, createdAt: Date.now(), timer });
  });
  return { approvalId, wait };
}

export function resolveApproval(approvalId: string, decision: ApprovalDecision): boolean {
  const entry = pending.get(approvalId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(approvalId);
  entry.resolve(decision);
  return true;
}

export function getPending(approvalId: string): PendingApproval | undefined {
  return pending.get(approvalId);
}
