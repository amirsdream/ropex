/**
 * One image per pipeline. Every stage shares that image so agents can read
 * each other's files. Hermes memory is copied back to the control plane, then
 * the session image is deleted — including when the run fails.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { binOnPath } from "./proc.js";
import type {
  ClusterState,
  LearnedSkill,
  PipelineRun,
  Policy,
  SharedMemoryFact,
  SkillRecord,
  TrajectoryRecord,
} from "./types.js";

export type SessionRequest = {
  pipeline: PipelineRun;
  desired: ClusterState["desired"];
  policies: Policy[];
  memory: SharedMemoryFact[];
  skills: LearnedSkill[];
  skillRegistry: SkillRecord[];
};

export type SessionResult = {
  ok: boolean;
  pipeline: PipelineRun;
  memory: SharedMemoryFact[];
  skills: LearnedSkill[];
  skillRegistry: SkillRecord[];
  trajectories: TrajectoryRecord[];
  error?: string;
};

export type DockerExec = (
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

const DEFAULT_WORKER_IMAGE = "ropex-worker:latest";

/** Container sessions are opt-in so local `tsx` runs stay in-process. */
export function useContainerSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ROPEX_EXECUTOR === "container" && env.ROPEX_IN_SESSION !== "1";
}

export function sessionSlug(pipelineId: string): string {
  const safe = pipelineId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 48);
  return safe || "pipeline";
}

export function sessionImageRef(pipelineId: string): string {
  return `ropex-session:${sessionSlug(pipelineId)}`;
}

export function sessionContainerName(pipelineId: string): string {
  return `ropex-session-${sessionSlug(pipelineId)}`;
}

/** Thin layer on the harness base. The base image is not deleted. */
export function sessionDockerfile(baseImage: string): string {
  return [
    `FROM ${baseImage}`,
    "COPY request.json /session/request.json",
    'ENTRYPOINT ["node", "/app/dist/cli.js", "session-exec", "/session/request.json"]',
    "",
  ].join("\n");
}

export function snapshotSession(state: ClusterState, pipeline: PipelineRun): SessionRequest {
  return {
    pipeline: structuredClone(pipeline),
    desired: state.desired,
    policies: state.policies,
    memory: state.memory ?? [],
    skills: state.skills ?? [],
    skillRegistry: state.skillRegistry ?? [],
  };
}

/** `docker` when it is installed, otherwise `podman`. */
export function resolveContainerBin(env: NodeJS.ProcessEnv = process.env): string {
  const chosen = env.ROPEX_CONTAINER_BIN?.trim();
  if (chosen) return chosen;
  return binOnPath("docker", env) ?? binOnPath("podman", env) ?? "docker";
}

export function spawnDocker(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const bin = resolveContainerBin(opts.env);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      reject(
        missing
          ? new Error(
              "No container runtime is running. Install Docker, or start Podman (`podman machine start`), or leave ROPEX_EXECUTOR unset in .env.",
            )
          : err,
      );
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function passThroughEnv(env: NodeJS.ProcessEnv): string[] {
  const args: string[] = [];
  for (const key of ["OPENAI_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"]) {
    const value = env[key]?.trim();
    if (value) args.push("-e", `${key}=${value}`);
  }
  args.push("-e", "ROPEX_IN_SESSION=1", "-e", "ROPEX_EXECUTOR=inprocess");
  return args;
}

/**
 * Build the session image, run every stage inside it, copy Hermes memory out,
 * then delete the container and the session image.
 */
export async function runPipelineSession(opts: {
  request: SessionRequest;
  workDir: string;
  docker?: DockerExec;
  baseImage?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SessionResult> {
  const docker = opts.docker ?? spawnDocker;
  const env = opts.env ?? process.env;
  const base = opts.baseImage ?? (env.ROPEX_WORKER_IMAGE?.trim() || DEFAULT_WORKER_IMAGE);
  const id = opts.request.pipeline.id;
  const image = sessionImageRef(id);
  const name = sessionContainerName(id);
  const resultPath = join(opts.workDir, "result.json");

  mkdirSync(opts.workDir, { recursive: true });
  writeFileSync(join(opts.workDir, "Dockerfile"), sessionDockerfile(base));
  writeFileSync(join(opts.workDir, "request.json"), JSON.stringify(opts.request));

  let built = false;
  let started = false;
  try {
    const build = await docker(["build", "-t", image, opts.workDir], { cwd: opts.workDir });
    if (build.code !== 0) {
      throw new Error(`session image build failed: ${build.stderr.trim() || build.stdout.trim()}`);
    }
    built = true;

    const run = await docker(
      ["run", "--name", name, ...passThroughEnv(env), image],
      { cwd: opts.workDir },
    );
    started = true;

    const copied = await docker(["cp", `${name}:/session/result.json`, resultPath]);
    if (copied.code === 0 && existsSync(resultPath)) {
      const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as SessionResult;
      if (run.code !== 0 && parsed.ok) parsed.ok = false;
      if (run.code !== 0 && !parsed.error) parsed.error = run.stderr.trim() || `session exited ${run.code}`;
      return parsed;
    }

    return {
      ok: false,
      pipeline: { ...opts.request.pipeline, status: "failed" },
      memory: opts.request.memory,
      skills: opts.request.skills,
      skillRegistry: opts.request.skillRegistry,
      trajectories: [],
      error: run.stderr.trim() || copied.stderr.trim() || `session exited ${run.code}`,
    };
  } finally {
    if (started) await docker(["rm", "-f", name]).catch(() => undefined);
    if (built) await docker(["rmi", image]).catch(() => undefined);
  }
}
