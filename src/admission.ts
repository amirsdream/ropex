/**
 * Policy admission — gate tool calls and task enqueue before DeepSeek executes.
 * Deny fails closed; requireApproval marks calls that need a human/agent ack.
 */

import { isToolApproved } from "./approval.js";
import type { ClusterState, Policy, Task } from "./types.js";

export type AdmissionDecision =
  | { status: "allow" }
  | { status: "deny"; reason: string }
  | { status: "approval"; tools: string[]; reason: string };

export function effectivePermissions(policies: Policy[]): {
  deny: string[];
  requireApproval: string[];
  maxReplicas: number;
} {
  const deny = new Set<string>();
  const requireApproval = new Set<string>();
  let maxReplicas = Number.POSITIVE_INFINITY;
  for (const p of policies) {
    maxReplicas = Math.min(maxReplicas, p.spec.maxReplicas);
    for (const d of p.spec.permissions.deny) deny.add(d);
    for (const r of p.spec.permissions.requireApproval) requireApproval.add(r);
  }
  return {
    deny: [...deny],
    requireApproval: [...requireApproval],
    maxReplicas,
  };
}

export function admitTool(
  policies: Policy[],
  tool: string,
  state?: ClusterState,
  ctx?: { taskId?: string; agent?: string },
): AdmissionDecision {
  const perms = effectivePermissions(policies);
  if (perms.deny.includes(tool)) {
    return { status: "deny", reason: `tool denied by policy: ${tool}` };
  }
  if (perms.requireApproval.includes(tool)) {
    if (state && ctx && isToolApproved(state, tool, ctx)) {
      return { status: "allow" };
    }
    return {
      status: "approval",
      tools: [tool],
      reason: `tool requires approval: ${tool}`,
    };
  }
  return { status: "allow" };
}

export function admitCalls(
  policies: Policy[],
  calls: Array<{ name: string; input: Record<string, unknown> }>,
  state?: ClusterState,
  ctx?: { taskId?: string; agent?: string },
): {
  allowed: Array<{ name: string; input: Record<string, unknown> }>;
  denied: Array<{ name: string; reason: string }>;
  needsApproval: Array<{ name: string; reason: string; input: Record<string, unknown> }>;
} {
  const allowed: Array<{ name: string; input: Record<string, unknown> }> = [];
  const denied: Array<{ name: string; reason: string }> = [];
  const needsApproval: Array<{ name: string; reason: string; input: Record<string, unknown> }> = [];

  for (const call of calls) {
    const d = admitTool(policies, call.name, state, ctx);
    if (d.status === "deny") {
      denied.push({ name: call.name, reason: d.reason });
    } else if (d.status === "approval") {
      needsApproval.push({ name: call.name, reason: d.reason, input: call.input });
    } else {
      allowed.push(call);
    }
  }
  return { allowed, denied, needsApproval };
}

/** Block enqueue of tasks that only target denied delivery surfaces (soft check). */
export function admitTask(state: ClusterState, task: Task): AdmissionDecision {
  const perms = effectivePermissions(state.policies);
  for (const tool of perms.deny) {
    if (new RegExp(`\\b${escapeReg(tool)}\\b`, "i").test(task.prompt)) {
      return { status: "deny", reason: `task references denied tool: ${tool}` };
    }
  }
  const approvalHits = perms.requireApproval.filter((t) =>
    new RegExp(`\\b${escapeReg(t)}\\b`, "i").test(task.prompt),
  );
  if (approvalHits.length) {
    // Still enqueue — runtime will create ApprovalRequests; task itself may proceed for other tools.
    return {
      status: "approval",
      tools: approvalHits,
      reason: `task references tools needing approval: ${approvalHits.join(", ")}`,
    };
  }
  return { status: "allow" };
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
