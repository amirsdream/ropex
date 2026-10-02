/**
 * Environment images — the "base image plus dependencies" a docker sandbox starts from.
 * The recipe renders to a Dockerfile; the image is tagged by the Dockerfile's digest, so
 * identical recipes (across agents, across restarts) share one image and a changed recipe
 * builds a new one. Nothing secret ever goes into an image.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { expectOk, type DockerRun } from "./client.js";
import { DEFAULT_SANDBOX_BASE, resolveAptPackages } from "./spec.js";
import type { SandboxSpec } from "../types.js";

export const ENV_IMAGE_REPO = "ropex-env";
export const SANDBOX_WORKDIR = "/workspace";

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Render the recipe. Deterministic: same recipe, same bytes. */
export function renderDockerfile(spec: SandboxSpec | undefined): string {
  const image = spec?.image;
  const lines = [
    `FROM ${image?.base ?? DEFAULT_SANDBOX_BASE}`,
    "ENV DEBIAN_FRONTEND=noninteractive PIP_BREAK_SYSTEM_PACKAGES=1 PIP_NO_CACHE_DIR=1",
    `RUN apt-get update && apt-get install -y --no-install-recommends ${resolveAptPackages(spec).join(" ")} && rm -rf /var/lib/apt/lists/*`,
  ];
  const npm = [...(image?.npm ?? [])].sort();
  if (npm.length) lines.push(`RUN npm install -g --no-fund --no-audit ${npm.map(quote).join(" ")}`);
  const pip = [...(image?.pip ?? [])].sort();
  if (pip.length) lines.push(`RUN pip3 install ${pip.map(quote).join(" ")}`);
  for (const step of image?.setup ?? []) lines.push(`RUN ${step}`);
  lines.push(`RUN mkdir -p ${SANDBOX_WORKDIR}`, `WORKDIR ${SANDBOX_WORKDIR}`, "");
  return lines.join("\n");
}

export type EnvImagePlan = {
  digest: string;
  ref: string;
  dockerfile: string;
  /** Build context directory (the Dockerfile's own directory for `image.dockerfile`). */
  context?: string;
  /** Dockerfile path when it lives in the workspace. */
  dockerfilePath?: string;
};

export function envImageRef(digest: string): string {
  return `${ENV_IMAGE_REPO}:${digest}`;
}

export function digestText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Work out the image a spec needs without touching docker. */
export function planEnvImage(spec: SandboxSpec | undefined, root: string): EnvImagePlan {
  const escape = spec?.image?.dockerfile;
  if (escape) {
    const path = resolve(root, escape);
    const dockerfile = readFileSync(path, "utf8");
    const digest = digestText(`file\n${dockerfile}`);
    return { digest, ref: envImageRef(digest), dockerfile, context: dirname(path), dockerfilePath: path };
  }
  const dockerfile = renderDockerfile(spec);
  const digest = digestText(dockerfile);
  return { digest, ref: envImageRef(digest), dockerfile };
}

export type EnsureEnvImageResult = EnvImagePlan & { built: boolean };

const inflight = new Map<string, Promise<boolean>>();

/** Build the environment image unless it is already present. */
export async function ensureEnvImage(
  docker: DockerRun,
  spec: SandboxSpec | undefined,
  root: string,
): Promise<EnsureEnvImageResult> {
  const plan = planEnvImage(spec, root);
  const pending = inflight.get(plan.ref);
  if (pending) return { ...plan, built: await pending };

  const work = (async () => {
    const present = await docker(["image", "inspect", "--format", "{{.Id}}", plan.ref]);
    if (present.code === 0) return false;

    let dir: string | undefined;
    try {
      let context = plan.context;
      let file = plan.dockerfilePath;
      if (!context || !file) {
        dir = mkdtempSync(join(tmpdir(), "ropex-env-"));
        file = join(dir, "Dockerfile");
        writeFileSync(file, plan.dockerfile);
        context = dir;
      }
      expectOk(
        await docker(["build", "--label", "ropex.managed=1", "-t", plan.ref, "-f", file, context], {
          timeoutMs: 1_800_000,
        }),
        `environment image build ${plan.ref}`,
      );
      return true;
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  })();
  inflight.set(plan.ref, work);
  try {
    return { ...plan, built: await work };
  } finally {
    inflight.delete(plan.ref);
  }
}
