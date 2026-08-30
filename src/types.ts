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
  /** Auto-write remembered facts to memory/*.yaml for git review. */
  exportMemory?: boolean;
};

export type GithubSpec = {
  events: string[];
  deliver: "comment" | "pull_request" | "check";
};

export type PlacementSpec = {
  /** Hard: worker labels must include these. */
  require?: Record<string, string>;
  /** Soft: prefer workers whose labels match. */
  prefer?: Record<string, string>;
  /**
   * Taints on the agent/worker slot (NoSchedule = tasks without matching
   * toleration cannot claim this worker).
   */
  taints?: Array<{ key: string; effect: "NoSchedule" }>;
  /** Task/event must tolerate these keys (Exists) or key=value. */
  tolerations?: Array<{ key: string; operator: "Exists" | "Equal"; value?: string }>;
};

/** How agent capacity is materialised. */
export type ScaleMode = "onDemand" | "static";

export type AgentSpec = {
  harness: HarnessSpec;
  hermes: HermesSpec;
  github?: GithubSpec;
  /**
   * Standing warm pool size when `scale: static`.
   * For `onDemand`, optional hint folded into maxConcurrent when maxConcurrent omitted.
   */
  replicas: number;
  /**
   * Capacity model. Default `onDemand` (spawn on claim, destroy after task).
   * Set `scale: static` for an explicit standing warm pool.
   */
  scale?: ScaleMode;
  /**
   * Max concurrent live workers for this agent when scale is onDemand.
   * Defaults to `replicas` or 1. Policy.maxReplicas is the cluster ceiling.
   */
  maxConcurrent?: number;
  /**
   * Keep an idle onDemand worker warm for this many ms after a task (0 = destroy immediately).
   */
  idleTTLMs?: number;
  selector?: LabelSelector;
  /** Scheduling constraints for claim / placement. */
  placement?: PlacementSpec;
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
    /**
     * Static: expand into N derived agents (warm inventory).
     * OnDemand: single agent definition with maxConcurrent = this value (or maxConcurrent).
     */
    replicas: number;
    scale?: ScaleMode;
    maxConcurrent?: number;
    idleTTLMs?: number;
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
    /** Task inbox directory relative to repo path (default `tasks`). */
    tasksPath?: string;
    /** Declarative memory facts relative to repo path (default `memory`). */
    memoryPath?: string;
  };
};

/** Git-declared memory fact (forge-neutral durable knowledge). */
export type MemoryManifest = {
  apiVersion: typeof API_VERSION;
  kind: "Memory";
  metadata: ObjectMeta;
  spec: {
    agent: string;
    text: string;
    scope?: MemoryScope;
    fleet?: string;
    tags?: string[];
  };
};

/** Git-native work item declared in the fleet repo (forge-neutral queue). */
export type TaskManifest = {
  apiVersion: typeof API_VERSION;
  kind: "Task";
  metadata: ObjectMeta;
  spec: {
    agent: string;
    prompt: string;
    priority?: number;
    status?: "pending" | "claimed" | "done" | "failed" | "cancelled";
    delivery?: { mode?: TaskDeliveryMode };
    result?: {
      output?: string;
      workerId?: string;
      completedAt?: string;
      error?: string;
    };
  };
};

export type Policy = {
  apiVersion: typeof API_VERSION;
  kind: "Policy";
  metadata: ObjectMeta;
  spec: {
    /**
     * Cluster-wide ceiling on live workers (static pools + on-demand spawns).
     * Acts as max concurrent executors — never spawn uncapped fleets.
     */
    maxReplicas: number;
    permissions: {
      deny: string[];
      requireApproval: string[];
    };
    /**
     * Optional task-unit budget. When set, enqueue/spend is gated per scope.
     * Units are abstract (1 ≈ one minimal task); profile weights apply on charge.
     */
    budget?: {
      /** Max units in the rolling window (required when budget is set). */
      maxUnits: number;
      /** Window length in ms (default 1h). */
      windowMs?: number;
      /** Scope for the ledger key (default cluster). */
      scope?: "cluster" | "fleet" | "agent";
    };
  };
};

export type Manifest = Agent | Fleet | GitRepo | Policy | TaskManifest | MemoryManifest;

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
  /** When true, scheduler will not claim this worker (drain/cordon). */
  cordoned?: boolean;
  /** Scheduling labels (from agent metadata / fleet template). */
  labels?: Record<string, string>;
  /** NoSchedule taints inherited from Agent.spec.placement.taints. */
  taints?: Array<{ key: string; effect: "NoSchedule" }>;
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
  /** When loaded from or exported to git Memory YAML. */
  manifestPath?: string;
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

