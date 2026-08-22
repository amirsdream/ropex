/**
 * Offline DeepSeek Harness (dsh) adapter.
 * Profile packs mirror `@deepseek-ai/dsh` presets; swap backend to "live" later
 * without changing Hermes→harness call sites.
 *
 * Live wiring contract (fail-closed until the package is present):
 * 1. `npm i @deepseek-ai/dsh` (optional peer — tests never require it)
 * 2. Map `DSH_PROFILE_PACKS[profile].plugins` onto Cordis pack loaders
 * 3. Implement `bootLiveDsh(spec)` that returns the same `DshAdapter` shape
 * 4. Keep Policy deny/requireApproval as a permissions plugin in front of tools
 * 5. `backend: "live"` must throw this module's error until step 3 lands
 */

import type { HermesPlan } from "./contracts.js";
import { createHarness, loopModeFor, toolsFor, type HarnessLoop } from "./harness.js";
import type { AgentSpec, HarnessProfile, TrajectoryStep } from "./types.js";
import type { HermesContract, MemoryPort } from "./contracts.js";
import type { Kernel } from "./plugins.js";

export type DshBackend = "simulated" | "live";

export type DshProfilePack = {
  profile: HarnessProfile;
  loop: "tool-calls" | "code";
  tools: string[];
  /** Cordis-style plugin ids the live dsh pack would load. */
  plugins: string[];
  description: string;
};

/** Canonical profile packs — the seam live `@deepseek-ai/dsh` will fill. */
export const DSH_PROFILE_PACKS: Record<HarnessProfile, DshProfilePack> = {
  minimal: {
    profile: "minimal",
    loop: "tool-calls",
    tools: ["bash", "str_replace_editor"],
    plugins: ["model", "session", "permissions", "tools", "loop"],
    description: "Bare editor + shell — DeepSeek minimal preset",
  },
  code: {
    profile: "code",
    loop: "code",
    tools: ["fs", "shell", "github"],
    plugins: ["model", "session", "permissions", "tools", "loop:code", "delivery"],
    description: "Code-mode collapsed program — DeepSeek code preset",
  },
  standard: {
    profile: "standard",
    loop: "tool-calls",
    tools: ["fs", "shell", "web", "github", "subagent"],
    plugins: ["model", "session", "permissions", "tools", "loop", "delivery", "subagent"],
    description: "Full tool surface — DeepSeek standard preset",
  },
  creator: {
    profile: "creator",
    loop: "tool-calls",
    tools: ["fs", "shell", "web", "github", "subagent", "inspect"],
    plugins: ["model", "session", "permissions", "tools", "loop", "delivery", "inspect"],
    description: "Creator + inspect — DeepSeek creator preset",
  },
};

export function profilePack(profile: HarnessProfile): DshProfilePack {
  return DSH_PROFILE_PACKS[profile];
}

export type DshAdapter = {
  backend: DshBackend;
  pack: DshProfilePack;
  kernel: Kernel;
  /** Run a Hermes-planned tool program through the harness loop. */
  execute(plan: HermesPlan): Promise<{ observations: string[]; steps: TrajectoryStep[] }>;
};

export type BootDshOptions = {
  deny?: string[];
  requireApproval?: string[];
  hermes?: HermesContract;
  memory?: MemoryPort;
  cwd?: string;
  /** Default simulated — live throws until @deepseek-ai/dsh is wired. */
  backend?: DshBackend;
};

/** Checklist returned by `liveDshScaffold` — docs + UI surface this. */
export type LiveDshScaffold = {
  liveReady: boolean;
  packageName: string;
  summary: string;
  steps: string[];
  env: string[];
  profiles: HarnessProfile[];
};

/**
 * Describe how to wire the live `@deepseek-ai/dsh` backend without importing it.
 * Always network-free; `liveReady` stays false until a future adapter lands.
 */
export function liveDshScaffold(): LiveDshScaffold {
  return {
    liveReady: false,
    packageName: "@deepseek-ai/dsh",
    summary:
      "Live dsh not wired — bootDsh(backend: live) fails closed; use simulated packs offline.",
    steps: [
      "Add optional peer dependency @deepseek-ai/dsh (never required by tests).",
      "Implement bootLiveDsh(spec) returning DshAdapter with backend: \"live\".",
      "Map DSH_PROFILE_PACKS[profile].plugins onto Cordis pack loaders.",
      "Mount Policy deny/requireApproval as a permissions plugin before tools.",
      "Prove one Hermes plan → trajectory in ropex run --root sandbox with backend live.",
      "Keep backend: simulated as the default for CI and network-free demos.",
    ],
    env: ["ROPEX_DSH_BACKEND=simulated|live", "DEEPSEEK_API_KEY=(live only)"],
    profiles: Object.keys(DSH_PROFILE_PACKS) as HarnessProfile[],
  };
}

/**
 * Boot a DeepSeek-shaped harness for an agent profile.
 * Live backend is a deliberate stub: tests stay network-free.
 */
export async function bootDsh(spec: AgentSpec, opts: BootDshOptions = {}): Promise<DshAdapter> {
  const backend = opts.backend ?? "simulated";
  const pack = profilePack(spec.harness.profile);

  if (backend === "live") {
    const scaffold = liveDshScaffold();
    throw new Error(
      `dsh live backend not wired — ${scaffold.summary} Next: ${scaffold.steps[1]}`,
    );
  }

  const resolvedTools = toolsFor(spec);
  const aligned: DshProfilePack = {
    ...pack,
    loop: loopModeFor(spec.harness.profile),
    tools: resolvedTools.length ? resolvedTools : pack.tools,
  };

  const kernel = await createHarness(spec, {
    deny: opts.deny,
    requireApproval: opts.requireApproval,
    hermes: opts.hermes,
    memory: opts.memory,
    cwd: opts.cwd,
  });

  return {
    backend,
    pack: aligned,
    kernel,
    async execute(plan) {
      const loop = kernel.context().get<HarnessLoop>("loop");
      const observations = await loop.run(plan.calls);
      const steps: TrajectoryStep[] = plan.calls.map((call, i) => ({
        thought: plan.thoughts[Math.min(i, plan.thoughts.length - 1)] ?? "",
        calls: [{ plugin: "dsh", name: call.name, input: call.input }],
        observation: observations[i] ?? "",
      }));
      return { observations, steps };
    },
  };
}
