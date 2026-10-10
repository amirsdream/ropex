/**
 * Cordis-inspired plugin kernel (DeepSeek Harness shape).
 * Everything — model, tools, loop, permissions, session — is a plugin.
 */

import { runProcess, type RunProcessResult } from "./proc.js";

export type PluginKind =
  | "model"
  | "tools"
  | "loop"
  | "permissions"
  | "session"
  | "delivery"
  | "memory"
  | "skills"
  | "soul";

export type PluginContext = {
  get<T>(name: string): T;
  set(name: string, value: unknown): void;
  emit(event: string, payload: unknown): void;
};

export type Plugin = {
  name: string;
  kind: PluginKind;
  apply(ctx: PluginContext): void | Promise<void>;
};

export type ToolFn = (input: Record<string, unknown>, ctx: PluginContext) => Promise<string> | string;

/** Run a command in the harness workspace (the sandbox, or the host worktree). */
export type WorkspaceExec = (
  bin: string,
  args: string[],
  opts?: { stdin?: string; env?: Record<string, string> },
) => Promise<RunProcessResult>;

export class Kernel {
  private readonly services = new Map<string, unknown>();
  private readonly plugins: Plugin[] = [];
  private readonly listeners = new Map<string, Array<(payload: unknown) => void>>();

  readonly tools = new Map<string, ToolFn>();

  context(): PluginContext {
    return {
      get: <T>(name: string) => {
        if (!this.services.has(name)) {
          throw new Error(`service not registered: ${name}`);
        }
        return this.services.get(name) as T;
      },
      set: (name, value) => {
        this.services.set(name, value);
      },
      emit: (event, payload) => {
        for (const fn of this.listeners.get(event) ?? []) fn(payload);
      },
    };
  }

  on(event: string, fn: (payload: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }

  use(plugin: Plugin): this {
    this.plugins.push(plugin);
    return this;
  }

  registerTool(name: string, fn: ToolFn): void {
    this.tools.set(name, fn);
  }

  async boot(): Promise<void> {
    const ctx = this.context();
    ctx.set("kernel", this);
    ctx.set("tools", this.tools);
    for (const plugin of this.plugins) {
      await plugin.apply(ctx);
    }
  }

  pluginNames(): string[] {
    return this.plugins.map((p) => p.name);
  }
}

export function modelPlugin(model: string): Plugin {
  return {
    name: `model:${model}`,
    kind: "model",
    apply(ctx) {
      ctx.set("model", model);
    },
  };
}

export function sessionPlugin(): Plugin {
  return {
    name: "session",
    kind: "session",
    apply(ctx) {
      ctx.set("session", { turns: [] as unknown[] });
    },
  };
}

export function permissionsPlugin(deny: string[], requireApproval: string[]): Plugin {
  return {
    name: "permissions",
    kind: "permissions",
    apply(ctx) {
      ctx.set("permissions", { deny, requireApproval });
    },
  };
}

export function toolsPlugin(
  names: string[],
  opts: { cwd?: string; exec?: WorkspaceExec } = {},
): Plugin {
  const exec: WorkspaceExec =
    opts.exec ??
    ((bin, args, o) => runProcess(bin, args, { cwd: opts.cwd, stdin: o?.stdin, env: o?.env }));
  return {
    name: `tools:${names.join("+")}`,
    kind: "tools",
    apply(ctx) {
      const kernel = ctx.get<Kernel>("kernel");
      if (opts.cwd) ctx.set("cwd", opts.cwd);
      for (const name of names) {
        kernel.registerTool(name, async (input) => {
          const perms = ctx.get<{ deny: string[] }>("permissions");
          if (perms.deny.includes(name)) {
            return `denied: ${name}`;
          }
          let cwd = opts.cwd;
          if (!cwd) {
            try {
              cwd = ctx.get<string>("cwd");
            } catch {
              cwd = undefined;
            }
          }
          // Tool name is the agent's. Effects run only when the input asks.
          const applied = await applyHarnessCall(exec, name, input);
          if (applied !== undefined) {
            return JSON.stringify({ ...applied, ...(cwd ? { cwd } : {}) });
          }
          // Calls with no workspace effect stay descriptors.
          if ((name === "fs" || name === "shell" || name === "bash") && cwd) {
            return JSON.stringify({ ok: true, tool: name, cwd, input });
          }
          return JSON.stringify({ ok: true, tool: name, input, ...(cwd ? { cwd } : {}) });
        });
      }
    },
  };
}

export type LoopMode = "tool-calls" | "code";

export function loopPlugin(mode: LoopMode): Plugin {
  return {
    name: `loop:${mode}`,
    kind: "loop",
    apply(ctx) {
      ctx.set("loop", {
        mode,
        async run(
          calls: Array<{ name: string; input: Record<string, unknown> }>,
        ): Promise<string[]> {
          const kernel = ctx.get<Kernel>("kernel");
          const results: string[] = [];
          if (mode === "code") {
            // DeepSeek Code profile: collapse a sequence into one program-shaped turn.
            for (const call of calls) {
              const fn = kernel.tools.get(call.name);
              results.push(fn ? await fn(call.input, ctx) : `unknown tool: ${call.name}`);
            }
            return results;
          }
          for (const call of calls) {
            const fn = kernel.tools.get(call.name);
            results.push(fn ? await fn(call.input, ctx) : `unknown tool: ${call.name}`);
          }
          return results;
        },
      });
    },
  };
}

export function deliveryPlugin(kind: "comment" | "pull_request" | "check"): Plugin {
  return {
    name: `delivery:${kind}`,
    kind: "delivery",
    apply(ctx) {
      ctx.set("delivery", {
        kind,
        send(body: string) {
          return { kind, body };
        },
      });
    },
  };
}

/**
 * DeepSeek memory plugin — mounts a Hermes MemoryPort onto the kernel.
 * Tools can remember/query through ctx.get("memory").
 */
export function memoryPlugin(port: import("./contracts.js").MemoryPort): Plugin {
  return {
    name: `memory:${port.context.policy.write}`,
    kind: "memory",
    apply(ctx) {
      ctx.set("memory", port);
      const kernel = ctx.get<Kernel>("kernel");
      kernel.registerTool("memory", (input) => {
        const action = String(input.action ?? "query");
        if (action === "remember") {
          const fact = port.remember(String(input.text ?? ""), {
            scope: input.scope as import("./types.js").MemoryScope | undefined,
            tags: Array.isArray(input.tags) ? (input.tags as string[]) : undefined,
          });
          return JSON.stringify({ ok: true, fact });
        }
        if (action === "promote") {
          const fact = port.promote(String(input.id ?? ""), input.scope as import("./types.js").MemoryScope);
          return JSON.stringify({ ok: Boolean(fact), fact });
        }
        const facts = port.query({
          text: input.text ? String(input.text) : undefined,
          limit: typeof input.limit === "number" ? input.limit : 20,
        });
        return JSON.stringify({ ok: true, facts });
      });
    },
  };
}

/** DeepSeek skills plugin — exposes learned + image skills to the kernel. */
export function skillsPlugin(skills: string[]): Plugin {
  return {
    name: "skills",
    kind: "skills",
    apply(ctx) {
      ctx.set("skills", [...skills]);
    },
  };
}

/** DeepSeek soul plugin — Hermes identity available inside the harness. */
export function soulPlugin(soul: string): Plugin {
  return {
    name: "soul",
    kind: "soul",
    apply(ctx) {
      ctx.set("soul", soul);
    },
  };
}

const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "Ropex",
  GIT_AUTHOR_EMAIL: "ropex@localhost",
  GIT_COMMITTER_NAME: "Ropex",
  GIT_COMMITTER_EMAIL: "ropex@localhost",
};

