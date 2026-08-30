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
import { memoryContextFor, resolveSharePolicy, SharedMemoryStore, promoteMemoryFact } from "./memory.js";
import {
  DEFAULT_MEMORY_DIR,
  exportMemoryFactToGit,
  exportMemoryFacts,
  memoryGitSummary,
  syncMemoryFromDir,
  syncMemoryFromGitRepos,
} from "./gitmemory.js";
import { healthReport } from "./health.js";
import { planAutoscale } from "./autoscale.js";
import { budgetReport, budgetAlerts } from "./budget.js";
import { canaryProgress } from "./canary.js";
import { outboundFor } from "./deliver.js";
import { detectDrift } from "./drift.js";
import { fairnessReport } from "./fairness.js";
import { simulatePolicies } from "./policy-sim.js";
import { cloneStatusReport, cloneAllGitRepos } from "./clone.js";
import { decideApproval } from "./approval.js";
import { pruneAffinity } from "./affinity.js";
import { DSH_PROFILE_PACKS, liveDshScaffold, resolveDshBackend } from "./dsh.js";
import { liveHermesScaffold, resolveHermesBackend } from "./hermes.js";
import { githubAppScaffold } from "./github-app.js";
import { rateLimitReport } from "./ratelimit.js";
import { drainQueue, drainStatus, setDrainConcurrency } from "./scheduler.js";
import {
  getPipeline,
  getExecutorEvents,
  mapExecutorEventToUi,
  pipelinePhase,
  submitPipeline,
  drainPipeline,
  subscribeExecutorEvents,
  validatePipelineAgents,
  type SubmitPipelineOptions,
} from "./executor.js";
import { hygieneReport, runHygiene } from "./hygiene.js";
import { promoteSkill, shareSkill, skillsCatalog } from "./skills.js";
import { auditsFor, exportAuditJsonl } from "./audit.js";
import { metricsPrometheus, metricsSnapshot } from "./metrics.js";
import { ensureQueue, queueSummary, pauseQueue, resumeQueue, requeueDead, deadLetters, isQueuePaused } from "./queue.js";
import { trajectoriesFor, exportTrajectoriesJsonl, ensureTrajectories, getTrajectory } from "./trajectory.js";
import { syncTasksFromDir, syncTasksFromGitRepos, taskGitSummaryFromRepos } from "./tasks.js";
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

