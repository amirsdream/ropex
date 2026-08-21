/**
 * Hermes-shaped brain: soul, memory, skills, closed learning loop.
 * Plans work; the DeepSeek harness executes it.
 */

import type { AgentSpec, LearnedSkill, MemoryFact, Task, TrajectoryStep } from "./types.js";

export type HermesBrain = {
  soul: string;
  skills: string[];
  memory: MemoryFact[];
  plan(task: Task): { thoughts: string[]; calls: Array<{ name: string; input: Record<string, unknown> }> };
  remember(fact: MemoryFact): void;
  learn(task: Task, steps: TrajectoryStep[]): LearnedSkill | undefined;
};

const DEFAULT_SOUL = [
  "You are a Ropex worker.",
  "Prefer git-native delivery: comments, checks, and pull requests.",
  "Use the smallest tool sequence that finishes the job.",
  "After hard tasks, persist a reusable skill.",
].join(" ");

export function createHermes(spec: AgentSpec, existing?: { memory?: MemoryFact[]; skills?: string[] }): HermesBrain {
  const memory = [...(existing?.memory ?? [])];
  const skills = [...new Set([...spec.hermes.skills, ...(existing?.skills ?? [])])];
  const soul = spec.hermes.soul ?? DEFAULT_SOUL;

  return {
    soul,
    skills,
    memory,
    plan(task) {
      const thoughts = [
        `soul: ${soul.slice(0, 80)}`,
        `skills: ${skills.join(", ") || "none"}`,
        `task: ${task.prompt}`,
      ];
      if (task.event) {
        thoughts.push(`github ${task.event.type} on ${task.event.repo}`);
      }
      const calls = planCalls(task, skills);
      return { thoughts, calls };
    },
    remember(fact) {
      memory.push(fact);
    },
    learn(task, steps) {
      if (!spec.hermes.learning) return undefined;
      if (steps.length < 2 && !task.event) return undefined;
      const slug = slugify(task.prompt).slice(0, 40);
      const name = `learned-${slug || "task"}`;
      if (skills.includes(name)) return undefined;
      skills.push(name);
      return {
        name,
        agent: task.agent,
        fromTask: task.prompt,
        at: new Date().toISOString(),
      };
    },
  };
}

function planCalls(
  task: Task,
  skills: string[],
): Array<{ name: string; input: Record<string, unknown> }> {
  const event = task.event?.type ?? "";
  if (event.startsWith("issues.")) {
    return [
      { name: "github", input: { action: "read_issue", repo: task.event?.repo, title: task.event?.title } },
      { name: "github", input: { action: "comment", body: `triaged via skills: ${skills.join(", ")}` } },
    ];
  }
  if (event.startsWith("pull_request.")) {
    return [
      { name: "github", input: { action: "read_pr", repo: task.event?.repo, number: task.event?.number } },
      { name: "fs", input: { action: "diff" } },
      { name: "github", input: { action: "review", event: "COMMENT" } },
    ];
  }
  if (/test|fix|implement/i.test(task.prompt)) {
    return [
      { name: "fs", input: { action: "search", query: task.prompt } },
      { name: "shell", input: { action: "test" } },
      { name: "github", input: { action: "open_pr", title: task.prompt } },
    ];
  }
  return [{ name: "fs", input: { action: "read", query: task.prompt } }];
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
