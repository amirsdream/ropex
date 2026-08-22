/**
 * Hermes-shaped brain: soul, memory port, skills, closed learning loop.
 * Plans work; the DeepSeek harness executes it.
 * Implements HermesContract so UI and runtime share one interface.
 */

import type { HermesContract, HermesPlan, MemoryPort } from "./contracts.js";
import { createMemoryPort, memoryContextFor, SharedMemoryStore } from "./memory.js";
import type {
  AgentSpec,
  LearnedSkill,
  Task,
  TrajectoryStep,
  Worker,
} from "./types.js";

export type HermesBrain = HermesContract;

const DEFAULT_SOUL = [
  "You are a Ropex worker.",
  "Prefer git-native delivery: comments, checks, and pull requests.",
  "Use the smallest tool sequence that finishes the job.",
  "After hard tasks, persist a reusable skill.",
].join(" ");

export type HermesCreateOptions = {
  store?: SharedMemoryStore;
  worker?: Pick<Worker, "id" | "agent" | "fleet">;
  skills?: string[];
};

export function createHermes(spec: AgentSpec, options: HermesCreateOptions = {}): HermesBrain {
  const worker = options.worker ?? {
    id: `${"agent"}:0`,
    agent: "agent",
    fleet: undefined,
  };
  // Prefer real agent name from caller when worker.agent is set by runtime.
  const ctx = memoryContextFor(
    { id: worker.id, agent: worker.agent, fleet: worker.fleet },
    spec.hermes,
  );
  const store = options.store ?? new SharedMemoryStore([]);
  const port: MemoryPort = createMemoryPort(store, ctx);
  const skills = [...new Set([...spec.hermes.skills, ...(options.skills ?? [])])];
  const soul = spec.hermes.soul ?? DEFAULT_SOUL;

  return {
    soul,
    skills,
    get memory() {
      return port.snapshot();
    },
    port,
    plan(task) {
      const memHints = port.query({ limit: 3 }).map((m) => `memory[${m.scope}]: ${m.text.slice(0, 60)}`);
      const thoughts = [
        `soul: ${soul.slice(0, 80)}`,
        `skills: ${skills.join(", ") || "none"}`,
        `share: read=${ctx.policy.read.join("+") || "∅"} write=${ctx.policy.write}`,
        `task: ${task.prompt}`,
        ...memHints,
      ];
      if (task.event) {
        thoughts.push(`github ${task.event.type} on ${task.event.repo}`);
      }
      const calls = planCalls(task, skills);
      return { thoughts, calls } satisfies HermesPlan;
    },
    remember(fact) {
      if (typeof fact === "string") {
        return port.remember(fact);
      }
      return port.remember(fact.text, {
        id: fact.id,
        scope: fact.scope,
        tags: fact.tags,
      });
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
      } satisfies LearnedSkill;
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

export type { HermesPlan };

/** Checklist for wiring a live hermes-agent process (network-free until wired). */
export type LiveHermesScaffold = {
  liveReady: boolean;
  packageName: string;
  summary: string;
  steps: string[];
  env: string[];
};

/**
 * Describe how to attach a real hermes-agent runtime without importing it.
 * createHermes() stays the offline brain; live is a future process/RPC seam.
 */
export function liveHermesScaffold(): LiveHermesScaffold {
  return {
    liveReady: false,
    packageName: "hermes-agent",
    summary:
      "Live hermes-agent not wired — createHermes() is the offline brain; process/RPC seam TBD.",
    steps: [
      "Optional peer: hermes-agent (never required by tests).",
      "Implement createLiveHermes(spec) returning HermesContract over RPC/stdio.",
      "Load SOUL.md from hermes.soul path into the live process identity.",
      "Bridge MemoryPort to SharedMemoryStore (same scopes as offline).",
      "Keep createHermes() as the default for CI and network-free demos.",
      "Prove plan→learn loop parity with simulated brain in sandbox.",
    ],
    env: ["ROPEX_HERMES_BACKEND=simulated|live", "HERMES_AGENT_BIN=(live only)"],
  };
}
