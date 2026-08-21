import type { AgentSpec, HarnessProfile } from "./types.js";
import {
  deliveryPlugin,
  Kernel,
  loopPlugin,
  modelPlugin,
  permissionsPlugin,
  sessionPlugin,
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
    .filter((p) => !p.startsWith("model:") && p !== "loop" && p !== "session" && p !== "permissions");
  const named = fromPlugins.length ? fromPlugins.flatMap((p) => p.split(/[+,]/)) : PROFILE_TOOLS[spec.harness.profile];
  return [...new Set(named)];
}

export async function createHarness(
  spec: AgentSpec,
  policy?: { deny: string[]; requireApproval: string[] },
): Promise<Kernel> {
  const kernel = new Kernel();
  const model = spec.harness.model ?? "deepseek-v4-flash";
  kernel
    .use(modelPlugin(model))
    .use(sessionPlugin())
    .use(permissionsPlugin(policy?.deny ?? [], policy?.requireApproval ?? []))
    .use(toolsPlugin(toolsFor(spec)))
    .use(loopPlugin(loopModeFor(spec.harness.profile)));
  if (spec.github) {
    kernel.use(deliveryPlugin(spec.github.deliver));
  }
  await kernel.boot();
  return kernel;
}

export type HarnessLoop = {
  mode: LoopMode;
  run(calls: Array<{ name: string; input: Record<string, unknown> }>): Promise<string[]>;
};
