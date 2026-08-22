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
  hermes: HermesSurfaceView[];
  harness: HarnessSurfaceView[];
  skills: LearnedSkill[];
  workflow: Array<{ id: string; owner: string; purpose: string }>;
  queue: Array<{ id: string; status: string; agent: string; source: string; prompt: string }>;
  deliveries: Array<{ id: string; kind: string; agent: string; body: string; at: string; repo?: string }>;
  metrics: {
    tasksCompleted: number;
    tasksFailed: number;
    queuePending: number;
    workersIdle: number;
    deliveries: number;
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
  trajectories: "/api/v1/trajectories",
  health: "/api/v1/health",
} as const;
