/**
 * Declarative descriptors for external headless coding-agent CLIs.
 *
 * Every CLI is one record — argv shape, policy translation, output parsing — so
 * flag drift between releases is a one-line fix here rather than a refactor, and
 * adding a fourth CLI is a new record plus a `WorkerRuntimeKind` member.
 *
 * Pure functions only: nothing in this module spawns a process, which is what
 * keeps it unit-testable with no network and no API keys.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { RuntimeAuthMethod, WorkerRuntimeKind } from "./types.js";

export type CliRuntimeKind = Exclude<WorkerRuntimeKind, "dsh">;

export type PromptChannel = "stdin" | "argv";

export type CliArgvInput = {
  /** The composed brief — soul, memory, skills, plan, task. */
  prompt: string;
  model?: string;
  cwd: string;
  /** Flags produced by `permissions()` for this run. */
  permissionArgs: string[];
  /** Flags from the selected auth strategy. Placement is per CLI. */
  authArgs?: string[];
};

export type PolicyInput = {
  deny: string[];
  requireApproval: string[];
};

export type PermissionPlan = {
  /** Flags to append to argv. */
  args: string[];
  /**
   * Declared tool denials this CLI cannot express. Non-empty ⇒ the runtime
   * refuses to boot rather than running a weaker gate than the policy declares.
   */
  unmappable: string[];
  /**
   * Deny entries that name no known Ropex tool (`prod-write`, `exfiltrate`, …).
   * Nothing registers a tool under these names, so the embedded harness does not
   * gate them either. They are injected into the brief as prohibitions instead
   * of failing the boot — being stricter than `dsh` here would break policies
   * that ship today.
   */
  advisory: string[];
};

/**
 * One way this CLI can authenticate.
 * `env` strategies forward a variable by name. `oauth-file` reads a host file
 * and, inside Docker, bind-mounts its directory read-only.
 */
export type RuntimeAuthStrategy = {
  method: RuntimeAuthMethod;
  /** Env vars that satisfy this strategy. The first one set is selected. */
  env: string[];
  /** Host credential file. `~` is the home directory. */
  defaultFile?: string;
  /** Env var whose value replaces `defaultFile`. */
  fileEnv?: string;
  /** Container directory that receives the credential directory. */
  mountTarget?: string;
  /** Set to the mount target so the CLI reads that directory. Not a secret. */
  homeEnv?: string;
};

export type AuthProbe = {
  env: NodeJS.ProcessEnv;
  fileExists: (path: string) => boolean;
  homedir: () => string;
};

export type SelectedAuth = {
  method: RuntimeAuthMethod;
  /** Chosen env var, for an env strategy. */
  envName?: string;
  /** Host credential file, for `oauth-file`. */
  hostFile?: string;
};

export type AuthApplyInput = SelectedAuth & {
  baseUrl?: string;
  /** Execute is already inside a Ropex container. */
  container: boolean;
  /** Home directory for host credential paths. Defaults to the process home. */
  homeDir?: string;
};

export type AuthMount = {
  source: string;
  target: string;
};

/** What boot forwards and which argv the strategy adds. */
export type AuthApply = {
  args: string[];
  /** Secret env names to forward into an isolate. Values stay off argv. */
  env: string[];
  /** Non-secret env for this run, such as `CODEX_HOME` inside the container. */
  injectEnv: Record<string, string>;
  /** Read-only bind for `docker run`. Absent on the host and for env strategies. */
  mount?: AuthMount;
};

export type PreparedRuntimeAuth = {
  method: RuntimeAuthMethod;
  args: string[];
  env: string[];
  injectEnv: Record<string, string>;
  mount?: AuthMount;
};

export type CliRuntimeDescriptor = {
  kind: CliRuntimeKind;
  /** Default binary name, resolved on PATH unless `spec.runtime.command` overrides it. */
  bin: string;
  /** Env vars gathered from the auth strategies. First match wins for probes. */
  credentialEnv: string[];
  /** Auth strategies this CLI accepts, in selection order. */
  auth: RuntimeAuthStrategy[];
  defaultModel?: string;
  label: string;
  docsUrl: string;
  /**
   * How the composed brief is delivered. `stdin` avoids ARG_MAX; `argv` is for
   * CLIs whose programmatic mode requires `-p <prompt>` as a flag value.
   */
  promptChannel: PromptChannel;
  argv(input: CliArgvInput): string[];
  permissions(policy: PolicyInput): PermissionPlan;
  /**
   * Extra argv when execute already runs inside a Ropex container.
   * Replaces a same-named flag from `permissions()` (Codex `--sandbox`).
   */
  containerArgs(policy: PolicyInput): string[];
  /** Turn the selected strategy into argv, env names, and an optional mount. */
  applyAuth(input: AuthApplyInput): AuthApply;
  /**
   * `isError` covers CLIs that report failure in their payload while still
   * exiting 0 — the adapter must not read that as a successful run.
   */
  parse(stdout: string, stderr: string): { observations: string[]; raw: string; isError?: boolean };
};

