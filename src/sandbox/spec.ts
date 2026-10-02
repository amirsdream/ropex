/**
 * Sandbox spec — validation, normalisation and policy checks.
 * Pure functions with no I/O so `spec.ts`, `image.ts` and the providers can share them.
 * Every value that reaches a generated Dockerfile or a docker argv is validated here.
 */

import type { Policy, SandboxProviderKind, SandboxSpec } from "../types.js";
import { SANDBOX_PROVIDER_KINDS_LIST } from "../types.js";

export const DEFAULT_SANDBOX_BASE = "node:22-bookworm";
export const DEFAULT_SANDBOX_PROVIDER: SandboxProviderKind = "local";

/** Named presets → apt packages. Presets assume a Debian/Ubuntu base image. */
export const SANDBOX_TOOL_PRESETS: Record<string, string[]> = {
  git: ["git"],
  gh: ["gh"],
  curl: ["curl", "ca-certificates"],
  web: ["curl", "wget", "ca-certificates"],
  ffmpeg: ["ffmpeg"],
  codecs: ["ffmpeg", "libavcodec-extra"],
  python: ["python3", "python3-pip"],
  build: ["build-essential"],
  jq: ["jq"],
  ripgrep: ["ripgrep"],
  chromium: ["chromium"],
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IMAGE_REF = /^[a-z0-9][A-Za-z0-9._\-/:@]*$/;
const APT_PKG = /^[a-z0-9][a-z0-9+.\-]*(=[A-Za-z0-9.+:~\-]+)?$/;
const NPM_PKG = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[A-Za-z0-9._\-^~*]+)?$/;
const PIP_PKG = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,_-]+\])?((==|>=|<=|~=|!=)[A-Za-z0-9.*+!_-]+)?$/;
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MEMORY = /^\d+(\.\d+)?[bkmg]?$/i;

function fail(where: string, message: string): never {
  throw new Error(`${where}: sandbox ${message}`);
}

function checkList(
  where: string,
  field: string,
  value: unknown,
  pattern: RegExp,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail(where, `${field} must be a list of strings`);
  }
  for (const item of value as string[]) {
    if (!pattern.test(item)) fail(where, `${field} entry "${item}" is not a valid name`);
  }
  return value as string[];
}

function singleLine(where: string, field: string, value: string): void {
  if (/[\r\n\0]/.test(value)) fail(where, `${field} must be a single line`);
}

