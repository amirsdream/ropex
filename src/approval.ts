/**
 * Approval workflow — Policy.requireApproval tools pause until approve/reject.
 */

import type { ApprovalRequest, ClusterState } from "./types.js";

export function ensureApprovals(state: ClusterState): void {
  if (!state.approvals) state.approvals = [];
}

export function requestApprovals(
  state: ClusterState,
  opts: {
    taskId: string;
    agent: string;
    workerId: string;
    tools: Array<{ name: string; reason: string; input?: Record<string, unknown> }>;
  },
): ApprovalRequest[] {
  ensureApprovals(state);
  const created: ApprovalRequest[] = [];
  for (const t of opts.tools) {
    const existing = state.approvals.find(
      (a) =>
        a.status === "pending" &&
        a.tool === t.name &&
        a.taskId === opts.taskId &&
        a.agent === opts.agent,
    );
    if (existing) {
      created.push(existing);
      continue;
    }
    const rec: ApprovalRequest = {
      id: `apr-${opts.taskId}-${t.name}-${Date.now()}`,
      at: new Date().toISOString(),
      status: "pending",
      tool: t.name,
      taskId: opts.taskId,
      agent: opts.agent,
      workerId: opts.workerId,
      reason: t.reason,
      input: t.input,
    };
    state.approvals.push(rec);
    created.push(rec);
  }
  return created;
}

/** True if this tool is approved for the task (preferred) or same agent. */
export function isToolApproved(
  state: ClusterState,
  tool: string,
  ctx: { taskId?: string; agent?: string },
): boolean {
  ensureApprovals(state);
  return state.approvals.some((a) => {
    if (a.status !== "approved" || a.tool !== tool) return false;
    if (ctx.taskId && a.taskId === ctx.taskId) return true;
    if (ctx.agent && a.agent === ctx.agent && a.taskId === ctx.taskId) return true;
    return false;
  });
}

export function decideApproval(
  state: ClusterState,
  id: string,
  decision: "approved" | "rejected",
): ApprovalRequest | undefined {
  ensureApprovals(state);
  const rec = state.approvals.find((a) => a.id === id);
  if (!rec || rec.status !== "pending") return undefined;
  rec.status = decision;
  rec.decidedAt = new Date().toISOString();
  return rec;
}

export function pendingApprovals(state: ClusterState): ApprovalRequest[] {
  ensureApprovals(state);
  return state.approvals.filter((a) => a.status === "pending");
}
