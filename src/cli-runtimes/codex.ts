/**
 * Codex CLI adapter: HTTPS API-key provider, ChatGPT login file, and the
 * container sandbox flag. Other harnesses do not import this module.
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { classifyPolicy } from "./policy.js";
import type { AuthApply, AuthApplyInput, PermissionPlan, PolicyInput, RuntimeAuthStrategy } from "./types.js";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Container directory for a Codex login file. Bind-mounted, so a snapshot omits it. */
export const CODEX_AUTH_MOUNT = "/run/ropex/auth/codex";

export const CODEX_API_KEY: RuntimeAuthStrategy = {
  method: "api-key",
  env: ["OPENAI_API_KEY", "CODEX_API_KEY"],
};

export const CODEX_OAUTH_FILE: RuntimeAuthStrategy = {
  method: "oauth-file",
  env: [],
  defaultFile: "~/.codex/auth.json",
  fileEnv: "ROPEX_AUTH_FILE_CODEX",
  mountTarget: CODEX_AUTH_MOUNT,
  homeEnv: "CODEX_HOME",
};

export function isHttpsBaseUrl(value: string): boolean {
  if (value.includes('"') || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/**
 * Codex `api-key` strategy. The default provider reads `~/.codex/auth.json`
 * and opens the Responses websocket, which rejects an API key. These `-c`
 * overrides select a provider that reads the named env var and speaks HTTPS.
 * The value of the key is not in argv.
 */
export function codexApiKeyConfig(envName: string, baseUrl = DEFAULT_OPENAI_BASE_URL): string[] {
  if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) {
    throw new Error(`codex api key env name is not an environment variable: ${envName}`);
  }
  if (!isHttpsBaseUrl(baseUrl)) {
    throw new Error(`runtime.baseUrl must be an https URL without embedded credentials`);
  }
  const provider = "ropex";
  const pairs: Array<[string, string]> = [
    ["model_provider", `"${provider}"`],
    [`model_providers.${provider}.name`, '"Ropex OpenAI"'],
    [`model_providers.${provider}.base_url`, `"${baseUrl}"`],
    [`model_providers.${provider}.env_key`, `"${envName}"`],
    [`model_providers.${provider}.wire_api`, '"responses"'],
    [`model_providers.${provider}.requires_openai_auth`, "false"],
    [`model_providers.${provider}.supports_websockets`, "false"],
  ];
  return pairs.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

function codexBlocked(policy: PolicyInput): { blocked: boolean; plan: ReturnType<typeof classifyPolicy> } {
  const plan = classifyPolicy(policy);
  const blocksWrite = plan.toolDenies.some((tool) => tool === "fs" || tool === "str_replace_editor");
  const blocksShell = plan.toolDenies.some((tool) => tool === "shell" || tool === "bash");
  return { blocked: blocksWrite || blocksShell, plan };
}

/** Host Codex uses workspace-write. A container replaces that in `codexContainerArgs`. */
export function codexPermissions(policy: PolicyInput): PermissionPlan {
  const { blocked, plan } = codexBlocked(policy);
  const expressible = new Set(["fs", "str_replace_editor", "shell", "bash", "memory"]);
  return {
    args: ["--sandbox", blocked ? "read-only" : "workspace-write", "-c", "approval_policy=never"],
    unmappable: plan.toolDenies.filter((tool) => !expressible.has(tool)),
    advisory: plan.advisory,
  };
}

/**
 * workspace-write needs a user namespace. The container sets no-new-privileges,
 * so that namespace cannot be created. A denied fs or shell stays read-only.
 */
export function codexContainerArgs(policy: PolicyInput): string[] {
  if (codexBlocked(policy).blocked) return [];
  return ["--sandbox", "danger-full-access"];
}

/** Host Codex reads `~/.codex/auth.json` unless the file lives somewhere else. */
function hostCodexHome(hostFile: string, homeDir: string): Record<string, string> {
  const home = dirname(resolve(hostFile));
  const standard = resolve(join(homeDir, ".codex"));
  if (home === standard) return {};
  return { CODEX_HOME: home };
}

export function codexApplyAuth(input: AuthApplyInput): AuthApply {
  if (input.method === "api-key") {
    if (!input.envName) throw new Error("codex api-key auth requires an environment variable");
    return {
      args: codexApiKeyConfig(input.envName, input.baseUrl),
      env: [input.envName],
      injectEnv: {},
    };
  }
  if (input.method === "oauth-file") {
    if (input.baseUrl) throw new Error("runtime.baseUrl applies to codex auth api-key");
    if (!input.hostFile) throw new Error("codex oauth-file auth requires a credential file");
    const homeEnv = CODEX_OAUTH_FILE.homeEnv ?? "CODEX_HOME";
    const target = CODEX_OAUTH_FILE.mountTarget ?? CODEX_AUTH_MOUNT;
    if (!input.container) {
      return { args: [], env: [], injectEnv: hostCodexHome(input.hostFile, input.homeDir ?? homedir()) };
    }
    return {
      args: [],
      env: [],
      injectEnv: { [homeEnv]: target },
      mount: { source: dirname(input.hostFile), target },
    };
  }
  throw new Error(`codex has no ${input.method} auth`);
}
