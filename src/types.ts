export const API_VERSION = "ropex.dev/v1";

export type HarnessProfile = "standard" | "code" | "minimal" | "creator";

export type ObjectMeta = {
  name: string;
  labels?: Record<string, string>;
};

export type LabelSelector = {
  matchLabels?: Record<string, string>;
};

export type HarnessSpec = {
  /** DeepSeek Harness profile: loop + tool surface. */
  profile: HarnessProfile;
  plugins: string[];
  model?: string;
};

/** Where a memory fact lives in the shared store. */
export type MemoryScope = "worker" | "agent" | "fleet" | "cluster";

/** Read/write policy for cross-replica memory sharing. */
export type MemoryShareSpec = {
  /** Scopes this worker may read from (union). */
  read: MemoryScope[];
  /** Scope used when writing new facts. */
  write: MemoryScope;
};

export type MemoryBackend = "sqlite" | "none" | "shared";

export type HermesSpec = {
  /** Path to SOUL.md / identity file. */
  soul?: string;
  /** Local sqlite, disabled, or cluster-shared memory bus. */
  memory: MemoryBackend;
  /**
   * Cross-replica share policy.
   * Defaults: sqlite → agent; shared → agent+fleet read / agent write; none → empty.
   */
  share?: MemoryShareSpec;
  skills: string[];
  /** Closed learning loop: extract skills from trajectories. */
  learning: boolean;
};

export type GithubSpec = {
  events: string[];
  deliver: "comment" | "pull_request" | "check";
};

export type AgentSpec = {
  harness: HarnessSpec;
  hermes: HermesSpec;
  github?: GithubSpec;
  replicas: number;
  selector?: LabelSelector;
};

export type Agent = {
  apiVersion: typeof API_VERSION;
  kind: "Agent";
  metadata: ObjectMeta;
  spec: AgentSpec;
};

export type Fleet = {
  apiVersion: typeof API_VERSION;
  kind: "Fleet";
  metadata: ObjectMeta;
  spec: {
    replicas: number;
    template: {
      metadata?: { labels?: Record<string, string> };
      spec: Omit<AgentSpec, "replicas"> & { replicas?: number };
    };
    targets?: LabelSelector[];
  };
};

export type GitRepo = {
  apiVersion: typeof API_VERSION;
  kind: "GitRepo";
  metadata: ObjectMeta;
  spec: {
    url: string;
    path: string;
    interval?: string;
    branch?: string;
  };
};

export type Policy = {
  apiVersion: typeof API_VERSION;
  kind: "Policy";
  metadata: ObjectMeta;
  spec: {
    maxReplicas: number;
    permissions: {
      deny: string[];
      requireApproval: string[];
    };
  };
};

export type Manifest = Agent | Fleet | GitRepo | Policy;

export type DesiredAgent = Agent & {
  derivedFrom?: { fleet: string; replica: number };
};

export type WorkerStatus = "pending" | "running" | "idle" | "failed" | "retired";

export type Worker = {
  id: string;
  agent: string;
  fleet?: string;
  replica: number;
  status: WorkerStatus;
  /** Content-addressed agent image — workers are immutable for a given digest. */
  imageDigest: string;
  harness: HarnessProfile;
  plugins: string[];
  /** Image skills plus runtime-learned skills (volume-like, not part of digest). */
  skills: string[];
  model: string;
  /** Isolated sandbox path for fs/shell (sandbox/worktrees/<id>). */
  worktree?: string;
  /** Last task finish time — fair scheduling prefers least-recently-used. */
  lastTaskAt?: string;
};

export type MemoryFact = {
  id: string;
  agent: string;
  text: string;
  at: string;
};

/** Memory fact with share scope — the durable unit on the cluster bus. */
export type SharedMemoryFact = MemoryFact & {
  scope: MemoryScope;
  worker?: string;
  fleet?: string;
  tags?: string[];
  sourceWorker?: string;
};

