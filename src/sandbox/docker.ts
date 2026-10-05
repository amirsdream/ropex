/**
 * Docker sandbox — one container per task, started from an environment image (or a warm
 * snapshot of it with the repo already checked out), executed into, then disposed or
 * snapshotted.
 *
 * Tokens: the container is created with no secrets. Each `docker exec` forwards secret
 * values by name (`-e NAME`, value read from the docker CLI's environment), so they never
 * appear on an argv, in `docker inspect`, or in a `docker commit` snapshot. Git auth uses a
 * credential helper that reads the token from that same environment.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { binOnPath } from "../proc.js";
import {
  defaultDockerRun,
  defaultDockerSync,
  expectOk,
  type DockerRun,
  type DockerSync,
} from "./client.js";
import { ensureEnvImage, SANDBOX_WORKDIR } from "./image.js";
import type { Sandbox, SandboxAcquireContext, SandboxProvider } from "./index.js";
import { snapshotByteCap } from "./spec.js";
import {
  evictSnapshots,
  exportSnapshotTar,
  findSnapshot,
  registerSnapshot,
  restoreSnapshot,
  sandboxStoreDir,
  snapshotImageRef,
  taskSnapshotKey,
  touchSnapshot,
  warmSnapshotKey,
  type SnapshotRecord,
} from "./store.js";
import { resolveContainerBin } from "../session.js";
import type { ClusterState, SandboxSpec } from "../types.js";
import { ensureWorktree, worktreeSlug } from "../worktree.js";

export const SANDBOX_LABEL = "ropex.sandbox";
export const SCRATCH_ROOT = join("sandbox", "scratch");
const DEFAULT_PIDS = 512;
const KEEPALIVE = "while :; do sleep 3600; done";
const GIT_HELPER = '!f() { echo username=x-access-token; echo "password=$ROPEX_GIT_TOKEN"; }; f';

export function scratchPath(root: string, workerId: string): string {
  return join(root, SCRATCH_ROOT, worktreeSlug(workerId));
}

function containerName(workerId: string): string {
  const slug = worktreeSlug(workerId).slice(0, 40);
  return `ropex-sbx-${slug}-${randomBytes(3).toString("hex")}`;
}

function requireEnvValue(env: NodeJS.ProcessEnv, name: string, what: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`sandbox ${what} needs env ${name}, which is not set on the control plane`);
  return value;
}

/**
 * A container has no git identity. These match the author the embedded harness
 * passes on `git` argv, so a CLI harness can commit without writing config
 * into the snapshot.
 */
const GIT_IDENTITY_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "Ropex",
  GIT_AUTHOR_EMAIL: "ropex@localhost",
  GIT_COMMITTER_NAME: "Ropex",
  GIT_COMMITTER_EMAIL: "ropex@localhost",
};

/** Values forwarded into every exec, by name. Keys are env names, values stay out of argv. */
function buildExecEnv(spec: SandboxSpec, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = { ...GIT_IDENTITY_ENV };
  for (const name of spec.secrets ?? []) out[name] = requireEnvValue(env, name, "secrets");
  const tokenEnv = spec.repo?.tokenEnv;
  if (tokenEnv) {
    const token = requireEnvValue(env, tokenEnv, "repo.tokenEnv");
    out[tokenEnv] = token;
    out.ROPEX_GIT_TOKEN = token;
    out.GIT_TERMINAL_PROMPT = "0";
    out.GIT_CONFIG_COUNT = "1";
    out.GIT_CONFIG_KEY_0 = "credential.helper";
    out.GIT_CONFIG_VALUE_0 = GIT_HELPER;
  }
  return out;
}

function createArgs(opts: {
  name: string;
  image: string;
  spec: SandboxSpec;
  ctx: SandboxAcquireContext;
  envDigest: string;
  mountSource?: string;
}): string[] {
  const { spec, ctx } = opts;
  const res = spec.resources ?? {};
  const args = [
    "run",
    "-d",
    "--init",
    "--name",
    opts.name,
    "--entrypoint",
    "sh",
    "--label",
    `${SANDBOX_LABEL}=1`,
    "--label",
    `ropex.worker=${ctx.worker.id}`,
    "--label",
    `ropex.agent=${ctx.worker.agent}`,
    "--label",
    `ropex.env=${opts.envDigest}`,
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(res.pids ?? DEFAULT_PIDS),
    "-w",
    SANDBOX_WORKDIR,
  ];
  if (ctx.taskId) args.push("--label", `ropex.task=${ctx.taskId}`);
  if (res.cpus !== undefined) args.push("--cpus", String(res.cpus));
  if (res.memory) args.push("--memory", res.memory);
  if (res.network) args.push("--network", res.network);
  for (const [key, value] of Object.entries(spec.env ?? {})) args.push("-e", `${key}=${value}`);
  if (opts.mountSource) {
    if (opts.mountSource.includes(",")) {
      throw new Error(`sandbox mount source cannot contain a comma: ${opts.mountSource}`);
    }
    args.push("--mount", `type=bind,source=${opts.mountSource},target=${SANDBOX_WORKDIR}`);
  }
  args.push(opts.image, "-c", KEEPALIVE);
  return args;
}

