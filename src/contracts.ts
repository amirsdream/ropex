/**
 * Control-plane contracts: typed surfaces that extend Hermes brain + DeepSeek harness
 * so CLI, plugins, and UI share one API shape.
 */

import type { LoopMode } from "./plugins.js";
import type {
  HarnessProfile,
  LearnedSkill,
  MemoryScope,
  MemoryShareSpec,
  SharedMemoryFact,
  Task,
  TrajectoryStep,
  WorkerStatus,
} from "./types.js";

/** Context a worker needs to read/write shared memory. */
export type MemoryContext = {
  agent: string;
  worker: string;
  fleet?: string;
  policy: MemoryShareSpec;
};

export type MemoryQuery = {
  tags?: string[];
  text?: string;
  scopes?: MemoryScope[];
  limit?: number;
};

/**
 * Memory port — Hermes remembers through this; DeepSeek exposes it as a plugin service.
 */
export type MemoryPort = {
  readonly context: MemoryContext;
  query(filter?: MemoryQuery): SharedMemoryFact[];
  remember(
    text: string,
    opts?: { scope?: MemoryScope; tags?: string[]; id?: string },
  ): SharedMemoryFact;
  /** Promote an existing fact to a wider scope (e.g. agent → fleet). */
  promote(id: string, scope: MemoryScope): SharedMemoryFact | undefined;
  snapshot(): SharedMemoryFact[];
};

/** Hermes plan shape (brain output before DeepSeek executes). */
export type HermesPlan = {
  thoughts: string[];
  calls: Array<{ name: string; input: Record<string, unknown> }>;
};

/**
 * Hermes brain contract — soul, skills, memory port, plan/learn loop.
 * UI and runtime both consume this interface.
 */
export type HermesContract = {
  soul: string;
  skills: string[];
  memory: SharedMemoryFact[];
  port: MemoryPort;
  plan(task: Task): HermesPlan;
  remember(fact: SharedMemoryFact | string): SharedMemoryFact;
  learn(task: Task, steps: TrajectoryStep[]): LearnedSkill | undefined;
};

/** DeepSeek harness loop contract. */
export type HarnessLoopContract = {
  mode: LoopMode;
  run(calls: HermesPlan["calls"]): Promise<string[]>;
};

/** DeepSeek harness surface for UI / status. */
export type HarnessContract = {
  profile: HarnessProfile;
  model: string;
  plugins: string[];
  loop: LoopMode;
  tools: string[];
  delivery?: "comment" | "pull_request" | "check";
};

/** Combined worker runtime surface (Hermes + DeepSeek). */
export type WorkerRuntimeContract = {
  workerId: string;
  agent: string;
  fleet?: string;
  imageDigest: string;
  hermes: Pick<HermesContract, "soul" | "skills" | "memory"> & {
    share: MemoryShareSpec;
    learning: boolean;
  };
  harness: HarnessContract;
};

/** UI-ready memory stream entry. */
export type MemoryStreamEntry = {
  id: string;
  text: string;
  scope: MemoryScope;
  agent: string;
  fleet?: string;
  worker?: string;
  at: string;
  tags: string[];
  /** Set when loaded from or exported to git Memory YAML. */
  manifestPath?: string;
};

/** UI-ready worker card data (not a layout card — structured view model). */
export type WorkerView = {
  id: string;
  agent: string;
  fleet?: string;
  replica: number;
  status: WorkerStatus;
  imageDigest: string;
  harness: HarnessProfile;
  model: string;
  plugins: string[];
  skills: string[];
  memoryReadable: number;
  worktree?: string;
};

export type FleetView = {
  name: string;
  replicas: number;
  live: number;
  profile?: HarnessProfile;
  memoryFacts: number;
};

export type HermesSurfaceView = {
  agent: string;
  soul: string;
  skills: string[];
  share: MemoryShareSpec;
  memoryBackend: string;
  learning: boolean;
};

export type HarnessSurfaceView = {
  agent: string;
  profile: HarnessProfile;
  model: string;
  plugins: string[];
  loop: LoopMode;
  tools: string[];
};

/**
 * Control plane view model — single composition for the Ropex UI.
 * Built from ClusterState via the API; no network required for tests.
 */
