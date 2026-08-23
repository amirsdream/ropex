import type { HermesContract, HarnessLoopContract, MemoryPort } from "./contracts.js";
import type { AgentSpec, HarnessProfile } from "./types.js";
import {
  deliveryPlugin,
  Kernel,
  loopPlugin,
  memoryPlugin,
  modelPlugin,
  permissionsPlugin,
  sessionPlugin,
  skillsPlugin,
  soulPlugin,
  toolsPlugin,
  type LoopMode,
} from "./plugins.js";

const PROFILE_TOOLS: Record<HarnessProfile, string[]> = {
  standard: ["fs", "shell", "web", "github", "subagent"],
  code: ["fs", "shell", "github"],
  minimal: ["bash", "str_replace_editor"],
  creator: ["fs", "shell", "web", "github", "subagent", "inspect"],
};

export function loopModeFor(profile: HarnessProfile): LoopMode {
  return profile === "code" ? "code" : "tool-calls";
}

export function toolsFor(spec: AgentSpec): string[] {
  const fromPlugins = spec.harness.plugins
    .map((p) => p.replace(/^tools:/, ""))
    .filter(
      (p) =>
        !p.startsWith("model:") &&
        p !== "loop" &&
        p !== "session" &&
        p !== "permissions" &&
        p !== "memory" &&
        p !== "skills" &&
        p !== "soul",
    );
  const named = fromPlugins.length ? fromPlugins.flatMap((p) => p.split(/[+,]/)) : PROFILE_TOOLS[spec.harness.profile];
  return [...new Set(named)];
}

export type CreateHarnessOptions = {
  deny?: string[];
  requireApproval?: string[];
  /** Hermes brain — mounts soul + skills plugins onto the DeepSeek kernel. */
  hermes?: HermesContract;
  /** Shared memory port (defaults to hermes.port when present). */
  memory?: MemoryPort;
  /** Worker worktree cwd — fs/shell tools are chrooted here. */
  cwd?: string;
};

export async function createHarness(
  spec: AgentSpec,
  opts: CreateHarnessOptions = {},
): Promise<Kernel> {
  const kernel = new Kernel();
  const model = spec.harness.model ?? "gpt-4o-mini";
  const tools = toolsFor(spec);
  const memoryPort = opts.memory ?? opts.hermes?.port;
  if (memoryPort && !tools.includes("memory")) {
    tools.push("memory");
  }

  kernel
    .use(modelPlugin(model))
    .use(sessionPlugin())
    .use(permissionsPlugin(opts.deny ?? [], opts.requireApproval ?? []))
    .use(toolsPlugin(tools, { cwd: opts.cwd }))
    .use(loopPlugin(loopModeFor(spec.harness.profile)));

  if (opts.hermes) {
    kernel.use(soulPlugin(opts.hermes.soul));
    kernel.use(skillsPlugin(opts.hermes.skills));
  }
  if (memoryPort) {
    kernel.use(memoryPlugin(memoryPort));
  }
  if (spec.github) {
    kernel.use(deliveryPlugin(spec.github.deliver));
  }
  await kernel.boot();
  return kernel;
}

export type HarnessLoop = HarnessLoopContract;
