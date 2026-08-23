/**
 * Git-native task inbox — Task YAML in the fleet repo, no forge required.
 * Sync enqueues pending manifests; drain writes status/result back to the file.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseDocument, YAMLMap } from "yaml";
import { recordAudit } from "./audit.js";
import { enqueueTask } from "./queue.js";
import { resolveRepoLocalPath } from "./gitrepo.js";
import { parseManifests } from "./spec.js";
import type { ClusterState, QueuedTask, Task, TaskManifest } from "./types.js";

export const DEFAULT_TASKS_DIR = "tasks";

export function resolveTasksDir(root: string, dir?: string): string {
  if (dir) return isAbsolute(dir) ? dir : resolve(root, dir);
  return resolve(root, DEFAULT_TASKS_DIR);
}

export function findTaskFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
    const full = join(dir, name);
    if (statSync(full).isFile()) out.push(full);
  }
  return out.sort();
}

export function readTaskManifest(path: string): TaskManifest {
  const raw = readFileSync(path, "utf8");
  const manifests = parseManifests(raw);
  const task = manifests.find((m) => m.kind === "Task");
  if (!task || task.kind !== "Task") {
    throw new Error(`not a Task manifest: ${path}`);
  }
  return task;
}

export function taskFromManifest(m: TaskManifest, manifestPath: string): Task {
  return {
    id: m.metadata.name,
    agent: m.spec.agent,
    prompt: m.spec.prompt,
    manifestPath,
  };
}

export function isTaskEnqueueable(m: TaskManifest): boolean {
  const status = m.spec.status ?? "pending";
  return status === "pending";
}

export type TaskSyncResult = {
  enqueued: string[];
  skipped: string[];
  errors: Array<{ path: string; error: string }>;
  scanned: number;
};

function shouldSkipEnqueue(state: ClusterState, taskId: string): boolean {
  const active = state.queue.find(
    (q) => q.id === taskId && (q.status === "pending" || q.status === "claimed"),
  );
  if (active) return true;
  const done = state.queue.find((q) => q.id === taskId && q.status === "done");
  return Boolean(done);
}

export function syncTasksFromDir(
  state: ClusterState,
  root: string,
  dir?: string,
): TaskSyncResult {
  const tasksDir = resolveTasksDir(root, dir);
  const result: TaskSyncResult = { enqueued: [], skipped: [], errors: [], scanned: 0 };
  for (const path of findTaskFiles(tasksDir)) {
    result.scanned += 1;
    try {
      const m = readTaskManifest(path);
      if (!isTaskEnqueueable(m)) {
        result.skipped.push(m.metadata.name);
        continue;
      }
      const task = taskFromManifest(m, path);
      if (shouldSkipEnqueue(state, task.id)) {
        result.skipped.push(task.id);
        continue;
      }
      enqueueTask(state, task, "git", { priority: m.spec.priority });
      result.enqueued.push(task.id);
      recordAudit(state, {
        kind: "enqueue",
        message: `git task synced from ${path}`,
        agent: task.agent,
        taskId: task.id,
        meta: { path, source: "git" },
      });
    } catch (err) {
      result.errors.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** Sync `tasks/` (or tasksPath) under every declared GitRepo local path. */
export function syncTasksFromGitRepos(state: ClusterState, root: string): TaskSyncResult {
  const merged: TaskSyncResult = { enqueued: [], skipped: [], errors: [], scanned: 0 };
  for (const repo of state.gitRepos ?? []) {
    const loc = resolveRepoLocalPath(root, repo);
    if (!loc.ok) {
      merged.errors.push({ path: loc.path, error: loc.reason ?? "repo path missing" });
      continue;
    }
    const tasksDir = join(loc.path, repo.spec.tasksPath ?? DEFAULT_TASKS_DIR);
    const part = syncTasksFromDir(state, root, tasksDir);
    merged.enqueued.push(...part.enqueued);
    merged.skipped.push(...part.skipped);
    merged.errors.push(...part.errors);
    merged.scanned += part.scanned;
  }
  return merged;
}

export function writeTaskManifestDelivery(
  manifestPath: string,
  outcome: {
    status: "done" | "failed";
    output?: string;
    workerId?: string;
    error?: string;
  },
): void {
  const raw = readFileSync(manifestPath, "utf8");
  const doc = parseDocument(raw);
  const spec = doc.get("spec") as YAMLMap | undefined;
  if (!spec) throw new Error("task manifest missing spec");
  spec.set("status", outcome.status);
  spec.set("result", {
    output: outcome.output?.slice(0, 2000),
    workerId: outcome.workerId,
    completedAt: new Date().toISOString(),
    error: outcome.error,
  });
  if (!spec.has("delivery")) {
    spec.set("delivery", { mode: "git" });
  }
  writeFileSync(manifestPath, String(doc));
}

