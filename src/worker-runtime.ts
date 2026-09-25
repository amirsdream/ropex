/**
 * Worker runtime registry — which executor runs the `execute` stage.
 *
 * `dsh` (DeepSeek Harness) stays the default. CLI kinds run an external headless
 * coding agent inside the worker worktree: Hermes still composes the brief,
 * plans, and learns, so the start → transform → result spine is unchanged; only
 * the transform is swapped.
 */

import {
  CLI_RUNTIME_KINDS,
  cliRuntime,
  type CliRuntimeDescriptor,
  type CliRuntimeKind,
  type PermissionPlan,
} from "./cli-runtimes.js";
import type { WorkerExecContext } from "./contracts.js";
import { bootDsh, profilePack, type BootDshOptions, type DshAdapter, type DshProfilePack } from "./dsh.js";
import { createHarness, loopModeFor, toolsFor } from "./harness.js";
import { binOnPath, runProcess } from "./proc.js";
import type { AgentSpec, RuntimeSpec, TrajectoryStep, WorkerRuntimeKind } from "./types.js";

export const WORKER_RUNTIME_KINDS: WorkerRuntimeKind[] = ["dsh", ...CLI_RUNTIME_KINDS];

export const DEFAULT_RUNTIME_TIMEOUT_MS = 600_000;

export type WorkerAdapter = DshAdapter & { runtime: WorkerRuntimeKind };

/** `spec.runtime.kind`, defaulting to the DeepSeek harness. */
export function resolveRuntimeKind(spec: AgentSpec): WorkerRuntimeKind {
  return spec.runtime?.kind ?? "dsh";
}

export function isCliRuntime(kind: WorkerRuntimeKind): kind is CliRuntimeKind {
  return kind !== "dsh";
}

/** Env override name for a runtime's binary, e.g. `ROPEX_RUNTIME_BIN_CLAUDE_CODE`. */
export function runtimeBinEnvVar(kind: CliRuntimeKind): string {
  return `ROPEX_RUNTIME_BIN_${kind.replace(/-/g, "_").toUpperCase()}`;
}

/**
 * Resolve the binary for a CLI runtime.
 * Precedence: `spec.runtime.command` → `ROPEX_RUNTIME_BIN_<KIND>` → descriptor default.
 */
export function resolveRuntimeBin(
  descriptor: CliRuntimeDescriptor,
  runtime: RuntimeSpec | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    runtime?.command?.trim() ||
    env[runtimeBinEnvVar(descriptor.kind)]?.trim() ||
    descriptor.bin
  );
}

export function credentialPresent(
  descriptor: CliRuntimeDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return descriptor.credentialEnv.find((name) => env[name]?.trim());
}

export type WorkerRuntimeStatus = {
  kind: WorkerRuntimeKind;
  label: string;
  /** Binary resolved on PATH (CLI kinds only; `dsh` is in-process). */
  binPresent: boolean;
  bin?: string;
  credentialPresent: boolean;
  credentialSource?: string;
  credentialEnv: string[];
  ready: boolean;
  hint: string;
  docsUrl: string;
};

/**
 * Probe every runtime without spawning anything — safe to call from the HTTP
 * view on every request.
 */
export function workerRuntimeScaffold(env: NodeJS.ProcessEnv = process.env): WorkerRuntimeStatus[] {
  const statuses: WorkerRuntimeStatus[] = [
    {
      kind: "dsh",
      label: "DeepSeek Harness (default)",
      binPresent: true,
      credentialPresent: true,
      credentialEnv: [],
      ready: true,
      hint: "Embedded Cordis kernel — always available. Set ROPEX_DSH_BACKEND=live for the headless dsh CLI.",
      docsUrl: "https://github.com/deepseek-ai/DeepSeek-Harness",
    },
  ];
  for (const kind of CLI_RUNTIME_KINDS) {
    const descriptor = cliRuntime(kind);
    const bin = resolveRuntimeBin(descriptor, undefined, env);
    const resolved = binOnPath(bin, env);
    const credentialSource = credentialPresent(descriptor, env);
    const ready = Boolean(resolved && credentialSource);
    statuses.push({
      kind,
      label: descriptor.label,
      binPresent: Boolean(resolved),
      bin: resolved,
      credentialPresent: Boolean(credentialSource),
      credentialSource,
      credentialEnv: [...descriptor.credentialEnv],
      ready,
      hint: ready
        ? `Ready — ${bin} on PATH, credentials from ${credentialSource}.`
        : !resolved
          ? `Install ${bin}, or point ${runtimeBinEnvVar(kind)} / spec.runtime.command at it.`
          : `Set one of ${descriptor.credentialEnv.join(", ")} for ${descriptor.label}.`,
      docsUrl: descriptor.docsUrl,
    });
  }
  return statuses;
}

