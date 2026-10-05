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

import type { WorkerRuntimeKind } from "./types.js";

export type CliRuntimeKind = Exclude<WorkerRuntimeKind, "dsh">;

export type PromptChannel = "stdin" | "argv";

export type CliArgvInput = {
  /** The composed brief — soul, memory, skills, plan, task. */
  prompt: string;
  model?: string;
  cwd: string;
  /** Flags produced by `permissions()` for this run. */
  permissionArgs: string[];
  /**
   * Name of the env var that holds the API key (`OPENAI_API_KEY`, …).
   * Codex's default provider ignores this variable and reads `~/.codex/auth.json`.
   */
  apiKeyEnv?: string;
};

export type PolicyInput = {
  deny: string[];
  requireApproval: string[];
  /** Already inside a Ropex container. Codex must not start a nested sandbox. */
  isolated?: boolean;
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

export type CliRuntimeDescriptor = {
  kind: CliRuntimeKind;
  /** Default binary name, resolved on PATH unless `spec.runtime.command` overrides it. */
  bin: string;
  /** Any one of these env vars present ⇒ the runtime has credentials. */
  credentialEnv: string[];
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

/**
 * Codex's default provider reads `~/.codex/auth.json` and uses the Responses
 * websocket. A sandbox has no login file, and that websocket rejects an API
 * key that HTTPS accepts. These `-c` overrides select a provider that reads
 * the named env var and speaks HTTPS. The value of the key is not in argv.
 */
export function codexApiKeyConfig(envName: string): string[] {
  if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) {
    throw new Error(`codex api key env name is not an environment variable: ${envName}`);
  }
  const provider = "ropex";
  const pairs: Array<[string, string]> = [
    ["model_provider", `"${provider}"`],
    [`model_providers.${provider}.name`, '"Ropex OpenAI"'],
    [`model_providers.${provider}.base_url`, '"https://api.openai.com/v1"'],
    [`model_providers.${provider}.env_key`, `"${envName}"`],
    [`model_providers.${provider}.wire_api`, '"responses"'],
    [`model_providers.${provider}.requires_openai_auth`, "false"],
    [`model_providers.${provider}.supports_websockets`, "false"],
  ];
  return pairs.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

export const CLI_RUNTIMES: Record<CliRuntimeKind, CliRuntimeDescriptor> = {
  "claude-code": {
    kind: "claude-code",
    bin: "claude",
    credentialEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
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
  },

  codex: {
    kind: "codex",
    bin: "codex",
    credentialEnv: ["OPENAI_API_KEY", "CODEX_API_KEY"],
    label: "Codex CLI",
    docsUrl: "https://developers.openai.com/codex/cli",
    // `codex exec` reads the prompt from stdin when the positional is omitted.
    promptChannel: "stdin",
    argv({ model, cwd, permissionArgs, apiKeyEnv }) {
      return [
        "exec",
        "--json",
        "--cd",
        cwd,
        ...(model ? ["--model", model] : []),
        ...(apiKeyEnv ? codexApiKeyConfig(apiKeyEnv) : []),
        ...permissionArgs,
      ];
    },
    permissions(policy) {
      const { toolDenies, advisory } = classifyPolicy(policy);
      // Codex gates by sandbox level, not per tool.
      const blocksWrite = toolDenies.some((t) => t === "fs" || t === "str_replace_editor");
      const blocksShell = toolDenies.some((t) => t === "shell" || t === "bash");
      // workspace-write uses a user namespace. The container already sets
      // no-new-privileges, so that namespace cannot be created. The container
      // is the sandbox; Codex writes directly in it.
      const sandbox =
        blocksWrite || blocksShell ? "read-only" : policy.isolated ? "danger-full-access" : "workspace-write";
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
  },

  copilot: {
    kind: "copilot",
    bin: "copilot",
    credentialEnv: ["GITHUB_TOKEN", "COPILOT_CLI_TOKEN", "GH_TOKEN"],
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
    parse(stdout, stderr) {
      return textFallback(stdout, stderr);
    },
  },
};

export function cliRuntime(kind: CliRuntimeKind): CliRuntimeDescriptor {
  return CLI_RUNTIMES[kind];
}

export const CLI_RUNTIME_KINDS = Object.keys(CLI_RUNTIMES) as CliRuntimeKind[];
