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
import { metricsPrometheus, metricsSnapshot } from "./metrics.js";
import { ensureQueue, queueSummary } from "./queue.js";
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
    })),
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
      resolve({
        port,
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
    return json(res, { ok: true, brand: "ropex" });
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
    return json(res, {
      summary: queueSummary(state),
      metrics: state.metrics,
      items: state.queue,
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

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}