/**
 * Tool names the Ropex harness actually registers (`PROFILE_TOOLS` in
 * `harness.ts`, plus the memory port). A deny entry outside this set gates
 * nothing today and is treated as advisory.
 */
export const KNOWN_ROPEX_TOOLS = [
  "fs",
  "shell",
  "bash",
  "web",
  "github",
  "subagent",
  "inspect",
  "str_replace_editor",
  "memory",
] as const;

export function isKnownRopexTool(name: string): boolean {
  return (KNOWN_ROPEX_TOOLS as readonly string[]).includes(name);
}

/**
 * Split declared denials into ones this CLI must translate and ones that are
 * advisory. `requireApproval` folds into deny: a headless CLI cannot pause for
 * a Ropex approval mid-run, so the conservative reading is to forbid outright.
 */
export function classifyPolicy(policy: PolicyInput): {
  toolDenies: string[];
  advisory: string[];
} {
  const all = [...new Set([...policy.deny, ...policy.requireApproval])];
  return {
    toolDenies: all.filter(isKnownRopexTool),
    advisory: all.filter((name) => !isKnownRopexTool(name)),
  };
}

/**
 * Translate tool denials through a lookup table.
 * `[]` means the CLI never exposes that capability (deny trivially satisfied);
 * `undefined` means it cannot be expressed → unmappable → fail closed.
 */
function mapDenies(
  toolDenies: string[],
  table: Record<string, string[] | undefined>,
): { patterns: string[]; unmappable: string[] } {
  const patterns: string[] = [];
  const unmappable: string[] = [];
  for (const tool of toolDenies) {
    const mapped = table[tool];
    if (mapped === undefined) {
      unmappable.push(tool);
      continue;
    }
    patterns.push(...mapped);
  }
  return { patterns: [...new Set(patterns)], unmappable };
}

/** Ropex tool → Claude Code tool names. */
const CLAUDE_TOOL_MAP: Record<string, string[] | undefined> = {
  fs: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
  str_replace_editor: ["Edit", "Write"],
  shell: ["Bash"],
  bash: ["Bash"],
  web: ["WebFetch", "WebSearch"],
  github: ["Bash(gh:*)"],
  subagent: ["Task"],
  // Ropex-internal: never surfaced to the CLI, so the denial already holds.
  memory: [],
  inspect: undefined,
};

/** Ropex tool → Copilot CLI tool names. */
const COPILOT_TOOL_MAP: Record<string, string[] | undefined> = {
  fs: ["write"],
  str_replace_editor: ["write"],
  shell: ["shell"],
  bash: ["shell"],
  github: ["github"],
  memory: [],
  web: undefined,
  subagent: undefined,
  inspect: undefined,
};

function textFallback(stdout: string, stderr: string): { observations: string[]; raw: string } {
  const raw = stdout.trim() || stderr.trim();
  return { observations: raw ? [raw] : [], raw };
}

/** Parse newline-delimited JSON, ignoring blank and non-JSON lines. */
function jsonLines(stdout: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") out.push(parsed as Record<string, unknown>);
    } catch {
      // partial or interleaved output — skip
    }
  }
  return out;
}

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Container directory for a Codex login file. Bind-mounted, so a snapshot omits it. */
export const CODEX_AUTH_MOUNT = "/run/ropex/auth/codex";

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

