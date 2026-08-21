/**
 * Cordis-inspired plugin kernel (DeepSeek Harness shape).
 * Everything — model, tools, loop, permissions, session — is a plugin.
 */

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

export function toolsPlugin(names: string[], opts: { cwd?: string } = {}): Plugin {
  return {
    name: `tools:${names.join("+")}`,
    kind: "tools",
    apply(ctx) {
      const kernel = ctx.get<Kernel>("kernel");
      if (opts.cwd) ctx.set("cwd", opts.cwd);
      for (const name of names) {
        kernel.registerTool(name, (input) => {
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
          // fs/shell are chrooted to the worker worktree when present.
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
