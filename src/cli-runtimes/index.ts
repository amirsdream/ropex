/**
 * Declarative descriptors for external headless coding-agent CLIs.
 *
 * Every CLI is one record — argv shape, policy translation, output parsing — so
 * flag drift between releases is a one-line fix here rather than a refactor, and
 * adding another CLI is a new record plus a `WorkerRuntimeKind` member.
 *
 * Auth selection is `auth.ts`. The Codex provider and login file are `codex.ts`.
 * Nothing here spawns a process.
 */

import { envApplyAuth } from "./auth.js";
import { CODEX_API_KEY, CODEX_OAUTH_FILE, codexApplyAuth, codexContainerArgs, codexPermissions } from "./codex.js";
import {
  CURSOR_API_KEY,
  CURSOR_OAUTH_FILE,
  cursorApplyAuth,
  cursorContainerArgs,
  cursorParse,
  cursorPermissions,
} from "./cursor.js";
import { classifyPolicy, mapDenies } from "./policy.js";
import type { CliArgvInput, CliRuntimeDescriptor, CliRuntimeKind, PermissionPlan, PolicyInput } from "./types.js";

export { authProbe, envApplyAuth, selectRuntimeAuth } from "./auth.js";
export {
  CODEX_AUTH_MOUNT,
  DEFAULT_OPENAI_BASE_URL,
  codexApiKeyConfig,
  isHttpsBaseUrl,
} from "./codex.js";
export { CURSOR_AUTH_MOUNT, CURSOR_CONFIG_HOME } from "./cursor.js";
export { KNOWN_ROPEX_TOOLS, classifyPolicy, isKnownRopexTool } from "./policy.js";
export type {
  AuthApply,
  AuthApplyInput,
  AuthMount,
  AuthProbe,
  CliArgvInput,
  CliRuntimeDescriptor,
  CliRuntimeKind,
  PermissionPlan,
  PolicyInput,
  PreparedRuntimeAuth,
  PromptChannel,
  RuntimeAuthStrategy,
  SelectedAuth,
} from "./types.js";

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
    auth: [CODEX_API_KEY, CODEX_OAUTH_FILE],
    label: "Codex CLI",
    docsUrl: "https://developers.openai.com/codex/cli",
    // `codex exec` reads the prompt from stdin when the positional is omitted.
    promptChannel: "stdin",
    argv({ model, cwd, permissionArgs, authArgs }: CliArgvInput) {
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
    permissions: codexPermissions,
    containerArgs: codexContainerArgs,
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
      const args = ["--allow-all-tools", ...patterns.flatMap((tool) => ["--deny-tool", tool])];
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

  cursor: cliDescriptor({
    kind: "cursor",
    bin: "agent",
    auth: [CURSOR_API_KEY, CURSOR_OAUTH_FILE],
    label: "Cursor CLI",
    docsUrl: "https://cursor.com/docs/cli/overview",
    // `-p` is boolean (--print). The brief goes on stdin so large souls do not
    // hit ARG_MAX. `--output-format json` is a single result envelope.
    promptChannel: "stdin",
    argv({ model, cwd, permissionArgs, authArgs }) {
      return [
        "-p",
        "--output-format",
        "json",
        "--workspace",
        cwd,
        ...(model ? ["--model", model] : []),
        ...(authArgs ?? []),
        ...permissionArgs,
      ];
    },
    permissions: cursorPermissions,
    containerArgs: cursorContainerArgs,
    applyAuth: cursorApplyAuth,
    parse: cursorParse,
  }),
};

export function cliRuntime(kind: CliRuntimeKind): CliRuntimeDescriptor {
  return CLI_RUNTIMES[kind];
}

export const CLI_RUNTIME_KINDS = Object.keys(CLI_RUNTIMES) as CliRuntimeKind[];