/** Write terminal status back to the Task YAML when manifestPath is set. */
export function deliverGitTaskManifest(
  task: Task,
  outcome: {
    ok: boolean;
    output?: string;
    workerId?: string;
    error?: string;
  },
): boolean {
  if (!task.manifestPath) return false;
  writeTaskManifestDelivery(task.manifestPath, {
    status: outcome.ok ? "done" : "failed",
    output: outcome.output,
    workerId: outcome.workerId,
    error: outcome.error,
  });
  return true;
}

export function deliverGitTaskFromQueueItem(item: QueuedTask, output?: string): boolean {
  if (!item.task.manifestPath) return false;
  if (item.status === "done") {
    deliverGitTaskManifest(item.task, {
      ok: true,
      output,
      workerId: item.workerId,
    });
    return true;
  }
  if (item.status === "dead") {
    deliverGitTaskManifest(item.task, {
      ok: false,
      workerId: item.workerId,
      error: item.error,
    });
    return true;
  }
  return false;
}

export type TaskGitEntry = {
  id: string;
  agent: string;
  status: string;
  prompt: string;
  priority?: number;
  path: string;
  inQueue: boolean;
  queueStatus?: string;
};

export type TaskGitSummary = {
  pending: number;
  done: number;
  failed: number;
  scanned: number;
  defaultDir: string;
  items: TaskGitEntry[];
};

function queueStateForTask(state: ClusterState, taskId: string): { inQueue: boolean; queueStatus?: string } {
  const items = state.queue.filter((q) => q.id === taskId);
  if (!items.length) return { inQueue: false };
  const latest = items[items.length - 1];
  return { inQueue: latest.status === "pending" || latest.status === "claimed", queueStatus: latest.status };
}

/** Scan git Task YAML manifests for the control-plane view (no writes). */
export function taskGitSummary(state: ClusterState, root: string, dir?: string): TaskGitSummary {
  const tasksDir = resolveTasksDir(root, dir);
  const summary: TaskGitSummary = {
    pending: 0,
    done: 0,
    failed: 0,
    scanned: 0,
    defaultDir: DEFAULT_TASKS_DIR,
    items: [],
  };
  for (const path of findTaskFiles(tasksDir)) {
    summary.scanned += 1;
    try {
      const m = readTaskManifest(path);
      const status = m.spec.status ?? "pending";
      if (status === "pending") summary.pending += 1;
      else if (status === "done") summary.done += 1;
      else if (status === "failed") summary.failed += 1;
      const q = queueStateForTask(state, m.metadata.name);
      summary.items.push({
        id: m.metadata.name,
        agent: m.spec.agent,
        status,
        prompt: m.spec.prompt,
        priority: m.spec.priority,
        path,
        inQueue: q.inQueue,
        queueStatus: q.queueStatus,
      });
    } catch {
      /* skip unreadable manifests in view scan */
    }
  }
  summary.items.sort((a, b) => a.id.localeCompare(b.id));
  return summary;
}

/** Merge task git summaries from declared GitRepo paths. */
export function taskGitSummaryFromRepos(state: ClusterState, root: string): TaskGitSummary {
  const merged: TaskGitSummary = {
    pending: 0,
    done: 0,
    failed: 0,
    scanned: 0,
    defaultDir: DEFAULT_TASKS_DIR,
    items: [],
  };
  const repos = state.gitRepos ?? [];
  if (!repos.length) {
    const local = taskGitSummary(state, root);
    return local;
  }
  for (const repo of repos) {
    const loc = resolveRepoLocalPath(root, repo);
    if (!loc.ok) continue;
    const tasksDir = join(loc.path, repo.spec.tasksPath ?? DEFAULT_TASKS_DIR);
    const part = taskGitSummary(state, root, tasksDir);
    merged.pending += part.pending;
    merged.done += part.done;
    merged.failed += part.failed;
    merged.scanned += part.scanned;
    merged.items.push(...part.items);
  }
  if (!merged.scanned) {
    const local = taskGitSummary(state, root);
    return local;
  }
  merged.items.sort((a, b) => a.id.localeCompare(b.id));
  return merged;
}
