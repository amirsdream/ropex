// Thin typed client for the Ropex control-plane HTTP API.
// The view model is large; we type the fields the dashboard consumes.

export type WorkflowStage = { id: string; owner: string; phase?: string; purpose: string };

export type View = {
  brand: string;
  tagline: string;
  revision: number;
  source: string;
  lastReconcile?: string;
  counts: {
    workersLive: number;
    workersKnown: number;
    fleets: number;
    memoryFacts: number;
    skills: number;
    queuePending: number;
    tasksCompleted: number;
  };
  workers: Array<{
    id: string;
    agent: string;
    fleet?: string;
    replica: number;
    status: string;
    imageDigest: string;
    harness: string;
    model: string;
    plugins: string[];
    skills: string[];
    worktree?: string;
  }>;
  fleets: Array<{
    name: string;
    replicas: number;
    live: number;
    maxConcurrent?: number;
    scale?: string;
    profile?: string;
    memoryFacts: number;
  }>;
  memory: Array<{ id: string; text: string; scope: string; agent: string; at: string; tags: string[] }>;
  workflow: WorkflowStage[];
  queue: Array<{
    id: string;
    status: string;
    agent: string;
    source: string;
    prompt: string;
    attempts?: number;
    error?: string;
  }>;
  deliveries: Array<{ id: string; kind: string; agent: string; body: string; at: string; repo?: string }>;
  metrics: {
    tasksCompleted: number;
    tasksFailed: number;
    queuePending: number;
    workersIdle: number;
    deliveries: number;
    workersUnhealthy: number;
    backlogSloBreached: boolean;
  };
  health: {
    ok: boolean;
    unhealthy: number;
    backlogBreached: boolean;
    backlogPending: number;
    oldestPendingAgeMs: number | null;
    workers: Array<{ id: string; status: string; healthy: boolean; detail: string }>;
  };
  drain: {
    concurrency: number;
    maxConcurrency: number;
    paused: boolean;
    pending: number;
    claimed: number;
    idleWorkers: number;
    runningWorkers: number;
  };
  drift: { ok: boolean; liveWorkers: number; desiredWorkers: number; summary: Record<string, number>; findings: Array<{ kind: string; detail: string }> };
  canary: { ok: boolean; matched: number; mismatched: number; total: number; pctMatched: number; agents: Array<{ agent: string; matched: number; total: number; pctMatched: number }> };
  fairness: { claimWaitP50Ms: number; claimWaitP95Ms: number; claimWaitMaxMs: number; runDurationP50Ms: number; runDurationP95Ms: number; pendingByAgent: Record<string, number> };
  hermes: Array<{ agent: string; soul: string; skills: string[]; memoryBackend: string; learning: boolean; share: { read: string[]; write: string } }>;
  harness: Array<{ agent: string; profile: string; model: string; plugins: string[]; loop: string; tools: string[] }>;
  hermesLive: { backend: string; liveReady: boolean; packageInstalled: boolean; steps: string[] };
  dsh: { backend: string; liveReady: boolean; packageInstalled: boolean; apiKeyPresent: boolean; apiKeySource?: string; profiles: Array<{ profile: string; loop: string; plugins: string[]; description: string }> };
  skillCatalog: Array<{ name: string; version: number; originAgent: string; sharedWith: string[]; summary: string; coverage: number }>;
  trajectories: { total: number; recent: Array<{ id: string; at: string; agent: string; workerId: string; taskId: string; steps: number; stages: string[]; output: string }> };
  pipelines: { total: number; recent: Array<{ id: string; status: string; phase?: string; prompt: string; stages: number; doneStages: number; updatedAt: string }> };
  rateLimits: { limit: number; windowMs: number; buckets: number; nearLimit: number; rows: Array<{ key: string; count: number; remaining: number; saturated: boolean }> };
  audit: Array<{ id: string; at: string; kind: string; message: string; agent?: string; taskId?: string }>;
  approvals: Array<{ id: string; status: string; tool: string; agent: string; taskId: string; reason: string }>;
  hygiene: {
    pool: Array<{ agent: string; idle: number; running: number; failed: number; cordoned: number; total: number }>;
    queueDepth: Array<{ key: string; count: number; kind: string }>;
    summary: { pending: number; claimed: number; dead: number; waitingRetry: number };
  };
  stack?: { status?: string; message?: string; queuePaused?: boolean };
  queuePaused?: boolean;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error((body as { error?: string })?.error || `${path} → ${res.status}`);
  return body as T;
}

export const api = {
  view: () => req<View>("/api/v1/view"),
  submitTask: (agent: string, prompt: string, mode: string, drain = true) =>
    req("/api/v1/tasks", { method: "POST", body: JSON.stringify({ action: "submit", agent, prompt, delivery: { mode }, drain }) }),
  submitPipeline: (prompt: string, drain = false) =>
    req<{ pipeline: { id: string; status: string } }>("/api/v1/pipeline", { method: "POST", body: JSON.stringify({ prompt, drain }) }),
  drainPipeline: (pipelineId: string) =>
    req("/api/v1/pipeline", { method: "POST", body: JSON.stringify({ action: "drain", pipelineId }) }),
  runDrain: (concurrency: number) => req("/api/v1/drain", { method: "POST", body: JSON.stringify({ concurrency }) }),
  preferDrain: (concurrency: number) => req("/api/v1/drain", { method: "PUT", body: JSON.stringify({ concurrency }) }),
  queue: (action: string, extra: Record<string, unknown> = {}) => req("/api/v1/queue", { method: "POST", body: JSON.stringify({ action, ...extra }) }),
  hygiene: (action: string) => req("/api/v1/hygiene", { method: "POST", body: JSON.stringify({ action }) }),
  promoteSkill: (name: string) => req("/api/v1/skills", { method: "POST", body: JSON.stringify({ action: "promote", name }) }),
  approve: (id: string, decision: "approved" | "rejected") => req("/api/v1/approvals", { method: "POST", body: JSON.stringify({ id, decision }) }),
  policySim: (prompt: string) => req<{ rows?: unknown[] }>("/api/v1/policy/simulate", { method: "POST", body: JSON.stringify({ prompt }) }),
  memory: (action: string) => req("/api/v1/memory", { method: "POST", body: JSON.stringify({ action }) }),
  stack: (action: "up" | "down") => req("/api/v1/stack", { method: "POST", body: JSON.stringify({ action }) }),
};

export function eventsUrl(pipelineId: string): string {
  return `/api/v1/events?pipelineId=${encodeURIComponent(pipelineId)}&format=ui`;
}
