#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyManifestText, loadState, planReconcile, saveState } from "./controller.js";
import { writeSnapshot, restoreSnapshot } from "./snapshot.js";
import { detectDrift, formatDriftReport } from "./drift.js";
import { fairnessReport, formatFairnessReport } from "./fairness.js";
import { canaryProgress } from "./canary.js";
import { deliverOutbound, outboundFor } from "./deliver.js";
import { cordonWorker, uncordonWorker, evictWorker, cordonedWorkers } from "./lifecycle.js";
import { agentsForEvent, eventToTask, pickWorker } from "./github.js";
import { buildControlPlaneView, startControlPlaneServer } from "./api.js";
import { enqueueTask, queueSummary, deadLetters, requeueDead, reclaimExpiredLeases, ageQueuePriorities, pauseQueue, resumeQueue, isQueuePaused } from "./queue.js";
import { gcOrphanWorktrees } from "./worktree.js";
import { promoteMemoryFact } from "./memory.js";
import { compactJournal } from "./journal.js";
import { runTask } from "./runtime.js";
import { drainQueue, setDrainConcurrency, getDrainConcurrency } from "./scheduler.js";
import { submitPipeline } from "./executor.js";
import { hygieneReport, runHygiene } from "./hygiene.js";
import { budgetReport } from "./budget.js";
import { planAutoscale } from "./autoscale.js";
import { controlPlaneTick } from "./tick.js";
import { cloneAllGitRepos } from "./clone.js";
import { simulatePolicies } from "./policy-sim.js";
import { healthReport } from "./health.js";
import { auditsFor, exportAuditJsonl } from "./audit.js";
import { metricsPrometheus, metricsSnapshot } from "./metrics.js";
import { deliveriesFor, replayDelivery } from "./journal.js";
import { shareSkill, promoteSkill, skillVersions } from "./skills.js";
import { fanOutTask } from "./fanout.js";
import { syncGitRepos, syncDueGitRepos, syncMultiRepo } from "./gitrepo.js";
import {
  readTaskManifest,
  syncTasksFromDir,
  syncTasksFromGitRepos,
  taskFromManifest,
} from "./tasks.js";
import {
  exportMemoryFactToGit,
  exportMemoryFacts,
  syncMemoryFromDir,
  syncMemoryFromGitRepos,
} from "./gitmemory.js";
import { runSandboxDemo } from "./demo.js";
import { exportTrajectoriesJsonl, trajectoriesFor, learnFromTrajectory } from "./trajectory.js";
import { rateLimitReport } from "./ratelimit.js";
import { decideApproval, pendingApprovals } from "./approval.js";
import { policyDryRun } from "./policy.js";
import { runReconcileChaos, assertChaosInvariants } from "./chaos.js";
import { parseManifests } from "./spec.js";
import { ingestGithubWebhook, signGithubPayload } from "./webhook.js";
import { parseInterval, watchLoop, watchOnce, watchDeclaredRepos, watchReposLoop } from "./watch.js";
import type { AuditKind, GithubEvent, ReconcilePlan } from "./types.js";

