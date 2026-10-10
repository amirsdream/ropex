/**
 * Pick one auth strategy for a CLI runtime.
 * The fleet names the method. This module checks which material is present.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { RuntimeAuthMethod } from "../types.js";
import type {
  AuthApply,
  AuthApplyInput,
  AuthProbe,
  CliRuntimeDescriptor,
  RuntimeAuthStrategy,
  SelectedAuth,
} from "./types.js";

export function authProbe(
  env: NodeJS.ProcessEnv,
  extra: { fileExists?: (path: string) => boolean; homedir?: () => string } = {},
): AuthProbe {
  return {
    env,
    fileExists: extra.fileExists ?? existsSync,
    homedir: extra.homedir ?? homedir,
  };
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function strategyHint(strategy: RuntimeAuthStrategy): string {
  if (strategy.env.length) return `Set one of: ${strategy.env.join(", ")}.`;
  const file = strategy.defaultFile ?? "a credential file";
  const override = strategy.fileEnv ? `, or set ${strategy.fileEnv}` : "";
  return `Provide ${file}${override}.`;
}

function missingAuthMessage(descriptor: CliRuntimeDescriptor): string {
  const parts = descriptor.auth.map((strategy) => {
    if (strategy.method === "oauth-file") {
      return `${strategy.defaultFile ?? "credential file"} (${strategy.method})`;
    }
    return `${strategy.env.join(" or ")} (${strategy.method})`;
  });
  return `${descriptor.label} requires one of: ${parts.join("; ")}`;
}

/** An override path must use the same filename as the strategy's default file. */
function assertCredentialFile(strategy: RuntimeAuthStrategy, path: string): void {
  const expected = strategy.defaultFile ? basename(strategy.defaultFile) : "";
  if (expected && basename(path) !== expected) {
    throw new Error(`credential file must be named ${expected}: ${path}`);
  }
}

function strategyMaterial(strategy: RuntimeAuthStrategy, probe: AuthProbe): SelectedAuth | undefined {
  if (strategy.method === "oauth-file") {
    const override = strategy.fileEnv ? probe.env[strategy.fileEnv]?.trim() : undefined;
    if (override) {
      if (!probe.fileExists(override)) {
        throw new Error(`${strategy.fileEnv} points at ${override}, which is not a file`);
      }
      assertCredentialFile(strategy, override);
      return { method: strategy.method, hostFile: override };
    }
    if (!strategy.defaultFile) return undefined;
    const path = expandHome(strategy.defaultFile, probe.homedir());
    if (!probe.fileExists(path)) return undefined;
    assertCredentialFile(strategy, path);
    return { method: strategy.method, hostFile: path };
  }
  const envName = strategy.env.find((name) => probe.env[name]?.trim());
  if (!envName) return undefined;
  return { method: strategy.method, envName };
}

/**
 * Pick one auth strategy.
 * An explicit `spec.runtime.auth` must have its material.
 * With no request, exactly one available strategy is used.
 * More than one available strategy fails until the fleet names one.
 */
export function selectRuntimeAuth(
  descriptor: CliRuntimeDescriptor,
  requested: RuntimeAuthMethod | undefined,
  probe: AuthProbe,
): SelectedAuth {
  if (requested) {
    const strategy = descriptor.auth.find((item) => item.method === requested);
    if (!strategy) {
      const supported = descriptor.auth.map((item) => item.method).join(" | ") || "none";
      throw new Error(
        `${descriptor.label} does not support auth ${requested} (expected ${supported})`,
      );
    }
    const material = strategyMaterial(strategy, probe);
    if (!material) {
      throw new Error(
        `${descriptor.label} auth ${requested} has no credentials. ${strategyHint(strategy)}`,
      );
    }
    return material;
  }
  const ready: SelectedAuth[] = [];
  for (const strategy of descriptor.auth) {
    const material = strategyMaterial(strategy, probe);
    if (material) ready.push(material);
  }
  if (ready.length === 1) return ready[0];
  if (ready.length === 0) throw new Error(missingAuthMessage(descriptor));
  throw new Error(
    `${descriptor.label} has more than one auth method available (${ready.map((item) => item.method).join(", ")}). Set spec.runtime.auth.`,
  );
}

/** Claude and Copilot read the env var themselves, so auth adds no flags. */
export function envApplyAuth(label: string, input: AuthApplyInput): AuthApply {
  if (input.baseUrl) throw new Error("runtime.baseUrl applies to codex auth api-key");
  if (input.method === "oauth-file") throw new Error(`${label} does not support auth oauth-file`);
  if (!input.envName) throw new Error(`${label} auth ${input.method} requires an environment variable`);
  return { args: [], env: [input.envName], injectEnv: {} };
}
