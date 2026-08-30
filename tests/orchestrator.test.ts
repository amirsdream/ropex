import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { emptyState, planReconcile } from "../src/controller.ts";
import { enqueueTask, pickIdleWorker, queueSummary } from "../src/queue.ts";
import { expandWorkers, runTask } from "../src/runtime.ts";
import { drainQueue } from "../src/scheduler.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import {
  ingestGithubWebhook,
  parseGithubWebhook,
  signGithubPayload,
  verifyGithubSignature,
} from "../src/webhook.ts";
import { ensureWorktree, removeWorktree, worktreePath } from "../src/worktree.ts";

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: triage
spec:
  scale: static
  replicas: 2
  harness:
    profile: minimal
    plugins: [github, fs]
  hermes:
    memory: shared
    learning: true
    skills: [issue-triage]
  github:
    events: [issues.opened]
    deliver: comment
  selector:
    matchLabels:
      org: acme
`;

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("worktrees", () => {
  it("provisions isolated sandbox paths per worker and tears them down", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-wt-"));
    temps.push(root);
    const { next, plan } = planReconcile(emptyState(), parseManifests(yaml), "fleets/", { root });
    expect(plan.create).toHaveLength(2);
    for (const w of plan.create) {
      expect(w.worktree).toBeTruthy();
      expect(existsSync(w.worktree!)).toBe(true);
      expect(readFileSync(join(w.worktree!, ".ropex-worker.json"), "utf8")).toContain(w.id);
    }
    expect(worktreePath(root, "triage:0")).not.toBe(worktreePath(root, "triage:1"));

    const shrunk = yaml.replace("replicas: 2", "replicas: 1");
    const retired = planReconcile(next, parseManifests(shrunk), "fleets/", { root });
    expect(retired.plan.retire).toHaveLength(1);
    expect(existsSync(worktreePath(root, "triage:1"))).toBe(false);
    expect(existsSync(worktreePath(root, "triage:0"))).toBe(true);
  });

  it("chroots fs tools to the worker worktree during runTask", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-run-"));
    temps.push(root);
    const desired = expandDesired(parseManifests(yaml));
    const worker = expandWorkers(desired[0])[0];
    worker.status = "idle";
    worker.worktree = ensureWorktree(root, worker);
    const state = emptyState();
    state.desired = desired;
    state.workers = [worker];

    const result = await runTask(state, worker, {
      id: "t-wt",
      agent: "triage",
      prompt: "read files",
    }, { root });

    expect(result.worktree).toBe(worker.worktree);
    const fsStep = result.steps.find((s) => s.calls.some((c) => c.name === "fs"));
    const obs = JSON.parse(fsStep!.observation) as { cwd?: string };
    expect(obs.cwd).toBe(worker.worktree);
    removeWorktree(root, worker.id);
  });
});

describe("queue + scheduler", () => {
  it("fairly picks least-recently-used idle worker", () => {
    const state = emptyState();
    state.desired = expandDesired(parseManifests(yaml));
    state.workers = expandWorkers(state.desired[0]).map((w) => ({ ...w, status: "idle" as const }));
    state.workers[0].lastTaskAt = "2026-01-01T00:00:00.000Z";
    state.workers[1].lastTaskAt = "2026-01-02T00:00:00.000Z";
    expect(pickIdleWorker(state, "triage")?.id).toBe("triage:0");
  });

  it("enqueues github work and drains onto idle workers", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-q-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "fleets/", { root });
    enqueueTask(
      next,
      {
        id: "job-1",
        agent: "triage",
        prompt: "issues.opened acme/app: login",
        event: { type: "issues.opened", repo: "acme/app", title: "login" },
      },
      "github",
    );
    expect(queueSummary(next).pending).toBe(1);
    const results = await drainQueue(next, { root });
    expect(results).toHaveLength(1);
    expect(queueSummary(next).done).toBe(1);
    expect(next.metrics.tasksCompleted).toBe(1);
    expect(results[0].worker.status).toBe("idle");
  });
});

describe("webhook ingress", () => {
  it("verifies HMAC signatures", () => {
    const body = '{"ok":true}';
    const sig = signGithubPayload("s3cret", body);
    expect(verifyGithubSignature("s3cret", body, sig)).toBe(true);
    expect(verifyGithubSignature("s3cret", body, "sha256=deadbeef")).toBe(false);
  });

  it("parses issues webhooks and enqueues matching agents", () => {
    const state = emptyState();
    state.desired = expandDesired(parseManifests(yaml));
    const payload = {
      action: "opened",
      repository: { full_name: "acme/app" },
      issue: { title: "login broken", number: 7, labels: [{ name: "bug" }] },
    };
    const event = parseGithubWebhook("issues", payload);
    expect(event?.type).toBe("issues.opened");
    expect(event?.number).toBe(7);

    const raw = JSON.stringify(payload);
    const secret = "test";
    const result = ingestGithubWebhook(
      state,
      raw,
      {
        "x-github-event": "issues",
        "x-github-delivery": "deliv-1",
        "x-hub-signature-256": signGithubPayload(secret, raw),
      },
      secret,
    );
    expect(result.ok).toBe(true);
    expect(result.enqueued).toHaveLength(1);
    expect(result.enqueued[0].source).toBe("webhook");
    expect(queueSummary(state).pending).toBe(1);
  });

  it("rejects bad signatures when secret is set", () => {
    const state = emptyState();
    const result = ingestGithubWebhook(
      state,
      "{}",
      { "x-github-event": "issues", "x-hub-signature-256": "sha256=nope" },
      "secret",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/signature/);
  });
});
