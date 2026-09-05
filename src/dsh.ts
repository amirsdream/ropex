/**
 * DeepSeek Harness (dsh) adapter.
 * Profile packs mirror `@deepseek-ai/dsh` presets; swap backend to "live" when
 * `@deepseek-ai/dsh` is installed and ROPEX_DSH_BACKEND=live.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HermesPlan } from "./contracts.js";
import { createHarness, loopModeFor, toolsFor, type HarnessLoop } from "./harness.js";
import type { AgentSpec, HarnessProfile, TrajectoryStep } from "./types.js";
import type { HermesContract, MemoryPort } from "./contracts.js";
import type { Kernel } from "./plugins.js";

const require = createRequire(import.meta.url);

/** In-process Cordis harness (default). `live` invokes @deepseek-ai/dsh CLI. */
export type DshBackend = "embedded" | "live";

/** Preferred live LLM credential for Ropex (OpenAI first, DeepSeek fallback). */
export type LlmApiKeySource = "OPENAI_API_KEY" | "DEEPSEEK_API_KEY";

export type LlmApiKey = {
  present: boolean;
  source?: LlmApiKeySource;
  /** Env var name that supplied the key (undefined when absent). */
  env?: LlmApiKeySource;
};

/**
 * Resolve live LLM API key. **OpenAI is the default** for Ropex;
 * `DEEPSEEK_API_KEY` remains a supported fallback.
 */
export function resolveLlmApiKey(
  env: NodeJS.ProcessEnv = process.env,
): LlmApiKey {
  const openai = env.OPENAI_API_KEY?.trim();
  if (openai) return { present: true, source: "OPENAI_API_KEY", env: "OPENAI_API_KEY" };
  const deepseek = env.DEEPSEEK_API_KEY?.trim();
  if (deepseek) return { present: true, source: "DEEPSEEK_API_KEY", env: "DEEPSEEK_API_KEY" };
  return { present: false };
}

/** Default harness model when Agent YAML omits `harness.model` (OpenAI-first). */
export const DEFAULT_HARNESS_MODEL = "gpt-4o-mini";

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

/**
 * True when optional peer `@deepseek-ai/dsh` is on disk (network-free).
 * The package is ESM-only with no `main`/`exports`, so bare
 * `require.resolve("@deepseek-ai/dsh")` fails even when installed — detect via
 * the CLI entry (or package.json) instead.
 */
export function dshPackageInstalled(): boolean {
  return resolveDshBin() !== undefined;
}

/** Resolve backend from explicit opt, then ROPEX_DSH_BACKEND, else embedded. */
export function resolveDshBackend(explicit?: DshBackend): DshBackend {
  if (explicit) return explicit;
  if (process.env.ROPEX_DSH_BACKEND === "live") return "live";
  return "embedded";
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
  /** True when OPENAI_API_KEY (preferred) or DEEPSEEK_API_KEY is set. */
  apiKeyPresent: boolean;
  /** Which env supplied the live key (OpenAI preferred). */
  apiKeySource?: LlmApiKeySource;
};

/**
 * Describe how to wire the live `@deepseek-ai/dsh` backend without importing it in tests.
 */
export function liveDshScaffold(): LiveDshScaffold {
  const packageInstalled = dshPackageInstalled();
  const key = resolveLlmApiKey();
  const apiKeyPresent = key.present;
  return {
    liveReady: packageInstalled && apiKeyPresent,
    packageInstalled,
    packageName: "@deepseek-ai/dsh",
    summary: packageInstalled
      ? apiKeyPresent
        ? `Live dsh ready (${key.source}) — set ROPEX_DSH_BACKEND=live to boot the headless adapter.`
        : "Live dsh package present — set OPENAI_API_KEY (default) or DEEPSEEK_API_KEY, then ROPEX_DSH_BACKEND=live."
      : "Install @deepseek-ai/dsh for live backend; embedded harness is the default.",
    steps: [
      "Add optional peer dependency @deepseek-ai/dsh for live CLI execution.",
      "Set OPENAI_API_KEY (preferred) or DEEPSEEK_API_KEY for live runs.",
      "Set ROPEX_DSH_BACKEND=live to boot the headless adapter.",
      "bootLiveDsh runs `dsh --profile headless` for Hermes-planned tool programs.",
      "bootDsh requires a Hermes brain — plan and execute stay coupled.",
      "Embedded harness (createHarness) is always used unless live is explicitly set.",
    ],
    env: [
      "ROPEX_DSH_BACKEND=embedded|live",
      "OPENAI_API_KEY=(preferred live key)",
      "DEEPSEEK_API_KEY=(optional fallback)",
    ],
    profiles: Object.keys(DSH_PROFILE_PACKS) as HarnessProfile[],
    apiKeyPresent,
    apiKeySource: key.source,
  };
}

