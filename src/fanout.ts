/**
 * Subagent fan-out — split a parent task across idle fleet (or agent) replicas.
 * World-class orchestrators scale work sideways, not just deeper loops.
 */

import { enqueueTask } from "./queue.js";
import { pickIdleWorker } from "./queue.js";
import type { ClusterState, QueuedTask, Task, Worker } from "./types.js";

export type FanOutPlan = {
  parentId: string;
  shards: Task[];
  enqueued: QueuedTask[];
};

export function shouldFanOut(task: Task, plannedCalls: Array<{ name: string }> = []): boolean {
  if (plannedCalls.some((c) => c.name === "subagent")) return true;
  return /fan[- ]?out|parallel|subagents?|shard/i.test(task.prompt);
}

export function shardCount(task: Task, available: number): number {
  const m = /(?:fan[- ]?out|shards?|parallel)\s*[:=]?\s*(\d+)/i.exec(task.prompt);
  const asked = m ? Number(m[1]) : Math.min(3, Math.max(2, available));
  return Math.max(1, Math.min(available, asked, 8));
}

/**
 * Enqueue N child tasks for the same agent (prefer same fleet workers).
 * Does not execute — caller drains the queue.
 */
export function fanOutTask(state: ClusterState, parent: Task): FanOutPlan {
  const idlePool = state.workers.filter(
    (w) => w.agent === parent.agent && (w.status === "idle" || w.status === "pending"),
  );
  // Prefer fleet siblings when parent worker has a fleet.
  const parentWorker = state.workers.find((w) => w.agent === parent.agent);
  const fleet = parentWorker?.fleet;
  const fleetIdle = fleet
    ? state.workers.filter(
        (w) => w.fleet === fleet && (w.status === "idle" || w.status === "pending"),
      )
    : idlePool;

  const pool = fleetIdle.length ? fleetIdle : idlePool;
  const n = shardCount(parent, Math.max(1, pool.length));
  const shards: Task[] = [];
  const enqueued: QueuedTask[] = [];

  for (let i = 0; i < n; i++) {
    const child: Task = {
      id: `${parent.id}#shard-${i}`,
      agent: parent.agent,
      prompt: `${parent.prompt} [shard ${i + 1}/${n}]`,
      event: parent.event,
    };
    shards.push(child);
    enqueued.push(enqueueTask(state, child, "cli"));
  }

  return { parentId: parent.id, shards, enqueued };
}

/** Pick distinct idle workers for fan-out execution (up to shards). */
export function assignShardWorkers(
  state: ClusterState,
  agent: string,
  count: number,
): Worker[] {
  const picked: Worker[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const w = pickIdleWorker(state, agent);
    if (!w || seen.has(w.id)) break;
    // Temporarily mark running so next pick skips it.
    w.status = "running";
    seen.add(w.id);
    picked.push(w);
  }
  // Reset to idle — claimPending/drain will re-claim properly.
  for (const w of picked) w.status = "idle";
  return picked;
}
