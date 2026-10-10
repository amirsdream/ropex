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
  authProbe,
  cliRuntime,
  permissionPlan,
  selectRuntimeAuth,
  type AuthProbe,
  type CliRuntimeDescriptor,
  type CliRuntimeKind,
  type PreparedRuntimeAuth,
} from "./cli-runtimes/index.js";
import type { WorkerExecContext } from "./contracts.js";
import { bootDsh, profilePack, type BootDshOptions, type DshAdapter, type DshProfilePack } from "./dsh.js";
import { createHarness, loopModeFor, toolsFor } from "./harness.js";
import { binOnPath, runProcess } from "./proc.js";
import type { AgentSpec, RuntimeSpec, TrajectoryStep, WorkerRuntimeKind } from "./types.js";

export type RuntimeAuthProbe = Partial<Pick<AuthProbe, "fileExists" | "homedir">>;

export type { PreparedRuntimeAuth };

export const WORKER_RUNTIME_KINDS: WorkerRuntimeKind[] = ["dsh", ...CLI_RUNTIME_KINDS];

export const DEFAULT_RUNTIME_TIMEOUT_MS = 600_000;

/**
 * A host CLI has whatever git identity the operator's shell does. Fleet commits
 * use the same author the container exec path sets, and these values stay in
 * the process environment — they are not written into a snapshot.
 */
const CLI_GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: "Ropex",
  GIT_AUTHOR_EMAIL: "ropex@localhost",
  GIT_COMMITTER_NAME: "Ropex",
  GIT_COMMITTER_EMAIL: "ropex@localhost",
};

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
  for (const strategy of descriptor.auth) {
    const name = strategy.env.find((item) => env[item]?.trim());
    if (name) return name;
  }
  return undefined;
}

/**
 * Resolve the auth strategy for a CLI runtime.
 * `dsh` returns undefined. A CLI with no usable strategy throws before a
 * container is started.
 */
export function prepareRuntimeAuth(
  spec: AgentSpec,
  opts: {
    env?: NodeJS.ProcessEnv;
    container: boolean;
    fileExists?: (path: string) => boolean;
    homedir?: () => string;
  },
): PreparedRuntimeAuth | undefined {
  const kind = resolveRuntimeKind(spec);
  if (!isCliRuntime(kind)) return undefined;
  const descriptor = cliRuntime(kind);
  const probe = authProbe(opts.env ?? process.env, opts);
  const selected = selectRuntimeAuth(descriptor, spec.runtime?.auth, probe);
  const applied = descriptor.applyAuth({
    ...selected,
    baseUrl: spec.runtime?.baseUrl,
    container: opts.container,
    homeDir: probe.homedir(),
  });
  return { method: selected.method, ...applied };
}

