/**
 * Cursor Agent CLI adapter: API key, login file, and the container sandbox flag.
 * Other harnesses do not import this module.
 *
 * Flags follow https://cursor.com/docs/cli/reference/parameters and
 * https://cursor.com/docs/cli/reference/authentication. The key stays in
 * `CURSOR_API_KEY`. It is never placed on argv (`--api-key` would).
 */

import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { classifyPolicy, mapDenies } from "./policy.js";
import type { AuthApply, AuthApplyInput, PermissionPlan, PolicyInput, RuntimeAuthStrategy } from "./types.js";

/** Container directory for a Cursor login file. Bind-mounted, so a snapshot omits it. */
export const CURSOR_AUTH_MOUNT = "/run/ropex/auth/cursor";

/**
 * Cursor reads `$XDG_CONFIG_HOME/cursor/auth.json`. The mount is the `cursor`
 * directory, so the variable points at its parent.
 */
export const CURSOR_CONFIG_HOME = "/run/ropex/auth";

export const CURSOR_API_KEY: RuntimeAuthStrategy = {
  method: "api-key",
  env: ["CURSOR_API_KEY"],
};

export const CURSOR_OAUTH_FILE: RuntimeAuthStrategy = {
  method: "oauth-file",
  env: [],
  defaultFile: "~/.config/cursor/auth.json",
  fileEnv: "ROPEX_AUTH_FILE_CURSOR",
  mountTarget: CURSOR_AUTH_MOUNT,
  homeEnv: "XDG_CONFIG_HOME",
};

/** Tools Cursor's headless CLI cannot single out. `memory` is never exposed. */
const CURSOR_TOOL_MAP: Record<string, string[] | undefined> = {
  memory: [],
  fs: undefined,
  str_replace_editor: undefined,
  shell: undefined,
  bash: undefined,
  web: undefined,
  github: undefined,
  subagent: undefined,
  inspect: undefined,
};

function cursorBlocked(policy: PolicyInput): boolean {
  return mapDenies(classifyPolicy(policy).toolDenies, CURSOR_TOOL_MAP).unmappable.length > 0;
}

/**
 * Headless Cursor writes and runs commands when `--force` and `--trust` are set.
 * A denied tool has no flag, so the run refuses instead of enforcing less.
 */
export function cursorPermissions(policy: PolicyInput): PermissionPlan {
  const plan = classifyPolicy(policy);
  const { unmappable } = mapDenies(plan.toolDenies, CURSOR_TOOL_MAP);
  return {
    args: unmappable.length ? [] : ["--force", "--trust"],
    unmappable,
    advisory: plan.advisory,
  };
}

/**
 * Cursor's own sandbox needs privileges the container does not grant
 * (`no-new-privileges`). The container is the sandbox. A denied tool still
 * refuses the run in `cursorPermissions`.
 */
export function cursorContainerArgs(policy: PolicyInput): string[] {
  if (cursorBlocked(policy)) return [];
  return ["--sandbox", "disabled"];
}

/** Host Cursor reads `~/.config/cursor/auth.json` unless the file lives somewhere else. */
function hostCursorConfig(hostFile: string, homeDir: string): Record<string, string> {
  const file = resolve(hostFile);
  const standard = resolve(join(homeDir, ".config", "cursor", "auth.json"));
  if (file === standard) return {};
  const dir = dirname(file);
  if (basename(dir) !== "cursor") {
    throw new Error(`Cursor login file must live in a directory named cursor: ${hostFile}`);
  }
  return { XDG_CONFIG_HOME: dirname(dir) };
}

export function cursorApplyAuth(input: AuthApplyInput): AuthApply {
  if (input.baseUrl) throw new Error("runtime.baseUrl applies to codex auth api-key");
  if (input.method === "api-key") {
    if (!input.envName) throw new Error("Cursor CLI auth api-key requires an environment variable");
    return { args: [], env: [input.envName], injectEnv: {} };
  }
  if (input.method === "oauth-file") {
    if (!input.hostFile) throw new Error("Cursor CLI oauth-file auth requires a credential file");
    if (!input.container) {
      return {
        args: [],
        env: [],
        injectEnv: hostCursorConfig(input.hostFile, input.homeDir ?? homedir()),
      };
    }
    return {
      args: [],
      env: [],
      injectEnv: { XDG_CONFIG_HOME: CURSOR_CONFIG_HOME },
      mount: { source: dirname(input.hostFile), target: CURSOR_AUTH_MOUNT },
    };
  }
  throw new Error(`Cursor CLI has no ${input.method} auth`);
}

export function cursorParse(stdout: string, stderr: string): { observations: string[]; raw: string; isError?: boolean } {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as { result?: unknown; is_error?: unknown } | Array<Record<string, unknown>>;
      const envelope = (Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed) as {
        result?: unknown;
        is_error?: unknown;
      };
      const isError = envelope?.is_error === true;
      const result = envelope?.result;
      if (typeof result === "string" && result.trim()) {
        return { observations: [result.trim()], raw: trimmed, isError };
      }
      if (isError) return { observations: [], raw: trimmed, isError: true };
    } catch {
      // fall through to raw text
    }
  }
  const raw = trimmed || stderr.trim();
  return { observations: raw ? [raw] : [], raw };
}
