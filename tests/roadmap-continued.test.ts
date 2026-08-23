import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildControlPlaneView } from "../src/api.ts";
import { applyManifestText, emptyState, loadState, planReconcile } from "../src/controller.ts";
import { githubAppScaffold } from "../src/github-app.js";
import { resolveClonedRepoManifestPath, resolveRepoLocalPath } from "../src/gitrepo.ts";
import { bootHermes, hermesPackageInstalled, liveHermesScaffold, resolveHermesBackend } from "../src/hermes.ts";
import { parseManifests } from "../src/spec.ts";
import { watchDeclaredRepos } from "../src/watch.ts";

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
    memory: none
    learning: false
    skills: []
`;

describe("roadmap continued: live hermes", () => {
  it("resolveHermesBackend defaults simulated and bootHermes fails closed for live", () => {
    expect(resolveHermesBackend()).toBe("simulated");
    expect(hermesPackageInstalled()).toBe(false);
    expect(liveHermesScaffold().packageInstalled).toBe(false);
    const { next } = planReconcile(emptyState(), parseManifests(agentYaml), "t");
    const agent = next.desired[0];
    expect(() => bootHermes(agent.spec, { backend: "live" })).toThrow(/live backend unavailable/);
  });

  it("projects hermesLive backend on the control-plane view", () => {
    const { next } = planReconcile(emptyState(), parseManifests(agentYaml), "t");
    const view = buildControlPlaneView(next);
    expect(view.hermesLive.backend).toBe("simulated");
    expect(view.hermesLive.packageInstalled).toBe(false);
  });
});

describe("roadmap continued: cloned gitrepo paths", () => {
  it("resolveRepoLocalPath finds manifests under .ropex/repos checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-cloned-repo-"));
    temps.push(root);
    const fleets = join(root, "upstream", "fleets");
    mkdirSync(fleets, { recursive: true });
    writeFileSync(join(fleets, "a.yaml"), agentYaml);

    const repo = parseManifests(`
apiVersion: ropex.dev/v1
kind: GitRepo
metadata:
  name: upstream
spec:
  url: file://${fleets}
  path: fleets/
  interval: 30s
`)[0];
    if (repo.kind !== "GitRepo") throw new Error("expected GitRepo");

    const checkout = join(root, ".ropex", "repos", "upstream");
    mkdirSync(checkout, { recursive: true });
    cpSync(fleets, join(checkout, "fleets"), { recursive: true });

    const clonedPath = resolveClonedRepoManifestPath(root, repo);
    expect(existsSync(clonedPath)).toBe(true);
    const loc = resolveRepoLocalPath(root, repo);
    expect(loc.ok).toBe(true);
    expect(loc.path).toBe(clonedPath);
  });
});

describe("roadmap continued: watch --repos", () => {
  it("watchDeclaredRepos union-syncs declared GitRepos", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-watch-repos-"));
    temps.push(root);
    const fleets = join(root, "fleets");
    mkdirSync(fleets, { recursive: true });
    writeFileSync(
      join(fleets, "all.yaml"),
      `${agentYaml}
---
apiVersion: ropex.dev/v1
kind: GitRepo
metadata:
  name: local
spec:
  url: file://${fleets}
  path: fleets/
  interval: 1s
`,
    );
    applyManifestText(root, readFileSync(join(fleets, "all.yaml"), "utf8"), "bootstrap");
    const state = loadState(root);
    const result = watchDeclaredRepos(root, state, { force: true });
    expect(result.state.desired.some((a) => a.metadata.name === "triage")).toBe(true);
    expect(result.source).toContain("fleets");
  });
});

describe("roadmap continued: github app scaffold", () => {
  it("reports env readiness on the view", () => {
    const view = buildControlPlaneView(emptyState());
    expect(view.githubApp.ready).toBe(false);
    expect(githubAppScaffold().webhookSecretPresent).toBe(false);
  });
});