function alignPack(spec: AgentSpec, kind: WorkerRuntimeKind): DshProfilePack {
  const pack = profilePack(spec.harness.profile);
  const resolvedTools = toolsFor(spec);
  return {
    ...pack,
    loop: loopModeFor(spec.harness.profile),
    tools: resolvedTools.length ? resolvedTools : pack.tools,
    plugins: [`runtime:${kind}`],
  };
}

/** Prohibitions the CLI has no flag for, restated in the prompt. */
export function advisoryPreamble(advisory: string[]): string {
  if (!advisory.length) return "";
  return [
    "Policy prohibitions (no tool gate enforces these — you must respect them):",
    ...advisory.map((name) => `- ${name}`),
  ].join("\n");
}

async function bootCliRuntime(
  descriptor: CliRuntimeDescriptor,
  spec: AgentSpec,
  opts: BootDshOptions,
): Promise<WorkerAdapter> {
  const runtime = spec.runtime;
  const env = process.env;
  const bin = resolveRuntimeBin(descriptor, runtime, env);
  const resolvedBin = binOnPath(bin, env);
  if (!resolvedBin) {
    throw new Error(
      `${descriptor.label} runtime unavailable — "${bin}" not found on PATH. ` +
        `Install it, or set ${runtimeBinEnvVar(descriptor.kind)} / spec.runtime.command.`,
    );
  }

  const credential = credentialPresent(descriptor, env);
  if (!credential) {
    throw new Error(
      `${descriptor.label} runtime requires one of: ${descriptor.credentialEnv.join(", ")}`,
    );
  }
  for (const name of runtime?.requireEnv ?? []) {
    if (!env[name]?.trim()) {
      throw new Error(`${descriptor.label} runtime requires env ${name} (spec.runtime.requireEnv)`);
    }
  }

  const policy: PermissionPlan = descriptor.permissions({
    deny: opts.deny ?? [],
    requireApproval: opts.requireApproval ?? [],
  });
  if (policy.unmappable.length) {
    throw new Error(
      `${descriptor.label} cannot enforce denied tools: ${policy.unmappable.join(", ")}. ` +
        `Remove them from Policy.permissions or use a runtime that gates them.`,
    );
  }

  // Kernel still boots: delivery, permissions, and memory services are read by
  // runTask regardless of which executor ran the work.
  const kernel = await createHarness(spec, {
    deny: opts.deny,
    requireApproval: opts.requireApproval,
    hermes: opts.hermes,
    memory: opts.memory,
    cwd: opts.cwd,
  });

  const pack = alignPack(spec, descriptor.kind);
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = runtime?.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS;
  const model = runtime?.model ?? descriptor.defaultModel;

  return {
    runtime: descriptor.kind,
    backend: "live",
    pack,
    kernel,
    async execute(plan, ctx?: WorkerExecContext) {
      const prompt = [advisoryPreamble(policy.advisory), ctx?.brief ?? plan.thoughts.join("\n")]
        .filter(Boolean)
        .join("\n\n");
      const args = [
        ...(runtime?.commandArgs ?? []),
        ...descriptor.argv({ prompt, model, cwd, permissionArgs: policy.args }),
      ];
      const res = await runProcess(resolvedBin, args, {
        cwd,
        timeoutMs,
        stdin: descriptor.promptChannel === "stdin" ? prompt : undefined,
      });
      if (res.timedOut) {
        throw new Error(`${descriptor.label} timed out after ${timeoutMs}ms`);
      }
      if (res.code !== 0) {
        throw new Error(
          `${descriptor.label} exited ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`,
        );
      }
      const parsed = descriptor.parse(res.stdout, res.stderr);
      if (parsed.isError) {
        // Some CLIs report failure in the payload and still exit 0.
        throw new Error(
          `${descriptor.label} reported an error: ${parsed.observations.join("\n") || parsed.raw}`,
        );
      }
      const observation = parsed.observations.join("\n");
      const steps: TrajectoryStep[] = [
        {
          thought: plan.thoughts[0] ?? `${descriptor.label} autonomous run`,
          calls: [
            {
              plugin: `runtime:${descriptor.kind}`,
              name: ctx?.task.id ? `task:${ctx.task.id}` : "run",
              input: { model: model ?? null, permissionArgs: policy.args },
            },
          ],
          observation,
        },
      ];
      return { observations: parsed.observations, steps };
    },
  };
}

/**
 * Boot the executor an agent declares. Requires Hermes for every runtime —
 * plan and learn stay coupled even when an external CLI does the work.
 */
export async function bootWorker(
  spec: AgentSpec,
  opts: BootDshOptions = {},
): Promise<WorkerAdapter> {
  const kind = resolveRuntimeKind(spec);
  if (!opts.hermes) {
    throw new Error(
      `bootWorker requires Hermes — pass hermes from bootHermes(); simulation shortcuts are not supported`,
    );
  }
  if (!isCliRuntime(kind)) {
    const adapter = await bootDsh(spec, opts);
    return { ...adapter, runtime: "dsh" };
  }
  return bootCliRuntime(cliRuntime(kind), spec, opts);
}
