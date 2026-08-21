/**
 * Metrics export — Prometheus text + JSON snapshot for the control plane.
 * No network; pure derivation from ClusterState.
 */

import { queueSummary } from "./queue.js";
import type { ClusterState } from "./types.js";

export type MetricsSnapshot = {
  workers_live: number;
  workers_idle: number;
  workers_running: number;
  workers_failed: number;
  queue_pending: number;
  queue_claimed: number;
  queue_done: number;
  queue_failed: number;
  tasks_completed: number;
  tasks_failed: number;
  tasks_enqueued: number;
  memory_facts: number;
  skills_learned: number;
  skills_registry: number;
  deliveries: number;
  revision: number;
};

export function metricsSnapshot(state: ClusterState): MetricsSnapshot {
  const live = state.workers.filter((w) => w.status !== "retired");
  const q = queueSummary(state);
  return {
    workers_live: live.length,
    workers_idle: live.filter((w) => w.status === "idle").length,
    workers_running: live.filter((w) => w.status === "running").length,
    workers_failed: live.filter((w) => w.status === "failed").length,
    queue_pending: q.pending,
    queue_claimed: q.claimed,
    queue_done: q.done,
    queue_failed: q.failed,
    tasks_completed: state.metrics?.tasksCompleted ?? 0,
    tasks_failed: state.metrics?.tasksFailed ?? 0,
    tasks_enqueued: state.metrics?.tasksEnqueued ?? 0,
    memory_facts: state.memory?.length ?? 0,
    skills_learned: state.skills?.length ?? 0,
    skills_registry: state.skillRegistry?.length ?? 0,
    deliveries: state.deliveries?.length ?? 0,
    revision: state.revision,
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
    "# HELP ropex_queue_pending Pending queue depth.",
    "# TYPE ropex_queue_pending gauge",
    `ropex_queue_pending ${m.queue_pending}`,
    "# HELP ropex_tasks_completed_total Completed tasks.",
    "# TYPE ropex_tasks_completed_total counter",
    `ropex_tasks_completed_total ${m.tasks_completed}`,
    "# HELP ropex_tasks_failed_total Failed tasks.",
    "# TYPE ropex_tasks_failed_total counter",
    `ropex_tasks_failed_total ${m.tasks_failed}`,
    "# HELP ropex_memory_facts Shared memory facts.",
    "# TYPE ropex_memory_facts gauge",
    `ropex_memory_facts ${m.memory_facts}`,
    "# HELP ropex_deliveries_total Delivery journal size.",
    "# TYPE ropex_deliveries_total counter",
    `ropex_deliveries_total ${m.deliveries}`,
    "# HELP ropex_cluster_revision Control-plane revision.",
    "# TYPE ropex_cluster_revision gauge",
    `ropex_cluster_revision ${m.revision}`,
  ];
  return `${lines.join("\n")}\n`;
}
