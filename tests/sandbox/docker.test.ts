import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyState } from "../../src/controller.ts";
import { expandWorkers, runTask } from "../../src/runtime.ts";
import { acquireSandbox } from "../../src/sandbox/index.ts";
import { gcOrphanSandboxes, scratchPath } from "../../src/sandbox/docker.ts";
import { findSnapshot, loadCatalog } from "../../src/sandbox/store.ts";
import { destroyWorker } from "../../src/scale.ts";
import { expandDesired, parseManifests } from "../../src/spec.ts";
import type { SandboxSpec, Worker } from "../../src/types.ts";
import { fakeDocker } from "./fake-docker.ts";

const TOKEN = "ghp_supersecrettoken123";
const API_KEY = "sk-test-secret-456";

const temps: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "ropex-sbxd-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const worker = { id: "builder:0", agent: "builder", imageDigest: "d" };

const repoSpec = (extra: Partial<SandboxSpec> = {}): SandboxSpec => ({
  provider: "docker",
  image: { base: "node:22-bookworm", tools: ["git"] },
  repo: { url: "https://github.com/org/repo.git", ref: "main", depth: 1, tokenEnv: "GITHUB_TOKEN" },
  secrets: ["OPENAI_API_KEY"],
  env: { CI: "1" },
  ...extra,
});

const env = { GITHUB_TOKEN: TOKEN, OPENAI_API_KEY: API_KEY, PATH: "" } as NodeJS.ProcessEnv;

function ctx(root: string, docker: ReturnType<typeof fakeDocker>) {
  return { root, worker, taskId: "t1", env, docker: docker.run, storeDir: join(root, "store") };
}

const gitSteps = (docker: ReturnType<typeof fakeDocker>) =>
  docker.calls
    .filter((c) => c.args[0] === "exec" && c.args.includes("git"))
    .map((c) => c.args.slice(c.args.indexOf("git") + 1).join(" "));

