import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyState, planReconcile } from "../src/controller.ts";
import { drainPipelineStages, submitPipeline } from "../src/executor.ts";
import { parseManifests } from "../src/spec.ts";
import { executeSessionRequest } from "../src/session-run.ts";
import {
  runPipelineSession,
  sessionDockerfile,
  sessionImageRef,
  type DockerExec,
  type SessionResult,
} from "../src/session.ts";
import type { PipelineRun } from "../src/types.ts";

const temps: string[] = [];
const envBackup = {
  ROPEX_EXECUTOR: process.env.ROPEX_EXECUTOR,
  ROPEX_IN_SESSION: process.env.ROPEX_IN_SESSION,
};

afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  if (envBackup.ROPEX_EXECUTOR === undefined) delete process.env.ROPEX_EXECUTOR;
  else process.env.ROPEX_EXECUTOR = envBackup.ROPEX_EXECUTOR;
  if (envBackup.ROPEX_IN_SESSION === undefined) delete process.env.ROPEX_IN_SESSION;
  else process.env.ROPEX_IN_SESSION = envBackup.ROPEX_IN_SESSION;
});

const fleet = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: triage
spec:
  scale: onDemand
  maxConcurrent: 1
  idleTTLMs: 0
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: shared
    learning: false
    skills: []
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: reviewer
spec:
  scale: onDemand
  maxConcurrent: 1
  idleTTLMs: 0
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: shared
    learning: false
    skills: []
---
apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: cap
spec:
  maxReplicas: 4
  permissions:
    deny: []
    requireApproval: []
`;

function pipeline(): PipelineRun {
  const at = new Date().toISOString();
  return {
    id: "pipe-1",
    prompt: "Say what this control plane does in one sentence.",
    createdAt: at,
    updatedAt: at,
    status: "running",
    input: { prompt: "Say what this control plane does in one sentence.", at },
    stages: [
      {
        id: "look",
        agent: "triage",
        role: "triage",
        prompt: "Say what this control plane does in one sentence.",
        taskId: "pipe-1:look",
        status: "pending",
      },
      {
        id: "check",
        agent: "reviewer",
        role: "reviewer",
        prompt: "Review the previous answer.",
        taskId: "pipe-1:check",
        status: "pending",
      },
    ],
  };
}

function finished(memoryText: string): SessionResult {
  const run = pipeline();
  run.status = "done";
  run.stages[0].status = "done";
  run.stages[0].output = "Ropex runs agent fleets from git.";
  run.stages[1].status = "done";
  run.stages[1].output = "PASS The sentence matches the control plane.";
  run.output = run.stages.map((s) => s.output).join("\n");
  return {
    ok: true,
    pipeline: run,
    memory: [
      {
        id: "mem-1",
        text: memoryText,
        scope: "agent",
        agent: "triage",
        at: new Date().toISOString(),
        tags: ["task-complete"],
      },
    ],
    skills: [],
    skillRegistry: [],
    trajectories: [],
  };
}

describe("session image", () => {
  it("builds a thin layer from the worker base and names it after the pipeline", () => {
    expect(sessionImageRef("pipe-1")).toBe("ropex-session:pipe-1");
    expect(sessionDockerfile("ropex-worker:latest")).toContain("FROM ropex-worker:latest");
    expect(sessionDockerfile("ropex-worker:latest")).toContain("session-exec");
  });

  it("copies Hermes memory out, then deletes the session image", async () => {
    const calls: string[][] = [];
    const docker: DockerExec = async (args) => {
      calls.push(args);
      if (args[0] === "cp") writeFileSync(args[2], JSON.stringify(finished("kept-on-the-plane")));
      return { code: 0, stdout: "", stderr: "" };
    };
    const workDir = mkdtempSync(join(tmpdir(), "ropex-session-"));
    temps.push(workDir);
    const result = await runPipelineSession({
      request: {
        pipeline: pipeline(),
        desired: [],
        policies: [],
        memory: [],
        skills: [],
        skillRegistry: [],
      },
      workDir,
      docker,
      env: {},
    });

    expect(result.ok).toBe(true);
    expect(result.memory[0]?.text).toBe("kept-on-the-plane");
    const verbs = calls.map((c) => c[0]);
    expect(verbs).toEqual(["build", "run", "cp", "rm", "rmi"]);
    expect(calls.find((c) => c[0] === "rmi")?.[1]).toBe("ropex-session:pipe-1");
    expect(calls.some((c) => c.includes("ropex-worker:latest") && c[0] === "rmi")).toBe(false);
    const dockerfile = readFileSync(join(workDir, "Dockerfile"), "utf8");
    expect(dockerfile.startsWith("FROM ropex-worker:latest")).toBe(true);
  });

  it("deletes the session image when the run fails", async () => {
    const calls: string[] = [];
    const docker: DockerExec = async (args) => {
      calls.push(args[0]);
      if (args[0] === "run") return { code: 1, stdout: "", stderr: "boom" };
      if (args[0] === "cp") return { code: 1, stdout: "", stderr: "no result" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const workDir = mkdtempSync(join(tmpdir(), "ropex-session-fail-"));
    temps.push(workDir);
    const result = await runPipelineSession({
      request: {
        pipeline: pipeline(),
        desired: [],
        policies: [],
        memory: [],
        skills: [],
        skillRegistry: [],
      },
      workDir,
      docker,
      env: {},
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual(["build", "run", "cp", "rm", "rmi"]);
  });
});

describe("session execution", () => {
  it("runs every stage in one process and returns learned memory", async () => {
    delete process.env.ROPEX_EXECUTOR;
    const root = mkdtempSync(join(tmpdir(), "ropex-session-exec-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(fleet), "fleets/");
    const submitted = await submitPipeline(next, {
      simple: true,
      drain: false,
      root,
    });
    const result = await executeSessionRequest(
      {
        pipeline: submitted.pipeline,
        desired: next.desired,
        policies: next.policies,
        memory: next.memory,
        skills: next.skills,
        skillRegistry: next.skillRegistry,
      },
      root,
    );
    expect(result.ok).toBe(true);
    expect(result.pipeline.stages.map((s) => s.agent)).toEqual(["triage", "reviewer"]);
    expect(result.pipeline.stages.every((s) => s.status === "done")).toBe(true);
    expect(result.pipeline.stages[1]?.prompt).toContain("Prior stage outputs");
  });

  it("uses the container runner only when asked, and keeps the returned memory", async () => {
    process.env.ROPEX_EXECUTOR = "container";
    delete process.env.ROPEX_IN_SESSION;
    const root = mkdtempSync(join(tmpdir(), "ropex-session-drain-"));
    temps.push(root);
    const { next } = planReconcile(emptyState(), parseManifests(fleet), "fleets/");
    const submitted = await submitPipeline(next, { simple: true, drain: false, root });
    const docker: DockerExec = async (args) => {
      if (args[0] === "cp") writeFileSync(args[2], JSON.stringify(finished("from-session")));
      return { code: 0, stdout: "", stderr: "" };
    };
    const drained = await drainPipelineStages(next, submitted.pipeline, { root, docker });
    expect(drained).toBe(2);
    expect(submitted.pipeline.status).toBe("done");
    expect(next.memory.some((m) => m.text === "from-session")).toBe(true);
  });
});
