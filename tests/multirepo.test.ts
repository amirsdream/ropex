import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { emptyState, planReconcile, saveState, loadState } from "../src/controller.ts";
import {
  collectMultiRepoManifests,
  isRepoDue,
  syncDueGitRepos,
  syncMultiRepo,
} from "../src/gitrepo.ts";
import { buildControlPlaneView } from "../src/api.ts";
import { parseManifests } from "../src/spec.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const repoA = `
apiVersion: ropex.dev/v1
kind: GitRepo
metadata:
  name: fleet-a
spec:
  url: file://a
  path: repos/a
  interval: 1h
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: alpha
spec:
  replicas: 1
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
`;

const repoB = `
apiVersion: ropex.dev/v1
kind: GitRepo
metadata:
  name: fleet-b
spec:
  url: file://b
  path: repos/b
  interval: 1h
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: beta
spec:
  replicas: 2
  harness:
    profile: code
    plugins: [github, fs]
  hermes:
    memory: none
    learning: false
    skills: []
`;

describe("multi-repo sync", () => {
  it("unions manifests from multiple GitRepo paths in one reconcile", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-mr-"));
    temps.push(root);
    mkdirSync(join(root, "repos/a"), { recursive: true });
    mkdirSync(join(root, "repos/b"), { recursive: true });
    writeFileSync(join(root, "repos/a/a.yaml"), repoA);
    writeFileSync(join(root, "repos/b/b.yaml"), repoB);

    // Seed state with both GitRepo declarations (as if applied from a bootstrap).
    const bootstrap = `${repoA}\n---\n${repoB}`;
    const { next } = planReconcile(emptyState(), parseManifests(bootstrap), "bootstrap", { root });
    // Simulate only alpha present after a single-path sync mistake, then multi-sync restores both.
    next.desired = next.desired.filter((a) => a.metadata.name === "alpha");
    next.workers = next.workers.filter((w) => w.agent === "alpha");
    saveState(root, next);

    const bundle = syncMultiRepo(root, loadState(root));
    expect(bundle.synced).toBe(true);
    expect(bundle.results.filter((r) => r.ok && r.included).length).toBe(2);
    const names = bundle.state.desired.map((a) => a.metadata.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
    expect(bundle.state.workers.filter((w) => w.status !== "retired").length).toBe(3);
    expect(bundle.state.gitRepoStatus.length).toBeGreaterThanOrEqual(2);
  });

  it("respects sync intervals with --due", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-due-"));
    temps.push(root);
    mkdirSync(join(root, "repos/a"), { recursive: true });
    writeFileSync(join(root, "repos/a/a.yaml"), repoA);
    const { next } = planReconcile(emptyState(), parseManifests(repoA), "a", { root });
    saveState(root, next);

    const t0 = Date.parse("2026-08-22T05:00:00.000Z");
    const first = syncMultiRepo(root, loadState(root), { now: t0 });
    expect(first.synced).toBe(true);
    const state = loadState(root);
    expect(isRepoDue(state.gitRepos[0], state, t0 + 60_000)).toBe(false);

    const skipped = syncDueGitRepos(root, state, { now: t0 + 60_000 });
    expect(skipped.skippedDue).toBe(true);
    expect(skipped.synced).toBe(false);

    const later = syncDueGitRepos(root, loadState(root), { now: t0 + 3_600_000 });
    expect(later.synced).toBe(true);
  });

  it("collectMultiRepoManifests reports missing paths", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-miss-"));
    temps.push(root);
    const repos = parseManifests(repoA + "\n---\n" + repoB).filter((m) => m.kind === "GitRepo");
    mkdirSync(join(root, "repos/a"), { recursive: true });
    writeFileSync(join(root, "repos/a/a.yaml"), repoA);
    const { resolved, missing } = collectMultiRepoManifests(root, repos as never);
    expect(resolved).toHaveLength(1);
    expect(missing.some((m) => m.repo === "fleet-b" && !m.ok)).toBe(true);
  });
});

describe("control plane health view", () => {
  it("projects health and gitRepos into the UI view", () => {
    const { next } = planReconcile(emptyState(), parseManifests(repoA), "a");
    const view = buildControlPlaneView(next);
    expect(view.health).toBeTruthy();
    expect(typeof view.health.ok).toBe("boolean");
    expect(view.health.workers.length).toBeGreaterThan(0);
    expect(view.gitRepos.some((g) => g.name === "fleet-a")).toBe(true);
  });
});
