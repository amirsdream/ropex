/**
 * Shared memory bus — scoped facts across workers, agents, fleets, and cluster.
 * Hermes remembers through MemoryPort; DeepSeek mounts the same port as a plugin.
 */

import type { MemoryContext, MemoryPort, MemoryQuery } from "./contracts.js";
import type {
  ClusterState,
  HermesSpec,
  MemoryBackend,
  MemoryScope,
  MemoryShareSpec,
  SharedMemoryFact,
} from "./types.js";

const SCOPE_RANK: Record<MemoryScope, number> = {
  worker: 0,
  agent: 1,
  fleet: 2,
  cluster: 3,
};

export function defaultSharePolicy(backend: MemoryBackend): MemoryShareSpec {
  if (backend === "none") return { read: [], write: "worker" };
  if (backend === "shared") return { read: ["agent", "fleet"], write: "agent" };
  return { read: ["agent"], write: "agent" };
}

export function resolveSharePolicy(hermes: HermesSpec): MemoryShareSpec {
  const base = defaultSharePolicy(hermes.memory);
  if (!hermes.share) return base;
  return {
    read: hermes.share.read.length ? [...hermes.share.read] : base.read,
    write: hermes.share.write ?? base.write,
  };
}

export function normalizeFact(raw: SharedMemoryFact | (SharedMemoryFact & { scope?: MemoryScope })): SharedMemoryFact {
  return {
    id: raw.id,
    agent: raw.agent,
    text: raw.text,
    at: raw.at,
    scope: raw.scope ?? "agent",
    worker: raw.worker,
    fleet: raw.fleet,
    tags: raw.tags ? [...raw.tags] : undefined,
    sourceWorker: raw.sourceWorker,
  };
}

export function canRead(fact: SharedMemoryFact, ctx: MemoryContext): boolean {
  if (!ctx.policy.read.includes(fact.scope)) return false;
  switch (fact.scope) {
    case "worker":
      return fact.worker === ctx.worker || fact.sourceWorker === ctx.worker;
    case "agent":
      return fact.agent === ctx.agent;
    case "fleet":
      return Boolean(ctx.fleet) && fact.fleet === ctx.fleet;
    case "cluster":
      return true;
    default:
      return false;
  }
}

/** Writes are allowed at or below the configured write scope. */
export function canWrite(scope: MemoryScope, ctx: MemoryContext): boolean {
  if (scope === "fleet" && !ctx.fleet) return false;
  if (scope === "worker" && !ctx.worker) return false;
  return SCOPE_RANK[scope] <= SCOPE_RANK[ctx.policy.write];
}

export function createMemoryPort(
  store: SharedMemoryStore,
  ctx: MemoryContext,
): MemoryPort {
  return {
    context: ctx,
    query(filter) {
      return store.query(ctx, filter);
    },
    remember(text, opts) {
      return store.remember(ctx, text, opts);
    },
    promote(id, scope) {
      return store.promote(ctx, id, scope);
    },
    snapshot() {
      return store.query(ctx);
    },
  };
}

/**
 * In-memory / file-backed shared store bound to ClusterState.memory.
 */
export class SharedMemoryStore {
  constructor(private facts: SharedMemoryFact[]) {}

  static fromState(state: ClusterState): SharedMemoryStore {
    state.memory = state.memory.map((f) => normalizeFact(f as SharedMemoryFact));
    return new SharedMemoryStore(state.memory);
  }

  /** Live reference — mutations persist on ClusterState.memory. */
  all(): SharedMemoryFact[] {
    return this.facts;
  }

  query(ctx: MemoryContext, filter: MemoryQuery = {}): SharedMemoryFact[] {
    const scopes = filter.scopes;
    let rows = this.facts.filter((f) => canRead(f, ctx));
    if (scopes?.length) {
      rows = rows.filter((f) => scopes.includes(f.scope));
    }
    if (filter.tags?.length) {
      rows = rows.filter((f) => filter.tags!.every((t) => f.tags?.includes(t)));
    }
    if (filter.text) {
      const q = filter.text.toLowerCase();
      rows = rows.filter((f) => f.text.toLowerCase().includes(q));
    }
    rows = [...rows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    if (filter.limit && filter.limit > 0) {
      rows = rows.slice(0, filter.limit);
    }
    return rows.map((f) => ({ ...f, tags: f.tags ? [...f.tags] : undefined }));
  }

  remember(
    ctx: MemoryContext,
    text: string,
    opts?: { scope?: MemoryScope; tags?: string[]; id?: string },
  ): SharedMemoryFact {
    if (ctx.policy.read.length === 0 && ctx.policy.write === "worker" && !opts?.scope) {
      // memory: none — still allow ephemeral worker-local writes for the run
    }
    const scope = opts?.scope ?? ctx.policy.write;
    if (!canWrite(scope, ctx)) {
      throw new Error(`memory write denied for scope ${scope} (policy write=${ctx.policy.write})`);
    }
    const fact: SharedMemoryFact = {
      id: opts?.id ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agent: ctx.agent,
      text,
      at: new Date().toISOString(),
      scope,
      worker: scope === "worker" ? ctx.worker : undefined,
      fleet: scope === "fleet" || scope === "cluster" ? ctx.fleet : ctx.fleet,
      tags: opts?.tags ? [...opts.tags] : undefined,
      sourceWorker: ctx.worker,
    };
    if (scope === "fleet" || scope === "cluster") {
      fact.fleet = ctx.fleet;
    }
    if (scope === "agent") {
      fact.fleet = ctx.fleet;
    }
    this.facts.push(fact);
    return { ...fact, tags: fact.tags ? [...fact.tags] : undefined };
  }

  promote(ctx: MemoryContext, id: string, scope: MemoryScope): SharedMemoryFact | undefined {
    const idx = this.facts.findIndex((f) => f.id === id);
    if (idx === -1) return undefined;
    const fact = this.facts[idx];
    if (!canRead(fact, ctx)) return undefined;
    if (SCOPE_RANK[scope] < SCOPE_RANK[fact.scope]) return undefined;
    if (!canWrite(scope, ctx)) {
      throw new Error(`memory promote denied to scope ${scope}`);
    }
    const next: SharedMemoryFact = {
      ...fact,
      scope,
      fleet: scope === "worker" ? fact.fleet : ctx.fleet ?? fact.fleet,
      worker: scope === "worker" ? ctx.worker : undefined,
      at: new Date().toISOString(),
    };
    this.facts[idx] = next;
    return { ...next, tags: next.tags ? [...next.tags] : undefined };
  }
}

export function memoryContextFor(
  worker: { id: string; agent: string; fleet?: string },
  hermes: HermesSpec,
): MemoryContext {
  return {
    agent: worker.agent,
    worker: worker.id,
    fleet: worker.fleet,
    policy: resolveSharePolicy(hermes),
  };
}
