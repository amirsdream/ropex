/**
 * Placement constraints — require/prefer labels + taints/tolerations for claims.
 */

import type { PlacementSpec, Task, Worker } from "./types.js";

export function labelsInclude(
  have: Record<string, string> | undefined,
  need: Record<string, string> | undefined,
): boolean {
  if (!need || !Object.keys(need).length) return true;
  const h = have ?? {};
  for (const [k, v] of Object.entries(need)) {
    if (h[k] !== v) return false;
  }
  return true;
}

export function countLabelMatches(
  have: Record<string, string> | undefined,
  prefer: Record<string, string> | undefined,
): number {
  if (!prefer) return 0;
  const h = have ?? {};
  let n = 0;
  for (const [k, v] of Object.entries(prefer)) {
    if (h[k] === v) n += 1;
  }
  return n;
}

/** Task/event labels (github labels + repo) as a label map. */
export function taskLabelMap(task: Task): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of task.event?.labels ?? []) out[`github.com/label/${l}`] = "true";
  if (task.event?.repo) {
    const [org, name] = task.event.repo.split("/");
    if (org) out["github.com/org"] = org;
    if (name) out["github.com/repo"] = name;
  }
  return out;
}

/** Implicit Exists tolerations from task github labels / repo keys. */
export function taskTolerations(
  task: Task | undefined,
): NonNullable<PlacementSpec["tolerations"]> {
  if (!task) return [];
  const out: NonNullable<PlacementSpec["tolerations"]> = [];
  const seen = new Set<string>();
  const add = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, operator: "Exists" });
  };
  for (const l of task.event?.labels ?? []) {
    add(l);
    add(`github.com/label/${l}`);
  }
  for (const key of Object.keys(taskLabelMap(task))) add(key);
  return out;
}

export function tolerates(
  tolerations: PlacementSpec["tolerations"] | undefined,
  taints: PlacementSpec["taints"] | undefined,
): boolean {
  if (!taints?.length) return true;
  const tols = tolerations ?? [];
  for (const t of taints) {
    if (t.effect !== "NoSchedule") continue;
    const ok = tols.some((tol) => {
      if (tol.key !== t.key) return false;
      if (tol.operator === "Exists") return true;
      return tol.value === t.key || tol.value === "true";
    });
    if (!ok) return false;
  }
  return true;
}

/**
 * Hard gates: worker labels must satisfy `require`; worker taints must be tolerated
 * by agent placement tolerations and/or task-derived tolerations.
 */
export function canPlace(
  worker: Worker,
  placement: PlacementSpec | undefined,
  task?: Task,
): boolean {
  if (placement?.require && !labelsInclude(worker.labels, placement.require)) {
    return false;
  }
  const taints = worker.taints ?? placement?.taints;
  const merged = [...(placement?.tolerations ?? []), ...taskTolerations(task)];
  return tolerates(merged, taints);
}

/** Soft score: prefer label matches on worker ∪ task labels. */
export function placementScore(
  worker: Worker,
  placement: PlacementSpec | undefined,
  task?: Task,
): number {
  if (!placement?.prefer) return 0;
  const merged = { ...(task ? taskLabelMap(task) : {}), ...(worker.labels ?? {}) };
  return countLabelMatches(merged, placement.prefer);
}
