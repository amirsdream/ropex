import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyManifestText, loadState, saveState } from "../src/controller.ts";
import { cloneGitRepo } from "../src/clone.ts";
import { dshPackageInstalled, liveDshScaffold, resolveDshBackend, resolveDshBin } from "../src/dsh.ts";
import { expandWorkers } from "../src/runtime.ts";
import { enqueueTask } from "../src/queue.ts";
import { drainQueue } from "../src/scheduler.ts";
import { parseManifests } from "../src/spec.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const agentExportYaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: docbot
spec:
  scale: static
  replicas: 1
  harness:
    profile: minimal
    plugins: [fs]
  hermes:
    memory: shared
    exportMemory: true
    learning: false
    skills: []
`;

describe("finish gaps", () => {
  it("resolveDshBackend defaults to embedded", () => {
    expect(resolveDshBackend()).toBe("embedded");
    // Detection must track the CLI entry (ESM-only package has no bare main).
    expect(dshPackageInstalled()).toBe(Boolean(resolveDshBin()));
    const scaffold = liveDshScaffold();
    expect(scaffold.liveReady).toBe(scaffold.packageInstalled && scaffold.apiKeyPresent);
  });

  it("remote clone plans git-remote when --remote enabled (vitest skips exec)", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-clone-"));
    temps.push(root);
    const repo = parseManifests(`
apiVersion: ropex.dev/v1
kind: GitRepo
metadata:
  name: remote
spec:
  url: https://github.com/example/ropex-config.git
  path: fleets/
`)[0];
    if (repo.kind !== "GitRepo") throw new Error("expected GitRepo");
    const blocked = cloneGitRepo(root, repo, {});
    expect(blocked.backend).toBe("remote-stub");
    const planned = cloneGitRepo(root, repo, { remote: true, dryRun: true });
    expect(planned.backend).toBe("git-remote");
    expect(planned.ok).toBe(true);
    expect(planned.steps.some((s) => s.detail.includes("git clone"))).toBe(true);
  });

  it("auto-exports memory after task when exportMemory is true", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-export-"));
    temps.push(root);
    applyManifestText(root, agentExportYaml, "agent");
    const state = loadState(root);
    const worker = expandWorkers(state.desired[0], { root })[0];
    state.workers = [worker];
    enqueueTask(state, { id: "t-auto", agent: "docbot", prompt: "remember this" }, "cli");
    saveState(root, state);

    await drainQueue(state, { root, limit: 1 });
    saveState(root, state);

    const after = loadState(root);
    expect(after.memory.some((f) => f.manifestPath?.includes(join(root, "memory")))).toBe(true);
    const exported = after.memory.find((f) => f.manifestPath);
    expect(exported).toBeTruthy();
    expect(readFileSync(exported!.manifestPath!, "utf8")).toMatch(/remember this/);
  });
});
