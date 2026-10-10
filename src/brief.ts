/**
 * Brief composition — the `compose` stage made explicit.
 *
 * The embedded harness consumes a Hermes plan as a tool program. External CLI
 * runtimes drive their own agentic loop and take a prompt instead, so the same
 * inputs (soul, memory, skills, plan, task) are rendered as text here. One
 * composer keeps both paths fed from identical context.
 */

import type { HermesContract, HermesPlan } from "./contracts.js";
import type { AgentWorkflow } from "./workflow.js";
import type { Task } from "./types.js";

export type ComposeBriefOptions = {
  /** Cap on memory facts injected (most recent first). */
  maxFacts?: number;
  workspace?: { branch: string; base: string };
};

function section(heading: string, body: string): string {
  return body.trim() ? `## ${heading}\n${body.trim()}` : "";
}

/** Render soul + memory + skills + plan + task into one prompt. */
export function composeBrief(
  workflow: AgentWorkflow,
  hermes: HermesContract,
  task: Task,
  plan: HermesPlan,
  opts: ComposeBriefOptions = {},
): string {
  const maxFacts = opts.maxFacts ?? 10;
  const facts = hermes.port
    .query({ limit: maxFacts })
    .map((f) => `- ${f.text}`)
    .join("\n");
  const skills = workflow.brain.skills.length
    ? workflow.brain.skills.map((s) => `- ${s}`).join("\n")
    : "";
  const thoughts = plan.thoughts.filter(Boolean).map((t) => `- ${t}`).join("\n");
  const intent = plan.calls.length
    ? plan.calls.map((c) => `- ${c.name}(${JSON.stringify(c.input ?? {})})`).join("\n")
    : "";

  return [
    section("Identity", workflow.brain.soul),
    section("Prior knowledge", facts),
    section("Skills", skills),
    section("Plan", thoughts),
    section("Intended actions", intent),
    section("Task", task.prompt),
    section(
      "Working directory",
      opts.workspace
        ? [
            `You are on branch ${opts.workspace.branch}, cut from ${opts.workspace.base}.`,
            "You may commit on this branch.",
            "You must not push, switch branches, or change remotes.",
          ].join(" ")
        : [
            "You are already in the worker worktree. Act here; do not clone or switch repositories.",
            "Carry out the intended actions in order. Each one is a tool call: a name and its input.",
            "When the input has argv, run that command. When it has path and content, write that file.",
            "Every other call is yours to perform with the tools you have.",
          ].join(" "),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}
