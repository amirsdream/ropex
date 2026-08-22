/**
 * Per-fleet / agent / cluster task-unit budget accounting.
 * Policy.spec.budget gates enqueue when the rolling window is exhausted.
 */

import { recordAudit } from "./audit.js";
import type {
  BudgetLedger,
  ClusterState,
  HarnessProfile,
  Policy,
  Task,
} from "./types.js";

export const DEFAULT_BUDGET_WINDOW_MS = 60 * 60_000;

/** Relative cost by harness profile (abstract units). */
export const PROFILE_UNIT_COST: Record<HarnessProfile, number> = {
  minimal: 1,
  standard: 2,
  code: 3,
  creator: 4,
};

export type BudgetStatus = {
  key: string;
  scope: "cluster" | "fleet" | "agent";
  spent: number;
  limit: number;
  remaining: number;
  windowStartedAt: string;
  windowMs: number;
  exhausted: boolean;
};

/** Alert level for budget remaining ratio (default warn below 20%). */
export type BudgetAlertLevel = "ok" | "warn" | "exhausted";

export type BudgetAlert = BudgetStatus & {
  level: BudgetAlertLevel;
  remainingPct: number;
};

export function budgetAlertLevel(
  row: Pick<BudgetStatus, "remaining" | "limit" | "exhausted">,
  warnPct = 0.2,
): BudgetAlertLevel {
  if (row.exhausted || row.remaining <= 0) return "exhausted";
  if (row.limit > 0 && row.remaining / row.limit <= warnPct) return "warn";
  return "ok";
}

export function budgetAlerts(
  state: ClusterState,
  opts: { now?: number; warnPct?: number } = {},
): BudgetAlert[] {
  const warnPct = opts.warnPct ?? 0.2;
  return budgetReport(state, { now: opts.now }).map((row) => ({
    ...row,
    level: budgetAlertLevel(row, warnPct),
    remainingPct: row.limit > 0 ? Math.round((100 * row.remaining) / row.limit) : 0,
  }));
}

export function ensureBudgets(state: ClusterState): void {
  if (!state.budgets) state.budgets = [];
}

export function budgetPolicies(policies: Policy[]): Policy[] {
  return (policies ?? []).filter((p) => p.spec.budget && p.spec.budget.maxUnits > 0);
}

function resolveScopeKey(
  scope: "cluster" | "fleet" | "agent",
  ctx: { agent?: string; fleet?: string },
): string {
  if (scope === "fleet") return `fleet:${ctx.fleet ?? ctx.agent ?? "unknown"}`;
  if (scope === "agent") return `agent:${ctx.agent ?? "unknown"}`;
  return "cluster";
}

function activeBudgetPolicy(policies: Policy[]): Policy | undefined {
  // Tightest maxUnits wins when multiple budgets exist.
  const withBudget = budgetPolicies(policies);
  if (!withBudget.length) return undefined;
  return withBudget.reduce((a, b) =>
    (a.spec.budget!.maxUnits <= b.spec.budget!.maxUnits ? a : b),
  );
}

function rollWindow(ledger: BudgetLedger, windowMs: number, now: number): void {
  const start = Date.parse(ledger.windowStartedAt);
  if (!Number.isFinite(start) || now - start >= windowMs) {
    ledger.windowStartedAt = new Date(now).toISOString();
    ledger.units = 0;
  }
}

export function budgetStatus(
  state: ClusterState,
  ctx: { agent?: string; fleet?: string } = {},
  opts: { now?: number } = {},
): BudgetStatus | null {
  ensureBudgets(state);
  const policy = activeBudgetPolicy(state.policies ?? []);
  if (!policy?.spec.budget) return null;
  const scope = policy.spec.budget.scope ?? "cluster";
  const key = resolveScopeKey(scope, ctx);
  const windowMs = policy.spec.budget.windowMs ?? DEFAULT_BUDGET_WINDOW_MS;
  const now = opts.now ?? Date.now();
  let ledger = state.budgets.find((b) => b.key === key);
  if (!ledger) {
    ledger = { key, windowStartedAt: new Date(now).toISOString(), units: 0 };
    state.budgets.push(ledger);
  }
  rollWindow(ledger, windowMs, now);
  const limit = policy.spec.budget.maxUnits;
  const remaining = Math.max(0, limit - ledger.units);
  return {
    key,
    scope,
    spent: ledger.units,
    limit,
    remaining,
    windowStartedAt: ledger.windowStartedAt,
    windowMs,
    exhausted: remaining <= 0,
  };
}

