#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyManifestText, loadState, planReconcile, saveState } from "./controller.js";
import { agentsForEvent, eventToTask, pickWorker } from "./github.js";
import { buildControlPlaneView, startControlPlaneServer } from "./api.js";
import { enqueueTask, queueSummary } from "./queue.js";
import { runTask } from "./runtime.js";
import { drainQueue } from "./scheduler.js";
import { parseManifests } from "./spec.js";
import { ingestGithubWebhook, signGithubPayload } from "./webhook.js";
import { parseInterval, watchLoop, watchOnce } from "./watch.js";
import type { GithubEvent, ReconcilePlan } from "./types.js";

const HELP = `ropex — GitOps control plane for agent fleets

Usage:
  ropex apply <path>              Reconcile YAML (file or directory) into workers
  ropex diff <path>               Show create/retire without writing state
  ropex status                    List derived workers
  ropex run --agent <name> <task> Execute one task on a live worker
  ropex github simulate <event> --repo <org/name> [--title t]
  ropex webhook simulate <event> --repo <org/name> [--title t] [--secret s]
  ropex queue                     Show work queue + metrics
  ropex drain [--limit N]         Claim idle workers and run pending queue
  ropex watch <path> [--once] [--interval 5s]
                                     Reconcile manifests on an interval (Flux-style)
  ropex scale <fleet> --replicas N
                                     Print YAML to commit (Git is source of truth)
  ropex memory                    Show shared memory stream
  ropex ui [--port N]             Serve control-plane UI + /api/v1/*
  ropex help
`;

