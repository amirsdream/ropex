/**
 * Metrics export — Prometheus text + JSON snapshot for the control plane.
 * No network; pure derivation from ClusterState.
 */

import { healthReport } from "./health.js";
import { planAutoscale } from "./autoscale.js";
import { budgetReport } from "./budget.js";
import { fairnessReport } from "./fairness.js";
import { queueSummary } from "./queue.js";
import type { ClusterState } from "./types.js";

export type MetricsSnapshot = {
  workers_live: number;
  workers_idle: number;
  workers_running: number;
  workers_failed: number;
  workers_unhealthy: number;
  queue_pending: number;
  queue_claimed: number;
  queue_done: number;
  queue_failed: number;
  queue_dead: number;
  queue_waiting_retry: number;
  tasks_completed: number;
  tasks_failed: number;
  tasks_enqueued: number;
  tasks_retried: number;
  tasks_dead: number;
  leases_reclaimed: number;
  memory_facts: number;
  skills_learned: number;
  skills_registry: number;
  deliveries: number;
  revision: number;
  audit_events: number;
  autoscale_recommendations: number;
  budget_spent: number;
  budget_limit: number;
  backlog_oldest_age_ms: number;
  backlog_slo_breached: number;
  claim_wait_p50_ms: number;
  claim_wait_p95_ms: number;
  claim_wait_max_ms: number;
  run_duration_p50_ms: number;
  run_duration_p95_ms: number;
  fairness_idle_skew_ms: number;
  fairness_claim_cv: number;
};

export function metricsSnapshot(state: ClusterState): MetricsSnapshot {
  const live = state.workers.filter((w) => w.status !== "retired");
  const q = queueSummary(state);
  const health = healthReport(state);
  const fair = fairnessReport(state);
  return {
    workers_live: live.length,
    workers_idle: live.filter((w) => w.status === "idle").length,
    workers_running: live.filter((w) => w.status === "running").length,
    workers_failed: live.filter((w) => w.status === "failed").length,
    workers_unhealthy: health.unhealthy,
    queue_pending: q.pending,
    queue_claimed: q.claimed,
    queue_done: q.done,
    queue_failed: q.failed,
    queue_dead: q.dead,
    queue_waiting_retry: q.waitingRetry,
    tasks_completed: state.metrics?.tasksCompleted ?? 0,
    tasks_failed: state.metrics?.tasksFailed ?? 0,
    tasks_enqueued: state.metrics?.tasksEnqueued ?? 0,
    tasks_retried: state.metrics?.tasksRetried ?? 0,
    tasks_dead: state.metrics?.tasksDead ?? 0,
    leases_reclaimed: state.metrics?.leasesReclaimed ?? 0,
    memory_facts: state.memory?.length ?? 0,
    skills_learned: state.skills?.length ?? 0,
    skills_registry: state.skillRegistry?.length ?? 0,
    deliveries: state.deliveries?.length ?? 0,
    revision: state.revision,
    audit_events: state.audit?.length ?? 0,
    autoscale_recommendations: planAutoscale(state).recommendations.length,
    budget_spent: (() => {
      const rows = budgetReport(state);
      return rows.reduce((n, r) => n + r.spent, 0);
    })(),
    budget_limit: (() => {
      const rows = budgetReport(state);
      return rows.reduce((n, r) => n + r.limit, 0);
    })(),
    backlog_oldest_age_ms: health.backlog.oldestPendingAgeMs ?? 0,
    backlog_slo_breached: health.backlog.breached ? 1 : 0,
    claim_wait_p50_ms: fair.claimWait.p50Ms,
    claim_wait_p95_ms: fair.claimWait.p95Ms,
    claim_wait_max_ms: fair.claimWait.maxMs,
    run_duration_p50_ms: fair.runDuration.p50Ms,
    run_duration_p95_ms: fair.runDuration.p95Ms,
    fairness_idle_skew_ms: fair.maxIdleSkewMs,
    fairness_claim_cv: fair.claimCountCv,
  };
}

