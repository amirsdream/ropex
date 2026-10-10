/**
 * Shared shapes for a CLI runtime record. Behavior lives next to this file:
 * `auth.ts` selects a strategy, `codex.ts` is the Codex adapter, `index.ts`
 * is the descriptor table.
 */

import type { RuntimeAuthMethod, WorkerRuntimeKind } from "../types.js";

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
  /** Host credential file. `~` is the home directory. Basename is required. */
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
