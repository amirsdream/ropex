/**
 * Offline DeepSeek Harness (dsh) adapter.
 * Profile packs mirror `@deepseek-ai/dsh` presets; swap backend to "live" when
 * `@deepseek-ai/dsh` is installed and ROPEX_DSH_BACKEND=live.
 */

import { createRequire } from "node:module";
import type { HermesPlan } from "./contracts.js";
import { createHarness, loopModeFor, toolsFor, type HarnessLoop } from "./harness.js";
import type { AgentSpec, HarnessProfile, TrajectoryStep } from "./types.js";
import type { HermesContract, MemoryPort } from "./contracts.js";
import type { Kernel } from "./plugins.js";

const require = createRequire(import.meta.url);

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

/** True when optional peer `@deepseek-ai/dsh` resolves (network-free check). */
export function dshPackageInstalled(): boolean {
  try {
    require.resolve("@deepseek-ai/dsh");
    return true;
  } catch {
    return false;
  }
}

/** Resolve backend from explicit opt, then ROPEX_DSH_BACKEND, else simulated. */
export function resolveDshBackend(explicit?: DshBackend): DshBackend {
  if (explicit) return explicit;
  if (process.env.ROPEX_DSH_BACKEND === "live") return "live";
  return "simulated";
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
  backend?: DshBackend;
};

/** Checklist returned by `liveDshScaffold` — docs + UI surface this. */
export type LiveDshScaffold = {
  liveReady: boolean;
  packageInstalled: boolean;
  packageName: string;
  summary: string;
  steps: string[];
  env: string[];
  profiles: HarnessProfile[];
};

/**
 * Describe how to wire the live `@deepseek-ai/dsh` backend without importing it in tests.
 */
export function liveDshScaffold(): LiveDshScaffold {
  const packageInstalled = dshPackageInstalled();
  return {
    liveReady: packageInstalled,
    packageInstalled,
    packageName: "@deepseek-ai/dsh",
    summary: packageInstalled
      ? "Live dsh package present — set ROPEX_DSH_BACKEND=live to boot the live adapter."
      : "Install @deepseek-ai/dsh for live backend; tests and default boot stay simulated.",
    steps: [
      "Add optional peer dependency @deepseek-ai/dsh (never required by tests).",
      "Set ROPEX_DSH_BACKEND=live and DEEPSEEK_API_KEY for production runs.",
      "bootDsh uses Cordis kernel adapter; extend bootLiveDsh when dsh exports a stable API.",
      "Map DSH_PROFILE_PACKS[profile].plugins onto Cordis pack loaders.",
      "Mount Policy deny/requireApproval as a permissions plugin before tools.",
      "Keep backend: simulated as the default for CI and network-free demos.",
    ],
    env: ["ROPEX_DSH_BACKEND=simulated|live", "DEEPSEEK_API_KEY=(live only)"],
    profiles: Object.keys(DSH_PROFILE_PACKS) as HarnessProfile[],
  };
}

async function bootSimulatedDsh(
  spec: AgentSpec,
  opts: BootDshOptions,
  backend: DshBackend,
): Promise<DshAdapter> {
  const pack = profilePack(spec.harness.profile);
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
        calls: [{ plugin: backend === "live" ? "dsh-live" : "dsh", name: call.name, input: call.input }],
        observation: observations[i] ?? "",
      }));
      return { observations, steps };
    },
  };
}

/**
 * Boot a DeepSeek-shaped harness for an agent profile.
 * Live backend requires @deepseek-ai/dsh installed; otherwise fail closed.
 */
export async function bootDsh(spec: AgentSpec, opts: BootDshOptions = {}): Promise<DshAdapter> {
  const backend = resolveDshBackend(opts.backend);
  if (backend === "live" && !dshPackageInstalled()) {
    const scaffold = liveDshScaffold();
    throw new Error(
      `dsh live backend unavailable — ${scaffold.summary} Install ${scaffold.packageName} first.`,
    );
  }
  return bootSimulatedDsh(spec, opts, backend);
}
