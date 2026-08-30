/**
 * One-click stack control — apply fleet, resume/pause queue, sweep workers.
 * Used by `ropex up` / `ropex down`, the UI, and podman compose entrypoint.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordAudit } from "./audit.js";
import { applyManifestText, loadState } from "./controller.js";
import { isQueuePaused, pauseQueue, resumeQueue } from "./queue.js";
import { destroyWorker, isOnDemandAgent, liveWorkersFor, sweepIdleWorkers } from "./scale.js";
import { controlPlaneTick } from "./tick.js";
import type { ClusterState, StackRecord, StackStatus } from "./types.js";

export const DEFAULT_STACK_MANIFEST = "fleets/examples/github-control-plane.yaml";

export type StackUpOptions = {
  manifest?: string;
  /** Run one drain tick after resume (default true). */
  tick?: boolean;
  root?: string;
};

export type StackDownOptions = {
  root?: string;
  /** Destroy idle on-demand workers (default true). */
  sweepWorkers?: boolean;
};

export type StackActionResult = {
  ok: boolean;
  stack: StackRecord;
  applied?: boolean;
  workersDestroyed?: number;
  tick?: Awaited<ReturnType<typeof controlPlaneTick>> | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

export function ensureStack(state: ClusterState): StackRecord {
  if (!state.stack) {
    state.stack = {
      status: "down",
      manifest: DEFAULT_STACK_MANIFEST,
      updatedAt: nowIso(),
      message: "Stack idle — click Start to spin up.",
    };
  }
  return state.stack;
}

export function stackStatus(state: ClusterState): StackRecord {
  const stack = ensureStack(state);
  const ageMs = Date.now() - new Date(stack.updatedAt).getTime();
  if ((stack.status === "starting" || stack.status === "stopping") && ageMs > 120_000) {
    stack.status = "down";
    stack.message = "Recovered from stuck transition — click Start.";
    stack.updatedAt = nowIso();
  }
  if (stack.status === "up" && isQueuePaused(state)) {
    return { ...stack, status: "stopping", message: "Queue paused — finishing shutdown." };
  }
  return stack;
}

function readManifests(path: string): string {
  const st = statSync(path);
  if (st.isFile()) return readFileSync(path, "utf8");
  const files = readdirSync(path)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  return files.map((f) => readFileSync(join(path, f), "utf8")).join("\n---\n");
}

/**
 * Spin the control plane up: apply manifest, resume queue, optional tick/drain.
 */
export async function stackUp(
  root: string,
  state: ClusterState,
  opts: StackUpOptions = {},
): Promise<StackActionResult> {
  const manifest = opts.manifest ?? ensureStack(state).manifest ?? DEFAULT_STACK_MANIFEST;
  const abs = resolve(root, manifest);
  ensureStack(state);
  const stack = state.stack!;
  stack.status = "starting";
  stack.manifest = manifest;
  stack.updatedAt = nowIso();
  stack.message = "Applying fleet and resuming queue…";

  let applied = false;
  try {
    statSync(abs);
    applyManifestText(root, readManifests(abs), abs);
    applied = true;
    const fresh = loadState(root);
    const preserved = { ...stack };
    Object.assign(state, fresh);
    state.stack = preserved;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stack.status = "down";
    stack.message = `Apply failed: ${msg}`;
    recordAudit(state, { kind: "info", message: `stack up failed: ${msg}` });
    return { ok: false, stack, applied: false, tick: null };
  }

  resumeQueue(state);
  sweepIdleWorkers(state, { root, reason: "stack-up-sweep" });

  let tick: Awaited<ReturnType<typeof controlPlaneTick>> | null = null;
  if (opts.tick !== false) {
    tick = await controlPlaneTick(root, state, { concurrency: 2, persist: false });
  }

  stack.status = "up";
  stack.updatedAt = nowIso();
  stack.message = "Stack running — queue active, workers ready.";
  recordAudit(state, {
    kind: "info",
    message: `stack up manifest=${manifest}`,
    meta: { applied, drained: tick?.drained.length ?? 0 },
  });

  return { ok: true, stack, applied, tick };
}

/**
 * Spin the control plane down: pause queue, destroy idle on-demand workers.
 */
export function stackDown(
  root: string,
  state: ClusterState,
  opts: StackDownOptions = {},
): StackActionResult {
  const stack = ensureStack(state);
  stack.status = "stopping";
  stack.updatedAt = nowIso();
  stack.message = "Pausing queue and sweeping workers…";

  pauseQueue(state);

  let workersDestroyed = 0;
  if (opts.sweepWorkers !== false) {
    sweepIdleWorkers(state, { root, reason: "stack-down-sweep" });
    for (const agent of state.desired) {
      if (!isOnDemandAgent(agent)) continue;
      for (const w of liveWorkersFor(state, agent.metadata.name)) {
        if (w.status === "running") continue;
        destroyWorker(state, w.id, { root, reason: "stack-down" });
        workersDestroyed += 1;
      }
    }
  }

  stack.status = "down";
  stack.updatedAt = nowIso();
  stack.message = "Stack stopped — queue paused.";
  recordAudit(state, {
    kind: "info",
    message: "stack down",
    meta: { workersDestroyed },
  });

  return { ok: true, stack, workersDestroyed, tick: null };
}

export function isStackUp(state: ClusterState): boolean {
  return ensureStack(state).status === "up" && !isQueuePaused(state);
}

export function setStackStatus(state: ClusterState, status: StackStatus, message?: string): StackRecord {
  const stack = ensureStack(state);
  stack.status = status;
  stack.updatedAt = nowIso();
  if (message) stack.message = message;
  return stack;
}
