import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { emptyState, planReconcile, saveState, loadState } from "../src/controller.ts";
import { cloneGitRepo, cloneAllGitRepos, planCloneAll, cloneStatusReport } from "../src/clone.ts";
import { enqueueTask } from "../src/queue.ts";
import { simulatePolicies } from "../src/policy-sim.ts";
import { controlPlaneTick } from "../src/tick.ts";
import { parseManifests } from "../src/spec.ts";
import { buildControlPlaneView } from "../src/api.ts";
import { deliverOutbound } from "../src/deliver.ts";
import { recordDelivery } from "../src/journal.ts";

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
  url: file://PLACEHOLDER
  path: fleets/
  interval: 1h
---
apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: guard
spec:
  maxReplicas: 20
  permissions:
    deny: [exfiltrate]
    requireApproval: []
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: triage
spec:
  scale: static
  replicas: 2
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
`;

describe("control plane tick", () => {
  it("reclaims, drains pending work, and reports autoscale", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-tick-"));
    temps.push(root);
    const fleets = join(root, "fleets");
    mkdirSync(fleets);
    writeFileSync(join(fleets, "a.yaml"), yaml.replace("PLACEHOLDER", fleets));
    const { next } = planReconcile(emptyState(), parseManifests(yaml.replace("PLACEHOLDER", fleets)), fleets, {
      root,
    });
    enqueueTask(next, {
      id: "t1",
      agent: "triage",
      prompt: "issues.opened acme/app: tick",
      event: { type: "issues.opened", repo: "acme/app", title: "tick" },
    });
    saveState(root, next);

    const state = loadState(root);
    const result = await controlPlaneTick(root, state, { concurrency: 2 });
    expect(result.drained.length).toBeGreaterThanOrEqual(1);
    expect(result.queue.done + result.queue.pending).toBeGreaterThan(0);
    expect(result.at).toBeTruthy();
  });
});

describe("clone contract", () => {
  it("copies file:// sources and refuses https", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-clone-"));
    temps.push(root);
    const src = join(root, "src-manifests");
    mkdirSync(src);
    writeFileSync(join(src, "x.yaml"), "apiVersion: ropex.dev/v1\nkind: Policy\nmetadata:\n  name: p\nspec:\n  maxReplicas: 1\n  permissions:\n    deny: []\n    requireApproval: []\n");

    const fileRepo = {
      apiVersion: "ropex.dev/v1" as const,
      kind: "GitRepo" as const,
      metadata: { name: "from-file" },
      spec: { url: `file://${src}`, path: "missing-path" },
    };
    const ok = cloneGitRepo(root, fileRepo);
    expect(ok.ok).toBe(true);
    expect(ok.backend).toBe("local-copy");
    expect(ok.phase).toBe("done");
    expect(ok.progressPct).toBe(100);
    expect(ok.steps.some((s) => s.phase === "copy")).toBe(true);
    expect(existsSync(ok.dest)).toBe(true);

    const remote = cloneGitRepo(root, {
      ...fileRepo,
      metadata: { name: "remote" },
      spec: { url: "https://github.com/example/ropex-config", path: "fleets/" },
    });
    expect(remote.ok).toBe(false);
    expect(remote.backend).toBe("remote-stub");
    expect(remote.phase).toBe("failed");
    expect(remote.steps.some((s) => s.phase === "remote-blocked")).toBe(true);
    expect(remote.reason).toMatch(/remote clone disabled/);
  });

  it("cloneAllGitRepos audits results and records progress", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-cloneall-"));
    temps.push(root);
    const state = emptyState();
    state.gitRepos = [
      {
        apiVersion: "ropex.dev/v1",
        kind: "GitRepo",
        metadata: { name: "r" },
        spec: { url: "https://github.com/example/x", path: "fleets/" },
      },
    ];
    const results = cloneAllGitRepos(root, state);
    expect(results[0].ok).toBe(false);
    expect(state.audit.some((a) => a.message.includes("clone skipped"))).toBe(true);
    expect(state.gitRepoStatus[0].clonePhase).toBe("failed");
    expect(state.gitRepoStatus[0].cloneProgressPct).toBe(40);
  });

  it("dry-run plans file:// without writing dest", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-clone-dry-"));
    temps.push(root);
    const src = join(root, "manifests");
    mkdirSync(src);
    writeFileSync(
      join(src, "p.yaml"),
      "apiVersion: ropex.dev/v1\nkind: Policy\nmetadata:\n  name: p\nspec:\n  maxReplicas: 1\n  permissions:\n    deny: []\n    requireApproval: []\n",
    );
    const state = emptyState();
    state.gitRepos = [
      {
        apiVersion: "ropex.dev/v1",
        kind: "GitRepo",
        metadata: { name: "dry" },
        spec: { url: `file://${src}`, path: "nope" },
      },
    ];
    const planned = planCloneAll(root, state);
    expect(planned[0].ok).toBe(true);
    expect(planned[0].reason).toMatch(/dry-run/);
    expect(existsSync(join(root, ".ropex", "repos", "dry"))).toBe(false);
    cloneAllGitRepos(root, state, { dryRun: true });
    const report = cloneStatusReport(state);
    expect(report.ok).toBe(1);
    expect(report.rows[0].clonePhase).toBe("done");
  });
});

describe("outbound + clone in control plane view", () => {
  it("projects outbound and clone status", () => {
    const state = emptyState();
    const worker = {
      id: "t:0",
      agent: "t",
      replica: 0,
      status: "idle" as const,
      imageDigest: "a".repeat(16),
      harness: "minimal" as const,
      plugins: [],
      skills: [],
      model: "m",
    };
    const del = recordDelivery(state, {
      task: { id: "1", agent: "t", prompt: "hi", event: { type: "issues.opened", repo: "a/b", number: 1 } },
      worker,
      imageDigest: worker.imageDigest,
      delivery: { kind: "comment", body: "ok" },
    })!;
    deliverOutbound(state, del, { mode: "stub" });
    state.gitRepoStatus = [
      {
        name: "r",
        path: "fleets/",
        ok: false,
        cloneBackend: "remote-stub",
        clonePhase: "failed",
        cloneProgressPct: 40,
        reason: "remote clone not wired",
      },
    ];
    const view = buildControlPlaneView(state);
    expect(view.outbound.simulated).toBe(1);
    expect(view.clone.blocked).toBe(1);
    expect(view.clone.rows[0].cloneProgressPct).toBe(40);
  });
});

describe("policy simulate", () => {
  it("reports deny/approval across agents", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml.replace("PLACEHOLDER", "/tmp")), "t");
    const report = simulatePolicies(next, { prompts: ["probe"] });
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.rows[0].agent).toBe("triage");
  });
});