/** Resolve the installed dsh CLI entry (network-free when package absent). */
export function resolveDshBin(): string | undefined {
  try {
    return require.resolve("@deepseek-ai/dsh/lib/bin.js");
  } catch {
    try {
      // ESM-only package may lack exports; package.json still resolves when present.
      const pkg = require.resolve("@deepseek-ai/dsh/package.json");
      const bin = join(pkg, "..", "lib", "bin.js");
      return existsSync(bin) ? bin : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Resolve DSH home (`$DSH_HOME` or `~/.dsh`). */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".dsh");
}

/**
 * Ensure `settings.yaml` routes the default model through OpenAI when using
 * `OPENAI_API_KEY`. Idempotent — does not overwrite existing llm-pi-ai /
 * agent-default-model sections.
 */
export function ensureOpenAiDshSettings(
  env: NodeJS.ProcessEnv = process.env,
): { path: string; wrote: boolean } {
  const home = resolveDshHome(env);
  const settingsPath = join(home, "settings.yaml");
  mkdirSync(home, { recursive: true });
  let existing = "";
  try {
    existing = readFileSync(settingsPath, "utf8");
  } catch {
    existing = "";
  }
  const hasPiAi = /(?:^|\n)llm-pi-ai\s*:/.test(existing);
  const hasDefault = /(?:^|\n)agent-default-model\s*:/.test(existing);
  if (hasPiAi && hasDefault) return { path: settingsPath, wrote: false };

  const openaiBlock = `llm-pi-ai:
  providers:
    openai:
      apiKeyEnv: OPENAI_API_KEY
`;
  const modelBlock = `agent-default-model:
  provider: openai
  model: gpt-4o-mini
`;
  const parts = [existing.trimEnd()];
  if (!hasPiAi) parts.push(openaiBlock.trimEnd());
  if (!hasDefault) parts.push(modelBlock.trimEnd());
  writeFileSync(settingsPath, `${parts.filter(Boolean).join("\n\n")}\n`, { mode: 0o600 });
  return { path: settingsPath, wrote: true };
}

/** Minimum Node major.minor required by live `@deepseek-ai/dsh` (zstd zlib APIs). */
export const LIVE_DSH_MIN_NODE = "22.19.0";

/** True when Node meets live dsh's floor (needs `node:zlib` zstd helpers). */
export function nodeSupportsLiveDsh(version = process.versions.node): boolean {
  const [maj, min] = version.split(".").map((n) => Number(n));
  if (!Number.isFinite(maj) || !Number.isFinite(min)) return false;
  if (maj > 22) return true;
  if (maj < 22) return false;
  return min >= 19;
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

/** Run one headless dsh turn (requires package + OPENAI_API_KEY or DEEPSEEK_API_KEY). */
export function runHeadlessDsh(
  profile: string,
  task: string,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  const bin = resolveDshBin();
  if (!bin) {
    return Promise.reject(new Error("dsh CLI not installed (@deepseek-ai/dsh)"));
  }
  if (!nodeSupportsLiveDsh()) {
    return Promise.reject(
      new Error(
        `dsh live backend needs Node >= ${LIVE_DSH_MIN_NODE} (current ${process.versions.node}); upgrade Node or use ROPEX_DSH_BACKEND=embedded`,
      ),
    );
  }
  const key = resolveLlmApiKey();
  if (!key.present) {
    return Promise.reject(
      new Error("dsh live backend requires OPENAI_API_KEY (preferred) or DEEPSEEK_API_KEY"),
    );
  }
  if (key.source === "OPENAI_API_KEY") {
    ensureOpenAiDshSettings();
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

async function bootEmbeddedDsh(
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
 * Requires a Hermes brain — plan and execute are always coupled.
 * Live backend requires @deepseek-ai/dsh installed; otherwise fail closed.
 */
export async function bootDsh(spec: AgentSpec, opts: BootDshOptions = {}): Promise<DshAdapter> {
  if (!opts.hermes) {
    throw new Error("bootDsh requires Hermes — pass hermes from bootHermes(); simulation shortcuts are not supported");
  }
  const backend = resolveDshBackend(opts.backend);
  if (backend === "live") {
    if (!dshPackageInstalled()) {
      const scaffold = liveDshScaffold();
      throw new Error(
        `dsh live backend unavailable — ${scaffold.summary} Install ${scaffold.packageName} first.`,
      );
    }
    if (!resolveLlmApiKey().present) {
      throw new Error(
        "dsh live backend requires OPENAI_API_KEY (preferred) or DEEPSEEK_API_KEY",
      );
    }
    if (!nodeSupportsLiveDsh()) {
      throw new Error(
        `dsh live backend needs Node >= ${LIVE_DSH_MIN_NODE} (current ${process.versions.node})`,
      );
    }
    return bootLiveDsh(spec, opts);
  }
  return bootEmbeddedDsh(spec, opts, backend);
}
