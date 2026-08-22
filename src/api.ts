/**
 * Control-plane API — pure view builders + optional HTTP server for the UI.
 * Tests call buildControlPlaneView with no network.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_ROUTES,
  type ControlPlaneView,
  type FleetView,
  type HarnessSurfaceView,
  type HermesSurfaceView,
  type MemoryStreamEntry,
  type WorkerView,
} from "./contracts.js";
import { loopModeFor, toolsFor } from "./harness.js";
import { memoryContextFor, resolveSharePolicy, SharedMemoryStore } from "./memory.js";
import { healthReport } from "./health.js";
import { planAutoscale } from "./autoscale.js";
import { budgetReport } from "./budget.js";
import { outboundFor } from "./deliver.js";
import { detectDrift } from "./drift.js";
import { fairnessReport } from "./fairness.js";
import { simulatePolicies } from "./policy-sim.js";
import { cloneStatusReport } from "./clone.js";
import { decideApproval } from "./approval.js";
import { pruneAffinity } from "./affinity.js";
import { DSH_PROFILE_PACKS, liveDshScaffold } from "./dsh.js";
import { liveHermesScaffold } from "./hermes.js";
import { auditsFor, exportAuditJsonl } from "./audit.js";
import { metricsPrometheus, metricsSnapshot } from "./metrics.js";
import { ensureQueue, queueSummary } from "./queue.js";
import { trajectoriesFor, exportTrajectoriesJsonl } from "./trajectory.js";
import { WORKFLOW_STAGES } from "./workflow.js";
import type { ClusterState, DesiredAgent } from "./types.js";

const UI_DIR = resolveUiDir();

function resolveUiDir(): string {
  const beside = join(dirname(fileURLToPath(import.meta.url)), "ui");
  try {
    readFileSync(join(beside, "index.html"));
    return beside;
  } catch {
    return join(process.cwd(), "src", "ui");
  }
}
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export function buildControlPlaneView(state: ClusterState): ControlPlaneView {
  ensureQueue(state);
  const live = state.workers.filter((w) => w.status !== "retired");
  const fleets = buildFleetViews(state);
  const store = SharedMemoryStore.fromState(state);
  const q = queueSummary(state);

  const workers: WorkerView[] = live.map((w) => {
    const agent = state.desired.find((a) => a.metadata.name === w.agent);
    const ctx = agent
      ? memoryContextFor(w, agent.spec.hermes)
      : { agent: w.agent, worker: w.id, fleet: w.fleet, policy: { read: ["agent" as const], write: "agent" as const } };
    return {
      id: w.id,
      agent: w.agent,
      fleet: w.fleet,
      replica: w.replica,
      status: w.status,
      imageDigest: w.imageDigest,
      harness: w.harness,
      model: w.model,
      plugins: [...w.plugins],
      skills: [...w.skills],
      memoryReadable: store.query(ctx).length,
      worktree: w.worktree,
    };
  });

  const memory: MemoryStreamEntry[] = [...state.memory]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 80)
    .map((f) => ({
      id: f.id,
      text: f.text,
      scope: f.scope,
      agent: f.agent,
      fleet: f.fleet,
      worker: f.worker ?? f.sourceWorker,
      at: f.at,
      tags: f.tags ?? [],
    }));

  const hermes: HermesSurfaceView[] = state.desired.map((a) => hermesSurface(a));
  const harness: HarnessSurfaceView[] = state.desired.map((a) => harnessSurface(a));
  const health = healthReport(state);

  return {
    brand: "ropex",
    tagline: "One git sequence. Many workers in position.",
    revision: state.revision,
    source: state.source,
    lastReconcile: state.lastReconcile,
    counts: {
      workersLive: live.length,
      workersKnown: state.workers.length,
      fleets: fleets.length,
      memoryFacts: state.memory.length,
      skills: state.skills.length,
      queuePending: q.pending,
      tasksCompleted: state.metrics.tasksCompleted,
    },
    workers,
    fleets,
    memory,
    hermes,
    harness,
    skills: [...state.skills],
    workflow: WORKFLOW_STAGES.map((s) => ({ id: s.id, owner: s.owner, purpose: s.purpose })),
    queue: state.queue.slice(-40).map((item) => ({
      id: item.id,
      status: item.status,
      agent: item.task.agent,
      source: item.source,
      prompt: item.task.prompt,
      priority: item.priority ?? 0,
      attempts: item.attempts,
      nextRetryAt: item.nextRetryAt,
      error: item.error,
    })),
    deliveries: (state.deliveries ?? []).slice(-30).map((d) => ({
      id: d.id,
      kind: d.kind,
      agent: d.agent,
      body: d.body,
      at: d.at,
      repo: d.repo,
    })),
    metrics: {
      tasksCompleted: state.metrics.tasksCompleted,
      tasksFailed: state.metrics.tasksFailed,
      queuePending: q.pending,
      workersIdle: live.filter((w) => w.status === "idle").length,
      deliveries: state.deliveries?.length ?? 0,
      workersUnhealthy: health.unhealthy,
      backlogSloBreached: health.backlog.breached,
    },
    approvals: (state.approvals ?? [])
      .filter((a) => a.status === "pending")
      .slice(0, 40)
      .map((a) => ({
        id: a.id,
        status: a.status,
        tool: a.tool,
        agent: a.agent,
        taskId: a.taskId,
        reason: a.reason,
      })),
    audit: auditsFor(state, { limit: 40 }).map((e) => ({
      id: e.id,
      at: e.at,
      kind: e.kind,
      message: e.message,
      agent: e.agent,
      taskId: e.taskId,
    })),
    health: {
      ok: health.ok,
      unhealthy: health.unhealthy,
      backlogBreached: health.backlog.breached,
      backlogPending: health.backlog.pending,
      oldestPendingAgeMs: health.backlog.oldestPendingAgeMs,
      workers: health.workers.map((w) => ({
        id: w.id,
        status: w.status,
        healthy: w.healthy,
        detail: w.checks
          .filter((c) => !c.ok)
          .map((c) => c.detail ?? c.name)
          .join("; ") || "ok",
      })),
    },
    gitRepos: (state.gitRepos ?? []).map((r) => {
      const st = state.gitRepoStatus?.find((s) => s.name === r.metadata.name);
      return {
        name: r.metadata.name,
        path: st?.path ?? r.spec.path,
        ok: st?.ok ?? true,
        lastSyncedAt: st?.lastSyncedAt,
        reason: st?.reason,
      };
    }),
    autoscale: (() => {
      const plan = planAutoscale(state);
      return {
        backlogBreached: plan.backlogBreached,
        policyCap: plan.policyCap,
        recommendations: plan.recommendations.map((r) => ({
          kind: r.kind,
          name: r.name,
          currentReplicas: r.currentReplicas,
          recommendedReplicas: r.recommendedReplicas,
          delta: r.delta,
          reason: r.reason,
        })),
      };
    })(),
    drift: (() => {
      const d = detectDrift(state);
      return {
        ok: d.ok,
        liveWorkers: d.liveWorkers,
        desiredWorkers: d.desiredWorkers,
        summary: { ...d.summary },
        findings: d.findings.slice(0, 30).map((f) => ({
          kind: f.kind,
          detail: f.detail,
          workerId: f.workerId,
          agent: f.agent,
        })),
      };
    })(),
    fairness: (() => {
      const f = fairnessReport(state);
      return {
        claimWaitP50Ms: f.claimWait.p50Ms,
        claimWaitP95Ms: f.claimWait.p95Ms,
        claimWaitMaxMs: f.claimWait.maxMs,
        runDurationP50Ms: f.runDuration.p50Ms,
        runDurationP95Ms: f.runDuration.p95Ms,
        maxIdleSkewMs: f.maxIdleSkewMs,
        claimCountCv: f.claimCountCv,
        pendingByAgent: { ...f.pendingByAgent },
        topWorkers: f.workers.slice(0, 12).map((w) => ({
          workerId: w.workerId,
          agent: w.agent,
          claims: w.claims,
          idleSkewMs: w.idleSkewMs,
        })),
      };
    })(),
    budget: {
      rows: budgetReport(state).map((r) => ({
        key: r.key,
        scope: r.scope,
        spent: r.spent,
        limit: r.limit,
        remaining: r.remaining,
        exhausted: r.exhausted,
      })),
    },
    policySim: (() => {
      const sim = simulatePolicies(state);
      return {
        deniedTasks: sim.deniedTasks,
        deniedCalls: sim.deniedCalls,
        approvalCalls: sim.approvalCalls,
        rows: sim.rows.slice(0, 24).map((r) => ({
          agent: r.agent,
          prompt: r.prompt,
          taskDenied: r.taskDenied,
          callsDenied: r.callsDenied,
          callsNeedApproval: r.callsNeedApproval,
        })),
      };
    })(),
    outbound: (() => {
      const rows = outboundFor(state, { limit: 40 });
      return {
        simulated: rows.filter((r) => r.status === "simulated").length,
        rejected: rows.filter((r) => r.status === "rejected").length,
        recent: rows.slice(0, 20).map((r) => ({
          id: r.id,
          status: r.status,
          url: r.url,
          agent: r.agent,
          deliveryId: r.deliveryId,
          reason: r.reason,
          at: r.at,
        })),
      };
    })(),
    clone: (() => {
      const c = cloneStatusReport(state);
      return {
        repos: c.repos,
        ok: c.ok,
        blocked: c.blocked,
        rows: c.rows.map((r) => ({
          name: r.name,
          path: r.path,
          ok: r.ok,
          reason: r.reason,
          cloneBackend: r.cloneBackend,
          clonePhase: r.clonePhase,
          cloneProgressPct: r.cloneProgressPct,
          lastClonedAt: r.lastClonedAt,
        })),
      };
    })(),
    queuePaused: Boolean(state.queuePaused),
    webhookDuplicates: state.metrics?.webhookDuplicates ?? 0,
    affinity: (() => {
      pruneAffinity(state);
      const bindings = (state.affinity ?? []).slice(0, 24);
      return {
        active: bindings.length,
        bindings: bindings.map((b) => ({
          key: b.key,
          workerId: b.workerId,
          agent: b.agent,
          expiresAt: b.expiresAt,
        })),
      };
    })(),
    dsh: (() => {
      const scaffold = liveDshScaffold();
      return {
        backend: "simulated" as const,
        profiles: Object.values(DSH_PROFILE_PACKS).map((p) => ({
          profile: p.profile,
          loop: p.loop,
          plugins: [...p.plugins],
          description: p.description,
        })),
        liveReady: scaffold.liveReady,
        scaffoldHint: scaffold.summary,
      };
    })(),
    hermesLive: (() => {
      const scaffold = liveHermesScaffold();
      return {
        liveReady: scaffold.liveReady,
        scaffoldHint: scaffold.summary,
        steps: [...scaffold.steps],
      };
    })(),
  };
}

function hermesSurface(agent: DesiredAgent): HermesSurfaceView {
  const share = resolveSharePolicy(agent.spec.hermes);
  return {
    agent: agent.metadata.name,
    soul: agent.spec.hermes.soul ?? "default",
    skills: [...agent.spec.hermes.skills],
    share,
    memoryBackend: agent.spec.hermes.memory,
    learning: agent.spec.hermes.learning,
  };
}

function harnessSurface(agent: DesiredAgent): HarnessSurfaceView {
  return {
    agent: agent.metadata.name,
    profile: agent.spec.harness.profile,
    model: agent.spec.harness.model ?? "deepseek-v4-flash",
    plugins: [...agent.spec.harness.plugins],
    loop: loopModeFor(agent.spec.harness.profile),
    tools: toolsFor(agent.spec),
  };
}

function buildFleetViews(state: ClusterState): FleetView[] {
  const byFleet = new Map<string, FleetView>();
  for (const w of state.workers.filter((x) => x.status !== "retired")) {
    const name = w.fleet ?? `solo:${w.agent}`;
    const cur = byFleet.get(name) ?? {
      name,
      replicas: 0,
      live: 0,
      profile: w.harness,
      memoryFacts: 0,
    };
    cur.replicas += 1;
    cur.live += 1;
    byFleet.set(name, cur);
  }
  for (const f of byFleet.values()) {
    f.memoryFacts = state.memory.filter((m) => m.fleet === f.name || (!m.fleet && f.name.startsWith("solo:"))).length;
  }
  return [...byFleet.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Facts visible to a specific worker (API helper). */