export type ControlPlaneView = {
  brand: "ropex";
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
  workers: WorkerView[];
  fleets: FleetView[];
  memory: MemoryStreamEntry[];
  memoryGit: {
    gitBacked: number;
    runtimeOnly: number;
    defaultDir: string;
  };
  hermes: HermesSurfaceView[];
  harness: HarnessSurfaceView[];
  skills: LearnedSkill[];
  workflow: Array<{ id: string; owner: string; purpose: string }>;
  queue: Array<{
    id: string;
    status: string;
    agent: string;
    source: string;
    prompt: string;
    priority?: number;
    attempts?: number;
    nextRetryAt?: string;
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
  approvals: Array<{ id: string; status: string; tool: string; agent: string; taskId: string; reason: string }>;
  audit: Array<{ id: string; at: string; kind: string; message: string; agent?: string; taskId?: string }>;
  health: {
    ok: boolean;
    unhealthy: number;
    backlogBreached: boolean;
    backlogPending: number;
    oldestPendingAgeMs: number | null;
    workers: Array<{ id: string; status: string; healthy: boolean; detail: string }>;
  };
  gitRepos: Array<{ name: string; path: string; ok: boolean; lastSyncedAt?: string; reason?: string }>;
  autoscale: {
    backlogBreached: boolean;
    policyCap: number;
    recommendations: Array<{
      kind: string;
      name: string;
      currentReplicas: number;
      recommendedReplicas: number;
      delta: number;
      reason: string;
    }>;
  };
  drift: {
    ok: boolean;
    liveWorkers: number;
    desiredWorkers: number;
    summary: Record<string, number>;
    findings: Array<{ kind: string; detail: string; workerId?: string; agent?: string }>;
  };
  fairness: {
    claimWaitP50Ms: number;
    claimWaitP95Ms: number;
    claimWaitMaxMs: number;
    runDurationP50Ms: number;
    runDurationP95Ms: number;
    maxIdleSkewMs: number;
    claimCountCv: number;
    pendingByAgent: Record<string, number>;
    topWorkers: Array<{ workerId: string; agent: string; claims: number; idleSkewMs: number }>;
  };
  budget: {
    rows: Array<{
      key: string;
      scope: string;
      spent: number;
      limit: number;
      remaining: number;
      exhausted: boolean;
      level?: string;
      remainingPct?: number;
    }>;
    alerts: number;
  };
  canary: {
    ok: boolean;
    matched: number;
    mismatched: number;
    total: number;
    pctMatched: number;
    agents: Array<{
      agent: string;
      desiredDigest: string;
      matched: number;
      mismatched: number;
      total: number;
      pctMatched: number;
    }>;
  };
  skillCatalog: Array<{
    name: string;
    version: number;
    originAgent: string;
    sharedWith: string[];
    summary: string;
    at: string;
    versions: number;
    coverage: number;
  }>;
  policySim: {
    deniedTasks: number;
    deniedCalls: number;
    approvalCalls: number;
    rows: Array<{
      agent: string;
      prompt: string;
      taskDenied: boolean;
      callsDenied: string[];
      callsNeedApproval: string[];
    }>;
  };
  outbound: {
    simulated: number;
    rejected: number;
    recent: Array<{
      id: string;
      status: string;
      url: string;
      agent?: string;
      deliveryId?: string;
      reason?: string;
      at: string;
    }>;
  };
  clone: {
    repos: number;
    ok: number;
    blocked: number;
    rows: Array<{
      name: string;
      path: string;
      ok: boolean;
      reason?: string;
      cloneBackend?: string;
      clonePhase?: string;
      cloneProgressPct?: number;
      lastClonedAt?: string;
    }>;
  };
  queuePaused: boolean;
  webhookDuplicates: number;
  affinity: {
    active: number;
    bindings: Array<{ key: string; workerId: string; agent: string; expiresAt: string }>;
  };
  dsh: {
    backend: "simulated" | "live";
    profiles: Array<{ profile: string; loop: string; plugins: string[]; description: string }>;
    liveReady: boolean;
    packageInstalled: boolean;
    scaffoldHint: string;
  };
  hermesLive: {
    liveReady: boolean;
    scaffoldHint: string;
    steps: string[];
  };
  trajectories: {
    total: number;
    recent: Array<{
      id: string;
      at: string;
      agent: string;
      workerId: string;
      taskId: string;
      steps: number;
      stages: string[];
      output: string;
    }>;
  };
  rateLimits: {
    limit: number;
    windowMs: number;
    buckets: number;
    nearLimit: number;
    rows: Array<{
      key: string;
      count: number;
      remaining: number;
      limit: number;
      windowMs: number;
      windowStartedAt: string;
      saturated: boolean;
    }>;
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
  hygiene: {
    pool: Array<{
      agent: string;
      idle: number;
      running: number;
      failed: number;
      cordoned: number;
      total: number;
    }>;
    queueDepth: Array<{ key: string; count: number; kind: string }>;
    webhook: { seen: number; duplicates: number; cap: number };
    leasesReclaimedTotal: number;
    summary: { pending: number; claimed: number; dead: number; waitingRetry: number };
  };
};

/** Stable API routes the UI and CLI share. */
export const API_ROUTES = {
  view: "/api/v1/view",
  memory: "/api/v1/memory",
  workers: "/api/v1/workers",
  queue: "/api/v1/queue",
  metrics: "/api/v1/metrics",
  deliveries: "/api/v1/deliveries",
  skills: "/api/v1/skills",
  canary: "/api/v1/canary",
  trajectories: "/api/v1/trajectories",
  approvals: "/api/v1/approvals",
  health: "/api/v1/health",
  audit: "/api/v1/audit",
  autoscale: "/api/v1/autoscale",
  budget: "/api/v1/budget",
  outbound: "/api/v1/outbound",
  drift: "/api/v1/drift",
  fairness: "/api/v1/fairness",
  clone: "/api/v1/clone",
  affinity: "/api/v1/affinity",
  ratelimits: "/api/v1/ratelimits",
  drain: "/api/v1/drain",
  policySim: "/api/v1/policy/simulate",
  hygiene: "/api/v1/hygiene",
} as const;
