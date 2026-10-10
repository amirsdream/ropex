import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceCheck } from "../src/workspace-check.ts";
import { emptyState, saveState } from "../src/controller.ts";
import type { GitRunner } from "../src/workspace.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workspace check", () => {
  it("reports a dry-run success and does not add a worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-cli-"));
    temps.push(root);
    const state = emptyState();
    state.desired = [
      {
        apiVersion: "ropex.dev/v1",
        kind: "Agent",
        metadata: { name: "builder" },
        spec: {
          replicas: 1,
          harness: { profile: "minimal", plugins: [] },
          hermes: { memory: "shared", learning: false, skills: [] },
          workspace: { path: "/tmp/app", remote: "origin", base: "main" },
        },
      },
    ];
    saveState(root, state);
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push(args);
      const key = args.join(" ");
      if (key === "rev-parse --is-inside-work-tree") return { code: 0, stdout: "true\n", stderr: "" };
      if (key === "remote get-url origin") return { code: 0, stdout: "ok\n", stderr: "" };
      if (key === "rev-parse --verify main^{commit}") return { code: 0, stdout: "abc\n", stderr: "" };
      if (key.startsWith("show-ref")) return { code: 1, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: key };
    };
    const lines: string[] = [];
    const code = workspaceCheck(root, ["check", "builder"], {
      git,
      fileExists: () => true,
      log: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("workspace ok /tmp/app");
    expect(calls.some((args) => args[0] === "worktree")).toBe(false);
  });

  it("exits 1 when the agent has no workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-cli-"));
    temps.push(root);
    const state = emptyState();
    state.desired = [
      {
        apiVersion: "ropex.dev/v1",
        kind: "Agent",
        metadata: { name: "builder" },
        spec: {
          replicas: 1,
          harness: { profile: "minimal", plugins: [] },
          hermes: { memory: "shared", learning: false, skills: [] },
        },
      },
    ];
    saveState(root, state);
    const errors: string[] = [];
    const code = workspaceCheck(root, ["check", "builder"], { error: (line) => errors.push(line) });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("has no spec.workspace");
  });
});
