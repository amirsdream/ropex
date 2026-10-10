import { describe, expect, it } from "vitest";
import { composeBrief } from "../src/brief.ts";
import type { HermesContract } from "../src/contracts.ts";
import type { AgentWorkflow } from "../src/workflow.ts";

const workflow = { brain: { soul: "builder", skills: [] } } as AgentWorkflow;
const hermes = { port: { query: () => [] } } as unknown as HermesContract;
const task = { id: "greeting", agent: "builder", prompt: "add a greeting" };
const plan = { thoughts: [], calls: [] };

describe("composeBrief workspace", () => {
  it("tells the runtime it may commit and must not push", () => {
    const brief = composeBrief(workflow, hermes, task, plan, {
      workspace: { branch: "ropex/greeting", base: "main" },
    });
    expect(brief).toContain("You are on branch ropex/greeting, cut from main.");
    expect(brief).toContain("You may commit on this branch.");
    expect(brief).toContain("You must not push, switch branches, or change remotes.");
    expect(brief).not.toContain("You are already in the worker worktree.");
  });

  it("keeps the current working-directory text when no workspace is set", () => {
    const brief = composeBrief(workflow, hermes, task, plan);
    expect(brief).toContain("You are already in the worker worktree.");
    expect(brief).not.toContain("You may commit on this branch.");
  });
});