export function memoryForWorker(state: ClusterState, workerId: string) {
  const worker = state.workers.find((w) => w.id === workerId);
  if (!worker) return [];
  const agent = state.desired.find((a) => a.metadata.name === worker.agent);
  if (!agent) return [];
  const ctx = memoryContextFor(worker, agent.spec.hermes);
  return SharedMemoryStore.fromState(state).query(ctx);
}

export type ServeOptions = {
  root: string;
  port?: number;
  loadState: (root: string) => ClusterState;
  /** Optional persist hook for mutating routes (approvals). */
  saveState?: (root: string, state: ClusterState) => void;
};

export function startControlPlaneServer(opts: ServeOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const port = opts.port ?? 7780;
  const server = createServer((req, res) => {
    void handleRequest(req, res, opts).catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: bound,
        close: () =>
          new Promise((r, j) => {
            server.close((e) => (e ? j(e) : r()));
          }),
      });
    });
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, opts: ServeOptions): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const state = opts.loadState(opts.root);

  if (url.pathname === API_ROUTES.health) {
    const report = healthReport(state);
    return json(res, { brand: "ropex", ...report }, report.ok ? 200 : 503);
  }
  if (url.pathname === API_ROUTES.view) {
    return json(res, buildControlPlaneView(state));
  }
  if (url.pathname === API_ROUTES.memory) {
    const workerId = url.searchParams.get("worker");
    if (workerId) return json(res, memoryForWorker(state, workerId));
    return json(res, state.memory);
  }
  if (url.pathname === API_ROUTES.workers) {
    return json(res, buildControlPlaneView(state).workers);
  }
  if (url.pathname === API_ROUTES.queue) {
    const summary = queueSummary(state);
    return json(res, {
      summary,
      metrics: state.metrics,
      items: state.queue,
      deadLetters: state.queue.filter((q) => q.status === "dead"),
    });
  }
  if (url.pathname === API_ROUTES.metrics) {
    if (url.searchParams.get("format") === "prometheus") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(metricsPrometheus(state));
      return;
    }
    return json(res, metricsSnapshot(state));
  }
  if (url.pathname === API_ROUTES.deliveries) {
    return json(res, state.deliveries ?? []);
  }
  if (url.pathname === API_ROUTES.skills) {
    return json(res, {
      learned: state.skills ?? [],
      registry: state.skillRegistry ?? [],
    });
  }
  if (url.pathname === API_ROUTES.trajectories) {
    if (url.searchParams.get("format") === "jsonl") {
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
      res.end(
        exportTrajectoriesJsonl(state, {
          agent: url.searchParams.get("agent") ?? undefined,
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 100,
        }),
      );
      return;
    }
    return json(
      res,
      trajectoriesFor(state, {
        agent: url.searchParams.get("agent") ?? undefined,
        limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 50,
      }),
    );
  }

  if (url.pathname === API_ROUTES.approvals) {
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: { id?: string; decision?: string } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          id?: string;
          decision?: string;
        };
      } catch {
        return json(res, { error: "invalid json" }, 400);
      }
      const id = body.id ?? url.searchParams.get("id") ?? undefined;
      const decision =
        body.decision === "approved" || body.decision === "rejected"
          ? body.decision
          : undefined;
      if (!id || !decision) {
        return json(res, { error: "need id and decision=approved|rejected" }, 400);
      }
      const updated = decideApproval(state, id, decision);
      if (!updated) return json(res, { error: `approval not found or not pending: ${id}` }, 404);
      opts.saveState?.(opts.root, state);
      return json(res, updated);
    }
    return json(res, state.approvals ?? []);
  }
  if (url.pathname === API_ROUTES.audit) {
    if (url.searchParams.get("format") === "jsonl") {
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
      res.end(
        exportAuditJsonl(state, {
          kind: (url.searchParams.get("kind") as import("./types.js").AuditKind) ?? undefined,
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 500,
        }),
      );
      return;
    }
    return json(
      res,
      auditsFor(state, {
        kind: (url.searchParams.get("kind") as import("./types.js").AuditKind) ?? undefined,
        agent: url.searchParams.get("agent") ?? undefined,
        limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 100,
      }),
    );
  }
  if (url.pathname === API_ROUTES.autoscale) {
    const plan = planAutoscale(state);
    return json(res, plan);
  }
  if (url.pathname === API_ROUTES.budget) {
    return json(res, { budgets: budgetReport(state), ledgers: state.budgets ?? [] });
  }
  if (url.pathname === API_ROUTES.outbound) {
    return json(
      res,
      outboundFor(state, {
        status: (url.searchParams.get("status") as "simulated" | "rejected" | undefined) ?? undefined,
        limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 50,
      }),
    );
  }
  if (url.pathname === API_ROUTES.drift) {
    return json(res, detectDrift(state));
  }
  if (url.pathname === API_ROUTES.fairness) {
    return json(res, fairnessReport(state));
  }
  if (url.pathname === API_ROUTES.clone) {
    return json(res, cloneStatusReport(state));
  }
  if (url.pathname === API_ROUTES.affinity) {
    pruneAffinity(state);
    return json(res, {
      active: state.affinity?.length ?? 0,
      bindings: state.affinity ?? [],
    });
  }

  // Static UI
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  if (path.includes("..")) {
    res.writeHead(400);
    res.end("bad path");
    return;
  }
  try {
    const file = join(UI_DIR, path.replace(/^\//, ""));
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}
