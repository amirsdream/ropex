/**
 * Fleet-wide policy simulation report — dry-run admission across agents/prompts.
 */

import { policyDryRun, type PolicyDryRunReport } from "./policy.js";
import type { ClusterState } from "./types.js";

export type PolicySimRow = {
  agent: string;
  prompt: string;
  taskDenied: boolean;
  callsDenied: string[];
  callsNeedApproval: string[];
  report: PolicyDryRunReport;
};

export type PolicySimReport = {
  at: string;
  rows: PolicySimRow[];
  deniedTasks: number;
  deniedCalls: number;
  approvalCalls: number;
};

export type PolicySimOptions = {
  /** Prompts to simulate (default: one generic probe per agent). */
  prompts?: string[];
  /** Limit agents (default: all desired). */
  agents?: string[];
};

/**
 * Run policy dry-run for each desired agent × prompt without mutating queue/workers.
 */
export function simulatePolicies(state: ClusterState, opts: PolicySimOptions = {}): PolicySimReport {
  const prompts = opts.prompts?.length ? opts.prompts : ["probe: list open issues"];
  const agents = (state.desired ?? []).filter(
    (a) => !opts.agents || opts.agents.includes(a.metadata.name),
  );
  const rows: PolicySimRow[] = [];
  let deniedTasks = 0;
  let deniedCalls = 0;
  let approvalCalls = 0;

  for (const agent of agents) {
    for (const prompt of prompts) {
      const report = policyDryRun(state, {
        id: `sim-${agent.metadata.name}-${rows.length}`,
        agent: agent.metadata.name,
        prompt,
      });
      const taskDenied = report.taskAdmission.status === "deny";
      if (taskDenied) deniedTasks += 1;
      const callsDenied = report.callAdmission.denied.map((d) => d.name);
      const callsNeedApproval = report.callAdmission.needsApproval.map((d) => d.name);
      deniedCalls += callsDenied.length;
      approvalCalls += callsNeedApproval.length;
      rows.push({
        agent: agent.metadata.name,
        prompt,
        taskDenied,
        callsDenied,
        callsNeedApproval,
        report,
      });
    }
  }

  return {
    at: new Date().toISOString(),
    rows,
    deniedTasks,
    deniedCalls,
    approvalCalls,
  };
}
