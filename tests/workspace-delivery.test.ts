import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deliverTaskOutcome } from "../src/connectors.ts";
import { emptyState } from "../src/controller.ts";
import { completeQueued, enqueueTask } from "../src/queue.ts";
import { deliverGitTaskManifest } from "../src/tasks.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workspace delivery", () => {
  it("dead-letters a terminal failure without retry", () => {
    const state = emptyState();
    const queued = enqueueTask(state, { id: "greeting", agent: "builder", prompt: "add greeting" }, "cli");
    queued.status = "claimed";
    queued.attempts = 1;
    const updated = completeQueued(state, queued.id, false, "rejected", { terminal: true });
    expect(updated?.status).toBe("dead");
    expect(updated?.error).toBe("rejected");
    expect(state.queue.some((item) => item.status === "pending")).toBe(false);
  });

  it("writes branch, commit, and remote onto a git task file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ropex-task-"));
    temps.push(dir);
    const manifestPath = join(dir, "greeting.yaml");
    writeFileSync(
      manifestPath,
      `apiVersion: ropex.dev/v1
kind: Task
metadata:
  name: greeting
spec:
  agent: builder
  prompt: add a greeting
  status: pending
  delivery:
    mode: git
`,
    );
    deliverGitTaskManifest(
      { id: "greeting", agent: "builder", prompt: "add a greeting", manifestPath, delivery: { mode: "git" } },
      {
        ok: true,
        output: "done",
        workerId: "builder-0",
        workspace: { branch: "ropex/greeting", commit: "abc", remote: "origin", pushed: true },
      },
    );
    const text = readFileSync(manifestPath, "utf8");
    expect(text).toContain("status: done");
    expect(text).toContain("branch: ropex/greeting");
    expect(text).toContain("commit: abc");
    expect(text).toContain("remote: origin");
  });

  it("writes the publish error when the queue item is dead", () => {
    const dir = mkdtempSync(join(tmpdir(), "ropex-task-"));
    temps.push(dir);
    const manifestPath = join(dir, "greeting.yaml");
    writeFileSync(
      manifestPath,
      `apiVersion: ropex.dev/v1
kind: Task
metadata:
  name: greeting
spec:
  agent: builder
  prompt: add a greeting
  delivery:
    mode: git
`,
    );
    const state = emptyState();
    const queued = enqueueTask(
      state,
      { id: "greeting", agent: "builder", prompt: "add a greeting", manifestPath, delivery: { mode: "git" } },
      "git",
    );
    queued.status = "claimed";
    queued.attempts = 1;
    const updated = completeQueued(state, queued.id, false, "rejected", { terminal: true });
    deliverTaskOutcome(state, updated!, {
      output: "failed",
      error: "rejected",
      workspace: { branch: "ropex/greeting", commit: "abc", remote: "origin", pushed: false },
    });
    const text = readFileSync(manifestPath, "utf8");
    expect(text).toContain("status: failed");
    expect(text).toContain("error: rejected");
    expect(text).toContain("branch: ropex/greeting");
    expect(text).toContain("remote: origin");
  });
});
