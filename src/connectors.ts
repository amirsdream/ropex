/**
 * Pluggable ingress/egress connectors — native UI by default, git/GitHub/webhook optional.
 */

import { recordAudit } from "./audit.js";
import { deliverOutbound } from "./deliver.js";
import { recordDelivery } from "./journal.js";
import { deliverGitTaskFromQueueItem } from "./tasks.js";
import type {
  ClusterState,
  ConnectorRecord,
  NativeTaskRecord,
  QueuedTask,
  TaskDeliveryMode,
  TaskDeliverySpec,
  Worker,
} from "./types.js";

export const DEFAULT_CONNECTORS: ConnectorRecord[] = [
  {
    id: "native",
    kind: "ui",
    enabled: true,
    label: "Ropex UI",
    description: "Submit tasks and read results in the control plane",
  },
  {
    id: "git",
    kind: "git",
    enabled: true,
    label: "Git tasks",
    description: "Task YAML under tasks/ in any git repo",
  },
  {
    id: "webhook",
    kind: "webhook",
    enabled: false,
    label: "Webhook",
    description: "POST task results to a configured URL",
  },
  {
    id: "github",
    kind: "github",
    enabled: false,
    label: "GitHub",
    description: "Issues and pull-request events (optional adapter)",
  },
];

export function ensureConnectors(state: ClusterState): ConnectorRecord[] {
  if (!state.connectors?.length) {
    state.connectors = DEFAULT_CONNECTORS.map((c) => ({ ...c }));
    return state.connectors;
  }
  const byId = new Map(state.connectors.map((c) => [c.id, c]));
  for (const def of DEFAULT_CONNECTORS) {
    if (!byId.has(def.id)) state.connectors.push({ ...def });
  }
  return state.connectors;
}

export function ensureNativeTasks(state: ClusterState): NativeTaskRecord[] {
  if (!state.nativeTasks) state.nativeTasks = [];
  return state.nativeTasks;
}

export function findNativeTask(state: ClusterState, taskId: string): NativeTaskRecord | undefined {
  return ensureNativeTasks(state).find((t) => t.id === taskId);
}

export function connectorForMode(state: ClusterState, mode: TaskDeliveryMode): ConnectorRecord | undefined {
  return ensureConnectors(state).find((c) => c.kind === mode && c.enabled);
}

export function resolveDeliverySpec(
  state: ClusterState,
  item: QueuedTask,
): TaskDeliverySpec {
  const native = findNativeTask(state, item.id);
  if (native?.delivery) return native.delivery;
  if (item.task.delivery) return item.task.delivery;
  if (item.task.manifestPath) return { mode: "git" };
  if (item.task.event) return { mode: "github" };
  return { mode: "ui" };
}

function touchNative(
  state: ClusterState,
  item: QueuedTask,
  patch: Partial<NativeTaskRecord>,
): NativeTaskRecord | undefined {
  const rec = findNativeTask(state, item.id);
  if (!rec) return undefined;
  Object.assign(rec, patch, { updatedAt: new Date().toISOString() });
  return rec;
}

export function markNativeTaskRunning(state: ClusterState, item: QueuedTask): void {
  touchNative(state, item, {
    status: "running",
    startedAt: item.claimedAt ?? new Date().toISOString(),
    workerId: item.workerId,
  });
}

export function finalizeNativeTask(
  state: ClusterState,
  item: QueuedTask,
  outcome: { output?: string },
): NativeTaskRecord | undefined {
  const status = item.status === "done" ? "done" : item.status === "dead" ? "failed" : "failed";
  return touchNative(state, item, {
    status,
    output: outcome.output,
    error: item.error,
    workerId: item.workerId,
    finishedAt: item.finishedAt ?? new Date().toISOString(),
  });
}

export type DeliverOutcome = {
  output?: string;
  delivery?: { kind: string; body: string };
  worker?: Worker;
  imageDigest?: string;
};

/**
 * Route terminal task results to the configured connector(s).
 * Git manifests, native UI records, webhook stubs, and GitHub journal entries.
 */
export function deliverTaskOutcome(
  state: ClusterState,
  item: QueuedTask,
  outcome: DeliverOutcome = {},
): { modes: TaskDeliveryMode[] } {
  const spec = resolveDeliverySpec(state, item);
  const modes: TaskDeliveryMode[] = [];
  finalizeNativeTask(state, item, outcome);

  const tryMode = (mode: TaskDeliveryMode): void => {
    const connector = connectorForMode(state, mode);
    if (!connector && mode !== "ui") return;
    modes.push(mode);

    if (mode === "git" && item.task.manifestPath) {
      deliverGitTaskFromQueueItem(item, outcome.output);
      const rec = findNativeTask(state, item.id);
      if (rec) rec.manifestPath = item.task.manifestPath;
      return;
    }

    if (mode === "webhook") {
      const url = spec.webhookUrl ?? connector?.config?.url;
      if (!url) return;
      const body = outcome.output ?? item.error ?? "";
      const worker =
        outcome.worker ??
        ({
          id: item.workerId ?? "unknown",
          agent: item.task.agent,
          fleet: undefined,
          replica: 0,
          status: "idle",
          imageDigest: outcome.imageDigest ?? "",
          harness: "minimal",
          model: "",
          plugins: [],
          skills: [],
        } as Worker);
      const delivery = recordDelivery(state, {
        task: item.task,
        worker,
        imageDigest: outcome.imageDigest ?? "",
        delivery: { kind: "comment", body },
      });
      if (delivery) deliverOutbound(state, delivery, { url, mode: "stub" });
      return;
    }

    if (mode === "github" && outcome.delivery && outcome.worker) {
      recordDelivery(state, {
        task: item.task,
        worker: outcome.worker,
        imageDigest: outcome.imageDigest ?? "",
        delivery: outcome.delivery as { kind: import("./types.js").GithubSpec["deliver"]; body: string },
      });
      return;
    }

    if (mode === "ui") {
      recordAudit(state, {
        kind: "info",
        message: "task result stored in native inbox",
        agent: item.task.agent,
        taskId: item.id,
        workerId: item.workerId,
      });
    }
  };

  tryMode(spec.mode);
  if (item.task.manifestPath && spec.mode !== "git") tryMode("git");
  if (outcome.delivery && spec.mode !== "github") tryMode("github");

  return { modes };
}

export function nativeTaskSummary(state: ClusterState, limit = 50): {
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  items: NativeTaskRecord[];
} {
  const items = [...ensureNativeTasks(state)]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
  let pending = 0;
  let running = 0;
  let done = 0;
  let failed = 0;
  for (const t of ensureNativeTasks(state)) {
    if (t.status === "pending") pending += 1;
    else if (t.status === "running") running += 1;
    else if (t.status === "done") done += 1;
    else if (t.status === "failed") failed += 1;
  }
  return {
    total: state.nativeTasks?.length ?? 0,
    pending,
    running,
    done,
    failed,
    items,
  };
}

export function setConnectorEnabled(
  state: ClusterState,
  id: string,
  enabled: boolean,
): ConnectorRecord | undefined {
  const rec = ensureConnectors(state).find((c) => c.id === id);
  if (!rec) return undefined;
  rec.enabled = enabled;
  return rec;
}