const HELP = `ropex — GitOps control plane for agent fleets

Usage:
  ropex apply <path> [--canary] [--canary-count N]
                                     Reconcile YAML (file or directory) into workers
  ropex diff <path> [--canary]        Show create/retire without writing state
  ropex drift [path]              Report live vs desired config drift
  ropex fairness                  Queue latency + LRU fairness report
  ropex canary                    Digest coverage vs desired images
  ropex snapshot                  Export cluster state checkpoint
  ropex restore <path>            Restore cluster state from a snapshot file
  ropex cordon <worker-id>        Stop scheduling onto a worker
  ropex uncordon <worker-id>      Allow scheduling again
  ropex evict <worker-id>         Retire idle worker (or cordon if running)
  ropex deliver <delivery-id> [--stub]  Outbound webhook stub for a journal entry
  ropex status                    List derived workers
  ropex run --agent <name> <task> Execute one task on a live worker
  ropex github simulate <event> --repo <org/name> [--title t]
  ropex webhook simulate <event> --repo <org/name> [--title t] [--secret s]
  ropex queue                     Show work queue + metrics
  ropex retry <id>|--all          Re-queue dead-letter item(s)
  ropex reclaim                   Reclaim expired claim leases
  ropex age                       Boost pending priorities by wait age
  ropex hygiene [reclaim|gc|age|all]
                                     Run hygiene hooks (default all)
  ropex pause                     Stop claiming new queue work
  ropex resume                    Allow claims again
  ropex compact [--keep N]        Soft-cap delivery journal
  ropex gc                        Remove orphan worker worktrees
  ropex drain [--limit N] [--concurrency N]
                                     Claim idle workers; --concurrency persists preference
  ropex pipeline <prompt> [--no-drain] [--concurrency N]
                                     Run multi-stage pipeline (executor API)
  ropex sync [--due]                  Sync declared GitRepos (multi-repo union)
  ropex replay <delivery-id>          Replay a delivery into the journal
  ropex demo [--root path]            End-to-end sandbox demo (no network)
  ropex trajectories [--agent a] [--jsonl]
  ropex ratelimits                Show active webhook rate-limit buckets
  ropex approvals                 List pending approval requests
  ropex approve <id>              Approve a gated tool (re-enqueue task)
  ropex reject <id>               Reject a gated tool
  ropex learn <trajectory-id>     Distill a skill from a stored trajectory
  ropex policy dry-run --agent <name> <prompt>
  ropex policy simulate           Fleet-wide policy dry-run report
  ropex enqueue --agent <name> [--priority N] <prompt>
  ropex tasks sync [path] [--repos]   Enqueue pending Task YAML from git
  ropex tasks apply <task.yaml>       Enqueue one Task manifest file
  ropex chaos [--replicas N]          Stress reconcile scale + digest rolls
  ropex watch <path> [--once] [--interval 5s]
  ropex watch --repos [--once] [--interval 30s] [--remote] [--force]
                                     Clone + sync declared GitRepos (Flux-style)
  ropex metrics [--prometheus]    Export cluster metrics
  ropex health                    Worker probes + backlog SLO
  ropex audit [--kind k] [--jsonl]  Control-plane event trail
  ropex journal                   Show delivery journal
  ropex skills [share <name> --to <agent>]
                                     List registry; share one skill to an agent
  ropex skills promote <name>         Share latest skill with all desired agents
  ropex skills versions <name>        List registered versions of a skill
  ropex fanout --agent <name> <prompt>
                                     Shard a task across idle replicas
  ropex scale <fleet> --replicas N
                                     Print YAML to commit (Git is source of truth)
  ropex autoscale                 Recommend replica YAML from backlog SLO
  ropex tick [--concurrency N] [--gc] [--age] [--clone] [--compact N]
                                     Control-plane heartbeat + optional hooks
  ropex clone [--force] [--dry-run] [--remote]   Prepare GitRepo checkouts (file:// / git remote)
  ropex budget                    Show task-unit budget spend
  ropex memory [promote <id> --scope fleet|cluster|agent [--no-export]]
                  | sync [path] [--repos]
                  | export <id>|--all [--force] [--path dir]
                                     Show shared memory; promote a fact wider
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
      const canary = rest.includes("--canary");
      const canaryCount = Number(flag(rest, "--canary-count") ?? "1");
      const { plan, canaryHeld } = applyManifestText(root, readManifests(source), source, {
        rollout: canary ? { strategy: "canary", canaryCount } : undefined,
      });
      printPlan(plan);
      if (canary) console.log(`canary held=${canaryHeld} (re-apply to continue rollout)`);
      console.log(`reconciled ${source}`);
      return 0;
    }
    case "diff": {
      const path = rest[0];
      if (!path) return fail("diff requires a path");
      const source = resolve(root, path);
      const canary = rest.includes("--canary");
      const canaryCount = Number(flag(rest, "--canary-count") ?? "1");
      const { plan, canaryHeld } = planReconcile(
        loadState(root),
        parseManifests(readManifests(source)),
        source,
        { root, rollout: canary ? { strategy: "canary", canaryCount } : undefined },
      );
      printPlan(plan);
      if (canary) console.log(`canary held=${canaryHeld}`);
      return 0;
    }
    case "snapshot": {
      const state = loadState(root);
      const out = writeSnapshot(root, state);
      console.log(`snapshot ${out.path}  rev=${out.meta.revision} live=${out.meta.workersLive}`);
      return 0;
    }
    case "restore": {
      const path = rest[0];
      if (!path) return fail("usage: ropex restore <snapshot-path>");
      const doc = restoreSnapshot(root, path, { save: saveState });
      console.log(
        `restored ${path}  rev=${doc.meta.revision} live=${doc.meta.workersLive} pending=${doc.meta.queuePending}`,
      );
      return 0;
    }
    case "drift": {
      const state = loadState(root);
      const path = rest[0];
      const report = path
        ? detectDrift(state, {
            manifests: parseManifests(readManifests(resolve(root, path))),
            root,
          })
        : detectDrift(state, { root });
      console.log(formatDriftReport(report));
      return report.ok ? 0 : 1;
    }
    case "fairness": {
      const state = loadState(root);
      console.log(formatFairnessReport(fairnessReport(state)));
      return 0;
    }
    case "canary": {
      const state = loadState(root);
      const c = canaryProgress(state);
      console.log(
        `canary  matched=${c.matched}/${c.total} (${c.pctMatched}%)  mismatched=${c.mismatched}  ${c.ok ? "ok" : "rolling"}`,
      );
      for (const a of c.agents) {
        console.log(
          `  ${a.agent}  ${a.pctMatched}%  ok=${a.matched} hold=${a.mismatched}  digest=${a.desiredDigest.slice(0, 12)}`,
        );
      }
      return c.ok ? 0 : 1;
    }
    case "cordon": {
      const id = rest[0];
      if (!id) return fail("usage: ropex cordon <worker-id>");
      const state = loadState(root);
      const w = cordonWorker(state, id);
      if (!w) return fail(`worker not found: ${id}`);
      saveState(root, state);
      console.log(`cordoned ${w.id}`);
      return 0;
    }
    case "uncordon": {
      const id = rest[0];
      if (!id) return fail("usage: ropex uncordon <worker-id>");
      const state = loadState(root);
      const w = uncordonWorker(state, id);
      if (!w) return fail(`worker not found: ${id}`);
      saveState(root, state);
      console.log(`uncordoned ${w.id}`);
      return 0;
    }
    case "evict": {
      const id = rest[0];
      if (!id) return fail("usage: ropex evict <worker-id>");
      const state = loadState(root);
      const result = evictWorker(state, id);
      if (result.status === "missing") return fail(result.reason);
      saveState(root, state);
      console.log(`${result.status} ${id}  ${result.reason}`);
      return 0;
    }
    case "deliver": {
      const id = rest[0];
      if (!id) return fail("usage: ropex deliver <delivery-id> [--stub] [--url u]");
      const state = loadState(root);
      const rec = state.deliveries?.find((d) => d.id === id);
      if (!rec) return fail(`delivery not found: ${id}`);
      const out = deliverOutbound(state, rec, {
        url: flag(rest, "--url") ?? undefined,
        secret: flag(rest, "--secret") ?? undefined,
        mode: rest.includes("--stub") ? "stub" : "live",
      });
      saveState(root, state);
      console.log(`${out.status} ${out.id}  ${out.url}${out.reason ? `  ${out.reason}` : ""}`);
      return out.status === "simulated" ? 0 : 1;
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
      console.log(
        `queue pending=${q.pending} claimed=${q.claimed} done=${q.done} failed=${q.failed} dead=${q.dead}`,
      );
      for (const w of state.workers.filter((x) => x.status !== "retired")) {
        const fleet = w.fleet ? ` fleet=${w.fleet}` : "";
        const wt = w.worktree ? ` worktree=${w.worktree}` : "";
        const dig = w.imageDigest ? ` digest=${w.imageDigest.slice(0, 8)}` : "";
        const cord = w.cordoned ? " CORDONED" : "";
        console.log(`  ${w.id}  ${w.status}${cord}  ${w.harness}  ${w.model}${dig}${fleet}${wt}`);
      }
      const cordoned = cordonedWorkers(state);
      if (cordoned.length) console.log(`cordoned ${cordoned.length}`);
      const outs = outboundFor(state, { limit: 3 });
      if (outs.length) {
        console.log("recent outbound:");
        for (const o of outs) console.log(`  [${o.status}] ${o.url}`);
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
      console.log(
        `pending=${q.pending} claimed=${q.claimed} done=${q.done} failed=${q.failed} dead=${q.dead} waitingRetry=${q.waitingRetry} leaseExpired=${q.leaseExpired}`,
      );
      console.log(
        `metrics completed=${state.metrics.tasksCompleted} failed=${state.metrics.tasksFailed} retried=${state.metrics.tasksRetried ?? 0} dead=${state.metrics.tasksDead ?? 0} leasesReclaimed=${state.metrics.leasesReclaimed ?? 0} enqueued=${state.metrics.tasksEnqueued}`,
      );
      for (const item of state.queue.slice(-20)) {
        const retry = item.nextRetryAt ? ` retry@${item.nextRetryAt}` : "";
        const lease = item.leaseExpiresAt ? ` lease@${item.leaseExpiresAt}` : "";
        console.log(
          `  [${item.status}] a${item.attempts} ${item.source} ${item.task.agent}  ${item.task.prompt}${retry}${lease}${item.error ? `  err=${item.error}` : ""}`,
        );
      }
      return 0;
    }
    case "retry": {
      const state = loadState(root);
      const all = rest.includes("--all");
      const id = rest.find((a) => a !== "--all");
      if (!all && !id) return fail("usage: ropex retry <id> | ropex retry --all");
      const targets = all ? deadLetters(state).map((d) => d.id) : [id!];
      if (!targets.length) {
        console.log("no dead-letter items");
        return 0;
      }
      let n = 0;
      for (const tid of targets) {
        if (requeueDead(state, tid)) n += 1;
      }
      saveState(root, state);
      console.log(`requeued ${n} dead-letter item(s)`);
      return n ? 0 : 1;
    }
    case "reclaim": {
      const state = loadState(root);
      const { reclaimed } = reclaimExpiredLeases(state);
      saveState(root, state);
      console.log(`reclaimed ${reclaimed.length} expired lease(s)`);
      for (const item of reclaimed) {
        console.log(`  [${item.status}] ${item.id}  ${item.error ?? ""}`);
      }
      return 0;
    }
    case "age": {
      const state = loadState(root);
      const bumped = ageQueuePriorities(state);
      saveState(root, state);
      console.log(`aged ${bumped} pending task(s)`);
      return 0;
    }
    case "hygiene": {
      const state = loadState(root);
      const actionRaw = rest[0] ?? "all";
      const action =
        actionRaw === "reclaim" || actionRaw === "gc" || actionRaw === "age" || actionRaw === "all"
          ? actionRaw
          : null;
      if (!action) return fail("usage: ropex hygiene [reclaim|gc|age|all]");
      if (rest.includes("--report")) {
        const report = hygieneReport(state);
        console.log(
          `pool=${report.pool.length} pending=${report.summary.pending} dead=${report.summary.dead} webhookSeen=${report.webhook.seen}/${report.webhook.cap} dupes=${report.webhook.duplicates}`,
        );
        for (const cell of report.pool) {
          console.log(
            `  ${cell.agent}  idle=${cell.idle} run=${cell.running} fail=${cell.failed} cordon=${cell.cordoned}`,
          );
        }
        return 0;
      }
      const result = runHygiene(state, action, { root });
      saveState(root, state);
      console.log(
        `hygiene ${result.action}  reclaimed=${result.reclaimed} aged=${result.aged} gcRemoved=${result.gc?.removed.length ?? 0}`,
      );
      return 0;
    }
    case "pause": {
      const state = loadState(root);
      pauseQueue(state);
      saveState(root, state);
      console.log("queue paused");
      return 0;
    }
    case "resume": {
      const state = loadState(root);
      resumeQueue(state);
      saveState(root, state);
      console.log("queue resumed");
      return 0;
    }
    case "compact": {
      const state = loadState(root);
      const keep = Number(flag(rest, "--keep") ?? "500");
      const result = compactJournal(state, { keep });
      saveState(root, state);
      console.log(`compact journal ${result.before}→${result.after} removed=${result.removed}`);
      return 0;
    }
    case "gc": {
      const state = loadState(root);
      const result = gcOrphanWorktrees(root, state);
      console.log(
        `gc worktrees kept=${result.kept.length} removed=${result.removed.length} root=${result.root}`,
      );
      for (const id of result.removed) console.log(`  removed ${id}`);
      return 0;
    }
    case "drain": {
      const state = loadState(root);
      const limit = Number(flag(rest, "--limit") ?? "32");
      const concurrencyFlag = flag(rest, "--concurrency");
      if (concurrencyFlag !== undefined) {
        setDrainConcurrency(state, Number(concurrencyFlag));
      }
      const concurrency = getDrainConcurrency(state);
      const results = await drainQueue(state, { root, limit, concurrency });
      saveState(root, state);
      console.log(
        `drained ${results.length}  concurrency=${concurrency}  remaining ${queueSummary(state).pending}`,
      );
      for (const r of results) console.log(`  ${r.worker.id}: ${r.output}`);
      return 0;
    }
    case "pipeline": {
      const prompt = rest.filter((a) => !a.startsWith("--")).join(" ").trim();
      if (!prompt) return fail("pipeline requires a prompt");
      const state = loadState(root);
      const drain = !rest.includes("--no-drain");
      const concurrency = flag(rest, "--concurrency");
      const result = await submitPipeline(state, {
        prompt,
        root,
        drain,
        concurrency: concurrency !== undefined ? Number(concurrency) : undefined,
      });
      saveState(root, state);
      console.log(
        `pipeline ${result.pipeline.id}  status=${result.pipeline.status}  stages=${result.pipeline.stages.length}${result.drained !== undefined ? `  drained=${result.drained}` : ""}`,
      );
      for (const s of result.pipeline.stages) {
        console.log(`  ${s.id}→${s.agent}  ${s.status}${s.output ? `: ${s.output.slice(0, 120)}` : ""}`);
      }
      if (result.pipeline.output) console.log(`\n${result.pipeline.output.slice(0, 2000)}`);
      return result.pipeline.status === "failed" ? 1 : 0;
    }
    case "sync": {
      const state = loadState(root);
      if (!state.gitRepos.length) {
        console.log("no GitRepo manifests in state — apply fleets first");
        return 0;
      }
      const dueOnly = rest.includes("--due");
      const bundle = dueOnly ? syncDueGitRepos(root, state) : syncMultiRepo(root, state);
      if (bundle.skippedDue) {
        console.log("no GitRepos due (interval not elapsed)");
        return 0;
      }
      for (const r of bundle.results) {
        if (r.ok && r.included !== false) {
          console.log(
            `ok ${r.repo}  path=${r.path}  create=${bundle.plan?.create.length ?? 0} retire=${bundle.plan?.retire.length ?? 0}`,
          );
        } else if (r.ok) {
          console.log(`skip ${r.repo}  ${r.reason ?? "not included"}`);
        } else {
          console.log(`skip ${r.repo}  ${r.reason}`);
        }
      }
      console.log(
        `multi-repo synced=${bundle.synced} changed=${bundle.changed} repos=${bundle.results.length}`,
      );
      return 0;
    }
    case "replay": {
      const id = rest[0];
      if (!id) return fail("usage: ropex replay <delivery-id>");
      const state = loadState(root);
      const replayed = replayDelivery(state, id);
      if (!replayed) return fail(`delivery not found: ${id}`);
      saveState(root, state);
      console.log(`replayed ${replayed.id}  kind=${replayed.kind}`);
      return 0;
    }
    case "demo": {
      const demoRoot = flag(rest, "--root") ?? join(root, "sandbox", "demo");
      const concurrency = Number(flag(rest, "--concurrency") ?? "2");
      const result = await runSandboxDemo(demoRoot, { concurrency });
      for (const s of result.steps) console.log(`  ${s}`);
      console.log(
        `demo complete  workers=${result.workers} drained=${result.drained} deliveries=${result.deliveries}`,
      );
      console.log(`root ${result.root}`);
      return 0;
    }
    case "trajectories": {
      const state = loadState(root);
      const agent = flag(rest, "--agent");
      if (rest.includes("--jsonl")) {
        process.stdout.write(exportTrajectoriesJsonl(state, { agent, limit: 200 }) + "\n");
        return 0;
      }
      const rows = trajectoriesFor(state, { agent, limit: 20 });
      if (!rows.length) {
        console.log("no trajectories yet");
        return 0;
      }
      for (const t of rows) {
        console.log(
          `${t.id}  ${t.agent}@${t.workerId}  steps=${t.steps.length}  ${t.output.slice(0, 60)}`,
        );
      }
      return 0;
    }
    case "ratelimits": {
      const state = loadState(root);
      const report = rateLimitReport(state);
      console.log(
        `rate limits  limit=${report.limit}  windowMs=${report.windowMs}  buckets=${report.buckets}  near=${report.nearLimit}`,
      );
      if (!report.rows.length) {
        console.log("no active buckets");
        return 0;
      }
      for (const row of report.rows) {
        console.log(
          `${row.saturated ? "[sat]" : "[ok ]"} ${row.key}  count=${row.count}  rem=${row.remaining}  since=${row.windowStartedAt}`,
        );
      }
      return report.rows.some((r) => r.saturated) ? 1 : 0;
    }
    case "approvals": {
      const state = loadState(root);
      const pending = pendingApprovals(state);
      if (!pending.length) {
        console.log("no pending approvals");
        return 0;
      }
      for (const a of pending) {
        console.log(`[pending] ${a.id}  tool=${a.tool}  agent=${a.agent}  task=${a.taskId}`);
        console.log(`  ${a.reason}`);
      }
      return 0;
    }
    case "approve":
    case "reject": {
      const id = rest[0];
      if (!id) return fail(`usage: ropex ${cmd} <approval-id>`);
      const state = loadState(root);
      const decided = decideApproval(state, id, cmd === "approve" ? "approved" : "rejected");
      if (!decided) return fail(`approval not found or not pending: ${id}`);
      if (cmd === "approve") {
        const task = state.queue.find((q) => q.id === decided.taskId)?.task ?? {
          id: `${decided.taskId}-retry`,
          agent: decided.agent,
          prompt: `retry after approval of ${decided.tool}`,
        };
        enqueueTask(state, { ...task, id: `${decided.taskId}-after-approve` }, "cli");
        console.log(`approved ${decided.tool}; re-enqueued ${decided.taskId}-after-approve`);
      } else {
        console.log(`rejected ${decided.tool}`);
      }
      saveState(root, state);
      return 0;
    }
    case "learn": {
      const id = rest[0];
      if (!id) return fail("usage: ropex learn <trajectory-id>");
      const state = loadState(root);
      const result = learnFromTrajectory(state, id);
      if (result.reason) return fail(result.reason);
      saveState(root, state);
      console.log(`learned ${result.learned?.name}  registry v${result.skill?.version}`);
      return 0;
    }
    case "policy": {
      if (rest[0] === "simulate") {
        const state = loadState(root);
        const report = simulatePolicies(state);
        console.log(
          `agents=${report.rows.length} deniedTasks=${report.deniedTasks} deniedCalls=${report.deniedCalls} approval=${report.approvalCalls}`,
        );
        for (const row of report.rows) {
          const flags = [
            row.taskDenied ? "TASK_DENY" : null,
            row.callsDenied.length ? `deny:${row.callsDenied.join(",")}` : null,
            row.callsNeedApproval.length ? `approval:${row.callsNeedApproval.join(",")}` : null,
          ]
            .filter(Boolean)
            .join(" ");
          console.log(`  ${row.agent}  ${flags || "ok"}  ${row.prompt}`);
        }
        return 0;
      }
      if (rest[0] !== "dry-run") return fail("usage: ropex policy dry-run|simulate …");
      const agent = flag(rest, "--agent");
      const prompt = positional(rest.slice(1)).join(" ");
      if (!agent || !prompt) return fail("policy dry-run requires --agent and a prompt");
      const state = loadState(root);
      const report = policyDryRun(state, { id: `dry-${Date.now()}`, agent, prompt });
      console.log(`task admission: ${report.taskAdmission.status}`);
      if (report.taskAdmission.status !== "allow") console.log(`  ${report.taskAdmission.reason}`);
      console.log(`deny=[${report.permissions.deny.join(",")}] approval=[${report.permissions.requireApproval.join(",")}]`);
      console.log(`planned: ${report.plannedCalls.map((c) => c.name).join(" → ") || "(none)"}`);
      console.log(
        `calls allow=${report.callAdmission.allowed.length} deny=${report.callAdmission.denied.length} approval=${report.callAdmission.needsApproval.length}`,
      );
      for (const d of report.callAdmission.denied) console.log(`  deny ${d.name}: ${d.reason}`);
      for (const a of report.callAdmission.needsApproval) console.log(`  approval ${a.name}: ${a.reason}`);
      return 0;
    }
    case "tasks": {
      const state = loadState(root);
      const sub = rest[0];
      if (sub === "apply") {
        const file = rest[1];
        if (!file) return fail("usage: ropex tasks apply <task.yaml>");
        const m = readTaskManifest(resolve(root, file));
        if ((m.spec.status ?? "pending") !== "pending") {
          return fail(`task ${m.metadata.name} is not pending (status=${m.spec.status})`);
        }
        const path = resolve(root, file);
        const task = taskFromManifest(m, path);
        const item = enqueueTask(state, task, "git", { priority: m.spec.priority });
        saveState(root, state);
        console.log(`enqueued ${item.id} from ${path}  status=${item.status}`);
        return 0;
      }
      if (sub === "sync" || !sub) {
        const fromRepos = rest.includes("--repos");
        const pathFlag = flag(rest, "--path");
        const dirArg = rest.find((x) => !x.startsWith("--") && x !== "sync");
        const result = fromRepos
          ? syncTasksFromGitRepos(state, root)
          : syncTasksFromDir(state, root, pathFlag ?? dirArg);
        saveState(root, state);
        console.log(
          `tasks sync  scanned=${result.scanned} enqueued=${result.enqueued.length} skipped=${result.skipped.length} errors=${result.errors.length}`,
        );
        for (const id of result.enqueued) console.log(`  + ${id}`);
        for (const e of result.errors) console.log(`  ! ${e.path}: ${e.error}`);
        return result.errors.length ? 1 : 0;
      }
      return fail("usage: ropex tasks sync [path] [--repos] | ropex tasks apply <file>");
    }
    case "enqueue": {
      const agent = flag(rest, "--agent");
      const priority = Number(flag(rest, "--priority") ?? "0");
      const prompt = positional(rest).join(" ");
      if (!agent || !prompt) return fail("enqueue requires --agent and a prompt");
      const state = loadState(root);
      const item = enqueueTask(
        state,
        { id: `enq-${Date.now()}`, agent, prompt },
        "cli",
        { priority },
      );
      saveState(root, state);
      console.log(`enqueued ${item.id}  priority=${item.priority}  status=${item.status}`);
      return 0;
    }
    case "chaos": {
      const maxReplicas = Number(flag(rest, "--replicas") ?? "8");
      const { steps, final } = runReconcileChaos(root, { maxReplicas });
      for (const s of steps) {
        console.log(
          `${s.name}  live=${s.live} retired=${s.retired}  create=${s.plan.create.length} retire=${s.plan.retire.length}`,
        );
      }
      const errors = assertChaosInvariants(final);
      if (errors.length) {
        for (const e of errors) console.error(`invariant: ${e}`);
        return 1;
      }
      console.log(`chaos ok  revision=${final.revision}  workers=${final.workers.length}`);
      return 0;
    }
    case "watch": {
      const reposMode = rest.includes("--repos");
      const once = rest.includes("--once");
      const intervalRaw = flag(rest, "--interval") ?? (reposMode ? "30s" : "5s");
      const remote = rest.includes("--remote");
      const force = rest.includes("--force");

      if (reposMode) {
        const state = loadState(root);
        if (!(state.gitRepos ?? []).length) {
          return fail("watch --repos requires GitRepo manifests in cluster state — apply fleets first");
        }
        if (once) {
          const result = watchDeclaredRepos(root, state, { remote, force });
          if (result.plan) printPlan(result.plan);
          console.log(
            result.changed
              ? `repos synced ${result.source}`
              : `no drift (${result.source || "gitrepos"})`,
          );
          return 0;
        }
        const intervalMs = parseInterval(intervalRaw);
        console.log(`watching declared GitRepos every ${intervalMs}ms  (ctrl-c to stop)`);
        await watchReposLoop({
          root,
          intervalMs,
          remote,
          force,
          onTick: (result, tick) => {
            const p = result.plan;
            console.log(
              `#${tick} rev=${result.state.revision} create=${p.create.length} retire=${p.retire.length}${result.changed ? "  CHANGED" : ""}`,
            );
          },
        });
        return 0;
      }

      const path = rest.find((a) => !a.startsWith("--")) ?? rest[0];
      if (!path) return fail("watch requires a path (or --repos)");
      const pathOnce = rest.includes("--once");
      const pathIntervalRaw = flag(rest, "--interval") ?? "5s";
      const source = resolve(root, path);
      if (pathOnce) {
        const result = watchOnce(root, source);
        printPlan(result.plan);
        console.log(result.changed ? "drift reconciled" : "no create/retire drift");
        return 0;
      }
      const intervalMs = parseInterval(pathIntervalRaw);
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
    case "metrics": {
      const state = loadState(root);
      if (rest.includes("--prometheus")) {
        process.stdout.write(metricsPrometheus(state));
        return 0;
      }
      console.log(JSON.stringify(metricsSnapshot(state), null, 2));
      return 0;
    }
    case "health": {
      const state = loadState(root);
      const report = healthReport(state);
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    case "audit": {
      const state = loadState(root);
      const kind = flag(rest, "--kind") as AuditKind | undefined;
      if (rest.includes("--jsonl")) {
        process.stdout.write(exportAuditJsonl(state, { kind, limit: 500 }));
        return 0;
      }
      const rows = auditsFor(state, { kind, limit: 40 });
      if (!rows.length) {
        console.log("no audit events yet");
        return 0;
      }
      for (const e of rows) {
        console.log(
          `[${e.kind}] ${e.at}  ${e.agent ?? "-"}  ${e.taskId ?? "-"}  ${e.message}`,
        );
      }
      return 0;
    }
    case "journal": {
      const state = loadState(root);
      const rows = deliveriesFor(state, { limit: 30 });
      if (!rows.length) {
        console.log("no deliveries yet");
        return 0;
      }
      for (const d of rows) {
        console.log(`[${d.kind}] ${d.agent} ${d.repo ?? "-"}#${d.number ?? "-"}  ${d.body.slice(0, 80)}`);
      }
      return 0;
    }
    case "skills": {
      const state = loadState(root);
      if (rest[0] === "share") {
        const name = rest[1];
        const to = flag(rest, "--to");
        if (!name || !to) return fail("usage: ropex skills share <name> --to <agent>");
        const rec = shareSkill(state, name, to);
        if (!rec) return fail(`skill not found: ${name}`);
        saveState(root, state);
        console.log(`shared ${rec.name}@v${rec.version} → ${to}`);
        return 0;
      }
      if (rest[0] === "promote") {
        const name = rest[1];
        if (!name) return fail("usage: ropex skills promote <name>");
        const rec = promoteSkill(state, name);
        if (!rec) return fail(`skill not found: ${name}`);
        saveState(root, state);
        console.log(
          `promoted ${rec.name}@v${rec.version} → [${rec.sharedWith.join(",") || "none"}]`,
        );
        return 0;
      }
      if (rest[0] === "versions") {
        const name = rest[1];
        if (!name) return fail("usage: ropex skills versions <name>");
        const rows = skillVersions(state, name);
        if (!rows.length) return fail(`skill not found: ${name}`);
        for (const s of rows) {
          console.log(
            `${s.name}@v${s.version} origin=${s.originAgent} shared=[${s.sharedWith.join(",")}] ${s.at}`,
          );
        }
        return 0;
      }
      console.log(`registry ${state.skillRegistry?.length ?? 0}  learned ${state.skills.length}`);
      for (const s of state.skillRegistry ?? []) {
        console.log(
          `  ${s.name}@v${s.version} origin=${s.originAgent} shared=[${s.sharedWith.join(",")}]`,
        );
      }
      return 0;
    }
    case "fanout": {
      const agent = flag(rest, "--agent");
      const prompt = positional(rest).join(" ");
      if (!agent || !prompt) return fail("fanout requires --agent <name> and a prompt");
      const state = loadState(root);
      const plan = fanOutTask(state, {
        id: `fanout-${Date.now()}`,
        agent,
        prompt: /fan|shard|parallel/i.test(prompt) ? prompt : `${prompt} fan-out:3`,
      });
      console.log(`sharded ${plan.shards.length} from ${plan.parentId}`);
      const results = await drainQueue(state, { root });
      saveState(root, state);
      for (const r of results) console.log(`  ${r.worker.id}: ${r.output}`);
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
    case "autoscale": {
      const state = loadState(root);
      const plan = planAutoscale(state, { audit: true });
      saveState(root, state);
      if (!plan.recommendations.length) {
        console.log(
          `no scale changes  backlogBreached=${plan.backlogBreached} policyCap=${plan.policyCap}`,
        );
        return 0;
      }
      for (const r of plan.recommendations) {
        console.log(
          `${r.kind}/${r.name}  ${r.currentReplicas}→${r.recommendedReplicas}  pending=${r.pending} idle=${r.idle}  ${r.reason}`,
        );
      }
      console.log("---");
      process.stdout.write(plan.yaml);
      return 0;
    }
    case "tick": {
      const state = loadState(root);
      const concurrency = Number(flag(rest, "--concurrency") ?? "2");
      const limit = Number(flag(rest, "--limit") ?? "32");
      const compactN = flag(rest, "--compact");
      const result = await controlPlaneTick(root, state, {
        concurrency,
        limit,
        gc: rest.includes("--gc"),
        age: rest.includes("--age"),
        clone: rest.includes("--clone"),
        compactJournalKeep: compactN !== undefined ? Number(compactN) : undefined,
      });
      console.log(
        `tick reclaim=${result.reclaimed.length} drain=${result.drained.length} sync=${result.sync?.synced ? "yes" : result.sync?.skippedDue ? "due-skip" : "n/a"} autoscale=${result.autoscale?.recommendations.length ?? 0}${result.paused ? " PAUSED" : ""}`,
      );
      console.log(
        `queue pending=${result.queue.pending} claimed=${result.queue.claimed} dead=${result.queue.dead}  gcRemoved=${result.gc?.removed.length ?? 0} aged=${result.aged} journalRemoved=${result.journal?.removed ?? 0}`,
      );
      if (result.autoscale?.recommendations.length) {
        for (const r of result.autoscale.recommendations) {
          console.log(`  scale ${r.kind}/${r.name} ${r.currentReplicas}→${r.recommendedReplicas}`);
        }
      }
      return 0;
    }
    case "clone": {
      const state = loadState(root);
      if (!state.gitRepos.length) {
        console.log("no GitRepo manifests — apply fleets first");
        return 0;
      }
      const dryRun = rest.includes("--dry-run");
      const results = cloneAllGitRepos(root, state, {
        force: rest.includes("--force"),
        dryRun,
        remote: rest.includes("--remote"),
      });
      if (!dryRun) saveState(root, state);
      for (const r of results) {
        console.log(
          `${r.ok ? "ok" : "skip"} ${r.repo}  ${r.progressPct}% phase=${r.phase} backend=${r.backend}  dest=${r.dest}${r.reason ? `  ${r.reason}` : ""}`,
        );
        for (const s of r.steps) {
          console.log(`    [${s.pct}%] ${s.phase}: ${s.detail}`);
        }
      }
      return results.every((r) => r.ok) ? 0 : 1;
    }
    case "budget": {
      const state = loadState(root);
      const rows = budgetReport(state);
      if (!rows.length) {
        console.log("no Policy.budget configured");
        return 0;
      }
      for (const r of rows) {
        console.log(
          `${r.key}  ${r.spent}/${r.limit}  remaining=${r.remaining}  windowMs=${r.windowMs}${r.exhausted ? "  EXHAUSTED" : ""}`,
        );
      }
      return rows.some((r) => r.exhausted) ? 1 : 0;
    }
    case "memory": {
      const state = loadState(root);
      const sub = rest[0];
      if (sub === "sync" || (!sub && rest.length === 0)) {
        const fromRepos = rest.includes("--repos");
        const pathFlag = flag(rest, "--path");
        const dirArg = rest.find((x) => !x.startsWith("--") && x !== "sync");
        const result = fromRepos
          ? syncMemoryFromGitRepos(state, root)
          : syncMemoryFromDir(state, root, pathFlag ?? dirArg);
        saveState(root, state);
        console.log(
          `memory sync  scanned=${result.scanned} synced=${result.synced.length} skipped=${result.skipped.length} errors=${result.errors.length}`,
        );
        for (const id of result.synced) console.log(`  + ${id}`);
        for (const e of result.errors) console.log(`  ! ${e.path}: ${e.error}`);
        return result.errors.length ? 1 : 0;
      }
      if (sub === "export") {
        const all = rest.includes("--all");
        const force = rest.includes("--force");
        const dir = flag(rest, "--path");
        const ids = rest.filter((x) => !x.startsWith("--") && x !== "export" && x !== "all");
        if (!all && !ids.length) {
          return fail("usage: ropex memory export <id>... | --all [--force] [--path dir]");
        }
        const result = exportMemoryFacts(state, root, {
          ids: all ? undefined : ids,
          all,
          force,
          dir: dir ?? undefined,
        });
        saveState(root, state);
        console.log(
          `memory export  exported=${result.exported.length} skipped=${result.skipped.length} errors=${result.errors.length}`,
        );
        for (const p of result.exported) console.log(`  → ${p}`);
        for (const e of result.errors) console.log(`  ! ${e.id}: ${e.error}`);
        return result.errors.length ? 1 : 0;
      }
      if (sub === "promote") {
        const id = rest[1];
        const scope = flag(rest, "--scope") as "worker" | "agent" | "fleet" | "cluster" | undefined;
        const doExport = !rest.includes("--no-export");
        if (!id || !scope) {
          return fail("usage: ropex memory promote <id> --scope agent|fleet|cluster [--no-export]");
        }
        if (!["agent", "fleet", "cluster", "worker"].includes(scope)) {
          return fail("scope must be worker|agent|fleet|cluster");
        }
        const next = promoteMemoryFact(state, id, scope);
        if (!next) return fail(`memory fact not found: ${id}`);
        let path: string | undefined;
        if (doExport) {
          path = exportMemoryFactToGit(next, { root });
          const idx = state.memory.findIndex((f) => f.id === next.id);
          if (idx !== -1) state.memory[idx] = { ...next, manifestPath: path };
        }
        saveState(root, state);
        console.log(`promoted ${next.id} → ${next.scope}${path ? `  exported=${path}` : ""}`);
        return 0;
      }
      const view = buildControlPlaneView(state, root);
      if (!view.memory.length) {
        console.log("no shared memory facts yet");
        return 0;
      }
      for (const m of view.memory) {
        console.log(`[${m.scope}] ${m.agent}${m.fleet ? `@${m.fleet}` : ""}  ${m.id}  ${m.text}`);
      }
      return 0;
    }
    case "ui": {
      const port = Number(flag(rest, "--port") ?? "7780");
      const server = await startControlPlaneServer({
        root,
        port,
        loadState,
        saveState,
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