/** Structural checks the `as Manifest` cast cannot make. */
export function validateSandboxSpec(raw: unknown, where: string): void {
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(where, "must be an object");
  }
  const sandbox = raw as Record<string, unknown>;
  const provider = (sandbox.provider ?? DEFAULT_SANDBOX_PROVIDER) as string;
  if (!SANDBOX_PROVIDER_KINDS_LIST.includes(provider as never)) {
    fail(
      where,
      `provider "${provider}" is unsupported (expected ${SANDBOX_PROVIDER_KINDS_LIST.join(" | ")})`,
    );
  }

  if (sandbox.env !== undefined) {
    const env = sandbox.env as Record<string, unknown>;
    if (!env || typeof env !== "object" || Array.isArray(env)) fail(where, "env must be a map");
    for (const [key, value] of Object.entries(env)) {
      if (!ENV_NAME.test(key)) fail(where, `env name "${key}" is invalid`);
      if (typeof value !== "string") fail(where, `env ${key} must be a string`);
      singleLine(where, `env ${key}`, value);
    }
  }
  checkList(where, "secrets", sandbox.secrets, ENV_NAME);

  if (provider === "local") {
    for (const field of ["image", "repo", "resources"]) {
      if (sandbox[field] !== undefined) fail(where, `${field} requires provider: docker`);
    }
    const life = sandbox.lifecycle as { after?: unknown; warmSnapshot?: unknown } | undefined;
    if (life?.after === "snapshot" || life?.warmSnapshot) {
      fail(where, "snapshots require provider: docker");
    }
    return;
  }

  const image = sandbox.image as Record<string, unknown> | undefined;
  if (image !== undefined) {
    if (!image || typeof image !== "object" || Array.isArray(image)) fail(where, "image must be an object");
    if (image.base !== undefined) {
      if (typeof image.base !== "string" || !IMAGE_REF.test(image.base)) {
        fail(where, `image.base "${String(image.base)}" is not a valid image reference`);
      }
    }
    const tools = checkList(where, "image.tools", image.tools, /^[a-z0-9-]+$/);
    for (const tool of tools ?? []) {
      if (!SANDBOX_TOOL_PRESETS[tool]) {
        fail(where, `image.tools "${tool}" is unknown (expected ${Object.keys(SANDBOX_TOOL_PRESETS).join(" | ")})`);
      }
    }
    checkList(where, "image.apt", image.apt, APT_PKG);
    checkList(where, "image.npm", image.npm, NPM_PKG);
    checkList(where, "image.pip", image.pip, PIP_PKG);
    if (image.setup !== undefined) {
      if (!Array.isArray(image.setup) || image.setup.some((s) => typeof s !== "string" || !s.trim())) {
        fail(where, "image.setup must be a list of non-empty strings");
      }
      for (const line of image.setup as string[]) singleLine(where, "image.setup entry", line);
    }
    if (image.dockerfile !== undefined) {
      if (typeof image.dockerfile !== "string" || !image.dockerfile.trim()) {
        fail(where, "image.dockerfile must be a path");
      }
      if (/^(\/|[A-Za-z]:)/.test(image.dockerfile) || image.dockerfile.split(/[\\/]/).includes("..")) {
        fail(where, "image.dockerfile must be a relative path inside the workspace");
      }
      const recipe = ["base", "tools", "apt", "npm", "pip", "setup"].filter((k) => image[k] !== undefined);
      if (recipe.length) {
        fail(where, `image.dockerfile cannot be combined with ${recipe.map((k) => `image.${k}`).join(", ")}`);
      }
    }
  }

  const repo = sandbox.repo as Record<string, unknown> | undefined;
  if (repo !== undefined) {
    if (!repo || typeof repo !== "object" || Array.isArray(repo)) fail(where, "repo must be an object");
    const workspace = (repo.workspace ?? "clone") as string;
    if (workspace !== "clone" && workspace !== "mount") {
      fail(where, `repo.workspace "${workspace}" is unsupported (expected clone | mount)`);
    }
    if (workspace === "clone") {
      if (typeof repo.url !== "string" || !repo.url.trim()) fail(where, "repo.url is required for workspace: clone");
      if (/\s/.test(repo.url) || repo.url.startsWith("-")) fail(where, "repo.url is not a valid remote");
    } else {
      for (const field of ["url", "ref", "depth"]) {
        if (repo[field] !== undefined) fail(where, `repo.${field} is not used with workspace: mount`);
      }
      if ((sandbox.lifecycle as { warmSnapshot?: unknown } | undefined)?.warmSnapshot) {
        fail(where, "warmSnapshot needs workspace: clone");
      }
    }
    if (repo.ref !== undefined && (typeof repo.ref !== "string" || !GIT_REF.test(repo.ref))) {
      fail(where, `repo.ref "${String(repo.ref)}" is invalid`);
    }
    if (repo.depth !== undefined && (!Number.isInteger(repo.depth) || (repo.depth as number) < 1)) {
      fail(where, "repo.depth must be a positive integer");
    }
    if (repo.tokenEnv !== undefined && (typeof repo.tokenEnv !== "string" || !ENV_NAME.test(repo.tokenEnv))) {
      fail(where, "repo.tokenEnv must be an environment variable name, not a token value");
    }
  } else if ((sandbox.lifecycle as { warmSnapshot?: unknown } | undefined)?.warmSnapshot) {
    fail(where, "lifecycle.warmSnapshot needs a repo to snapshot");
  }

  const res = sandbox.resources as Record<string, unknown> | undefined;
  if (res !== undefined) {
    if (!res || typeof res !== "object" || Array.isArray(res)) fail(where, "resources must be an object");
    if (res.cpus !== undefined && (typeof res.cpus !== "number" || !(res.cpus > 0))) {
      fail(where, "resources.cpus must be a positive number");
    }
    if (res.memory !== undefined && (typeof res.memory !== "string" || !MEMORY.test(res.memory))) {
      fail(where, "resources.memory must look like 512m or 4g");
    }
    if (res.pids !== undefined && (!Number.isInteger(res.pids) || (res.pids as number) < 1)) {
      fail(where, "resources.pids must be a positive integer");
    }
    if (res.network !== undefined && res.network !== "bridge" && res.network !== "none") {
      fail(where, "resources.network must be bridge | none");
    }
  }

  const life = sandbox.lifecycle as Record<string, unknown> | undefined;
  if (life !== undefined) {
    if (!life || typeof life !== "object" || Array.isArray(life)) fail(where, "lifecycle must be an object");
    if (life.after !== undefined && life.after !== "dispose" && life.after !== "snapshot") {
      fail(where, "lifecycle.after must be dispose | snapshot");
    }
    for (const field of ["keep", "ttlMs"]) {
      const v = life[field];
      if (v !== undefined && (!Number.isInteger(v) || (v as number) < 0)) {
        fail(where, `lifecycle.${field} must be a non-negative integer`);
      }
    }
  }
}

