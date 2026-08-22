import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { emptyState, planReconcile } from "../src/controller.ts";
import { ensureWorktree, gcOrphanWorktrees, worktreePath } from "../src/worktree.ts";
import {
  ingestGithubWebhook,
  signGithubPayload,
} from "../src/webhook.ts";
import {
  ageQueuePriorities,
  claimPending,
  effectivePriority,
  enqueueTask,
} from "../src/queue.ts";
import { promoteMemoryFact } from "../src/memory.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import { expandWorkers } from "../src/runtime.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const agentYaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: triage
spec:
  replicas: 1
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: shared
    learning: false
    skills: []
  github:
    events: [issues.opened]
    deliver: comment
`;

describe("worktree gc", () => {
  it("removes orphan worktree dirs and keeps live ones", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-gc-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(agentYaml), "t", { root });
    const live = next.workers.find((w) => w.status !== "retired")!;
    ensureWorktree(root, live);
    const orphan = join(root, "sandbox", "worktrees", "ghost_9");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "x"), "orphan");
    const result = gcOrphanWorktrees(root, next);
    expect(result.removed).toContain("ghost_9");
    expect(result.kept).toContain("triage_0");
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(worktreePath(root, live.id))).toBe(true);
  });
});

describe("webhook idempotency", () => {
  it("skips duplicate x-github-delivery", () => {
    const state = emptyState();
    state.desired = expandDesired(parseManifests(agentYaml));
    state.workers = expandWorkers(state.desired[0]).map((w) => ({ ...w, status: "idle" as const }));
    const raw = JSON.stringify({
      action: "opened",
      repository: { full_name: "acme/app" },
      issue: { title: "x", number: 1 },
    });
    const headers = {
      "x-github-event": "issues",
      "x-github-delivery": "deliv-1",
      "x-hub-signature-256": signGithubPayload("s", raw),
    };
    const first = ingestGithubWebhook(state, raw, headers, "s");
    expect(first.ok).toBe(true);
    expect(first.enqueued.length).toBe(1);
    expect(first.duplicate).toBeUndefined();
    const second = ingestGithubWebhook(state, raw, headers, "s");
    expect(second.ok).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.enqueued).toHaveLength(0);
    expect(state.metrics.webhookDuplicates).toBe(1);
  });
});

describe("priority aging", () => {
  it("boosts old low-priority ahead of fresh high when age accrues", () => {
    const state = emptyState();
    state.desired = expandDesired(parseManifests(agentYaml));
    state.workers = expandWorkers(state.desired[0]).map((w) => ({ ...w, status: "idle" as const }));
    // Need 2 workers for 2 claims or claim one at a time
    state.desired[0].spec.replicas = 2;
    state.workers = expandWorkers(state.desired[0]).map((w) => ({ ...w, status: "idle" as const }));

    const t0 = Date.parse("2026-08-22T00:00:00.000Z");
    enqueueTask(state, { id: "old", agent: "triage", prompt: "old" }, "cli", { priority: 0 });
    enqueueTask(state, { id: "new", agent: "triage", prompt: "new" }, "cli", { priority: 2 });
    state.queue[0].enqueuedAt = new Date(t0).toISOString();
    state.queue[1].enqueuedAt = new Date(t0 + 10_000).toISOString();

    // After 5 minutes, old gets +5 boost → priority 5 > 2
    const now = t0 + 5 * 60_000;
    expect(effectivePriority(state.queue[0], now)).toBe(5);
    ageQueuePriorities(state, { now });
    expect(state.queue[0].priority).toBe(5);
    const { claimed } = claimPending(state, 1, { now, agePriorities: false });
    expect(claimed[0].queueId).toBe("old");
  });
});

describe("memory promote CLI helper", () => {
  it("widens fact scope to cluster", () => {
    const state = emptyState();
    state.memory.push({
      id: "m1",
      agent: "triage",
      text: "fact",
      at: new Date().toISOString(),
      scope: "agent",
      sourceWorker: "triage:0",
    });
    const next = promoteMemoryFact(state, "m1", "cluster");
    expect(next?.scope).toBe("cluster");
    expect(state.memory[0].scope).toBe("cluster");
  });
});