/** Outbound webhook POST intent (network fail-closed until live transport). */
export type OutboundDelivery = {
  id: string;
  at: string;
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /** simulated = recorded locally; rejected = live transport not wired / bad URL. */
  status: "simulated" | "rejected";
  reason?: string;
  deliveryId?: string;
  agent?: string;
  taskId?: string;
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
  /** Workflow stage ids completed for this run (compose→learn). */
  stages?: Array<"compose" | "plan" | "execute" | "deliver" | "learn">;
};

/** Sliding-window webhook rate-limit counters (per delivery key / repo). */
export type RateLimitBucket = {
  key: string;
  windowStartedAt: string;
  count: number;
  /** Cap applied when this window was opened (defaults assumed if absent). */
  limit?: number;
  /** Window length in ms when opened. */
  windowMs?: number;
};

/** Human/agent approval for Policy.requireApproval tools. */
export type ApprovalRequest = {
  id: string;
  at: string;
  status: "pending" | "approved" | "rejected";
  tool: string;
  taskId: string;
  agent: string;
  workerId: string;
  reason: string;
  input?: Record<string, unknown>;
  decidedAt?: string;
};

/** Append-only control-plane audit event (event-sourced trail). */
export type AuditKind =
  | "reconcile"
  | "enqueue"
  | "claim"
  | "complete"
  | "retry"
  | "dead"
  | "reclaim"
  | "webhook"
  | "approval"
  | "sync"
  | "memory"
  | "info";

export type AuditEvent = {
  id: string;
  at: string;
  kind: AuditKind;
  message: string;
  agent?: string;
  workerId?: string;
  taskId?: string;
  revision?: number;
  meta?: Record<string, string | number | boolean | null>;
};

/** External executor pipeline run (engine-neutral API). */
export type PipelineStageRun = {
  id: string;
  agent: string;
  prompt: string;
  /** Immutable original prompt (context handoff recomputed each drain). */
  basePrompt?: string;
  role?: string;
  taskId: string;
  status: "pending" | "running" | "done" | "failed";
  /** True after stage.start has been emitted for this stage. */
  started?: boolean;
  workerId?: string;
  output?: string;
  error?: string;
};

/** Which phase of the start → transform → result spine a pipeline is currently in. */
export type PipelinePhase = "intake" | "execute" | "result";

/** The Start point: the normalized input a run was accepted with. */
export type PipelineInput = {
  prompt: string;
  /** Agents the plan was scoped to, when the caller pinned them. */
  agents?: string[];
  at: string;
};

/** The Result point: the single terminal outcome of a run. */
export type PipelineResult = {
  status: "done" | "failed";
  /** Concatenated stage outputs (empty string on failure with no output). */
  output: string;
  stageCount: number;
  /** Agents that produced output, in stage order. */
  producedBy: string[];
  at: string;
  /** Present when the run ended in failure. */
  error?: string;
};

export type PipelineRun = {
  id: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  status: "pending" | "running" | "done" | "failed";
  /** Start point — normalized input captured when the run was accepted. */
  input: PipelineInput;
  stages: PipelineStageRun[];
  output?: string;
  /** Result point — terminal outcome, set exactly once when the run finishes. */
  result?: PipelineResult;
  /** Recent executor events (persisted, capped). */
  events?: PipelineEventRecord[];
};

/** Persisted executor event snapshot on a pipeline run. */
export type PipelineEventRecord = {
  pipelineId: string;
  at: string;
  kind: string;
  stageId?: string;
  agent?: string;
  taskId?: string;
  workerId?: string;
  message?: string;
  artifact?: string;
  meta?: Record<string, string | number | boolean | null>;
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
  /** Intended outbound HTTP deliveries (stub until live GitHub App). */
  outbound: OutboundDelivery[];
  /** Hermes/DeepSeek trajectories for export and learning. */
  trajectories: TrajectoryRecord[];
  /** Webhook rate-limit buckets. */
  rateLimits: RateLimitBucket[];
  /** Pending/decided approvals for gated tools. */
  approvals: ApprovalRequest[];
  /** Durable work queue (API / git / webhook / CLI). */
  queue: QueuedTask[];
  /** Native tasks submitted via API/UI (primary inbox when no external forge). */
  nativeTasks?: NativeTaskRecord[];
  /** Configured ingress/egress connectors (GitHub optional). */
  connectors?: ConnectorRecord[];
  metrics: ClusterMetrics;
  /** Append-only control-plane audit trail. */
  audit: AuditEvent[];
  /** Last sync status per declared GitRepo (multi-repo). */
  gitRepoStatus: GitRepoSyncStatus[];
  /** Rolling task-unit spend for Policy.budget. */
  budgets: BudgetLedger[];
  /**
   * Seen GitHub webhook delivery IDs (x-github-delivery) for idempotent ingest.
   * Soft-capped; oldest dropped first.
   */
  webhookSeen?: string[];
  /** When true, claimPending / drain will not take new work. */
  queuePaused?: boolean;
  /** Preferred parallel drain concurrency (bounded; default 1). */
  drainConcurrency?: number;
  /** Sticky worker affinity hints (repo/agent → worker) with TTL. */
  affinity?: AffinityBinding[];
  /** Durable pipeline runs for external executor clients. */
  pipelines?: PipelineRun[];
  lastReconcile?: string;
  /** One-click stack lifecycle (up/down from UI or `ropex up`). */
  stack?: StackRecord;
};

