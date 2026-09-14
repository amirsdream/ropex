import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyState } from "../src/controller.ts";
import { createHermes } from "../src/hermes.ts";
import { expandWorkers, runTask } from "../src/runtime.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import { trajectoriesFor } from "../src/trajectory.ts";
import { bootWorker } from "../src/worker-runtime.ts";
import type { ClusterState, DesiredAgent, Worker } from "../src/types.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude-cli.mjs", import.meta.url));

/**
 * `command` + `commandArgs` point the claude-code runtime at a fixture that
 * speaks claude's CLI contract, so the real argv() and permissions() output is
 * what runs. Spawning via process.execPath keeps this portable (no shebang or
 * exec-bit dependency).
 */
const yaml = (extra = "") => `
apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: guard
spec:
  maxReplicas: 8
  permissions:
    deny: [prod-write]
    requireApproval: []
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  runtime:
    kind: claude-code
    model: claude-opus-5
    command: ${JSON.stringify(process.execPath)}
    commandArgs: [${JSON.stringify(FAKE_CLAUDE)}]
    timeoutMs: 30000
${extra}
  harness:
    profile: code
    plugins: [fs, shell]
  hermes:
    memory: shared
    learning: true
    skills: [implement-issue]
  github:
    events: [issues.labeled]
    deliver: pull_request
`;

function setup(manifest: string): { state: ClusterState; agent: DesiredAgent; worker: Worker } {
  const manifests = parseManifests(manifest);
  const desired = expandDesired(manifests);
  const agent = desired[0];
  const worker = expandWorkers(agent)[0];
  const state = emptyState();
  state.desired = desired;
  state.policies = manifests.filter((m) => m.kind === "Policy") as ClusterState["policies"];
  worker.status = "running";
  state.workers = [worker];
  return { state, agent, worker };
}

