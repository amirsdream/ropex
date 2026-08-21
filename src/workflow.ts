/**
 * Agent workflow: Hermes brain + DeepSeek Harness execution.
 * Stages assign each concern to the system that owns it best.
 */

import type { DesiredAgent, GithubSpec, HarnessProfile, HermesSpec } from "./types.js";
import { buildAgentImage, type ImageResolveOptions } from "./image.js";

export type WorkflowOwner = "hermes" | "deepseek" | "ropex";

export type WorkflowStage = {
  id: "compose" | "plan" | "execute" | "deliver" | "learn";
  owner: WorkflowOwner;
  /** What this stage contributes. */
  purpose: string;
};

/** Fixed pipeline — best attributes of each runtime, orchestrated by Ropex. */
export const WORKFLOW_STAGES: WorkflowStage[] = [
  {
    id: "compose",
    owner: "hermes",
    purpose: "Load SOUL, memory, and skills into the worker context",
  },
  {
    id: "plan",
    owner: "hermes",
    purpose: "Decide what to do from soul + skills + task",
  },
  {
    id: "execute",
    owner: "deepseek",
    purpose: "Run Cordis loop (tool-calls or code) with profile tools + permissions",
  },
  {
    id: "deliver",
    owner: "deepseek",
    purpose: "Emit comment / check / pull_request via delivery plugin",
  },
  {
    id: "learn",
    owner: "hermes",
    purpose: "Distill trajectory into a reusable skill for the next replica",
  },
];

export type AgentWorkflow = {
  agent: string;
  imageDigest: string;
  /** Hermes pillars frozen into the image. */
  brain: {
    soul: string;
    memory: HermesSpec["memory"];
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
      skills: [...image.hermes.skills],
      learning: image.hermes.learning,
    },
    harness: {
      profile: image.harness.profile,
      model: image.harness.model ?? "deepseek-v4-flash",
      plugins: [...image.harness.plugins],
      deliver: image.github?.deliver,
    },
    stages: WORKFLOW_STAGES.map((s) => ({ ...s })),
  };
}