export function buildControlPlaneView(state: ClusterState, root = process.cwd()): ControlPlaneView {
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
      manifestPath: f.manifestPath,
    }));

  const memGit = memoryGitSummary(state);
  const taskGit = taskGitSummaryFromRepos(state, root);

  const hermes: HermesSurfaceView[] = state.desired.map((a) => hermesSurface(a));
  const harness: HarnessSurfaceView[] = state.desired.map((a) => harnessSurface(a));
  const health = healthReport(state);

  return {
    brand: "ropex",
    tagline: "Admit → spawn → run → destroy. Memory stays.",
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
    memoryGit: {
      gitBacked: memGit.gitBacked,
      runtimeOnly: memGit.runtimeOnly,
      defaultDir: DEFAULT_MEMORY_DIR,
    },
    taskGit: {
      pending: taskGit.pending,
      done: taskGit.done,
      failed: taskGit.failed,
      scanned: taskGit.scanned,
      defaultDir: taskGit.defaultDir,
      items: taskGit.items.map((t) => ({ ...t })),
    },
    hermes,
    harness,
    skills: [...state.skills],
    workflow: WORKFLOW_STAGES.map((s) => ({ id: s.id, owner: s.owner, phase: s.phase, purpose: s.purpose })),
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
    budget: (() => {
      const alerts = budgetAlerts(state);
      return {
        rows: alerts.map((r) => ({
          key: r.key,
          scope: r.scope,
          spent: r.spent,
          limit: r.limit,
          remaining: r.remaining,
          exhausted: r.exhausted,
          level: r.level,
          remainingPct: r.remainingPct,
        })),
        alerts: alerts.filter((a) => a.level !== "ok").length,
      };
    })(),
    canary: (() => {
      const c = canaryProgress(state);
      return {
        ok: c.ok,
        matched: c.matched,
        mismatched: c.mismatched,
        total: c.total,
        pctMatched: c.pctMatched,
        agents: c.agents.map((a) => ({
          agent: a.agent,
          desiredDigest: a.desiredDigest,
          matched: a.matched,
          mismatched: a.mismatched,
          total: a.total,
          pctMatched: a.pctMatched,
        })),
      };
    })(),
    skillCatalog: skillsCatalog(state),
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
      const backend = resolveDshBackend();
      return {
        backend,
        profiles: Object.values(DSH_PROFILE_PACKS).map((p) => ({
          profile: p.profile,
          loop: p.loop,
          plugins: [...p.plugins],
          description: p.description,
          dshProfile: p.dshProfile,
        })),
        liveReady: scaffold.liveReady,
        packageInstalled: scaffold.packageInstalled,
        apiKeyPresent: scaffold.apiKeyPresent,
        apiKeySource: scaffold.apiKeySource,
        scaffoldHint: scaffold.summary,
      };
    })(),
    hermesLive: (() => {
      const scaffold = liveHermesScaffold();
      return {
        backend: resolveHermesBackend(),
        liveReady: scaffold.liveReady,
        packageInstalled: scaffold.packageInstalled,
        scaffoldHint: scaffold.summary,
        steps: [...scaffold.steps],
      };
    })(),
    githubApp: (() => {
      const app = githubAppScaffold();
      return {
        ready: app.ready,
        appIdPresent: app.appIdPresent,
        privateKeyPresent: app.privateKeyPresent,
        webhookSecretPresent: app.webhookSecretPresent,
        summary: app.summary,
        steps: [...app.steps],
      };
    })(),
    trajectories: (() => {
      ensureTrajectories(state);
      const rows = trajectoriesFor(state, { limit: 20 });
      return {
        total: state.trajectories?.length ?? 0,
        recent: rows.map((t) => ({
          id: t.id,
          at: t.at,
          agent: t.agent,
          workerId: t.workerId,
          taskId: t.taskId,
          steps: t.steps?.length ?? 0,
          stages: t.stages ? [...t.stages] : [],
          output: (t.output ?? "").slice(0, 120),
        })),
      };
    })(),
    rateLimits: (() => {
      const r = rateLimitReport(state);
      return {
        limit: r.limit,
        windowMs: r.windowMs,
        buckets: r.buckets,
        nearLimit: r.nearLimit,
        rows: r.rows,
      };
    })(),
    drain: drainStatus(state),
    hygiene: (() => {
      const h = hygieneReport(state);
      return {
        pool: h.pool,
        queueDepth: h.queueDepth,
        webhook: h.webhook,
        leasesReclaimedTotal: h.leasesReclaimedTotal,
        summary: h.summary,
      };
    })(),
    pipelines: (() => {
      const rows = state.pipelines ?? [];
      return {
        total: rows.length,
        recent: rows
          .slice(-20)
          .reverse()
          .map((p) => ({
            id: p.id,
            status: p.status,
            phase: pipelinePhase(p),
            prompt: p.prompt.slice(0, 160),
            stages: p.stages.length,
            doneStages: p.stages.filter((s) => s.status === "done").length,
            updatedAt: p.updatedAt,
          })),
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
    model: agent.spec.harness.model ?? "gpt-4o-mini",
    plugins: [...agent.spec.harness.plugins],
    loop: loopModeFor(agent.spec.harness.profile),
    tools: toolsFor(agent.spec),
  };
}

function buildFleetViews(state: ClusterState): FleetView[] {
  const byFleet = new Map<string, FleetView>();
  // Seed from desired definitions so on-demand agents appear with 0 live runners.
  for (const a of state.desired ?? []) {
    const name = a.derivedFrom?.fleet ?? `solo:${a.metadata.name}`;
    const scale = a.spec.scale === "static" ? "static" : "onDemand";
    const maxConcurrent =
      scale === "onDemand" ? (a.spec.maxConcurrent ?? a.spec.replicas ?? 1) : a.spec.replicas;
    const cur = byFleet.get(name) ?? {
      name,
      replicas: 0,
      live: 0,
      maxConcurrent: 0,
      scale,
      profile: a.spec.harness.profile,
      memoryFacts: 0,
    };
    cur.maxConcurrent = (cur.maxConcurrent ?? 0) + maxConcurrent;
    cur.scale = scale;
    cur.profile = a.spec.harness.profile;
    byFleet.set(name, cur);
  }
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
    cur.profile = w.harness;
    byFleet.set(name, cur);
  }
  for (const f of byFleet.values()) {
    f.memoryFacts = state.memory.filter(
      (m) => m.fleet === f.name || (!m.fleet && f.name.startsWith("solo:")),
    ).length;
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
    return json(res, buildControlPlaneView(state, opts.root));
  }
  if (url.pathname === API_ROUTES.memory) {
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: { action?: string; id?: string; scope?: string; all?: boolean; force?: boolean } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as typeof body;
      } catch {
        return json(res, { error: "invalid json" }, 400);
      }
      const action = body.action ?? url.searchParams.get("action") ?? "";
      if (action === "sync") {
        const fromRepos = url.searchParams.get("repos") === "1" || body.all;
        const result = fromRepos
          ? syncMemoryFromGitRepos(state, opts.root)
          : syncMemoryFromDir(state, opts.root);
        opts.saveState?.(opts.root, state);
        return json(res, { ok: true, action: "sync", ...result, summary: memoryGitSummary(state) });
      }
      if (action === "export") {
        const result = exportMemoryFacts(state, opts.root, {
          ids: body.id ? [body.id] : undefined,
          all: body.all ?? !body.id,
          force: body.force,
        });
        opts.saveState?.(opts.root, state);
        return json(res, { ok: true, action: "export", ...result, summary: memoryGitSummary(state) });
      }
      if (action === "promote") {
        const id = body.id;
        const scope = body.scope as "worker" | "agent" | "fleet" | "cluster" | undefined;
        if (!id || !scope) return json(res, { error: "need id and scope" }, 400);
        const next = promoteMemoryFact(state, id, scope);
        if (!next) return json(res, { error: `fact not found: ${id}` }, 404);
        const path = exportMemoryFactToGit(next, { root: opts.root });
        const idx = state.memory.findIndex((f) => f.id === next.id);
        if (idx !== -1) state.memory[idx] = { ...next, manifestPath: path };
        opts.saveState?.(opts.root, state);
        return json(res, { ok: true, action: "promote", fact: next, path, summary: memoryGitSummary(state) });
      }
      return json(res, { error: "action must be sync|export|promote" }, 400);
    }
    const workerId = url.searchParams.get("worker");
    if (workerId) return json(res, memoryForWorker(state, workerId));
    return json(res, { facts: state.memory, summary: memoryGitSummary(state) });
  }
  if (url.pathname === API_ROUTES.tasks) {
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: { action?: string; all?: boolean } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as typeof body;
      } catch {
        return json(res, { error: "invalid json" }, 400);
      }
      const action = body.action ?? url.searchParams.get("action") ?? "";
      if (action === "sync") {
        const fromRepos = url.searchParams.get("repos") === "1" || body.all;
        const result = fromRepos
          ? syncTasksFromGitRepos(state, opts.root)
          : syncTasksFromDir(state, opts.root);
        opts.saveState?.(opts.root, state);
        return json(res, {
          ok: true,
          action: "sync",
          ...result,
          summary: taskGitSummaryFromRepos(state, opts.root),
        });
      }
      return json(res, { error: "action must be sync" }, 400);
    }
    return json(res, { summary: taskGitSummaryFromRepos(state, opts.root) });
  }
  if (url.pathname === API_ROUTES.workers) {
    return json(res, buildControlPlaneView(state).workers);
  }
  if (url.pathname === API_ROUTES.queue) {
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: { action?: string; id?: string; all?: boolean } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          action?: string;
          id?: string;
          all?: boolean;
        };
      } catch {
        return json(res, { error: "invalid json" }, 400);
      }
      const action = body.action ?? url.searchParams.get("action") ?? "";
      if (action === "pause") {
        pauseQueue(state);
        opts.saveState?.(opts.root, state);
        return json(res, { ok: true, action: "pause", paused: true });
      }
      if (action === "resume") {
        resumeQueue(state);
        opts.saveState?.(opts.root, state);
        return json(res, { ok: true, action: "resume", paused: false });
      }
      if (action === "retry") {
        const targets = body.all
          ? deadLetters(state).map((d) => d.id)
          : body.id
            ? [body.id]
            : [];
        if (!targets.length) {
          return json(res, { error: "need id or all=true for retry" }, 400);
        }
        let n = 0;
        for (const tid of targets) {
          if (requeueDead(state, tid)) n += 1;
        }
        opts.saveState?.(opts.root, state);
        return json(res, { ok: true, action: "retry", retried: n, ids: targets });
      }
      return json(res, { error: "action must be pause|resume|retry" }, 400);
    }
    const summary = queueSummary(state);
    return json(res, {
      summary,
      metrics: state.metrics,
      items: state.queue,
      deadLetters: deadLetters(state),
      paused: isQueuePaused(state),
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
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: { action?: string; name?: string; to?: string } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          action?: string;
          name?: string;
          to?: string;
        };
      } catch {
        return json(res, { error: "invalid json" }, 400);
      }
      const name = body.name?.trim();
      if (!name) return json(res, { error: "need name" }, 400);
      if (body.action === "promote") {
        const rec = promoteSkill(state, name);
        if (!rec) return json(res, { error: `skill not found: ${name}` }, 404);
        opts.saveState?.(opts.root, state);
        return json(res, { ok: true, action: "promote", skill: rec, catalog: skillsCatalog(state) });
      }
      if (body.action === "share") {
        if (!body.to) return json(res, { error: "need to for share" }, 400);
        const rec = shareSkill(state, name, body.to);
        if (!rec) return json(res, { error: `skill not found: ${name}` }, 404);
        opts.saveState?.(opts.root, state);
        return json(res, { ok: true, action: "share", skill: rec, catalog: skillsCatalog(state) });
      }
      return json(res, { error: "action must be promote|share" }, 400);
    }
    return json(res, {
      learned: state.skills ?? [],
      registry: state.skillRegistry ?? [],
      catalog: skillsCatalog(state),
    });
  }
  if (url.pathname === API_ROUTES.canary) {
    return json(res, canaryProgress(state));
  }
  if (url.pathname === API_ROUTES.trajectories) {
    const trajId = url.searchParams.get("id");
    if (trajId) {
      const traj = getTrajectory(state, trajId);
      if (!traj) return json(res, { error: `trajectory not found: ${trajId}` }, 404);
      return json(res, traj);
    }
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
  if (url.pathname === API_ROUTES.policySim) {
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: { prompts?: string[]; agents?: string[]; prompt?: string } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          prompts?: string[];
          agents?: string[];
          prompt?: string;
        };
      } catch {
        return json(res, { error: "invalid json" }, 400);
      }
      const prompts =
        body.prompts?.length
          ? body.prompts
          : body.prompt
            ? [body.prompt]
            : undefined;
      const report = simulatePolicies(state, {
        prompts,
        agents: body.agents,
      });
      return json(res, report);
    }
    return json(res, simulatePolicies(state));
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
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: { remote?: boolean; force?: boolean; dryRun?: boolean } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as typeof body;
      } catch {
        return json(res, { error: "invalid json" }, 400);
      }
      const results = cloneAllGitRepos(opts.root, state, {
        remote: body.remote,
        force: body.force,
        dryRun: body.dryRun,
      });
      opts.saveState?.(opts.root, state);
      return json(res, { ok: true, results, report: cloneStatusReport(state) });
    }
    return json(res, cloneStatusReport(state));
  }
  if (url.pathname === API_ROUTES.affinity) {
    pruneAffinity(state);
    return json(res, {
      active: state.affinity?.length ?? 0,
      bindings: state.affinity ?? [],
    });
  }
  if (url.pathname === API_ROUTES.ratelimits) {
    return json(res, rateLimitReport(state));
  }
  if (url.pathname === API_ROUTES.drain) {
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: { concurrency?: number; limit?: number } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          concurrency?: number;
          limit?: number;
        };
      } catch {
        return json(res, { error: "invalid json" }, 400);
      }
      if (body.concurrency !== undefined) {
        setDrainConcurrency(state, Number(body.concurrency));
      }
      const before = drainStatus(state);
      if (before.paused) {
        opts.saveState?.(opts.root, state);
        return json(res, { error: "queue paused — resume before drain", status: before }, 409);
      }
      const results = await drainQueue(state, {
        root: opts.root,
        concurrency: body.concurrency !== undefined ? Number(body.concurrency) : undefined,
        limit: body.limit !== undefined ? Number(body.limit) : undefined,
      });
      opts.saveState?.(opts.root, state);
      return json(res, {
        drained: results.length,
        status: drainStatus(state),
        results: results.map((r) => ({
          taskId: r.task.id,
          agent: r.worker.agent,
          workerId: r.worker.id,
          output: (r.output ?? "").slice(0, 160),
        })),
      });
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: { concurrency?: number } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { concurrency?: number };
      } catch {
        return json(res, { error: "invalid json" }, 400);
      }
      if (body.concurrency === undefined || !Number.isFinite(Number(body.concurrency))) {
        return json(res, { error: "need concurrency number" }, 400);
      }
      setDrainConcurrency(state, Number(body.concurrency));
      opts.saveState?.(opts.root, state);
      return json(res, drainStatus(state));
    }
    return json(res, drainStatus(state));
  }
  if (url.pathname === API_ROUTES.pipeline) {
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: SubmitPipelineOptions = { prompt: "" };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as SubmitPipelineOptions;
      } catch {
        return json(res, { error: "invalid json" }, 400);
      }
      if (body.action === "drain") {
        if (!body.pipelineId) return json(res, { error: "need pipelineId for drain action" }, 400);
        const result = await drainPipeline(state, body.pipelineId, {
          root: opts.root,
          concurrency: body.concurrency,
        });
        if (!result) return json(res, { error: `pipeline not found: ${body.pipelineId}` }, 404);
        opts.saveState?.(opts.root, state);
        return json(res, { ok: true, action: "drain", pipeline: result.pipeline, drained: result.drained });
      }
      if (!body.prompt?.trim()) return json(res, { error: "need prompt" }, 400);
      try {
        const result = await submitPipeline(state, { ...body, root: opts.root });
        opts.saveState?.(opts.root, state);
        return json(res, {
          ok: true,
          pipeline: result.pipeline,
          drained: result.drained,
        });
      } catch (err) {
        return json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    const id = url.searchParams.get("id");
    if (!id) {
      const rows = state.pipelines ?? [];
      return json(res, {
        total: rows.length,
        pipelines: rows
          .slice(-30)
          .reverse()
          .map((p) => ({
            id: p.id,
            status: p.status,
            prompt: p.prompt,
            stages: p.stages.length,
            updatedAt: p.updatedAt,
            output: p.output?.slice(0, 400),
          })),
      });
    }
    const pipeline = getPipeline(state, id);
    if (!pipeline) return json(res, { error: `pipeline not found: ${id}` }, 404);
    return json(res, pipeline);
  }
  if (url.pathname === API_ROUTES.events) {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("method not allowed");
      return;
    }
    const pipelineId = url.searchParams.get("pipelineId") ?? "*";
    const uiFormat = url.searchParams.get("format") === "ui";
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const write = (chunk: string) => {
      if (uiFormat) {
        try {
          const raw = chunk.trim().replace(/^data:\s*/, "");
          if (raw) {
            const event = JSON.parse(raw) as import("./executor.js").ExecutorEvent;
            const mapped = mapExecutorEventToUi(event);
            res.write(`data: ${JSON.stringify(mapped)}\n\n`);
            return;
          }
        } catch {
          /* fall through */
        }
      }
      res.write(chunk);
    };
    const unsub = subscribeExecutorEvents(
      pipelineId,
      write,
      () => {
        try {
          res.end();
        } catch {
          /* closed */
        }
      },
      state,
    );
    req.on("close", () => unsub());
    return;
  }
  if (url.pathname === API_ROUTES.hygiene) {
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: { action?: string } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { action?: string };
      } catch {
        return json(res, { error: "invalid json" }, 400);
      }
      const action = body.action ?? "all";
      if (action !== "reclaim" && action !== "gc" && action !== "age" && action !== "all") {
        return json(res, { error: "action must be reclaim|gc|age|all" }, 400);
      }
      try {
        const result = runHygiene(state, action, { root: opts.root });
        opts.saveState?.(opts.root, state);
        return json(res, {
          ok: true,
          action: result.action,
          reclaimed: result.reclaimed,
          aged: result.aged,
          gcRemoved: result.gc?.removed.length ?? 0,
          gcKept: result.gc?.kept.length ?? 0,
          report: result.report,
        });
      } catch (err) {
        return json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    return json(res, hygieneReport(state));
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
