import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type View } from "../lib/api";

export type Sample = {
  t: number;
  label: string;
  queuePending: number;
  claimed: number;
  running: number;
  idle: number;
  workersLive: number;
  done: number;
  failed: number;
  deliveries: number;
  pipelines: number;
  backlogAge: number;
  unhealthy: number;
  throughput: number; // tasks completed per minute (derived)
};

const MAX_SAMPLES = 120;
const history: Sample[] = [];
const listeners = new Set<() => void>();

function pushSample(view: View) {
  const now = Date.now();
  const prev = history[history.length - 1];
  const done = view.metrics.tasksCompleted ?? 0;
  let throughput = 0;
  if (prev) {
    const dtMin = (now - prev.t) / 60000;
    if (dtMin > 0) throughput = Math.max(0, (done - prev.done) / dtMin);
  }
  const sample: Sample = {
    t: now,
    label: new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    queuePending: view.drain?.pending ?? view.counts.queuePending ?? 0,
    claimed: view.drain?.claimed ?? 0,
    running: view.drain?.runningWorkers ?? 0,
    idle: view.drain?.idleWorkers ?? 0,
    workersLive: view.counts.workersLive ?? 0,
    done,
    failed: view.metrics.tasksFailed ?? 0,
    deliveries: view.metrics.deliveries ?? 0,
    pipelines: view.pipelines?.total ?? 0,
    backlogAge: view.health?.oldestPendingAgeMs ?? 0,
    unhealthy: view.metrics.workersUnhealthy ?? 0,
    throughput,
  };
  history.push(sample);
  while (history.length > MAX_SAMPLES) history.shift();
  listeners.forEach((l) => l());
}

export function useHistory(): Sample[] {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return history;
}

export function useView(intervalMs = 2500) {
  const seen = useRef(0);
  const q = useQuery({
    queryKey: ["view"],
    queryFn: api.view,
    refetchInterval: intervalMs,
  });
  useEffect(() => {
    if (q.data && q.dataUpdatedAt !== seen.current) {
      seen.current = q.dataUpdatedAt;
      pushSample(q.data);
    }
  }, [q.data, q.dataUpdatedAt]);
  return q;
}