function describeAuth(
  descriptor: CliRuntimeDescriptor,
  probe: AuthProbe,
): { present: boolean; source?: string; detail: string; ambiguous?: boolean } {
  try {
    const selected = selectRuntimeAuth(descriptor, undefined, probe);
    return {
      present: true,
      source: selected.envName ?? selected.method,
      detail: "",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (detail.includes("more than one auth method")) {
      return { present: true, detail, ambiguous: true };
    }
    return { present: false, detail };
  }
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
export function workerRuntimeScaffold(
  env: NodeJS.ProcessEnv = process.env,
  probe: RuntimeAuthProbe = {},
): WorkerRuntimeStatus[] {
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
    const auth = describeAuth(descriptor, authProbe(env, probe));
    const ready = Boolean(resolved && auth.present);
    statuses.push({
      kind,
      label: descriptor.label,
      binPresent: Boolean(resolved),
      bin: resolved,
      credentialPresent: auth.present,
      credentialSource: auth.source,
      credentialEnv: [...descriptor.credentialEnv],
      ready,
      hint: ready
        ? auth.ambiguous
          ? auth.detail
          : `Ready — ${bin} on PATH, credentials from ${auth.source}.`
        : !resolved
          ? `Install ${bin}, or point ${runtimeBinEnvVar(kind)} / spec.runtime.command at it.`
          : auth.detail,
      docsUrl: descriptor.docsUrl,
    });
  }
  return statuses;
}

const RUNTIME_KIND_WIDTH = 15;
const RUNTIME_FIELD_WIDTH = 13;
const RUNTIME_TEXT_WIDTH = 68;

function wrapRuntimeText(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!current) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

const RUNTIME_COLOR = {
  reset: "\x1b[0m",
  kind: "\x1b[1;36m",
  ready: "\x1b[1;32m",
  notReady: "\x1b[1;33m",
  dim: "\x1b[2m",
  good: "\x1b[32m",
  warn: "\x1b[33m",
  action: "\x1b[36m",
} as const;

function paint(text: string, open: string, enabled: boolean): string {
  if (!enabled || text.length === 0) return text;
  return `${open}${text}${RUNTIME_COLOR.reset}`;
}

function runtimeField(name: string, value: string, tone: (text: string) => string, dim: (text: string) => string): string {
  return `${dim(name.padEnd(RUNTIME_FIELD_WIDTH))}${tone(value)}`;
}

function credentialSummary(status: WorkerRuntimeStatus): string {
  if (status.hint.includes("more than one auth method")) return "ambiguous";
  if (status.credentialSource) return status.credentialSource;
  if (status.credentialPresent) return "present";
  return "missing";
}

/**
 * Human layout for `ropex runtimes`. One block per runtime. The first line is
 * the kind, then `status: ready` or `status: not ready`. Later lines are the
 * label, binary, credentials, and the next step. `--json` keeps the scaffold
 * objects. `color` paints the kind, the status, and the credential result.
 * The CLI turns it on for a terminal and leaves it off when `NO_COLOR` is set.
 */
export function formatRuntimeReport(statuses: WorkerRuntimeStatus[], opts: { color?: boolean } = {}): string {
  const color = opts.color === true;
  const dim = (text: string) => paint(text, RUNTIME_COLOR.dim, color);
  const blocks = statuses.map((status) => {
    const mark = status.ready ? "ready" : "not ready";
    const kind = status.kind.padEnd(RUNTIME_KIND_WIDTH);
    const gap = kind.length - status.kind.length;
    const head = `${paint(status.kind, RUNTIME_COLOR.kind, color)}${" ".repeat(gap)}${dim("status:")} ${paint(mark, status.ready ? RUNTIME_COLOR.ready : RUNTIME_COLOR.notReady, color)}`;
    const lines = [head, dim(status.label)];
    const valueTone = (value: string) => {
      if (value === "missing" || value === "ambiguous" || value === "not on PATH") return paint(value, RUNTIME_COLOR.warn, color);
      if (value === "embedded" || value === "built in" || status.credentialSource === value) return paint(value, RUNTIME_COLOR.good, color);
      return dim(value);
    };
    const field = (name: string, value: string) => runtimeField(name, value, valueTone, dim);
    if (status.kind === "dsh") {
      lines.push(field("binary", "embedded"));
      lines.push(field("credentials", "built in"));
    } else {
      lines.push(field("binary", status.binPresent && status.bin ? status.bin : "not on PATH"));
      lines.push(field("credentials", credentialSummary(status)));
    }
    const requires = status.hint.match(/^(.*) requires one of: (.*)$/);
    if (requires) {
      lines.push(dim("needs one of:"));
      for (const part of requires[2].split("; ").filter(Boolean)) lines.push(`  ${paint(part, RUNTIME_COLOR.action, color)}`);
    } else if (!(status.ready && status.hint.startsWith("Ready — "))) {
      lines.push(...wrapRuntimeText(status.hint, RUNTIME_TEXT_WIDTH).map(dim));
    }
    const pad = " ".repeat(RUNTIME_KIND_WIDTH);
    return [lines[0], ...lines.slice(1).map((line) => `${pad}${line}`)].join("\n");
  });
  return `${blocks.join("\n\n")}\n`;
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
  const sandbox = opts.sandbox;
  const isolated = sandbox !== undefined && sandbox.kind !== "local";
  const resolvedBin = isolated ? await sandbox.resolveBin(bin) : binOnPath(bin, env);
  if (!resolvedBin) {
    throw new Error(
      isolated
        ? `${descriptor.label} runtime unavailable — "${bin}" not found inside the ${sandbox.kind} sandbox. ` +
            `Install it in spec.sandbox.image (e.g. npm: [...]), or set spec.runtime.command to a path inside it.`
        : `${descriptor.label} runtime unavailable — "${bin}" not found on PATH. ` +
            `Install it, or set ${runtimeBinEnvVar(descriptor.kind)} / spec.runtime.command.`,
    );
  }

  const container = isolated;
  const prepared =
    opts.auth ??
    prepareRuntimeAuth(spec, {
      env,
      container,
      fileExists: opts.authProbe?.fileExists,
      homedir: opts.authProbe?.homedir,
    });
  if (!prepared) {
    throw new Error(`${descriptor.label} requires auth`);
  }
  for (const name of runtime?.requireEnv ?? []) {
    if (!env[name]?.trim()) {
      throw new Error(`${descriptor.label} runtime requires env ${name} (spec.runtime.requireEnv)`);
    }
  }

  const policy = permissionPlan(
    descriptor,
    { deny: opts.deny ?? [], requireApproval: opts.requireApproval ?? [] },
    { container },
  );
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
  const cwd = sandbox?.cwd ?? opts.cwd ?? process.cwd();
  const timeoutMs = runtime?.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS;
  // Credentials the CLI needs inside an isolate. Forwarded by name; values stay off argv.
  const forwardEnv: Record<string, string> = { ...CLI_GIT_IDENTITY, ...prepared.injectEnv };
  if (isolated) {
    for (const name of [...prepared.env, ...(runtime?.requireEnv ?? [])]) {
      const value = env[name]?.trim();
      if (value) forwardEnv[name] = value;
    }
  }
  const hostEnv: NodeJS.ProcessEnv = { ...env, ...CLI_GIT_IDENTITY, ...prepared.injectEnv };
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
        ...descriptor.argv({
          prompt,
          model,
          cwd,
          permissionArgs: policy.args,
          authArgs: prepared.args,
        }),
      ];
      const stdin = descriptor.promptChannel === "stdin" ? prompt : undefined;
      const res = sandbox
        ? await sandbox.exec(resolvedBin, args, { timeoutMs, stdin, env: forwardEnv })
        : await runProcess(resolvedBin, args, { cwd, timeoutMs, stdin, env: hostEnv });
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