describe("docker sandbox lifecycle", () => {
  it("builds the env image, starts a labelled container, checks the repo out, and disposes", async () => {
    const root = tmp();
    const docker = fakeDocker();
    const sandbox = await acquireSandbox(repoSpec(), ctx(root, docker));

    expect(docker.verbs()).toEqual(["image", "build", "run", "exec", "exec", "exec", "exec"]);
    const run = docker.calls.find((c) => c.args[0] === "run")!.args;
    expect(run).toContain("--init");
    expect(run).toContain("no-new-privileges");
    expect(run.join(" ")).toContain("--label ropex.sandbox=1");
    expect(run.join(" ")).toContain("--label ropex.worker=builder:0");
    expect(run.join(" ")).toContain("--pids-limit 512");
    expect(run.join(" ")).toContain("-e CI=1");
    expect(sandbox.kind).toBe("docker");
    expect(sandbox.cwd).toBe("/workspace");
    expect(gitSteps(docker)).toEqual([
      "init -q",
      "remote add origin https://github.com/org/repo.git",
      "fetch -q --depth 1 origin main",
      "checkout -q -f --detach FETCH_HEAD",
    ]);
    expect(existsSync(sandbox.hostCwd)).toBe(true);

    await sandbox.dispose();
    await sandbox.dispose();
    expect(docker.verbs().filter((v) => v === "rm")).toHaveLength(1);
    expect(docker.containers.size).toBe(0);
    expect(existsSync(sandbox.hostCwd)).toBe(false);
  });

  it("applies resource limits", async () => {
    const docker = fakeDocker({ images: [] });
    await acquireSandbox(
      { provider: "docker", resources: { cpus: 2, memory: "4g", pids: 64, network: "none" } },
      ctx(tmp(), docker),
    );
    const run = docker.calls.find((c) => c.args[0] === "run")!.args.join(" ");
    expect(run).toContain("--cpus 2");
    expect(run).toContain("--memory 4g");
    expect(run).toContain("--pids-limit 64");
    expect(run).toContain("--network none");
  });

  it("execs commands in /workspace and forwards env by name", async () => {
    const docker = fakeDocker();
    const sandbox = await acquireSandbox(repoSpec(), ctx(tmp(), docker));
    await sandbox.exec("codex", ["exec", "--json"], { stdin: "the brief", env: { EXTRA: "v" } });
    const exec = docker.calls[docker.calls.length - 1];
    expect(exec.args.slice(0, 4)).toEqual(["exec", "-i", "-w", "/workspace"]);
    expect(exec.args.slice(-3)).toEqual(["codex", "exec", "--json"]);
    expect(exec.args).toContain("OPENAI_API_KEY");
    expect(exec.args).toContain("EXTRA");
    expect(exec.stdin).toBe("the brief");
    expect(exec.env?.OPENAI_API_KEY).toBe(API_KEY);
  });

  it("resolves binaries inside the container", async () => {
    const docker = fakeDocker();
    const sandbox = await acquireSandbox({ provider: "docker" }, ctx(tmp(), docker));
    expect(await sandbox.resolveBin("codex")).toBe("/usr/local/bin/codex");
  });

  it("removes the container when checkout fails", async () => {
    const docker = fakeDocker({
      onExec: (args) => (args.includes("fetch") ? { code: 128, stderr: "fatal: repository not found" } : undefined),
    });
    await expect(acquireSandbox(repoSpec(), ctx(tmp(), docker))).rejects.toThrow(/repository not found/);
    expect(docker.removed).toHaveLength(1);
    expect(docker.containers.size).toBe(0);
  });

  it("fails closed when a declared token or secret is missing from the control plane", async () => {
    const docker = fakeDocker();
    await expect(
      acquireSandbox(repoSpec(), { ...ctx(tmp(), docker), env: { PATH: "" } as NodeJS.ProcessEnv }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
    expect(docker.verbs()).not.toContain("run");
  });

  it("mounts the host worktree instead of cloning when workspace is mount", async () => {
    const root = tmp();
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    const docker = fakeDocker();
    const sandbox = await acquireSandbox(
      { provider: "docker", repo: { workspace: "mount" } },
      { ...ctx(root, docker), worker: { ...worker, worktree: checkout } },
    );
    const run = docker.calls.find((c) => c.args[0] === "run")!.args.join(" ");
    expect(run).toContain(`--mount type=bind,source=${checkout},target=/workspace`);
    expect(gitSteps(docker)).toEqual([]);
    await sandbox.dispose();
    expect(existsSync(checkout)).toBe(true);
  });
});

describe("token safety", () => {
  it("never puts a token value on a docker argv or in the container's creation env", async () => {
    const root = tmp();
    const docker = fakeDocker();
    const sandbox = await acquireSandbox(repoSpec({ lifecycle: { after: "snapshot", warmSnapshot: true } }), ctx(root, docker));
    await sandbox.exec("codex", ["exec"]);
    await sandbox.snapshot("t1");

    const argv = JSON.stringify(docker.calls.map((c) => c.args));
    expect(argv).not.toContain(TOKEN);
    expect(argv).not.toContain(API_KEY);

    for (const call of docker.calls) {
      const carriesSecret = call.env?.GITHUB_TOKEN === TOKEN || call.env?.OPENAI_API_KEY === API_KEY;
      // Only `exec` calls may carry secret values; create, commit and save never do.
      if (call.args[0] !== "exec") expect(carriesSecret).toBe(false);
    }
    const commit = docker.calls.find((c) => c.args[0] === "commit")!;
    expect(commit.env).toBeUndefined();
  });

  it("authenticates git through a credential helper that reads the token from env", async () => {
    const docker = fakeDocker();
    await acquireSandbox(repoSpec(), ctx(tmp(), docker));
    const fetch = docker.calls.find((c) => c.args.includes("fetch"))!;
    expect(fetch.env?.ROPEX_GIT_TOKEN).toBe(TOKEN);
    expect(fetch.env?.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(fetch.env?.GIT_CONFIG_VALUE_0).toContain("$ROPEX_GIT_TOKEN");
    expect(fetch.env?.GIT_CONFIG_VALUE_0).not.toContain(TOKEN);
    expect(fetch.args).toContain("ROPEX_GIT_TOKEN");
    expect(fetch.args.join(" ")).not.toContain("https://x-access-token");
  });
});

describe("warm snapshots and storage", () => {
  const warm = repoSpec({ lifecycle: { warmSnapshot: true } });

  it("commits and stores a warm snapshot on a miss, then reuses it on a hit", async () => {
    const root = tmp();
    const docker = fakeDocker();
    const first = await acquireSandbox(warm, ctx(root, docker));
    expect(docker.verbs()).toContain("commit");
    expect(docker.verbs()).toContain("save");
    const catalog = loadCatalog(join(root, "store"));
    expect(catalog.snapshots).toHaveLength(1);
    const snap = catalog.snapshots[0];
    expect(snap.kind).toBe("warm");
    expect(snap.tarPath && existsSync(snap.tarPath)).toBe(true);
    expect(snap.bytes).toBeGreaterThan(0);
    await first.dispose();

    const before = docker.calls.length;
    const second = await acquireSandbox(warm, ctx(root, docker));
    const after = docker.calls.slice(before);
    expect(after.find((c) => c.args[0] === "run")!.args).toContain(snap.imageRef);
    const steps = after.filter((c) => c.args.includes("git")).map((c) => c.args[c.args.indexOf("git") + 1]);
    expect(steps).toEqual(["fetch", "checkout", "clean"]);
    expect(after.some((c) => c.args[0] === "commit")).toBe(false);
    expect(second.imageRef).toBe(snap.imageRef);
  });

  it("restores a snapshot from its tarball when the image is gone", async () => {
    const root = tmp();
    const docker = fakeDocker();
    await (await acquireSandbox(warm, ctx(root, docker))).dispose();
    const snap = loadCatalog(join(root, "store")).snapshots[0];

    docker.images.delete(snap.imageRef);
    docker.pendingLoads.add(snap.imageRef);
    const before = docker.calls.length;
    await acquireSandbox(warm, ctx(root, docker));
    const after = docker.calls.slice(before).map((c) => c.args);
    expect(after.find((a) => a[0] === "load")).toEqual(["load", "-i", snap.tarPath!]);
    expect(after.some((a) => a.includes("init"))).toBe(false);
  });

  it("rebuilds the checkout when neither the image nor the tarball survives", async () => {
    const root = tmp();
    const docker = fakeDocker();
    await (await acquireSandbox(warm, ctx(root, docker))).dispose();
    const snap = loadCatalog(join(root, "store")).snapshots[0];
    docker.images.delete(snap.imageRef);
    rmSync(snap.tarPath!);

    const before = docker.calls.length;
    await acquireSandbox(warm, ctx(root, docker));
    const after = docker.calls.slice(before);
    expect(after.some((c) => c.args.includes("init"))).toBe(true);
    expect(after.some((c) => c.args[0] === "commit")).toBe(true);
  });

  it("does not fail the task when a warm snapshot cannot be written", async () => {
    const docker = fakeDocker();
    const failing = async (args: string[], o?: Parameters<typeof docker.run>[1]) =>
      args[0] === "commit" ? { code: 1, stdout: "", stderr: "no space left", timedOut: false } : docker.run(args, o);
    const sandbox = await acquireSandbox(warm, { ...ctx(tmp(), docker), docker: failing });
    expect(sandbox.kind).toBe("docker");
  });

  it("snapshots on demand, registers it, and applies keep retention", async () => {
    const root = tmp();
    const docker = fakeDocker();
    const spec = repoSpec({ lifecycle: { after: "snapshot", keep: 1 } });
    const a = await acquireSandbox(spec, { ...ctx(root, docker), taskId: "task-a" });
    await a.snapshot("task-a");
    await a.dispose();
    const b = await acquireSandbox(spec, { ...ctx(root, docker), taskId: "task-b" });
    const rec = await b.snapshot("task-b");
    expect(rec?.kind).toBe("task");
    expect(rec?.labels.task).toBe("task-b");
    const keys = loadCatalog(join(root, "store")).snapshots.map((s) => s.key);
    expect(keys).toHaveLength(1);
    expect(findSnapshot(join(root, "store"), rec!.key)).toBeDefined();
  });
});

describe("orphan GC", () => {
  const dockerState = () => {
    const state = emptyState();
    state.desired = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata: { name: builder }
spec:
  scale: onDemand
  maxConcurrent: 1
  sandbox: { provider: docker }
  harness: { profile: minimal, plugins: [github] }
  hermes: { memory: none, learning: false, skills: [] }
`),
    );
    return state;
  };

  it("removes sandbox containers and scratch dirs with no live worker", () => {
    const root = tmp();
    const state = dockerState();
    state.workers = [{ id: "builder:0", agent: "builder", status: "running" } as Worker];
    mkdirSync(scratchPath(root, "builder:0"), { recursive: true });
    mkdirSync(scratchPath(root, "builder:7"), { recursive: true });
    const rm: string[][] = [];
    const result = gcOrphanSandboxes(root, state, {
      docker: (args) => {
        if (args[0] === "rm") rm.push(args);
        return {
          code: 0,
          stdout: args[0] === "ps" ? "keep-me\tbuilder:0\norphan-1\tbuilder:7\nno-worker\t\n" : "",
          stderr: "",
          timedOut: false,
        };
      },
    });
    expect(result.keptContainers).toEqual(["keep-me"]);
    expect(result.removedContainers).toEqual(["orphan-1", "no-worker"]);
    expect(rm.map((a) => a[2])).toEqual(["orphan-1", "no-worker"]);
    expect(result.removedScratch).toEqual(["builder_7"]);
    expect(existsSync(scratchPath(root, "builder:0"))).toBe(true);
  });

  it("does nothing on a host whose fleet declares no docker sandbox", () => {
    const root = tmp();
    let called = false;
    const result = gcOrphanSandboxes(root, emptyState(), {
      docker: () => {
        called = true;
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    expect(called).toBe(false);
    expect(result.skipped).toMatch(/no docker sandbox/);
  });
});

const codexAgent = (sandbox: string) => `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  runtime:
    kind: codex
${sandbox}
  harness:
    profile: code
    plugins: [fs, shell]
  hermes:
    memory: shared
    learning: false
    skills: []
  github:
    events: [issues.labeled]
    deliver: pull_request
`;

function runnable(manifest: string) {
  const desired = expandDesired(parseManifests(manifest));
  const w = expandWorkers(desired[0])[0];
  w.status = "running";
  const state = emptyState();
  state.desired = desired;
  state.workers = [w];
  return { state, worker: w };
}

describe("runTask with a docker sandbox", () => {
  const block = `  sandbox:
    provider: docker
    image: { npm: ["@openai/codex"] }
    repo: { url: "https://github.com/org/repo.git", ref: main }
    secrets: [OPENAI_API_KEY]`;

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("runs the CLI runtime inside the container and disposes it afterwards", async () => {
    process.env.OPENAI_API_KEY = API_KEY;
    const root = tmp();
    const docker = fakeDocker({
      onExec: (args) =>
        args.includes("--sandbox")
          ? { stdout: JSON.stringify({ message: "patched in container" }) }
          : undefined,
    });
    const { state, worker: w } = runnable(codexAgent(block));
    const result = await runTask(state, w, { id: "t1", agent: "builder", prompt: "fix the bug" }, {
      root,
      sandboxDocker: docker.run,
    });

    expect(result.output).toContain("patched in container");
    const codexCall = docker.calls.find((c) => c.args[0] === "exec" && c.args.includes("--sandbox"))!;
    expect(codexCall.args.slice(0, 4)).toEqual(["exec", "-i", "-w", "/workspace"]);
    expect(codexCall.args).toContain("/usr/local/bin/codex");
    expect(codexCall.args[codexCall.args.indexOf("--cd") + 1]).toBe("/workspace");
    expect(codexCall.stdin).toContain("fix the bug");
    expect(JSON.stringify(docker.calls.map((c) => c.args))).not.toContain(API_KEY);
    expect(docker.verbs()[docker.verbs().length - 1]).toBe("rm");
    expect(docker.containers.size).toBe(0);
    expect(w.sandbox).toBeUndefined();
    expect(w.worktree).toBeUndefined();
    expect(result.worktree).toBe(scratchPath(root, w.id));
  });

  it("disposes the container even when the task fails", async () => {
    process.env.OPENAI_API_KEY = API_KEY;
    const docker = fakeDocker({
      onExec: (args) => (args.includes("--sandbox") ? { code: 2, stderr: "codex crashed" } : undefined),
    });
    const { state, worker: w } = runnable(codexAgent(block));
    await expect(
      runTask(state, w, { id: "t2", agent: "builder", prompt: "x" }, { root: tmp(), sandboxDocker: docker.run }),
    ).rejects.toThrow(/codex crashed/);
    expect(docker.containers.size).toBe(0);
    expect(docker.removed).toHaveLength(1);
  });

  it("snapshots after the task when lifecycle.after is snapshot", async () => {
    process.env.OPENAI_API_KEY = API_KEY;
    const root = tmp();
    const docker = fakeDocker({
      onExec: (args) => (args.includes("--sandbox") ? { stdout: "{}" } : undefined),
    });
    const { state, worker: w } = runnable(codexAgent(`${block}\n    lifecycle: { after: snapshot }`));
    await runTask(state, w, { id: "t3", agent: "builder", prompt: "x" }, { root, sandboxDocker: docker.run });
    const verbs = docker.verbs();
    expect(verbs.indexOf("commit")).toBeGreaterThan(verbs.indexOf("exec"));
    expect(verbs.indexOf("rm")).toBeGreaterThan(verbs.indexOf("commit"));
    expect(loadCatalog(join(root, ".ropex", "sandboxes")).snapshots[0]?.kind).toBe("task");
    expect(state.audit.some((a) => a.message.startsWith("sandbox snapshot ropex-snap:"))).toBe(true);
  });

  it("fails with a recipe hint when the runtime binary is not in the image", async () => {
    process.env.OPENAI_API_KEY = API_KEY;
    const docker = fakeDocker({
      onExec: (args) => (args.join(" ").includes("command -v") ? { code: 1 } : undefined),
    });
    const { state, worker: w } = runnable(codexAgent(block));
    await expect(
      runTask(state, w, { id: "t4", agent: "builder", prompt: "x" }, { root: tmp(), sandboxDocker: docker.run }),
    ).rejects.toThrow(/not found inside the docker sandbox.*spec\.sandbox\.image/);
    expect(docker.containers.size).toBe(0);
  });

  it("destroyWorker removes a container left behind by a crash", () => {
    const state = emptyState();
    const { worker: w } = runnable(codexAgent(block));
    w.sandbox = { provider: "docker", id: "ropex-sbx-leftover" };
    w.status = "idle";
    state.workers = [w];
    const prior = process.env.ROPEX_CONTAINER_BIN;
    process.env.ROPEX_CONTAINER_BIN = "/nonexistent/docker";
    try {
      destroyWorker(state, w.id);
    } finally {
      if (prior === undefined) delete process.env.ROPEX_CONTAINER_BIN;
      else process.env.ROPEX_CONTAINER_BIN = prior;
    }
    expect(w.status).toBe("retired");
    expect(w.sandbox).toBeUndefined();
  });
});

describe("local provider parity", () => {
  it("runs commands in the worker worktree on the host", async () => {
    const root = tmp();
    const dir = join(root, "wt");
    mkdirSync(dir);
    writeFileSync(join(dir, "marker.txt"), "x");
    const sandbox = await acquireSandbox(undefined, {
      root,
      worker: { ...worker, worktree: dir },
    });
    expect(sandbox.kind).toBe("local");
    expect(sandbox.cwd).toBe(dir);
    const res = await sandbox.exec(process.execPath, ["-e", "console.log(require('fs').readdirSync('.').join(','), process.env.A)"], {
      env: { A: "b" },
    });
    expect(res.stdout.trim()).toBe("marker.txt b");
    expect(await sandbox.resolveBin(process.execPath)).toBe(process.execPath);
    expect(await sandbox.snapshot("x")).toBeUndefined();
    await sandbox.dispose();
    expect(existsSync(dir)).toBe(true);
  });
});