describe("claude-code runtime end to end", () => {
  beforeEach(() => {
    // A syntactically valid but fake key: the fixture never calls anything.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.FAKE_CLAUDE_FAIL;
    delete process.env.FAKE_CLAUDE_IS_ERROR;
  });

  it("runs the CLI in the worktree and records it as the executor", async () => {
    const { state, worker } = setup(yaml());
    const result = await runTask(state, worker, {
      id: "t1",
      agent: "builder",
      prompt: "implement login tests",
    });

    expect(result.steps.length).toBe(1);
    expect(result.steps[0].calls[0].plugin).toBe("runtime:claude-code");
    expect(result.steps[0].calls[0].name).toBe("task:t1");

    const echoed = JSON.parse(result.steps[0].observation) as {
      received: Record<string, string | string[] | null>;
      cwd: string;
      argv: string[];
    };
    // The composed brief reached stdin (not argv — ARG_MAX), carrying soul, skills and task.
    expect(echoed.received.prompt).toContain("implement login tests");
    expect(echoed.received.prompt).toContain("## Task");
    expect(echoed.received.prompt).toContain("implement-issue");
    expect(echoed.argv).not.toContain("implement login tests");
    // Real argv: model and headless permission mode came from the descriptor.
    expect(echoed.received.model).toBe("claude-opus-5");
    expect(echoed.received.outputFormat).toBe("json");
    expect(echoed.received.permissionMode).toBe("acceptEdits");
    // The CLI ran inside the worker worktree, not the repo root.
    expect(echoed.cwd).toBe(worker.worktree);
  });

  it("keeps the rest of the spine intact — delivery, learning, trajectory", async () => {
    const { state, worker } = setup(yaml());
    const result = await runTask(state, worker, {
      id: "t2",
      agent: "builder",
      prompt: "add a regression test",
    });

    expect(result.delivery?.kind).toBe("pull_request");
    expect(result.learned?.name).toMatch(/^learned-/);
    expect(worker.status).toBe("idle");
    expect(trajectoriesFor(state, "builder").length).toBe(1);
    expect(result.workflow.find((s) => s.id === "execute")?.owner).toBe("worker");
    expect(result.workflow.find((s) => s.id === "execute")?.purpose).toMatch(/claude-code/);
    expect(result.workflow.find((s) => s.id === "plan")?.owner).toBe("hermes");
    // Only execute moves — delivery still runs through the harness plugin.
    expect(result.workflow.find((s) => s.id === "deliver")?.owner).toBe("deepseek");
  });

  it("restates unmappable-by-flag policy labels in the prompt", async () => {
    const { state, worker } = setup(yaml());
    const result = await runTask(state, worker, {
      id: "t3",
      agent: "builder",
      prompt: "touch prod",
    });
    const echoed = JSON.parse(result.steps[0].observation) as { received: { prompt: string } };
    // `prod-write` names no registered tool, so no CLI flag can gate it.
    expect(echoed.received.prompt).toContain("Policy prohibitions");
    expect(echoed.received.prompt).toContain("prod-write");
  });

  it("surfaces a non-zero CLI exit instead of reporting success", async () => {
    process.env.FAKE_CLAUDE_FAIL = "1";
    const { state, worker } = setup(yaml());
    await expect(
      runTask(state, worker, { id: "t4", agent: "builder", prompt: "fail please" }),
    ).rejects.toThrow(/Claude Code CLI exited 1/);
  });

  it("re-materialises a worktree that no longer exists on disk", async () => {
    const { state, worker } = setup(yaml());
    await runTask(state, worker, { id: "t6a", agent: "builder", prompt: "first run" });
    const worktree = worker.worktree as string;
    expect(existsSync(worktree)).toBe(true);

    // Worker state outlives the filesystem (container restart, sandbox cleanup).
    // A CLI runtime spawns in this directory, so a stale path is a hard failure.
    rmSync(worktree, { recursive: true, force: true });
    expect(existsSync(worktree)).toBe(false);

    const result = await runTask(state, worker, {
      id: "t6b",
      agent: "builder",
      prompt: "second run",
    });
    expect(existsSync(worker.worktree as string)).toBe(true);
    const echoed = JSON.parse(result.steps[0].observation) as { cwd: string };
    expect(echoed.cwd).toBe(worker.worktree);
  });

  it("does not report success when the CLI fails but exits 0", async () => {
    process.env.FAKE_CLAUDE_IS_ERROR = "1";
    const { state, worker } = setup(yaml());
    await expect(
      runTask(state, worker, { id: "t5", agent: "builder", prompt: "hit a rate limit" }),
    ).rejects.toThrow(/reported an error: rate limit exceeded/);
  });
});

describe("cli runtimes fail closed", () => {
  // runTask derives these from Policy; boot them directly to isolate each gate.
  const boot = (manifest: string, deny: string[] = []) => {
    const agent = expandDesired(parseManifests(manifest))[0];
    return bootWorker(agent.spec, { hermes: createHermes(agent.spec), deny });
  };

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("refuses to run when the binary is missing", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const manifest = yaml().replace(
      `command: ${JSON.stringify(process.execPath)}`,
      'command: "ropex-no-such-binary"',
    );
    await expect(boot(manifest)).rejects.toThrow(/not found on PATH/);
  });

  it("refuses to run without credentials", async () => {
    await expect(boot(yaml())).rejects.toThrow(/requires one of: ANTHROPIC_API_KEY/);
  });

  it("refuses to run when a declared tool deny cannot be expressed as a flag", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    await expect(boot(yaml(), ["inspect"])).rejects.toThrow(
      /cannot enforce denied tools: inspect/,
    );
  });

  it("refuses to run when a required env var is absent", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    await expect(
      boot(yaml("    requireEnv: [ROPEX_TEST_MISSING_VAR]")),
    ).rejects.toThrow(/requires env ROPEX_TEST_MISSING_VAR/);
  });

  it("still requires Hermes, exactly like the dsh path", async () => {
    const agent = expandDesired(parseManifests(yaml()))[0];
    await expect(bootWorker(agent.spec, {})).rejects.toThrow(/requires Hermes/);
  });
});