export async function acquireDockerSandbox(
  spec: SandboxSpec | undefined,
  ctx: SandboxAcquireContext,
): Promise<Sandbox> {
  const sandbox = spec ?? { provider: "docker" as const };
  const env = ctx.env ?? process.env;
  const docker: DockerRun = ctx.docker ?? defaultDockerRun(env);
  const storeDir = ctx.storeDir ?? sandboxStoreDir(ctx.root, env);
  const execEnv = buildExecEnv(sandbox, env);
  const repo = sandbox.repo;
  const clone = Boolean(repo && (repo.workspace ?? "clone") === "clone");
  const life = sandbox.lifecycle ?? {};

  const image = await ensureEnvImage(docker, sandbox, ctx.root);

  let startImage = image.ref;
  let warmKey: string | undefined;
  let warmHit = false;
  if (clone && life.warmSnapshot) {
    warmKey = warmSnapshotKey(image.digest, repo!.url!, repo!.ref, repo!.depth);
    const known = findSnapshot(storeDir, warmKey);
    if (known && (await restoreSnapshot(docker, storeDir, known))) {
      warmHit = true;
      startImage = known.imageRef;
      touchSnapshot(storeDir, warmKey);
    }
  }

  const mount = repo?.workspace === "mount";
  const hostCwd = mount
    ? ensureHostWorktree(ctx)
    : mkScratch(ctx.root, ctx.worker.id);
  const name = containerName(ctx.worker.id);

  let disposed = false;
  const removeContainer = async () => {
    await docker(["rm", "-f", name]).catch(() => undefined);
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await removeContainer();
    if (!mount) rmSync(hostCwd, { recursive: true, force: true });
  };

  const exec: Sandbox["exec"] = (bin, args, opts = {}) => {
    const forwarded: Record<string, string> = { ...execEnv };
    for (const [k, v] of Object.entries(opts.env ?? {})) if (v !== undefined) forwarded[k] = v;
    const envFlags = Object.keys(forwarded).flatMap((k) => ["-e", k]);
    return docker(
      ["exec", "-i", "-w", opts.cwd ?? SANDBOX_WORKDIR, ...envFlags, name, bin, ...args],
      { env: forwarded, stdin: opts.stdin, timeoutMs: opts.timeoutMs, onStdout: opts.onStdout },
    );
  };

  const eviction = async () => {
    await evictSnapshots(docker, storeDir, {
      keep: life.keep,
      ttlMs: life.ttlMs,
      maxBytes: snapshotByteCap(ctx.policies ?? []),
    });
  };

  const commit = async (key: string, kind: SnapshotRecord["kind"], labels: Record<string, string>) => {
    const imageRef = snapshotImageRef(key);
    expectOk(await docker(["commit", name, imageRef]), `docker commit ${name}`);
    const { tarPath, bytes } = await exportSnapshotTar(docker, imageRef, storeDir, key);
    const now = new Date().toISOString();
    const record: SnapshotRecord = {
      key,
      kind,
      imageRef,
      envDigest: image.digest,
      tarPath,
      bytes,
      createdAt: now,
      lastUsedAt: now,
      labels,
    };
    registerSnapshot(storeDir, record);
    await eviction();
    return record;
  };

  try {
    expectOk(
      await docker(
        createArgs({
          name,
          image: startImage,
          spec: sandbox,
          ctx,
          envDigest: image.digest,
          mountSource: mount ? resolve(hostCwd) : undefined,
        }),
      ),
      `sandbox container ${name}`,
    );

    if (clone && repo) {
      const depth = repo.depth ? ["--depth", String(repo.depth)] : [];
      const steps: string[][] = warmHit
        ? []
        : [["init", "-q"], ["remote", "add", "origin", repo.url!]];
      steps.push(
        ["fetch", "-q", ...depth, "origin", repo.ref ?? "HEAD"],
        ["checkout", "-q", "-f", "--detach", "FETCH_HEAD"],
      );
      if (warmHit) steps.push(["clean", "-fdq"]);
      for (const step of steps) {
        expectOk(await exec("git", step, { timeoutMs: 600_000 }), `git ${step[0]} in sandbox`);
      }
      if (warmKey && !warmHit) {
        // A warm snapshot is an optimisation; a full disk must not fail the task.
        await commit(warmKey, "warm", {
          repo: repo.url!,
          ref: repo.ref ?? "HEAD",
          worker: ctx.worker.id,
        }).catch(() => undefined);
      }
    }
  } catch (err) {
    await dispose();
    throw err;
  }

  return {
    id: name,
    kind: "docker",
    cwd: SANDBOX_WORKDIR,
    hostCwd,
    imageRef: startImage,
    exec,
    async resolveBin(bin) {
      const probe = bin.includes("/")
        ? await exec("test", ["-x", bin])
        : await exec("sh", ["-c", 'command -v "$1"', "sh", bin]);
      if (probe.code !== 0) return undefined;
      return bin.includes("/") ? bin : probe.stdout.trim().split("\n")[0] || bin;
    },
    snapshot(label) {
      return commit(taskSnapshotKey(label, image.digest), "task", {
        worker: ctx.worker.id,
        agent: ctx.worker.agent,
        task: ctx.taskId ?? label,
      });
    },
    async copyOut(src, dest) {
      expectOk(await docker(["cp", `${name}:${src}`, dest]), `docker cp ${src}`);
    },
    dispose,
  };
}