function workspacePath(value: unknown): string {
  const path = String(value ?? "").trim();
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`fs path escapes the workspace: ${path || "(empty)"}`);
  }
  return path;
}

async function writeWorkspaceFile(exec: WorkspaceExec, path: string, content: string): Promise<void> {
  const res = await exec(
    "sh",
    ["-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", path],
    { stdin: content },
  );
  if (res.code !== 0) {
    throw new Error(`harness file write ${path} failed: ${(res.stderr || res.stdout).trim() || `exit ${res.code}`}`);
  }
}

/**
 * One thing the workspace can do for any tool. A call stays `{ name, input }`:
 * `name` is whichever tool the agent invoked. An effect runs only when `input`
 * asks for it. Append an effect to teach the workspace a new capability;
 * every other call stays a descriptor for that tool.
 */
export type WorkspaceEffect = (
  exec: WorkspaceExec,
  name: string,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown> | undefined>;

/** Workspace capabilities. Order is first match. Tool names are not listed here. */
export const workspaceEffects: WorkspaceEffect[] = [commandEffect, fileEffect];

/** Apply one plan call. Returns undefined when no workspace effect claims it. */
export async function applyHarnessCall(
  exec: WorkspaceExec,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  for (const effect of workspaceEffects) {
    const applied = await effect(exec, name, input);
    if (applied !== undefined) return applied;
  }
  return undefined;
}

/** `input.argv` runs a command, whatever tool asked for it. */
async function commandEffect(
  exec: WorkspaceExec,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const argv = stringList(input.argv);
  if (!argv?.length) return undefined;
  const ran = await runArgv(exec, argv, typeof input.stdin === "string" ? input.stdin : undefined);
  return { ok: true, tool: name, argv, code: ran.code, stdout: ran.stdout.trim() };
}

/** `input.path` + `input.content` writes a file, whatever tool asked for it. */
async function fileEffect(
  exec: WorkspaceExec,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  if (typeof input.path !== "string" || typeof input.content !== "string") return undefined;
  const path = workspacePath(input.path);
  await writeWorkspaceFile(exec, path, input.content);
  return { ok: true, tool: name, path };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    return undefined;
  }
  return value as string[];
}

/** Run a command. Git gets a harness identity and signing turned off so a commit cannot wait on gpg. */
async function runArgv(exec: WorkspaceExec, argv: string[], stdin?: string): Promise<RunProcessResult> {
  const [bin, ...args] = argv;
  const git = bin === "git";
  const res = await exec(
    bin,
    git ? ["-c", "user.name=Ropex", "-c", "user.email=ropex@localhost", "-c", "commit.gpgsign=false", ...args] : args,
    { stdin, env: git ? AUTHOR_ENV : undefined },
  );
  if (res.code !== 0) {
    throw new Error(
      `harness ${argv.join(" ")} failed: ${(res.stderr || res.stdout).trim() || `exit ${res.code}`}`,
    );
  }
  return res;
}