export type LearnedSkill = {
  name: string;
  agent: string;
  fromTask: string;
  at: string;
};

/** Cluster-wide skill catalog entry (versioned, shareable across agents). */
export type SkillRecord = {
  name: string;
  version: number;
  /** Owning agent that first learned it; may be shared to others. */
  originAgent: string;
  fromTask: string;
  at: string;
  /** Agents allowed to load this skill (empty = origin only). */
  sharedWith: string[];
  /** Short recipe / description distilled from the trajectory. */
  summary: string;
};

/** Append-only delivery audit log (git-native delivery trail). */
export type DeliveryRecord = {
  id: string;
  at: string;
  kind: "comment" | "pull_request" | "check";
  body: string;
  workerId: string;
  agent: string;
  taskId: string;
  imageDigest: string;
  repo?: string;
  number?: number;
};

/** Persisted Hermes→DeepSeek trajectory for learning / export. */
export type TrajectoryRecord = {
  id: string;
  at: string;
  taskId: string;
  agent: string;
  workerId: string;
  imageDigest: string;
  plan: string[];
  steps: TrajectoryStep[];
  output: string;
};

/** Sliding-window webhook rate-limit counters (per delivery key / repo). */
export type RateLimitBucket = {
  key: string;
  windowStartedAt: string;
  count: number;
};

export type ClusterState = {
  revision: number;
  source: string;
  desired: DesiredAgent[];
  workers: Worker[];
  gitRepos: GitRepo[];
  policies: Policy[];
  /** Cluster memory bus (scoped facts). Legacy flat MemoryFact rows are upgraded on load. */
  memory: SharedMemoryFact[];
  skills: LearnedSkill[];
  /** Versioned skill registry (superset of learned skills). */
  skillRegistry: SkillRecord[];
  /** Append-only delivery journal. */
  deliveries: DeliveryRecord[];
  /** Hermes/DeepSeek trajectories for export and learning. */
  trajectories: TrajectoryRecord[];
  /** Webhook rate-limit buckets. */
  rateLimits: RateLimitBucket[];
  /** Durable work queue (webhook / simulate / CLI). */
  queue: QueuedTask[];
  metrics: ClusterMetrics;
  lastReconcile?: string;
};

export type ReconcilePlan = {
  create: Worker[];
  retire: Worker[];
  update: Worker[];
  capped: Array<{ agent: string; requested: number; allowed: number }>;
};

export type GithubEvent = {
  type: string;
  repo: string;
  title?: string;
  body?: string;
  number?: number;
  labels?: string[];
};

export type Task = {
  id: string;
  agent: string;
  prompt: string;
  event?: GithubEvent;
};

/** Work-queue item — GitHub webhook / CLI / simulate all land here. */
export type QueuedTask = {
  id: string;
  task: Task;
  enqueuedAt: string;
  status: "pending" | "claimed" | "done" | "failed";
  workerId?: string;
  attempts: number;
  source: "cli" | "github" | "webhook";
  error?: string;
  finishedAt?: string;
};

export type ClusterMetrics = {
  tasksCompleted: number;
  tasksFailed: number;
  tasksEnqueued: number;
  lastEventAt?: string;
  lastDrainAt?: string;
};

export type ToolCall = {
  plugin: string;
  name: string;
  input: Record<string, unknown>;
};

export type TrajectoryStep = {
  thought: string;
  calls: ToolCall[];
  observation: string;
};

export type RunResult = {
  task: Task;
  worker: Worker;
  /** Image digest the workflow ran against. */
  imageDigest: string;
  /** Stage owners for this run (Hermes brain + DeepSeek harness). */
  workflow: Array<{ id: string; owner: string }>;
  plan: string[];
  steps: TrajectoryStep[];
  delivery?: { kind: GithubSpec["deliver"]; body: string };
  learned?: LearnedSkill;
  output: string;
  /** Worktree cwd used for fs/shell isolation. */
  worktree?: string;
};