function ensureHostWorktree(ctx: SandboxAcquireContext): string {
  const existing = ctx.worker.worktree;
  return existing && existsSync(existing) ? existing : ensureWorktree(ctx.root, ctx.worker);
}

function mkScratch(root: string, workerId: string): string {
  const dir = scratchPath(root, workerId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const dockerProvider: SandboxProvider = {
  kind: "docker",
  label: "Docker container per task",
  probe(env = process.env) {
    const bin = binOnPath(resolveContainerBin(env), env);
    return {
      kind: "docker",
      label: "Docker container per task",
      ready: Boolean(bin),
      bin,
      hint: bin
        ? `Ready — ${bin} on PATH. Environment images are built on first use and cached as ropex-env:<digest>.`
        : "Install Docker or Podman (or set ROPEX_CONTAINER_BIN) to use provider: docker.",
    };
  },
  acquire: acquireDockerSandbox,
};

export type SandboxGcResult = {
  removedContainers: string[];
  keptContainers: string[];
  removedScratch: string[];
  skipped?: string;
};

const LIVE_STATUSES = new Set(["running", "pending"]);

/** True when any desired agent or live worker uses a docker sandbox. */
export function usesDockerSandbox(state: ClusterState): boolean {
  return (
    state.desired.some((a) => a.spec.sandbox?.provider === "docker") ||
    state.workers.some((w) => w.sandbox?.provider === "docker")
  );
}

export type SandboxContainer = { name: string; worker: string };

export function listSandboxContainers(run: DockerSync): SandboxContainer[] | string {
  const listed = run([
    "ps",
    "-a",
    "--filter",
    `label=${SANDBOX_LABEL}=1`,
    "--format",
    '{{.Names}}\t{{.Label "ropex.worker"}}',
  ]);
  if (listed.code !== 0) return listed.stderr.trim() || `ps exited ${listed.code}`;
  return listed.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([name]) => name?.trim())
    .map(([name, worker]) => ({ name: name.trim(), worker: (worker ?? "").trim() }));
}

/**
 * Remove sandbox containers and scratch directories whose worker is gone.
 * A worker that is `running` or `pending` keeps its sandbox; everything else is orphaned.
 */
export function gcOrphanSandboxes(
  root: string,
  state: ClusterState,
  opts: { docker?: DockerSync; env?: NodeJS.ProcessEnv } = {},
): SandboxGcResult {
  const env = opts.env ?? process.env;
  const result: SandboxGcResult = { removedContainers: [], keptContainers: [], removedScratch: [] };
  // Never touch containers on a host whose fleet does not use docker sandboxes: the
  // containers may belong to another control plane.
  if (!usesDockerSandbox(state)) {
    result.skipped = "no docker sandbox declared";
    return result;
  }
  const live = new Set(
    state.workers.filter((w) => LIVE_STATUSES.has(w.status)).map((w) => w.id),
  );

  const scratch = join(root, SCRATCH_ROOT);
  if (existsSync(scratch)) {
    const liveSlugs = new Set([...live].map(worktreeSlug));
    for (const name of readdirSync(scratch)) {
      if (liveSlugs.has(name)) continue;
      rmSync(join(scratch, name), { recursive: true, force: true });
      result.removedScratch.push(name);
    }
  }

  const run = opts.docker ?? (binOnPath(resolveContainerBin(env), env) ? defaultDockerSync(env) : undefined);
  if (!run) {
    result.skipped = "no container runtime on PATH";
    return result;
  }
  const listed = listSandboxContainers(run);
  if (typeof listed === "string") {
    result.skipped = listed;
    return result;
  }
  for (const { name, worker } of listed) {
    if (worker && live.has(worker)) {
      result.keptContainers.push(name);
      continue;
    }
    run(["rm", "-f", name]);
    result.removedContainers.push(name);
  }
  return result;
}

/** Best-effort synchronous removal, for call sites that cannot await (`destroyWorker`). */
export function removeContainerSync(
  name: string,
  opts: { docker?: DockerSync; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const env = opts.env ?? process.env;
  const run = opts.docker ?? (binOnPath(resolveContainerBin(env), env) ? defaultDockerSync(env) : undefined);
  if (!run) return false;
  try {
    return run(["rm", "-f", name]).code === 0;
  } catch {
    return false;
  }
}