export type StackStatus = "up" | "down" | "starting" | "stopping";

export type StackRecord = {
  status: StackStatus;
  manifest: string;
  updatedAt: string;
  message?: string;
};

/** Sticky scheduling hint — prefer the same worker for a key until expiry. */
export type AffinityBinding = {
  key: string;
  workerId: string;
  agent: string;
  expiresAt: string;
};

/** Rolling window spend counter for budget admission. */
export type BudgetLedger = {
  key: string;
  windowStartedAt: string;
  units: number;
};

/** Per-GitRepo sync stamp for interval-aware multi-repo sync. */
export type GitRepoSyncStatus = {
  name: string;
  path: string;
  lastSyncedAt?: string;
  ok: boolean;
  reason?: string;
  /** Last clone attempt backend (local-copy | remote-stub). */
  cloneBackend?: string;
  /** Last clone phase reached (resolve → done/failed). */
  clonePhase?: string;
  /** 0–100 progress from last clone / plan. */
  cloneProgressPct?: number;
  lastClonedAt?: string;
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

/** Where task results are delivered after a worker finishes. */
export type TaskDeliveryMode = "ui" | "git" | "webhook" | "github";

export type TaskDeliverySpec = {
  mode: TaskDeliveryMode;
  connectorId?: string;
  webhookUrl?: string;
};

/** First-class task submitted via API/UI (not git or GitHub). */
export type NativeTaskRecord = {
  id: string;
  agent: string;
  prompt: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  delivery: TaskDeliverySpec;
  priority?: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  workerId?: string;
  output?: string;
  error?: string;
  manifestPath?: string;
};

export type ConnectorKind = TaskDeliveryMode;

/** Optional ingress/egress adapter (GitHub, webhook, git, native UI). */
export type ConnectorRecord = {
  id: string;
  kind: ConnectorKind;
  enabled: boolean;
  label: string;
  description?: string;
  config?: Record<string, string>;
};

export type Task = {
  id: string;
  agent: string;
  prompt: string;
  event?: GithubEvent;
  /** Absolute path to source Task YAML for git delivery writeback. */
  manifestPath?: string;
  delivery?: TaskDeliverySpec;
};

/** Work-queue item — API / git / GitHub / pipeline ingress. */
export type QueuedTask = {
  id: string;
  task: Task;
  enqueuedAt: string;
  status: "pending" | "claimed" | "done" | "failed" | "dead";
  workerId?: string;
  /** Set when a worker claims the item (stuck-probe input). */
  claimedAt?: string;
  /** Lease deadline — expired claims are reclaimed. */
  leaseExpiresAt?: string;
  /** Last heartbeat that extended the lease. */
  heartbeatAt?: string;
  attempts: number;
  source: "cli" | "api" | "github" | "webhook" | "git" | "pipeline";
  /** Higher runs first (default 0). */
  priority: number;
  error?: string;
  finishedAt?: string;
  /** Earliest time a pending retry may be claimed again. */
  nextRetryAt?: string;
};

export type ClusterMetrics = {
  tasksCompleted: number;
  tasksFailed: number;
  tasksEnqueued: number;
  /** Soft failures that were re-queued for another attempt. */
  tasksRetried?: number;
  /** Tasks that exhausted retries (dead-letter). */
  tasksDead?: number;
  /** Claimed tasks reclaimed after lease expiry. */
  leasesReclaimed?: number;
  /** Webhook deliveries skipped as duplicates. */
  webhookDuplicates?: number;
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
