/**
 * Offline DeepSeek Harness (dsh) adapter.
 * Profile packs mirror `@deepseek-ai/dsh` presets; swap backend to "live" when
 * `@deepseek-ai/dsh` is installed and ROPEX_DSH_BACKEND=live.
 */

import { spawn } from "node:child_process";
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
  /** `@deepseek-ai/dsh` profile name for headless one-shot runs. */
  dshProfile: string;
  description: string;
};

/** Canonical profile packs — the seam live `@deepseek-ai/dsh` will fill. */
export const DSH_PROFILE_PACKS: Record<HarnessProfile, DshProfilePack> = {
  minimal: {
    profile: "minimal",
    loop: "tool-calls",
    tools: ["bash", "str_replace_editor"],
    plugins: ["model", "session", "permissions", "tools", "loop"],
    dshProfile: "headless",
    description: "Bare editor + shell — DeepSeek minimal preset",
  },
  code: {
    profile: "code",
    loop: "code",
    tools: ["fs", "shell", "github"],
    plugins: ["model", "session", "permissions", "tools", "loop:code", "delivery"],
    dshProfile: "headless",
    description: "Code-mode collapsed program — DeepSeek code preset",
  },
  standard: {
    profile: "standard",
    loop: "tool-calls",
    tools: ["fs", "shell", "web", "github", "subagent"],
    plugins: ["model", "session", "permissions", "tools", "loop", "delivery", "subagent"],
    dshProfile: "headless",
    description: "Full tool surface — DeepSeek standard preset",
  },
  creator: {
    profile: "creator",
    loop: "tool-calls",
    tools: ["fs", "shell", "web", "github", "subagent", "inspect"],
    plugins: ["model", "session", "permissions", "tools", "loop", "delivery", "inspect"],
    dshProfile: "headless",
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
  /** True when DEEPSEEK_API_KEY is set for headless one-shot runs. */
  apiKeyPresent: boolean;
};

/**
 * Describe how to wire the live `@deepseek-ai/dsh` backend without importing it in tests.
 */
export function liveDshScaffold(): LiveDshScaffold {
  const packageInstalled = dshPackageInstalled();
  const apiKeyPresent = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
  return {
    liveReady: packageInstalled && apiKeyPresent,
    packageInstalled,
    packageName: "@deepseek-ai/dsh",
    summary: packageInstalled
      ? apiKeyPresent
        ? "Live dsh ready — set ROPEX_DSH_BACKEND=live to boot the headless adapter."
        : "Live dsh package present — set DEEPSEEK_API_KEY then ROPEX_DSH_BACKEND=live."
      : "Install @deepseek-ai/dsh for live backend; tests and default boot stay simulated.",
    steps: [
      "Add optional peer dependency @deepseek-ai/dsh (never required by tests).",
      "Set ROPEX_DSH_BACKEND=live and DEEPSEEK_API_KEY for production runs.",
      "bootLiveDsh runs `dsh --profile headless` for Hermes-planned tool programs.",
      "Map DSH_PROFILE_PACKS[profile].plugins onto Cordis pack loaders.",
      "Mount Policy deny/requireApproval as a permissions plugin before tools.",
      "Keep backend: simulated as the default for CI and network-free demos.",
    ],
    env: ["ROPEX_DSH_BACKEND=simulated|live", "DEEPSEEK_API_KEY=(live only)"],
    profiles: Object.keys(DSH_PROFILE_PACKS) as HarnessProfile[],
    apiKeyPresent,
  };
}

/** Resolve the installed dsh CLI entry (network-free when package absent). */
export function resolveDshBin(): string | undefined {
  try {
    return require.resolve("@deepseek-ai/dsh/lib/bin.js");
  } catch {
    return undefined;
  }
}

/** Optional live profile bundle metadata from @deepseek-ai/dsh-app-boot. */
export function loadLiveProfileMeta(profile: HarnessProfile): { bundleId?: string } | undefined {
  try {
    const boot = require("@deepseek-ai/dsh-app-boot") as {
      DEFAULT_PROFILE_BUNDLES?: Record<string, string>;
    };
    const bundleId = boot.DEFAULT_PROFILE_BUNDLES?.[DSH_PROFILE_PACKS[profile].dshProfile];
    return bundleId ? { bundleId } : undefined;
  } catch {
    return undefined;
  }
}

function planPrompt(plan: HermesPlan): string {
  const thoughts = plan.thoughts.filter(Boolean).join("\n");
  const calls = plan.calls
    .map((c) => `- ${c.name}(${JSON.stringify(c.input ?? {})})`)
    .join("\n");
  return [thoughts, calls ? `Execute:\n${calls}` : ""].filter(Boolean).join("\n\n");
}

/** Run one headless dsh turn (requires package + DEEPSEEK_API_KEY). */
export function runHeadlessDsh(
  profile: string,
  task: string,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  const bin = resolveDshBin();
  if (!bin) {
    return Promise.reject(new Error("dsh CLI not installed (@deepseek-ai/dsh)"));
  }
  if (!process.env.DEEPSEEK_API_KEY?.trim()) {
    return Promise.reject(new Error("dsh live backend requires DEEPSEEK_API_KEY"));
  }
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, "--profile", profile, task], {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr?.on("data", (c) => {
      stderr += String(c);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`dsh headless timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`dsh headless exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve(stdout.trim() || stderr.trim());
    });
  });
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

async function bootLiveDsh(spec: AgentSpec, opts: BootDshOptions): Promise<DshAdapter> {
  const pack = profilePack(spec.harness.profile);
  const resolvedTools = toolsFor(spec);
  const liveMeta = loadLiveProfileMeta(spec.harness.profile);
  const aligned: DshProfilePack = {
    ...pack,
    loop: loopModeFor(spec.harness.profile),
    tools: resolvedTools.length ? resolvedTools : pack.tools,
    plugins: liveMeta?.bundleId ? [...pack.plugins, liveMeta.bundleId] : pack.plugins,
  };

  const kernel = await createHarness(spec, {
    deny: opts.deny,
    requireApproval: opts.requireApproval,
    hermes: opts.hermes,
    memory: opts.memory,
    cwd: opts.cwd,
  });

  return {
    backend: "live",
    pack: aligned,
    kernel,
    async execute(plan) {
      const prompt = planPrompt(plan);
      const observation = await runHeadlessDsh(aligned.dshProfile, prompt, { cwd: opts.cwd });
      const steps: TrajectoryStep[] = [
        {
          thought: plan.thoughts[0] ?? "live dsh headless",
          calls: plan.calls.map((call) => ({
            plugin: "dsh-live",
            name: call.name,
            input: call.input,
          })),
          observation,
        },
      ];
      return { observations: [observation], steps };
    },
  };
}

/**
 * Boot a DeepSeek-shaped harness for an agent profile.
 * Live backend requires @deepseek-ai/dsh installed; otherwise fail closed.
 */
export async function bootDsh(spec: AgentSpec, opts: BootDshOptions = {}): Promise<DshAdapter> {
  const backend = resolveDshBackend(opts.backend);
  if (backend === "live") {
    if (!dshPackageInstalled()) {
      const scaffold = liveDshScaffold();
      throw new Error(
        `dsh live backend unavailable — ${scaffold.summary} Install ${scaffold.packageName} first.`,
      );
    }
    if (!process.env.DEEPSEEK_API_KEY?.trim()) {
      throw new Error("dsh live backend requires DEEPSEEK_API_KEY");
    }
    return bootLiveDsh(spec, opts);
  }
  return bootSimulatedDsh(spec, opts, backend);
}
