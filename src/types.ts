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

export type HermesSpec = {
  /** Path to SOUL.md / identity file. */
  soul?: string;
  memory: "sqlite" | "none";
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
  harness: HarnessProfile;
  plugins: string[];
  skills: string[];
  model: string;
};

export type MemoryFact = {
  id: string;
  agent: string;
  text: string;
  at: string;
};

export type LearnedSkill = {
  name: string;
  agent: string;
  fromTask: string;
  at: string;
};

export type ClusterState = {
  revision: number;
  source: string;
  desired: DesiredAgent[];
  workers: Worker[];
  gitRepos: GitRepo[];
  policies: Policy[];
  memory: MemoryFact[];
  skills: LearnedSkill[];
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
  plan: string[];
  steps: TrajectoryStep[];
  delivery?: { kind: GithubSpec["deliver"]; body: string };
  learned?: LearnedSkill;
  output: string;
};