function assertCodexAuthFile(path: string): void {
  if (basename(path) !== "auth.json") {
    throw new Error(`codex credential file must be named auth.json: ${path}`);
  }
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

function strategyMaterial(strategy: RuntimeAuthStrategy, probe: AuthProbe): SelectedAuth | undefined {
  if (strategy.method === "oauth-file") {
    const override = strategy.fileEnv ? probe.env[strategy.fileEnv]?.trim() : undefined;
    if (override) {
      if (!probe.fileExists(override)) {
        throw new Error(`${strategy.fileEnv} points at ${override}, which is not a file`);
      }
      assertCodexAuthFile(override);
      return { method: strategy.method, hostFile: override };
    }
    if (!strategy.defaultFile) return undefined;
    const path = expandHome(strategy.defaultFile, probe.homedir());
    if (!probe.fileExists(path)) return undefined;
    assertCodexAuthFile(path);
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

/** Host Codex reads `~/.codex/auth.json` unless the file lives somewhere else. */
function hostCodexHome(hostFile: string, homeDir: string): Record<string, string> {
  const home = dirname(resolve(hostFile));
  const standard = resolve(join(homeDir, ".codex"));
  if (home === standard) return {};
  return { CODEX_HOME: home };
}

const CODEX_OAUTH_FILE: RuntimeAuthStrategy = {
  method: "oauth-file",
  env: [],
  defaultFile: "~/.codex/auth.json",
  fileEnv: "ROPEX_AUTH_FILE_CODEX",
  mountTarget: CODEX_AUTH_MOUNT,
  homeEnv: "CODEX_HOME",
};

function codexApplyAuth(input: AuthApplyInput): AuthApply {
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

function envApplyAuth(label: string, input: AuthApplyInput): AuthApply {
  if (input.baseUrl) throw new Error("runtime.baseUrl applies to codex auth api-key");
  if (input.method === "oauth-file") throw new Error(`${label} does not support auth oauth-file`);
  if (!input.envName) throw new Error(`${label} auth ${input.method} requires an environment variable`);
  return { args: [], env: [input.envName], injectEnv: {} };
}

function mergeContainerArgs(args: string[], extra: string[]): string[] {
  if (!extra.length) return args;
  const next = [...args];
  const consumed = new Set<number>();
  for (let i = 0; i < extra.length; i++) {
    const flag = extra[i];
    if (!flag.startsWith("--")) continue;
    const value = extra[i + 1];
    const hasValue = value !== undefined && !value.startsWith("-");
    const idx = next.indexOf(flag);
    if (idx !== -1 && (!hasValue || idx + 1 < next.length)) {
      if (hasValue) next[idx + 1] = value;
      consumed.add(i);
      if (hasValue) consumed.add(i + 1);
    }
    if (hasValue) i += 1;
  }
  const tail = extra.filter((_, index) => !consumed.has(index));
  return tail.length ? [...next, ...tail] : next;
}

/** Permission flags for a host run, or for a run that is already inside a container. */
export function permissionPlan(
  descriptor: CliRuntimeDescriptor,
  policy: PolicyInput,
  opts: { container: boolean },
): PermissionPlan {
  const plan = descriptor.permissions(policy);
  if (!opts.container) return plan;
  return { ...plan, args: mergeContainerArgs(plan.args, descriptor.containerArgs(policy)) };
}

function cliDescriptor(record: Omit<CliRuntimeDescriptor, "credentialEnv">): CliRuntimeDescriptor {
  return {
    ...record,
    credentialEnv: record.auth.flatMap((strategy) => strategy.env),
  };
}

export const CLI_RUNTIMES: Record<CliRuntimeKind, CliRuntimeDescriptor> = {
  "claude-code": cliDescriptor({
    kind: "claude-code",
    bin: "claude",
    auth: [
      { method: "api-key", env: ["ANTHROPIC_API_KEY"] },
      { method: "oauth", env: ["CLAUDE_CODE_OAUTH_TOKEN"] },
    ],
    label: "Claude Code CLI",
    docsUrl: "https://docs.claude.com/en/docs/claude-code/cli-reference",
    // `-p` is boolean (--print). The brief goes on stdin so large souls do not
    // hit ARG_MAX; a positional prompt after `-p` would also be swallowed by
    // the variadic `--disallowedTools` list if it were placed last.
    promptChannel: "stdin",
    argv({ model, permissionArgs }) {
      return [
        "-p",
        "--output-format",
        "json",
        ...(model ? ["--model", model] : []),
        ...permissionArgs,
      ];
    },
    permissions(policy) {
      const { toolDenies, advisory } = classifyPolicy(policy);
      const { patterns, unmappable } = mapDenies(toolDenies, CLAUDE_TOOL_MAP);
      // Headless runs cannot answer an interactive permission prompt.
      const args = ["--permission-mode", "acceptEdits"];
      // `--disallowedTools <tools...>` is variadic: one arg per pattern.
      // Comma-joining them yields a single bogus tool name that matches nothing,
      // which would silently enforce no gate at all. Keep it last in argv.
      if (patterns.length) args.push("--disallowedTools", ...patterns);
      return { args, unmappable, advisory };
    },
    containerArgs() {
      return [];
    },
    applyAuth(input) {
      return envApplyAuth("Claude Code CLI", input);
    },
    parse(stdout, stderr) {
      // `--output-format json` emits a single result envelope.
      const trimmed = stdout.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed) as
            | { result?: unknown; is_error?: boolean }
            | Array<Record<string, unknown>>;
          const envelope = (Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed) as {
            result?: unknown;
            is_error?: unknown;
          };
          const isError = envelope?.is_error === true;
          const result = envelope?.result;
          if (typeof result === "string" && result.trim()) {
            return { observations: [result.trim()], raw: trimmed, isError };
          }
          if (isError) {
            return { observations: [], raw: trimmed, isError: true };
          }
        } catch {
          // fall through to raw text
        }
      }
      return textFallback(stdout, stderr);
    },
  }),

  codex: cliDescriptor({
    kind: "codex",
    bin: "codex",
    auth: [
      { method: "api-key", env: ["OPENAI_API_KEY", "CODEX_API_KEY"] },
      CODEX_OAUTH_FILE,
    ],
    label: "Codex CLI",
    docsUrl: "https://developers.openai.com/codex/cli",
    // `codex exec` reads the prompt from stdin when the positional is omitted.
    promptChannel: "stdin",
    argv({ model, cwd, permissionArgs, authArgs }) {
      return [
        "exec",
        "--json",
        "--cd",
        cwd,
        ...(model ? ["--model", model] : []),
        ...(authArgs ?? []),
        ...permissionArgs,
      ];
    },
    permissions(policy) {
      const { toolDenies, advisory } = classifyPolicy(policy);
      // Codex gates by sandbox level, not per tool. A host run uses
      // workspace-write. A container replaces that via containerArgs.
      const blocksWrite = toolDenies.some((t) => t === "fs" || t === "str_replace_editor");
      const blocksShell = toolDenies.some((t) => t === "shell" || t === "bash");
      const sandbox = blocksWrite || blocksShell ? "read-only" : "workspace-write";
      const expressible = new Set(["fs", "str_replace_editor", "shell", "bash", "memory"]);
      const unmappable = toolDenies.filter((t) => !expressible.has(t));
      // `approval_policy=never` is required for headless exec — without it a
      // sandbox escalation can block on an interactive prompt until timeout.
      return {
        args: ["--sandbox", sandbox, "-c", "approval_policy=never"],
        unmappable,
        advisory,
      };
    },
    containerArgs(policy) {
      const { toolDenies } = classifyPolicy(policy);
      const blocksWrite = toolDenies.some((t) => t === "fs" || t === "str_replace_editor");
      const blocksShell = toolDenies.some((t) => t === "shell" || t === "bash");
      // workspace-write needs a user namespace. The container sets
      // no-new-privileges, so that namespace cannot be created.
      if (blocksWrite || blocksShell) return [];
      return ["--sandbox", "danger-full-access"];
    },
    applyAuth: codexApplyAuth,
    parse(stdout, stderr) {
      const events = jsonLines(stdout);
      const messages: string[] = [];
      for (const event of events) {
        const msg = event.message ?? event.text ?? (event.item as { text?: unknown })?.text;
        if (typeof msg === "string" && msg.trim()) messages.push(msg.trim());
      }
      if (messages.length) {
        return { observations: [messages[messages.length - 1]], raw: stdout.trim() };
      }
      return textFallback(stdout, stderr);
    },
  }),

  copilot: cliDescriptor({
    kind: "copilot",
    bin: "copilot",
    auth: [{ method: "api-key", env: ["GITHUB_TOKEN", "COPILOT_CLI_TOKEN", "GH_TOKEN"] }],
    label: "GitHub Copilot CLI",
    docsUrl: "https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli",
    // Programmatic mode requires `-p <prompt>` as a flag value (not a boolean).
    promptChannel: "argv",
    argv({ prompt, model, permissionArgs }) {
      return [
        "-p",
        prompt,
        "--log-level",
        "error",
        ...(model ? ["--model", model] : []),
        ...permissionArgs,
      ];
    },
    permissions(policy) {
      const { toolDenies, advisory } = classifyPolicy(policy);
      const { patterns, unmappable } = mapDenies(toolDenies, COPILOT_TOOL_MAP);
      // `--allow-all-tools` is required for headless `-p` runs; without it
      // Copilot prompts for every tool and the worker hangs until timeout.
      // `--deny-tool` still wins over allow-all.
      const args = [
        "--allow-all-tools",
        ...patterns.flatMap((tool) => ["--deny-tool", tool]),
      ];
      return { args, unmappable, advisory };
    },
    containerArgs() {
      return [];
    },
    applyAuth(input) {
      return envApplyAuth("GitHub Copilot CLI", input);
    },
    parse(stdout, stderr) {
      return textFallback(stdout, stderr);
    },
  }),
};

export function cliRuntime(kind: CliRuntimeKind): CliRuntimeDescriptor {
  return CLI_RUNTIMES[kind];
}

export const CLI_RUNTIME_KINDS = Object.keys(CLI_RUNTIMES) as CliRuntimeKind[];
