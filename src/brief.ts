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
};

function section(heading: string, body: string): string {
  return body.trim() ? `## ${heading}\n${body.trim()}` : "";
}

export type WorkspaceEdits = {
  message?: string;
  files: Array<{ path: string; content: string }>;
};

/**
 * File writes and the commit Hermes planned. dsh runs these as tool calls.
 * A CLI harness (`claude -p`, `codex exec`, `copilot -p`) receives the same
 * edits in the brief and applies them itself.
 */
export function workspaceEdits(plan: HermesPlan): WorkspaceEdits | undefined {
  const files: WorkspaceEdits["files"] = [];
  let message: string | undefined;
  for (const call of plan.calls) {
    const action = call.input?.action;
    if (
      (call.name === "fs" || call.name === "str_replace_editor") &&
      action === "write" &&
      typeof call.input?.path === "string"
    ) {
      files.push({ path: call.input.path, content: String(call.input.content ?? "") });
    }
    if ((call.name === "shell" || call.name === "bash") && action === "commit") {
      const text = call.input?.message;
      if (typeof text === "string" && text.trim()) message = text.trim();
    }
  }
  if (!files.length && !message) return undefined;
  return { message, files };
}

function workspaceSection(plan: HermesPlan): string {
  const edits = workspaceEdits(plan);
  if (!edits) return "";
  return section(
    "Workspace",
    [
      "You are the harness for this run. Write each file exactly, then git commit with the message. Leave the worktree clean.",
      "```json",
      JSON.stringify(edits, null, 2),
      "```",
    ].join("\n"),
  );
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
    workspaceSection(plan),
    section(
      "Working directory",
      "You are already in the worker worktree. Make the change here; do not clone or switch repositories.",
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}