export function estimateTaskUnits(
  state: ClusterState,
  task: Task,
): number {
  const agent = state.desired.find((a) => a.metadata.name === task.agent);
  const profile = agent?.spec.harness.profile ?? "standard";
  return PROFILE_UNIT_COST[profile] ?? 1;
}

/**
 * Deny when charging `units` would exceed the active Policy budget.
 */
export function admitBudget(
  state: ClusterState,
  task: Task,
  opts: { now?: number; units?: number } = {},
): { status: "allow" } | { status: "deny"; reason: string } {
  const agent = state.desired.find((a) => a.metadata.name === task.agent);
  const status = budgetStatus(
    state,
    { agent: task.agent, fleet: agent?.derivedFrom?.fleet },
    { now: opts.now },
  );
  if (!status) return { status: "allow" };
  const units = opts.units ?? estimateTaskUnits(state, task);
  if (status.remaining < units) {
    return {
      status: "deny",
      reason: `budget exhausted for ${status.key}: spent ${status.spent}/${status.limit}, need ${units}`,
    };
  }
  return { status: "allow" };
}

/**
 * Charge units after a successful task (or on enqueue reservation).
 */
export function chargeBudget(
  state: ClusterState,
  task: Task,
  opts: { now?: number; units?: number; workerId?: string } = {},
): BudgetStatus | null {
  ensureBudgets(state);
  const agent = state.desired.find((a) => a.metadata.name === task.agent);
  const policy = activeBudgetPolicy(state.policies ?? []);
  if (!policy?.spec.budget) return null;
  const scope = policy.spec.budget.scope ?? "cluster";
  const key = resolveScopeKey(scope, {
    agent: task.agent,
    fleet: agent?.derivedFrom?.fleet,
  });
  const windowMs = policy.spec.budget.windowMs ?? DEFAULT_BUDGET_WINDOW_MS;
  const now = opts.now ?? Date.now();
  let ledger = state.budgets.find((b) => b.key === key);
  if (!ledger) {
    ledger = { key, windowStartedAt: new Date(now).toISOString(), units: 0 };
    state.budgets.push(ledger);
  }
  rollWindow(ledger, windowMs, now);
  const units = opts.units ?? estimateTaskUnits(state, task);
  ledger.units += units;
  recordAudit(state, {
    kind: "info",
    message: `budget charge ${units} on ${key}`,
    agent: task.agent,
    workerId: opts.workerId,
    taskId: task.id,
    meta: { key, units, spent: ledger.units, limit: policy.spec.budget.maxUnits },
  });
  return budgetStatus(state, { agent: task.agent, fleet: agent?.derivedFrom?.fleet }, { now });
}

export function budgetReport(state: ClusterState, opts: { now?: number } = {}): BudgetStatus[] {
  ensureBudgets(state);
  const policy = activeBudgetPolicy(state.policies ?? []);
  if (!policy?.spec.budget) return [];
  const scope = policy.spec.budget.scope ?? "cluster";
  if (scope === "cluster") {
    const s = budgetStatus(state, {}, opts);
    return s ? [s] : [];
  }
  if (scope === "fleet") {
    const fleets = [...new Set(state.desired.map((a) => a.derivedFrom?.fleet).filter(Boolean))] as string[];
    const keys = fleets.length ? fleets : ["unknown"];
    return keys
      .map((fleet) => budgetStatus(state, { fleet }, opts))
      .filter((s): s is BudgetStatus => Boolean(s));
  }
  return state.desired
    .map((a) => budgetStatus(state, { agent: a.metadata.name }, opts))
    .filter((s): s is BudgetStatus => Boolean(s));
}
