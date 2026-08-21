#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyManifestText, loadState, planReconcile, saveState } from "./controller.js";
import { agentsForEvent, eventToTask, pickWorker } from "./github.js";
import { runTask } from "./runtime.js";
import { parseManifests } from "./spec.js";
import type { GithubEvent, ReconcilePlan } from "./types.js";

const HELP = `ropex — GitOps control plane for agent fleets

Usage:
  ropex apply <path>              Reconcile YAML (file or directory) into workers
  ropex diff <path>               Show create/retire without writing state
  ropex status                    List derived workers
  ropex run --agent <name> <task> Execute one task on a live worker
  ropex github simulate <event> --repo <org/name> [--title t]
  ropex scale <fleet> --replicas N
                                     Print YAML to commit (Git is source of truth)
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
      const { plan } = planReconcile(loadState(root), parseManifests(readManifests(source)), source);
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
      for (const w of state.workers.filter((x) => x.status !== "retired")) {
        const fleet = w.fleet ? ` fleet=${w.fleet}` : "";
        console.log(`  ${w.id}  ${w.status}  ${w.harness}  ${w.model}${fleet}`);
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
      const result = await runTask(state, worker, { id: `cli-${Date.now()}`, agent, prompt });
      saveState(root, state);
      console.log(result.output);
      if (result.delivery) console.log(`deliver ${result.delivery.kind}`);
      if (result.learned) console.log(`learned skill ${result.learned.name}`);
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
        const worker = pickWorker(state, agent.metadata.name);
        if (!worker) {
          console.log(`matched ${agent.metadata.name} but no worker`);
          continue;
        }
        worker.status = "running";
        const result = await runTask(state, worker, eventToTask(agent, event));
        console.log(`${agent.metadata.name}: ${result.output}`);
        if (result.delivery) console.log(`  -> ${result.delivery.kind}`);
      }
      saveState(root, state);
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