export function sandboxProvider(spec: SandboxSpec | undefined): SandboxProviderKind {
  return spec?.provider ?? DEFAULT_SANDBOX_PROVIDER;
}

/** apt packages after expanding presets, de-duplicated and sorted. */
export function resolveAptPackages(spec: SandboxSpec | undefined): string[] {
  const image = spec?.image;
  const pkgs = new Set<string>(["git", "ca-certificates"]);
  for (const tool of image?.tools ?? []) for (const p of SANDBOX_TOOL_PRESETS[tool] ?? []) pkgs.add(p);
  for (const p of image?.apt ?? []) pkgs.add(p);
  if (image?.pip?.length) {
    pkgs.add("python3");
    pkgs.add("python3-pip");
  }
  return [...pkgs].sort();
}

/** Canonical, order-stable form of a sandbox block. Feeds the agent image digest. */
export function canonicalSandbox(spec: SandboxSpec): Record<string, unknown> {
  const sorted = (xs?: string[]) => (xs ? [...xs].sort() : null);
  const sortedEnv = (env?: Record<string, string>) =>
    env ? Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) : null;
  return {
    provider: sandboxProvider(spec),
    image: spec.image
      ? {
          base: spec.image.base ?? null,
          tools: sorted(spec.image.tools),
          apt: sorted(spec.image.apt),
          npm: sorted(spec.image.npm),
          pip: sorted(spec.image.pip),
          setup: spec.image.setup ?? null,
          dockerfile: spec.image.dockerfile ?? null,
        }
      : null,
    repo: spec.repo
      ? {
          url: spec.repo.url ?? null,
          ref: spec.repo.ref ?? null,
          depth: spec.repo.depth ?? null,
          tokenEnv: spec.repo.tokenEnv ?? null,
          workspace: spec.repo.workspace ?? "clone",
        }
      : null,
    env: sortedEnv(spec.env),
    secrets: sorted(spec.secrets),
    resources: spec.resources
      ? {
          cpus: spec.resources.cpus ?? null,
          memory: spec.resources.memory ?? null,
          pids: spec.resources.pids ?? null,
          network: spec.resources.network ?? null,
        }
      : null,
    lifecycle: spec.lifecycle
      ? {
          after: spec.lifecycle.after ?? "dispose",
          warmSnapshot: spec.lifecycle.warmSnapshot ?? false,
          keep: spec.lifecycle.keep ?? null,
          ttlMs: spec.lifecycle.ttlMs ?? null,
        }
      : null,
  };
}

export function cloneSandboxSpec(spec: SandboxSpec): SandboxSpec {
  return structuredClone(spec);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export type SandboxPolicyDecision = { ok: true } | { ok: false; reason: string };

/** Fail closed when any Policy forbids what the agent asks of the sandbox layer. */
export function admitSandbox(policies: Policy[], spec: SandboxSpec | undefined): SandboxPolicyDecision {
  const provider = sandboxProvider(spec);
  for (const policy of policies) {
    const rules = policy.spec.sandbox;
    if (!rules) continue;
    if (rules.allowProviders && !rules.allowProviders.includes(provider)) {
      return {
        ok: false,
        reason: `policy ${policy.metadata.name} does not allow sandbox provider "${provider}" (allowed: ${rules.allowProviders.join(", ") || "none"})`,
      };
    }
    if (provider === "docker" && rules.allowBaseImages) {
      const base = spec?.image?.dockerfile ? undefined : (spec?.image?.base ?? DEFAULT_SANDBOX_BASE);
      if (!base) {
        return {
          ok: false,
          reason: `policy ${policy.metadata.name} restricts base images; image.dockerfile cannot be verified`,
        };
      }
      if (!rules.allowBaseImages.some((glob) => globToRegExp(glob).test(base))) {
        return {
          ok: false,
          reason: `policy ${policy.metadata.name} does not allow base image "${base}"`,
        };
      }
    }
  }
  return { ok: true };
}

/** Smallest `maxSnapshotBytes` across policies, if any. */
export function snapshotByteCap(policies: Policy[]): number | undefined {
  const caps = policies
    .map((p) => p.spec.sandbox?.maxSnapshotBytes)
    .filter((n): n is number => typeof n === "number");
  return caps.length ? Math.min(...caps) : undefined;
}