/** Prometheus exposition format (text/plain). */
export function metricsPrometheus(state: ClusterState): string {
  const m = metricsSnapshot(state);
  const lines = [
    "# HELP ropex_workers_live Live workers (non-retired).",
    "# TYPE ropex_workers_live gauge",
    `ropex_workers_live ${m.workers_live}`,
    "# HELP ropex_workers_idle Idle workers ready for claim.",
    "# TYPE ropex_workers_idle gauge",
    `ropex_workers_idle ${m.workers_idle}`,
    "# HELP ropex_workers_running Workers currently executing.",
    "# TYPE ropex_workers_running gauge",
    `ropex_workers_running ${m.workers_running}`,
    "# HELP ropex_workers_unhealthy Workers failing health probes.",
    "# TYPE ropex_workers_unhealthy gauge",
    `ropex_workers_unhealthy ${m.workers_unhealthy}`,
    "# HELP ropex_queue_pending Pending queue depth.",
    "# TYPE ropex_queue_pending gauge",
    `ropex_queue_pending ${m.queue_pending}`,
    "# HELP ropex_queue_dead Dead-letter depth.",
    "# TYPE ropex_queue_dead gauge",
    `ropex_queue_dead ${m.queue_dead}`,
    "# HELP ropex_tasks_completed_total Completed tasks.",
    "# TYPE ropex_tasks_completed_total counter",
    `ropex_tasks_completed_total ${m.tasks_completed}`,
    "# HELP ropex_tasks_failed_total Failed tasks (incl. dead-letter).",
    "# TYPE ropex_tasks_failed_total counter",
    `ropex_tasks_failed_total ${m.tasks_failed}`,
    "# HELP ropex_tasks_retried_total Soft failures re-queued.",
    "# TYPE ropex_tasks_retried_total counter",
    `ropex_tasks_retried_total ${m.tasks_retried}`,
    "# HELP ropex_tasks_dead_total Tasks exhausted retries.",
    "# TYPE ropex_tasks_dead_total counter",
    `ropex_tasks_dead_total ${m.tasks_dead}`,
    "# HELP ropex_leases_reclaimed_total Expired claim leases reclaimed.",
    "# TYPE ropex_leases_reclaimed_total counter",
    `ropex_leases_reclaimed_total ${m.leases_reclaimed}`,
    "# HELP ropex_memory_facts Shared memory facts.",
    "# TYPE ropex_memory_facts gauge",
    `ropex_memory_facts ${m.memory_facts}`,
    "# HELP ropex_deliveries_total Delivery journal size.",
    "# TYPE ropex_deliveries_total counter",
    `ropex_deliveries_total ${m.deliveries}`,
    "# HELP ropex_cluster_revision Control-plane revision.",
    "# TYPE ropex_cluster_revision gauge",
    `ropex_cluster_revision ${m.revision}`,
    "# HELP ropex_audit_events Audit trail depth.",
    "# TYPE ropex_audit_events gauge",
    `ropex_audit_events ${m.audit_events}`,
    "# HELP ropex_autoscale_recommendations Pending GitOps scale recommendations.",
    "# TYPE ropex_autoscale_recommendations gauge",
    `ropex_autoscale_recommendations ${m.autoscale_recommendations}`,
    "# HELP ropex_budget_spent Task units spent in active budget windows.",
    "# TYPE ropex_budget_spent gauge",
    `ropex_budget_spent ${m.budget_spent}`,
    "# HELP ropex_budget_limit Task unit budget limit (sum of active scopes).",
    "# TYPE ropex_budget_limit gauge",
    `ropex_budget_limit ${m.budget_limit}`,
    "# HELP ropex_backlog_oldest_age_ms Age of oldest pending task (ms).",
    "# TYPE ropex_backlog_oldest_age_ms gauge",
    `ropex_backlog_oldest_age_ms ${m.backlog_oldest_age_ms}`,
    "# HELP ropex_backlog_slo_breached 1 if backlog age exceeds SLO.",
    "# TYPE ropex_backlog_slo_breached gauge",
    `ropex_backlog_slo_breached ${m.backlog_slo_breached}`,
    "# HELP ropex_claim_wait_p50_ms Claim wait p50 (enqueued→claimed).",
    "# TYPE ropex_claim_wait_p50_ms gauge",
    `ropex_claim_wait_p50_ms ${m.claim_wait_p50_ms}`,
    "# HELP ropex_claim_wait_p95_ms Claim wait p95 (enqueued→claimed).",
    "# TYPE ropex_claim_wait_p95_ms gauge",
    `ropex_claim_wait_p95_ms ${m.claim_wait_p95_ms}`,
    "# HELP ropex_claim_wait_max_ms Claim wait max (enqueued→claimed).",
    "# TYPE ropex_claim_wait_max_ms gauge",
    `ropex_claim_wait_max_ms ${m.claim_wait_max_ms}`,
    "# HELP ropex_run_duration_p50_ms Run duration p50 (claimed→finished).",
    "# TYPE ropex_run_duration_p50_ms gauge",
    `ropex_run_duration_p50_ms ${m.run_duration_p50_ms}`,
    "# HELP ropex_run_duration_p95_ms Run duration p95 (claimed→finished).",
    "# TYPE ropex_run_duration_p95_ms gauge",
    `ropex_run_duration_p95_ms ${m.run_duration_p95_ms}`,
    "# HELP ropex_fairness_idle_skew_ms Max lastTaskAt age gap among peers.",
    "# TYPE ropex_fairness_idle_skew_ms gauge",
    `ropex_fairness_idle_skew_ms ${m.fairness_idle_skew_ms}`,
    "# HELP ropex_fairness_claim_cv Claim-count coefficient of variation.",
    "# TYPE ropex_fairness_claim_cv gauge",
    `ropex_fairness_claim_cv ${m.fairness_claim_cv}`,
  ];
  return `${lines.join("\n")}\n`;
}
