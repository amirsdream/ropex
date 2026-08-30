import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { emptyState, planReconcile, saveState, loadState } from "../src/controller.ts";
import { runSandboxDemo } from "../src/demo.ts";
import { syncGitRepos, resolveGitRepoPath, gitRepoIntervalMs } from "../src/gitrepo.ts";
import { recordDelivery, replayDelivery } from "../src/journal.ts";
import { enqueueTask } from "../src/queue.ts";
import { expandWorkers } from "../src/runtime.ts";
import { drainQueue } from "../src/scheduler.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const yaml = `
apiVersion: ropex.dev/v1
kind: GitRepo
metadata:
  name: local
spec:
  url: file://local
  path: fleets/
  interval: 15s
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: triage
spec:
  scale: static
  replicas: 3
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
  github:
    events: [issues.opened]
    deliver: comment
  selector:
    matchLabels:
      org: acme
`;

describe("concurrent drain", () => {
  it("drains multiple claims with concurrency > 1", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-conc-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "fleets/", { root });
    for (let i = 0; i < 3; i++) {
      enqueueTask(next, {
        id: `job-${i}`,
        agent: "triage",
        prompt: `issues.opened acme/app: t${i}`,
        event: { type: "issues.opened", repo: "acme/app", title: `t${i}` },
      });
    }
    const results = await drainQueue(next, { root, concurrency: 3 });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(next.metrics.tasksCompleted).toBeGreaterThanOrEqual(2);
  });
});

describe("delivery replay", () => {
  it("appends a replayed delivery marked [replay]", () => {
    const state = emptyState();
    const worker = {
      id: "triage:0",
      agent: "triage",
      replica: 0,
      status: "idle" as const,
      imageDigest: "abc",
      harness: "minimal" as const,
      plugins: [],
      skills: [],
      model: "x",
    };
    const rec = recordDelivery(state, {
      task: { id: "t1", agent: "triage", prompt: "hi", event: { type: "issues.opened", repo: "acme/app", number: 1 } },
      worker,
      imageDigest: "abc",
      delivery: { kind: "comment", body: "done" },
    });
    expect(rec).toBeTruthy();
    const replayed = replayDelivery(state, rec!.id);
    expect(replayed?.body).toContain("[replay]");
    expect(state.deliveries).toHaveLength(2);
  });
});

describe("gitrepo sync stub", () => {
  it("resolves paths and intervals", () => {
    const manifests = parseManifests(yaml);
    const repo = manifests.find((m) => m.kind === "GitRepo")!;
    expect(resolveGitRepoPath("/ws", repo).endsWith("fleets")).toBe(true);
    expect(gitRepoIntervalMs(repo)).toBe(15_000);
  });

  it("syncs local fleets path when present", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-sync-"));
    temps.push(root);
    const fleets = join(root, "fleets");
    mkdirSync(fleets);
    writeFileSync(join(fleets, "a.yaml"), yaml);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), fleets, { root });
    saveState(root, next);
    const results = syncGitRepos(root, loadState(root));
    expect(results.some((r) => r.ok)).toBe(true);
  });
});

describe("sandbox demo", () => {
  it("runs apply → webhook → concurrent drain offline", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-demo-"));
    temps.push(root);
    const result = await runSandboxDemo(root, {
      concurrency: 2,
      exampleYaml: yaml,
    });
    expect(result.workers).toBeGreaterThanOrEqual(2);
    expect(result.drained).toBeGreaterThanOrEqual(1);
    expect(result.deliveries).toBeGreaterThanOrEqual(1);
    expect(result.steps.length).toBeGreaterThan(3);
  });
});
