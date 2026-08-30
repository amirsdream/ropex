/**
 * Agent workflow: Hermes brain + DeepSeek Harness execution.
 * Stages assign each concern to the system that owns it best.
 */

import type { DesiredAgent, GithubSpec, HarnessProfile, HermesSpec } from "./types.js";
import { buildAgentImage, type ImageResolveOptions } from "./image.js";
import { resolveSharePolicy } from "./memory.js";

export type WorkflowOwner = "hermes" | "deepseek" | "ropex";

/**
 * Every stage belongs to exactly one phase of a single start → transform → result spine:
 *  - `intake`  (Start):   normalize the input and decide what to do (nothing has run yet).
 *  - `execute` (Transform): the one point where work actually happens.
 *  - `result`  (Result):  emit the outcome and persist what was learned.
 * This makes the pipeline's starting point, execution point, and result point unambiguous.
 */
export type WorkflowPhase = "intake" | "execute" | "result";

/** Ordered phases with the human labels the control plane surfaces. */
export const WORKFLOW_PHASE_ORDER: WorkflowPhase[] = ["intake", "execute", "result"];

export const WORKFLOW_PHASE_LABELS: Record<WorkflowPhase, string> = {
  intake: "Start",
  execute: "Execute",
  result: "Result",
};

export type WorkflowStage = {
  id: "compose" | "plan" | "execute" | "deliver" | "learn";
  owner: WorkflowOwner;
  /** Which of the three spine phases this stage belongs to. */
  phase: WorkflowPhase;
  /** What this stage contributes. */
  purpose: string;
};

/** Fixed pipeline — best attributes of each runtime, orchestrated by Ropex. */
export const WORKFLOW_STAGES: WorkflowStage[] = [
  {
    id: "compose",
    owner: "hermes",
    phase: "intake",
    purpose: "Load SOUL, memory, and skills into the worker context",
  },
  {
    id: "plan",
    owner: "hermes",
    phase: "intake",
    purpose: "Decide what to do from soul + skills + task",
  },
  {
    id: "execute",
    owner: "deepseek",
    phase: "execute",
    purpose: "Run Cordis loop (tool-calls or code) with profile tools + permissions",
  },
  {
    id: "deliver",
    owner: "deepseek",
    phase: "result",
    purpose: "Emit comment / check / pull_request via delivery plugin",
  },
  {
    id: "learn",
    owner: "hermes",
    phase: "result",
    purpose: "Distill trajectory into a reusable skill for the next replica",
  },
];

export type WorkflowPhaseGroup = {
  phase: WorkflowPhase;
  label: string;
  stages: WorkflowStage[];
};

/** Group the flat stage list into the ordered start → execute → result spine. */
export function workflowPhases(stages: WorkflowStage[] = WORKFLOW_STAGES): WorkflowPhaseGroup[] {
  return WORKFLOW_PHASE_ORDER.map((phase) => ({
    phase,
    label: WORKFLOW_PHASE_LABELS[phase],
    stages: stages.filter((s) => s.phase === phase),
  })).filter((group) => group.stages.length > 0);
}

export type AgentWorkflow = {
  agent: string;
  imageDigest: string;
  /** Hermes pillars frozen into the image. */
  brain: {
    soul: string;
    memory: HermesSpec["memory"];
    share: import("./types.js").MemoryShareSpec;
    skills: string[];
    learning: boolean;
  };
  /** DeepSeek Harness attributes frozen into the image. */
  harness: {
    profile: HarnessProfile;
    model: string;
    plugins: string[];
    deliver?: GithubSpec["deliver"];
  };
  stages: WorkflowStage[];
};

/** Compose an immutable workflow from desired agent code (image). */
export function composeWorkflow(
  agent: DesiredAgent,
  opts: ImageResolveOptions = {},
): AgentWorkflow {
  const image = buildAgentImage(agent, opts);
  return {
    agent: agent.metadata.name,
    imageDigest: image.digest,
    brain: {
      soul: image.soulText || image.hermes.soul || "default",
      memory: image.hermes.memory,
      share: resolveSharePolicy(image.hermes),
      skills: [...image.hermes.skills],
      learning: image.hermes.learning,
    },
    harness: {
      profile: image.harness.profile,
      model: image.harness.model ?? "gpt-4o-mini",
      plugins: [...image.harness.plugins],
      deliver: image.github?.deliver,
    },
    stages: WORKFLOW_STAGES.map((s) => ({ ...s })),
  };
}
