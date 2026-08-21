/**
 * Immutable agent images — content-addressed snapshots of agent code + config.
 * Like a container image digest: change the soul/skills/harness → new image → roll workers.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DesiredAgent, HarnessSpec, HermesSpec, GithubSpec } from "./types.js";

export type AgentImage = {
  /** Short sha256 of the canonical agent code payload. */
  digest: string;
  hermes: HermesSpec;
  harness: HarnessSpec;
  github?: GithubSpec;
  /** Soul body frozen into the image (empty if none). */
  soulText: string;
};

export type ImageResolveOptions = {
  /** Workspace root for reading soul files. */
  root?: string;
};

/** Canonical payload that defines an agent image (order-stable). */
export function agentImagePayload(agent: DesiredAgent, soulText: string): string {
  return JSON.stringify({
    apiVersion: agent.apiVersion,
    name: agent.metadata.name,
    labels: agent.metadata.labels ?? {},
    hermes: {
      soul: agent.spec.hermes.soul ?? null,
      soulText,
      memory: agent.spec.hermes.memory,
      learning: agent.spec.hermes.learning,
      skills: [...agent.spec.hermes.skills].sort(),
    },
    harness: {
      profile: agent.spec.harness.profile,
      model: agent.spec.harness.model ?? null,
      plugins: [...agent.spec.harness.plugins].sort(),
    },
    github: agent.spec.github
      ? {
          events: [...agent.spec.github.events].sort(),
          deliver: agent.spec.github.deliver,
        }
      : null,
    selector: agent.spec.selector?.matchLabels ?? null,
  });
}

export function digestOf(payload: string): string {
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function readSoulText(root: string | undefined, soulPath: string | undefined): string {
  if (!soulPath) return "";
  if (!root) return `path:${soulPath}`;
  try {
    return readFileSync(join(root, soulPath), "utf8");
  } catch {
    return `missing:${soulPath}`;
  }
}

/** Build the immutable image for a desired agent from its code/config. */
export function buildAgentImage(agent: DesiredAgent, opts: ImageResolveOptions = {}): AgentImage {
  const soulText = readSoulText(opts.root, agent.spec.hermes.soul);
  const digest = digestOf(agentImagePayload(agent, soulText));
  return {
    digest,
    hermes: {
      ...agent.spec.hermes,
      skills: [...agent.spec.hermes.skills],
    },
    harness: {
      ...agent.spec.harness,
      plugins: [...agent.spec.harness.plugins],
    },
    github: agent.spec.github
      ? { ...agent.spec.github, events: [...agent.spec.github.events] }
      : undefined,
    soulText,
  };
}