async function main(argv: string[]): Promise<number> {
  const [cmd = "help", ...rest] = argv;
  const root = process.cwd();

  switch (cmd) {
    case "apply": {
      const path = rest[0];
      if (!path) return fail("apply requires a path");
      const source = resolve(root, path);
      const { plan } = applyManifestText(root, readManifests(source), source);
      printPlan(plan);
      console.log(`reconciled ${source}`);
      return 0;
    }
    case "diff": {
      const path = rest[0];
      if (!path) return fail("diff requires a path");
      const source = resolve(root, path);
      const { plan } = planReconcile(loadState(root), parseManifests(readManifests(source)), source, { root });
      printPlan(plan);
      return 0;
    }
    case "status": {
      const state = loadState(root);
      if (!state.workers.length) {
        console.log("no workers. run: ropex apply fleets/examples");
        return 0;
      }
      console.log(`revision ${state.revision}  source ${state.source}`);
      console.log(`workers ${liveCount(state.workers)} live / ${state.workers.length} known`);
      const q = queueSummary(state);
      console.log(`queue pending=${q.pending} claimed=${q.claimed} done=${q.done} failed=${q.failed}`);
      for (const w of state.workers.filter((x) => x.status !== "retired")) {
        const fleet = w.fleet ? ` fleet=${w.fleet}` : "";
        const wt = w.worktree ? ` worktree=${w.worktree}` : "";
        console.log(`  ${w.id}  ${w.status}  ${w.harness}  ${w.model}  image=${w.imageDigest}${fleet}${wt}`);
      }
      if (state.skills.length) {
        console.log("learned skills:");
        for (const s of state.skills) console.log(`  ${s.agent}: ${s.name}`);
      }
      return 0;
    }
    case "run": {
      const agent = flag(rest, "--agent");
      const prompt = positional(rest).join(" ");
      if (!agent || !prompt) return fail("run requires --agent <name> and a task");
      const state = loadState(root);
      const worker = pickWorker(state, agent);
      if (!worker) return fail(`no live worker for agent ${agent}`);
      worker.status = "running";
      const result = await runTask(state, worker, { id: `cli-${Date.now()}`, agent, prompt }, { root });
      saveState(root, state);
      console.log(result.output);
      if (result.delivery) console.log(`deliver ${result.delivery.kind}`);
      if (result.learned) console.log(`learned skill ${result.learned.name}`);
      console.log(`image ${result.imageDigest}  workflow ${result.workflow.map((s) => `${s.id}:${s.owner}`).join(" → ")}`);
      return 0;
    }
    case "github": {
      if (rest[0] !== "simulate") return fail("usage: ropex github simulate <event> --repo org/name");
      const eventType = rest[1];
      const repo = flag(rest, "--repo");
      const title = flag(rest, "--title") ?? "simulated event";
      if (!eventType || !repo) return fail("github simulate requires <event> and --repo");
      const state = loadState(root);
      const event: GithubEvent = { type: eventType, repo, title, number: 1 };
      const matched = agentsForEvent(state, event);
      if (!matched.length) {
        console.log(`no agents listen for ${eventType}`);
        return 1;
      }
      for (const agent of matched) {
        enqueueTask(state, eventToTask(agent, event), "github");
      }
      const results = await drainQueue(state, { root });
      for (const result of results) {
        console.log(`${result.worker.agent}: ${result.output}`);
        if (result.delivery) console.log(`  -> ${result.delivery.kind}`);
        console.log(`  image ${result.imageDigest}  worktree ${result.worktree ?? "-"}`);
      }
      if (!results.length) console.log("enqueued but no idle workers to claim");
      saveState(root, state);
      return 0;
    }
    case "webhook": {
      if (rest[0] !== "simulate") return fail("usage: ropex webhook simulate <event> --repo org/name");
      const eventType = rest[1];
      const repo = flag(rest, "--repo");
      const title = flag(rest, "--title") ?? "webhook event";
      const secret = flag(rest, "--secret") ?? "";
      if (!eventType || !repo) return fail("webhook simulate requires <event> and --repo");
      const [eventName, action] = eventType.includes(".")
        ? (eventType.split(".") as [string, string])
        : [eventType, "opened"];
      const payload = {
        action,
        repository: { full_name: repo },
        issue: { title, number: 1, body: "", labels: [] },
        pull_request: { title, number: 1, body: "", labels: [] },
      };
      const rawBody = JSON.stringify(payload);
      const state = loadState(root);
      const headers = {
        "x-github-event": eventName.startsWith("pull_request") ? "pull_request" : "issues",
        "x-github-delivery": `sim-${Date.now()}`,
        "x-hub-signature-256": secret ? signGithubPayload(secret, rawBody) : undefined,
      };
      const ingested = ingestGithubWebhook(state, rawBody, headers, secret);
      if (!ingested.ok) {
        console.error(ingested.reason ?? "ingest failed");
        return 1;
      }
      console.log(`enqueued ${ingested.enqueued.length}  event ${ingested.event?.type ?? "?"}`);
      const results = await drainQueue(state, { root });
      for (const r of results) console.log(`${r.worker.agent}: ${r.output}`);
      saveState(root, state);
      return 0;
    }
    case "queue": {
      const state = loadState(root);
      const q = queueSummary(state);
      console.log(`pending=${q.pending} claimed=${q.claimed} done=${q.done} failed=${q.failed}`);
      console.log(
        `metrics completed=${state.metrics.tasksCompleted} failed=${state.metrics.tasksFailed} enqueued=${state.metrics.tasksEnqueued}`,
      );
      for (const item of state.queue.slice(-20)) {
        console.log(`  [${item.status}] ${item.source} ${item.task.agent}  ${item.task.prompt}`);
      }
      return 0;
    }
    case "drain": {
      const state = loadState(root);
      const limit = Number(flag(rest, "--limit") ?? "32");
      const results = await drainQueue(state, { root, limit });
      saveState(root, state);
      console.log(`drained ${results.length}  remaining ${queueSummary(state).pending}`);
      for (const r of results) console.log(`  ${r.worker.id}: ${r.output}`);
      return 0;
    }
    case "watch": {
      const path = rest.find((a) => !a.startsWith("--")) ?? rest[0];
      if (!path) return fail("watch requires a path");
      const once = rest.includes("--once");
      const intervalRaw = flag(rest, "--interval") ?? "5s";
      const source = resolve(root, path);
      if (once) {
        const result = watchOnce(root, source);
        printPlan(result.plan);
        console.log(result.changed ? "drift reconciled" : "no create/retire drift");
        return 0;
      }
      const intervalMs = parseInterval(intervalRaw);
      console.log(`watching ${source} every ${intervalMs}ms  (ctrl-c to stop)`);
      await watchLoop({
        root,
        path: source,
        intervalMs,
        onTick: (result, tick) => {
          console.log(
            `#${tick} rev=${result.state.revision} create=${result.plan.create.length} retire=${result.plan.retire.length}${result.changed ? "  CHANGED" : ""}`,
          );
        },
      });
      return 0;
    }
    case "scale": {
      const name = rest[0];
      const n = Number(flag(rest, "--replicas"));
      if (!name || !Number.isFinite(n)) return fail("usage: ropex scale <fleet> --replicas N");
      const yaml = [
        "apiVersion: ropex.dev/v1",
        "kind: Fleet",
        "metadata:",
        `  name: ${name}`,
        "spec:",
        `  replicas: ${n}`,
        "# commit this to git — the controller derives workers from the repo",
      ].join("\n");
      console.log(yaml);
      return 0;
    }
    case "memory": {
      const state = loadState(root);
      const view = buildControlPlaneView(state);
      if (!view.memory.length) {
        console.log("no shared memory facts yet");
        return 0;
      }
      for (const m of view.memory) {
        console.log(`[${m.scope}] ${m.agent}${m.fleet ? `@${m.fleet}` : ""}  ${m.text}`);
      }
      return 0;
    }
    case "ui": {
      const port = Number(flag(rest, "--port") ?? "7780");
      const server = await startControlPlaneServer({
        root,
        port,
        loadState,
      });
      console.log(`ropex ui  http://127.0.0.1:${server.port}`);
      console.log(`api       http://127.0.0.1:${server.port}/api/v1/view`);
      await new Promise(() => {
        /* keep process alive until killed */
      });
      return 0;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      return fail(`unknown command: ${cmd}\n${HELP}`);
  }
}

function readManifests(path: string): string {
  const st = statSync(path);
  if (st.isFile()) return readFileSync(path, "utf8");
  const files = readdirSync(path)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  return files.map((f) => readFileSync(join(path, f), "utf8")).join("\n---\n");
}

function printPlan(plan: ReconcilePlan): void {
  console.log(`create ${plan.create.length}  update ${plan.update.length}  retire ${plan.retire.length}`);
  for (const c of plan.capped) {
    console.log(`capped ${c.agent}: requested ${c.requested} allowed ${c.allowed}`);
  }
}

function liveCount(workers: { status: string }[]): number {
  return workers.filter((w) => w.status !== "retired").length;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function fail(msg: string): number {
  console.error(msg);
  return 1;
}

const code = await main(process.argv.slice(2));
process.exit(code);
