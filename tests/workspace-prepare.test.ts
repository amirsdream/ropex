import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandDesired, parseManifests } from "../src/spec.ts";
import type { DesiredAgent } from "../src/types.ts";
import {
  assertWorkspaceRuntime,
  prepareWorkspace,
  sandboxSpecForWorkspace,
  workspaceBranch,
  workspaceSlug,
  type GitRunner,
} from "../src/workspace.ts";

function agent(extra = ""): DesiredAgent {
  return expandDesired(
    parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  replicas: 1
  runtime:
    kind: dsh
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: shared
    learning: false
    skills: []
  workspace:
    path: /tmp/app
    remote: origin
    base: main
${extra}
`),
  )[0];
}

function scripted(map: Record<string, { code?: number; stdout?: string; stderr?: string }>): {
  git: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push(args);
    const key = args.join(" ");
    const hit = map[key];
    if (!hit) return { code: 1, stdout: "", stderr: `unexpected ${key}` };
    return { code: hit.code ?? 0, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
  };
  return { git, calls };
}

function okScript(root: string) {
  const worktree = join(root, ".ropex", "workspace", "builder", "greeting");
  return {
    "rev-parse --is-inside-work-tree": { stdout: "true\n" },
    "remote get-url origin": { stdout: "https://example.test/app.git\n" },
    "rev-parse --verify main^{commit}": { stdout: "abc\n" },
    "show-ref --verify --quiet refs/heads/ropex/greeting": { code: 1 },
    [`worktree add -b ropex/greeting ${worktree} main`]: { stdout: "" },
  };
}

describe("prepareWorkspace", () => {
  it("slug-formats the branch", () => {
    expect(workspaceSlug("Issue: 12")).toBe("Issue-12");
    expect(workspaceBranch("Issue: 12")).toBe("ropex/Issue-12");
    expect(workspaceSlug("a".repeat(90))).toHaveLength(80);
    expect(() => workspaceSlug("///")).toThrow(/empty branch slug/);
  });

  it("creates the worktree after the checks pass", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-ctrl-"));
    const fake = scripted(okScript(root));
    const prepared = prepareWorkspace({
      root,
      agent: agent(),
      taskId: "greeting",
      git: fake.git,
      fileExists: () => true,
      binExists: () => true,
    });
    expect(prepared).toMatchObject({
      checkout: "/tmp/app",
      worktree: join(root, ".ropex", "workspace", "builder", "greeting"),
      branch: "ropex/greeting",
      base: "main",
      remote: "origin",
      agent: "builder",
    });
    expect(fake.calls.some((args) => args[0] === "worktree")).toBe(true);
  });

  it("does not create a branch on dry run", () => {
    const fake = scripted(okScript("/ctrl"));
    prepareWorkspace({
      root: "/ctrl",
      agent: agent(),
      taskId: "greeting",
      dryRun: true,
      git: fake.git,
      fileExists: () => true,
    });
    expect(fake.calls.some((args) => args[0] === "worktree")).toBe(false);
  });

  it.each([
    ["rev-parse --is-inside-work-tree", { code: 1 }, /not a git checkout/],
    ["remote get-url origin", { code: 1 }, /remote origin is missing/],
    ["rev-parse --verify main^{commit}", { code: 1 }, /base main does not exist/],
    ["show-ref --verify --quiet refs/heads/ropex/greeting", { code: 0 }, /branch ropex\/greeting already exists/],
  ] as const)("stops before worktree add when %s fails", (key, result, message) => {
    const fake = scripted({ ...okScript("/ctrl"), [key]: result });
    expect(() =>
      prepareWorkspace({
        root: "/ctrl",
        agent: agent(),
        taskId: "greeting",
        git: fake.git,
        fileExists: () => true,
      }),
    ).toThrow(message);
    expect(fake.calls.some((args) => args[0] === "worktree")).toBe(false);
  });

  it("rejects a missing checkout path before git", () => {
    const fake = scripted(okScript("/ctrl"));
    expect(() =>
      prepareWorkspace({
        root: "/ctrl",
        agent: agent(),
        taskId: "greeting",
        git: fake.git,
        fileExists: () => false,
      }),
    ).toThrow(/not a git checkout: \/tmp\/app/);
    expect(fake.calls).toEqual([]);
  });

  it("rejects a detached HEAD when base is omitted", () => {
    const yamlAgent = agent();
    delete yamlAgent.spec.workspace!.base;
    const fake = scripted({
      "rev-parse --is-inside-work-tree": { stdout: "true\n" },
      "remote get-url origin": { stdout: "ok\n" },
      "rev-parse --abbrev-ref HEAD": { stdout: "HEAD\n" },
    });
    expect(() =>
      prepareWorkspace({
        root: "/ctrl",
        agent: yamlAgent,
        taskId: "greeting",
        git: fake.git,
        fileExists: () => true,
      }),
    ).toThrow(/detached HEAD and workspace.base is unset/);
    expect(fake.calls.some((args) => args[0] === "worktree")).toBe(false);
  });

  it("rejects live dsh in a docker sandbox before git", () => {
    const previous = process.env.ROPEX_DSH_BACKEND;
    process.env.ROPEX_DSH_BACKEND = "live";
    try {
      const docker = agent("  sandbox:\n    provider: docker\n");
      const fake = scripted(okScript("/ctrl"));
      expect(() =>
        prepareWorkspace({
          root: "/ctrl",
          agent: docker,
          taskId: "greeting",
          git: fake.git,
          fileExists: () => true,
        }),
      ).toThrow(/live dsh cannot run in a docker sandbox/);
      expect(fake.calls).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.ROPEX_DSH_BACKEND;
      else process.env.ROPEX_DSH_BACKEND = previous;
    }
  });

  it("fails a missing CLI binary before git", () => {
    const cli = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  replicas: 1
  runtime:
    kind: codex
    auth: api-key
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: shared
    learning: false
    skills: []
  workspace:
    path: /tmp/app
`),
    )[0];
    const fake = scripted(okScript("/ctrl"));
    expect(() =>
      prepareWorkspace({
        root: "/ctrl",
        agent: cli,
        taskId: "greeting",
        git: fake.git,
        fileExists: () => true,
        binExists: () => false,
        env: { ...process.env, OPENAI_API_KEY: "test-key" },
      }),
    ).toThrow(/runtime codex binary not found/);
    expect(fake.calls).toEqual([]);
  });

  it("does not require a host binary for a docker CLI runtime", () => {
    const cli = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  replicas: 1
  runtime:
    kind: codex
    auth: api-key
  sandbox:
    provider: docker
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: shared
    learning: false
    skills: []
  workspace:
    path: /tmp/app
`),
    )[0];
    expect(() =>
      assertWorkspaceRuntime(cli, {
        env: { OPENAI_API_KEY: "test-key" },
        binExists: () => false,
      }),
    ).not.toThrow();
    expect(() =>
      assertWorkspaceRuntime(cli, {
        env: {},
        binExists: () => false,
      }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it("forces a docker sandbox to mount the prepared worktree", () => {
    const spec = sandboxSpecForWorkspace(
      {
        provider: "docker" as const,
        repo: { url: "https://example.test/other.git", workspace: "clone" as const },
        lifecycle: { warmSnapshot: true },
      },
      true,
    );
    expect(spec).toEqual({
      provider: "docker",
      repo: { workspace: "mount" },
      lifecycle: { warmSnapshot: false },
    });
    expect(sandboxSpecForWorkspace({ provider: "local" }, true)).toEqual({ provider: "local" });
    expect(sandboxSpecForWorkspace({ provider: "docker", repo: { url: "https://example.test/a.git" } }, false)).toEqual({
      provider: "docker",
      repo: { url: "https://example.test/a.git" },
    });
  });
});
