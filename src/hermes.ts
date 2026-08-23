/**
 * Hermes-shaped brain: soul, memory port, skills, closed learning loop.
 * Plans work; the DeepSeek harness executes it.
 * Implements HermesContract so UI and runtime share one interface.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import type { HermesContract, HermesPlan, MemoryPort } from "./contracts.js";
import { createMemoryPort, memoryContextFor, SharedMemoryStore } from "./memory.js";
import type {
  AgentSpec,
  LearnedSkill,
  Task,
  TrajectoryStep,
  Worker,
} from "./types.js";

const require = createRequire(import.meta.url);

export type HermesBackend = "simulated" | "live";

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
  backend?: HermesBackend;
  /** Worker worktree cwd for live hermes-agent invocations. */
  cwd?: string;
};

/** True when optional peer `hermes-agent` resolves (network-free check). */
export function hermesPackageInstalled(): boolean {
  try {
    require.resolve("hermes-agent/bin/hermes.js");
    return true;
  } catch {
    return false;
  }
}

export function resolveHermesBackend(explicit?: HermesBackend): HermesBackend {
  if (explicit) return explicit;
  if (process.env.ROPEX_HERMES_BACKEND === "live") return "live";
  return "simulated";
}

/** Resolve installed hermes CLI entry (undefined when package absent). */
export function resolveHermesBin(): string | undefined {
  try {
    return require.resolve("hermes-agent/bin/hermes.js");
  } catch {
    return undefined;
  }
}

/**
 * Run one hermes-agent turn synchronously (live backend only).
 * Requires hermes-agent installed; fails closed in tests without the package.
 */
export function runLiveHermesTask(
  prompt: string,
  opts: { cwd?: string; timeoutMs?: number } = {},
): string {
  const bin = resolveHermesBin();
  if (!bin) {
    throw new Error("hermes live backend unavailable — install hermes-agent first.");
  }
  if (process.env.VITEST === "true") {
    throw new Error("hermes live backend disabled under vitest");
  }
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const result = spawnSync(process.execPath, [bin, prompt], {
    cwd: opts.cwd,
    env: process.env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || "hermes exited non-zero").trim();
    throw new Error(`hermes live failed (${result.status}): ${msg.slice(0, 500)}`);
  }
  return (result.stdout || result.stderr || "").trim();
}

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
  const backend = resolveHermesBackend(options.backend);
  const cwd = options.cwd;

  const offlinePlan = (task: Task): HermesPlan => {
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
    return { thoughts, calls };
  };

  return {
    soul,
    skills,
    get memory() {
      return port.snapshot();
    },
    port,
    plan(task) {
      if (backend === "live") {
        try {
          const liveOut = runLiveHermesTask(task.prompt, { cwd: cwd ?? process.cwd() });
          return {
            thoughts: [`hermes-live: ${liveOut.slice(0, 240)}`],
            calls: [{ name: "fs", input: { action: "apply_plan", plan: liveOut.slice(0, 4000) } }],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            thoughts: [`hermes-live failed: ${msg}`, "falling back to offline planner"],
            calls: offlinePlan(task).calls,
          };
        }
      }
      return offlinePlan(task);
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

export type BootHermesOptions = HermesCreateOptions;

/** Boot Hermes brain — simulated by default; live when ROPEX_HERMES_BACKEND=live. */
export function bootHermes(spec: AgentSpec, opts: BootHermesOptions = {}): HermesBrain {
  const backend = resolveHermesBackend(opts.backend);
  if (backend === "live" && !hermesPackageInstalled()) {
    const scaffold = liveHermesScaffold();
    throw new Error(`hermes live backend unavailable — ${scaffold.summary}`);
  }
  return createHermes(spec, { ...opts, backend });
}

/** Checklist for wiring a live hermes-agent process (network-free until wired). */
export type LiveHermesScaffold = {
  liveReady: boolean;
  packageInstalled: boolean;
  packageName: string;
  summary: string;
  steps: string[];
  env: string[];
};

/**
 * Describe how to attach a real hermes-agent runtime without importing it.
 * createHermes() stays the offline brain; live invokes hermes-agent CLI.
 */
export function liveHermesScaffold(): LiveHermesScaffold {
  const packageInstalled = hermesPackageInstalled();
  return {
    liveReady: packageInstalled,
    packageInstalled,
    packageName: "hermes-agent",
    summary: packageInstalled
      ? "Live hermes-agent present — set ROPEX_HERMES_BACKEND=live to plan via hermes CLI."
      : "Install hermes-agent for live brain; createHermes() stays the offline default.",
    steps: [
      "Add optional peer dependency hermes-agent (never required by tests).",
      "Set ROPEX_HERMES_BACKEND=live for production runs.",
      "bootHermes() invokes hermes-agent CLI for plan(); harness still executes via dsh.",
      "Bridge MemoryPort to SharedMemoryStore (same scopes as offline).",
      "Keep createHermes() as the default for CI and network-free demos.",
      "Prove plan→learn loop parity with simulated brain in sandbox.",
    ],
    env: ["ROPEX_HERMES_BACKEND=simulated|live"],
  };
}
