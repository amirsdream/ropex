import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startControlPlaneServer } from "../src/api.ts";
import {
  CLI_RUNTIMES,
  classifyPolicy,
  isKnownRopexTool,
  permissionPlan,
} from "../src/cli-runtimes/index.ts";
import { API_ROUTES } from "../src/contracts.ts";
import { emptyState, saveState, loadState } from "../src/controller.ts";
import { buildAgentImage } from "../src/image.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import {
  credentialPresent,
  formatRuntimeReport,
  resolveRuntimeBin,
  resolveRuntimeKind,
  runtimeBinEnvVar,
  workerRuntimeScaffold,
  WORKER_RUNTIME_KINDS,
  type WorkerRuntimeStatus,
} from "../src/worker-runtime.ts";
import { composeWorkflow } from "../src/workflow.ts";

const base = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  harness:
    profile: code
    plugins: [fs, shell]
  hermes:
    memory: none
    learning: false
    skills: []
`;

describe("cli runtime descriptors", () => {
  it("builds claude-code argv with model and permission flags, brief on stdin", () => {
    expect(CLI_RUNTIMES["claude-code"].promptChannel).toBe("stdin");
    const argv = CLI_RUNTIMES["claude-code"].argv({
      prompt: "do the thing",
      model: "claude-opus-5",
      cwd: "/wt",
      permissionArgs: ["--permission-mode", "acceptEdits"],
    });
    expect(argv.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(argv).not.toContain("do the thing");
    expect(argv).toContain("claude-opus-5");
    expect(argv.slice(-2)).toEqual(["--permission-mode", "acceptEdits"]);
  });

  it("builds codex exec argv with the worktree via --cd and no argv prompt", () => {
    expect(CLI_RUNTIMES.codex.promptChannel).toBe("stdin");
    const argv = CLI_RUNTIMES.codex.argv({
      prompt: "do the thing",
      cwd: "/wt",
      permissionArgs: ["--sandbox", "workspace-write", "-c", "approval_policy=never"],
    });
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("--json");
    expect(argv[argv.indexOf("--cd") + 1]).toBe("/wt");
    expect(argv).not.toContain("do the thing");
  });

  it("points codex api-key auth at HTTPS and leaves the key off argv", () => {
    const applied = CLI_RUNTIMES.codex.applyAuth({
      method: "api-key",
      envName: "OPENAI_API_KEY",
      container: true,
    });
    const argv = CLI_RUNTIMES.codex.argv({
      prompt: "do the thing",
      cwd: "/wt",
      authArgs: applied.args,
      permissionArgs: ["--sandbox", "workspace-write", "-c", "approval_policy=never"],
    });
    expect(argv).toContain('model_provider="ropex"');
    expect(argv).toContain('model_providers.ropex.env_key="OPENAI_API_KEY"');
    expect(argv).toContain('model_providers.ropex.base_url="https://api.openai.com/v1"');
    expect(argv).toContain("model_providers.ropex.supports_websockets=false");
    expect(argv).toContain("model_providers.ropex.requires_openai_auth=false");
    expect(applied.env).toEqual(["OPENAI_API_KEY"]);
    expect(argv.join(" ")).not.toContain("sk-");
  });

  it("builds cursor argv in print mode with the brief on stdin and the key off argv", () => {
    expect(CLI_RUNTIMES.cursor.promptChannel).toBe("stdin");
    const applied = CLI_RUNTIMES.cursor.applyAuth({
      method: "api-key",
      envName: "CURSOR_API_KEY",
      container: true,
    });
    const argv = CLI_RUNTIMES.cursor.argv({
      prompt: "do the thing",
      model: "composer-2.5",
      cwd: "/wt",
      authArgs: applied.args,
      permissionArgs: ["--force", "--trust"],
    });
    expect(argv.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(argv[argv.indexOf("--workspace") + 1]).toBe("/wt");
    expect(argv).toContain("--model");
    expect(argv).toContain("composer-2.5");
    expect(argv).toContain("--force");
    expect(argv).toContain("--trust");
    expect(argv).not.toContain("do the thing");
    expect(argv).not.toContain("--api-key");
    expect(applied.env).toEqual(["CURSOR_API_KEY"]);
    expect(applied.args).toEqual([]);
    expect(argv.join(" ")).not.toContain("sk-");
  });

  it("refuses a Cursor tool deny it cannot express, and disables the nested sandbox in a container", () => {
    const open = CLI_RUNTIMES.cursor.permissions({ deny: [], requireApproval: [] });
    expect(open.unmappable).toEqual([]);
    expect(open.args).toEqual(["--force", "--trust"]);
    const denied = CLI_RUNTIMES.cursor.permissions({ deny: ["fs"], requireApproval: [] });
    expect(denied.unmappable).toEqual(["fs"]);
    const container = permissionPlan(CLI_RUNTIMES.cursor, { deny: [], requireApproval: [] }, { container: true });
    expect(container.args).toContain("--sandbox");
    expect(container.args[container.args.indexOf("--sandbox") + 1]).toBe("disabled");
    const host = permissionPlan(CLI_RUNTIMES.cursor, { deny: [], requireApproval: [] }, { container: false });
    expect(host.args).not.toContain("--sandbox");
  });

  it("reads the Cursor json result and a payload error", () => {
    const ok = CLI_RUNTIMES.cursor.parse(
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "committed abc" }),
      "",
    );
    expect(ok.observations).toEqual(["committed abc"]);
    expect(ok.isError).toBe(false);
    const failed = CLI_RUNTIMES.cursor.parse(
      JSON.stringify({ type: "result", is_error: true, result: "not authenticated" }),
      "",
    );
    expect(failed.isError).toBe(true);
  });

  it("builds copilot argv in programmatic mode with the prompt as -p value", () => {
    expect(CLI_RUNTIMES.copilot.promptChannel).toBe("argv");
    const argv = CLI_RUNTIMES.copilot.argv({
      prompt: "do the thing",
      cwd: "/wt",
      permissionArgs: ["--allow-all-tools", "--deny-tool", "shell"],
    });
    expect(argv.slice(0, 2)).toEqual(["-p", "do the thing"]);
    expect(argv).toContain("--log-level");
    expect(argv.slice(-2)).toEqual(["--deny-tool", "shell"]);
  });
});

describe("policy translation", () => {
  it("splits known tool denies from advisory capability labels", () => {
    const { toolDenies, advisory } = classifyPolicy({
      deny: ["shell", "prod-write"],
      requireApproval: ["force-push"],
    });
    expect(toolDenies).toEqual(["shell"]);
    expect(advisory).toEqual(["prod-write", "force-push"]);
    expect(isKnownRopexTool("shell")).toBe(true);
    expect(isKnownRopexTool("prod-write")).toBe(false);
  });

  it("folds requireApproval into deny — a headless CLI cannot pause for approval", () => {
    const plan = CLI_RUNTIMES["claude-code"].permissions({
      deny: [],
      requireApproval: ["shell"],
    });
    expect(plan.args).toContain("--disallowedTools");
    expect(plan.args.slice(plan.args.indexOf("--disallowedTools") + 1)).toContain("Bash");
    expect(plan.unmappable).toEqual([]);
  });

  it("maps claude-code denies onto its own tool names and always sets a headless mode", () => {
    const plan = CLI_RUNTIMES["claude-code"].permissions({
      deny: ["fs", "web"],
      requireApproval: [],
    });
    expect(plan.args.slice(0, 2)).toEqual(["--permission-mode", "acceptEdits"]);
    const denied = plan.args.slice(plan.args.indexOf("--disallowedTools") + 1);
    expect(denied).toContain("Edit");
    expect(denied).toContain("WebFetch");
    expect(plan.unmappable).toEqual([]);
  });

  it("tightens the codex sandbox when writes or shell are denied", () => {
    const open = CLI_RUNTIMES.codex.permissions({ deny: [], requireApproval: [] });
    expect(open.args).toEqual(["--sandbox", "workspace-write", "-c", "approval_policy=never"]);
    const locked = CLI_RUNTIMES.codex.permissions({ deny: ["shell"], requireApproval: [] });
    expect(locked.args).toEqual(["--sandbox", "read-only", "-c", "approval_policy=never"]);
    const inside = permissionPlan(CLI_RUNTIMES.codex, { deny: [], requireApproval: [] }, { container: true });
    expect(inside.args).toEqual(["--sandbox", "danger-full-access", "-c", "approval_policy=never"]);
    const insideLocked = permissionPlan(
      CLI_RUNTIMES.codex,
      { deny: ["fs"], requireApproval: [] },
      { container: true },
    );
    expect(insideLocked.args).toEqual(["--sandbox", "read-only", "-c", "approval_policy=never"]);
  });

  it("reports denies a runtime cannot express so boot can fail closed", () => {
    // codex gates by sandbox level only — it has no per-tool web switch.
    expect(CLI_RUNTIMES.codex.permissions({ deny: ["web"], requireApproval: [] }).unmappable)
      .toEqual(["web"]);
    // claude-code has no equivalent of the inspect tool.
    expect(
      CLI_RUNTIMES["claude-code"].permissions({ deny: ["inspect"], requireApproval: [] }).unmappable,
    ).toEqual(["inspect"]);
    // copilot emits one --deny-tool per mapped tool.
    const copilot = CLI_RUNTIMES.copilot.permissions({ deny: ["shell", "fs"], requireApproval: [] });
    expect(copilot.args[0]).toBe("--allow-all-tools");
    expect(copilot.args).toEqual([
      "--allow-all-tools",
      "--deny-tool",
      "shell",
      "--deny-tool",
      "write",
    ]);
  });

  it("passes --disallowedTools variadically, never comma-joined", () => {
    // `--disallowedTools <tools...>` is variadic. A comma-joined string is read
    // as one tool name that matches nothing, so the gate would silently vanish.
    const plan = CLI_RUNTIMES["claude-code"].permissions({
      deny: ["shell", "web"],
      requireApproval: [],
    });
    const denied = plan.args.slice(plan.args.indexOf("--disallowedTools") + 1);
    expect(denied.length).toBeGreaterThan(1);
    for (const tool of denied) expect(tool).not.toContain(",");
    // ...and it must be the last flag, so the variadic list ends the argv.
    expect(plan.args.indexOf("--disallowedTools")).toBe(plan.args.length - denied.length - 1);
  });

  it("treats memory as already denied — it is never surfaced to an external CLI", () => {
    const plan = CLI_RUNTIMES["claude-code"].permissions({ deny: ["memory"], requireApproval: [] });
    expect(plan.unmappable).toEqual([]);
    expect(plan.args).not.toContain("--disallowedTools");
  });
});

describe("output parsing", () => {
  it("unwraps the claude-code json result envelope", () => {
    const parsed = CLI_RUNTIMES["claude-code"].parse(
      JSON.stringify({ type: "result", is_error: false, result: "patched login.ts" }),
      "",
    );
    expect(parsed.observations).toEqual(["patched login.ts"]);
  });

  it("flags a claude-code envelope that reports failure while exiting 0", () => {
    const parsed = CLI_RUNTIMES["claude-code"].parse(
      JSON.stringify({ type: "result", is_error: true, result: "rate limit exceeded" }),
      "",
    );
    expect(parsed.isError).toBe(true);
    const ok = CLI_RUNTIMES["claude-code"].parse(
      JSON.stringify({ type: "result", is_error: false, result: "done" }),
      "",
    );
    expect(ok.isError).toBe(false);
  });

  it("takes the last message from codex jsonl and ignores interleaved noise", () => {
    const stdout = [
      "not json at all",
      JSON.stringify({ message: "reading files" }),
      JSON.stringify({ message: "done: 2 files changed" }),
    ].join("\n");
    expect(CLI_RUNTIMES.codex.parse(stdout, "").observations).toEqual(["done: 2 files changed"]);
  });

  it("falls back to raw text for copilot and for unparseable output", () => {
    expect(CLI_RUNTIMES.copilot.parse("all done\n", "").observations).toEqual(["all done"]);
    expect(CLI_RUNTIMES["claude-code"].parse("{not json", "").observations).toEqual(["{not json"]);
    expect(CLI_RUNTIMES.codex.parse("", "warn: nothing to do").observations).toEqual([
      "warn: nothing to do",
    ]);
  });
});

describe("runtime resolution", () => {
  it("defaults to dsh and reads spec.runtime.kind otherwise", () => {
    const agent = expandDesired(parseManifests(base))[0];
    expect(resolveRuntimeKind(agent.spec)).toBe("dsh");
    expect(resolveRuntimeKind({ ...agent.spec, runtime: { kind: "codex" } })).toBe("codex");
  });

  it("prefers spec.runtime.command over the env override over the default bin", () => {
    const descriptor = CLI_RUNTIMES["claude-code"];
    const env = { ROPEX_RUNTIME_BIN_CLAUDE_CODE: "/opt/claude" };
    expect(runtimeBinEnvVar("claude-code")).toBe("ROPEX_RUNTIME_BIN_CLAUDE_CODE");
    expect(resolveRuntimeBin(descriptor, undefined, {})).toBe("claude");
    expect(resolveRuntimeBin(descriptor, undefined, env)).toBe("/opt/claude");
    expect(resolveRuntimeBin(descriptor, { kind: "claude-code", command: "/usr/bin/cc" }, env)).toBe(
      "/usr/bin/cc",
    );
  });

  it("detects credentials from any of a runtime's accepted env vars", () => {
    const descriptor = CLI_RUNTIMES["claude-code"];
    expect(credentialPresent(descriptor, {})).toBeUndefined();
    expect(credentialPresent(descriptor, { CLAUDE_CODE_OAUTH_TOKEN: "t" })).toBe(
      "CLAUDE_CODE_OAUTH_TOKEN",
    );
  });
});

describe("runtime scaffold", () => {
  it("reports dsh ready and every CLI not-ready on a bare environment", () => {
    const statuses = workerRuntimeScaffold({ PATH: "" });
    expect(statuses.map((s) => s.kind)).toEqual(WORKER_RUNTIME_KINDS);
    const dsh = statuses.find((s) => s.kind === "dsh");
    expect(dsh?.ready).toBe(true);
    for (const status of statuses.filter((s) => s.kind !== "dsh")) {
      expect(status.ready).toBe(false);
      expect(status.binPresent).toBe(false);
      expect(status.hint).toMatch(/Install|ROPEX_RUNTIME_BIN/);
    }
  });

  it("separates a missing binary from missing credentials in the hint", () => {
    const statuses = workerRuntimeScaffold({
      PATH: "",
      ROPEX_RUNTIME_BIN_CLAUDE_CODE: process.execPath,
      ANTHROPIC_API_KEY: "sk-test",
    });
    const claude = statuses.find((s) => s.kind === "claude-code");
    expect(claude?.binPresent).toBe(true);
    expect(claude?.credentialSource).toBe("ANTHROPIC_API_KEY");
    expect(claude?.ready).toBe(true);

    const noKey = workerRuntimeScaffold(
      {
        PATH: "",
        ROPEX_RUNTIME_BIN_CODEX: process.execPath,
      },
      { fileExists: () => false },
    ).find((s) => s.kind === "codex");
    expect(noKey?.binPresent).toBe(true);
    expect(noKey?.ready).toBe(false);
    expect(noKey?.hint).toMatch(/OPENAI_API_KEY/);
  });
});

describe("image digest", () => {
  it("leaves agents without spec.runtime at their existing digest", () => {
    const agent = expandDesired(parseManifests(base))[0];
    const withUndefined = { ...agent, spec: { ...agent.spec, runtime: undefined } };
    expect(buildAgentImage(withUndefined).digest).toBe(buildAgentImage(agent).digest);
  });

  it("rolls the digest when the runtime changes", () => {
    const agent = expandDesired(parseManifests(base))[0];
    const dsh = buildAgentImage(agent).digest;
    const claude = buildAgentImage({
      ...agent,
      spec: { ...agent.spec, runtime: { kind: "claude-code" } },
    }).digest;
    const codex = buildAgentImage({
      ...agent,
      spec: { ...agent.spec, runtime: { kind: "codex" } },
    }).digest;
    expect(new Set([dsh, claude, codex]).size).toBe(3);
    const authed = buildAgentImage({
      ...agent,
      spec: { ...agent.spec, runtime: { kind: "codex", auth: "api-key", baseUrl: "https://api.openai.com/v1" } },
    }).digest;
    expect(authed).not.toBe(codex);
  });
});

describe("manifest validation", () => {
  const agentWith = (specLines: string) => `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
${specLines}
  harness:
    profile: code
    plugins: [fs]
  hermes:
    memory: none
    learning: false
    skills: []
`;

  it("accepts every supported runtime kind", () => {
    for (const kind of WORKER_RUNTIME_KINDS) {
      expect(() => parseManifests(agentWith(`  runtime:\n    kind: ${kind}`))).not.toThrow();
    }
  });

  it("rejects an unknown runtime kind", () => {
    expect(() => parseManifests(agentWith("  runtime:\n    kind: nope"))).toThrow(
      /unsupported runtime.kind "nope"/,
    );
  });

  it("rejects an auth method the runtime does not support", () => {
    expect(() => parseManifests(agentWith("  runtime:\n    kind: claude-code\n    auth: oauth-file"))).toThrow(
      /not supported by claude-code/,
    );
    expect(() => parseManifests(agentWith("  runtime:\n    kind: cursor\n    auth: oauth"))).toThrow(
      /not supported by cursor/,
    );
    expect(() => parseManifests(agentWith("  runtime:\n    kind: cursor\n    auth: api-key"))).not.toThrow();
    expect(() => parseManifests(agentWith("  runtime:\n    kind: cursor\n    auth: oauth-file"))).not.toThrow();
    expect(() => parseManifests(agentWith("  runtime:\n    kind: dsh\n    auth: api-key"))).toThrow(
      /does not apply to dsh/,
    );
    expect(() => parseManifests(agentWith("  runtime:\n    kind: codex\n    auth: token"))).toThrow(
      /unsupported runtime.auth "token"/,
    );
    expect(() =>
      parseManifests(agentWith("  runtime:\n    kind: claude-code\n    baseUrl: https://api.openai.com/v1")),
    ).toThrow(/runtime.baseUrl applies to codex auth api-key/);
    expect(() =>
      parseManifests(agentWith("  runtime:\n    kind: codex\n    auth: oauth-file\n    baseUrl: https://example.com/v1")),
    ).toThrow(/runtime.baseUrl applies to codex auth api-key/);
  });

  it("rejects commandArgs without command", () => {
    expect(() =>
      parseManifests(agentWith("  runtime:\n    kind: codex\n    commandArgs: [exec]")),
    ).toThrow(/commandArgs requires runtime.command/);
  });

  it("rejects an unknown harness profile that previously failed silently", () => {
    expect(() =>
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: static
  replicas: 1
  harness:
    profile: turbo
    plugins: [fs]
  hermes:
    memory: none
    learning: false
    skills: []
`),
    ).toThrow(/unsupported harness.profile "turbo"/);
  });

  it("validates a Fleet template spec too", () => {
    expect(() =>
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Fleet
metadata:
  name: builders
spec:
  replicas: 2
  template:
    spec:
      runtime:
        kind: bogus
      harness:
        profile: code
        plugins: [fs]
      hermes:
        memory: none
        learning: false
        skills: []
`),
    ).toThrow(/unsupported runtime.kind "bogus"/);
  });

  it("copies runtime onto fleet-derived agents", () => {
    const desired = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Fleet
metadata:
  name: builders
spec:
  scale: static
  replicas: 2
  template:
    spec:
      runtime:
        kind: claude-code
        command: /usr/bin/claude
        commandArgs: [claude]
        requireEnv: [GH_TOKEN]
      harness:
        profile: code
        plugins: [fs]
      hermes:
        memory: none
        learning: false
        skills: []
`),
    );
    expect(desired).toHaveLength(2);
    for (const agent of desired) {
      expect(agent.spec.runtime).toEqual({
        kind: "claude-code",
        command: "/usr/bin/claude",
        commandArgs: ["claude"],
        requireEnv: ["GH_TOKEN"],
      });
      expect(agent.spec.runtime?.commandArgs).not.toBe(
        desired.find((a) => a !== agent)?.spec.runtime?.commandArgs,
      );
    }
  });
});

describe("workflow execute stage", () => {
  it("keeps the Cordis purpose for dsh and names the CLI for other kinds", () => {
    const dsh = expandDesired(parseManifests(base))[0];
    expect(composeWorkflow(dsh).stages.find((s) => s.id === "execute")).toMatchObject({
      owner: "deepseek",
      purpose: "Run Cordis loop (tool-calls or code) with profile tools + permissions",
    });
    const claude = {
      ...dsh,
      spec: { ...dsh.spec, runtime: { kind: "claude-code" as const } },
    };
    expect(composeWorkflow(claude).stages.find((s) => s.id === "execute")).toMatchObject({
      owner: "worker",
      purpose: "Run claude-code in the worker worktree",
    });
  });
});

describe("ropex runtimes text", () => {
  const status = (patch: Partial<WorkerRuntimeStatus> & Pick<WorkerRuntimeStatus, "kind" | "label" | "hint">): WorkerRuntimeStatus => ({
    binPresent: false,
    credentialPresent: false,
    credentialEnv: [],
    ready: false,
    docsUrl: "https://example.test",
    ...patch,
  });

  it("prints one block per runtime with an explicit status", () => {
    const text = formatRuntimeReport([
      status({
        kind: "dsh",
        label: "DeepSeek Harness (default)",
        binPresent: true,
        credentialPresent: true,
        ready: true,
        hint: "Embedded Cordis kernel — always available. Set ROPEX_DSH_BACKEND=live for the headless dsh CLI.",
      }),
      status({
        kind: "claude-code",
        label: "Claude Code CLI",
        credentialEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
        hint: "Claude Code CLI requires one of: ANTHROPIC_API_KEY (api-key); CLAUDE_CODE_OAUTH_TOKEN (oauth)",
      }),
      status({
        kind: "codex",
        label: "Codex CLI",
        binPresent: true,
        bin: "/usr/bin/codex",
        credentialPresent: true,
        hint: "Codex CLI has more than one auth method available (api-key, oauth-file). Set spec.runtime.auth.",
      }),
      status({
        kind: "cursor",
        label: "Cursor CLI",
        binPresent: true,
        bin: "/home/kovi/.local/bin/agent",
        credentialPresent: true,
        credentialSource: "oauth-file",
        ready: true,
        hint: "Ready — agent on PATH, credentials from oauth-file.",
      }),
    ]);

    expect(text).toBe(`dsh            status: ready
               DeepSeek Harness (default)
               binary       embedded
               credentials  built in
               Embedded Cordis kernel — always available. Set
               ROPEX_DSH_BACKEND=live for the headless dsh CLI.

claude-code    status: not ready
               Claude Code CLI
               binary       not on PATH
               credentials  missing
               needs one of:
                 ANTHROPIC_API_KEY (api-key)
                 CLAUDE_CODE_OAUTH_TOKEN (oauth)

codex          status: not ready
               Codex CLI
               binary       /usr/bin/codex
               credentials  ambiguous
               Codex CLI has more than one auth method available (api-key,
               oauth-file). Set spec.runtime.auth.

cursor         status: ready
               Cursor CLI
               binary       /home/kovi/.local/bin/agent
               credentials  oauth-file
`);
  });

  it("colors the kind and the status without moving the columns", () => {
    const sample = [
      status({
        kind: "dsh",
        label: "DeepSeek Harness (default)",
        binPresent: true,
        credentialPresent: true,
        ready: true,
        hint: "Embedded Cordis kernel — always available.",
      }),
      status({
        kind: "cursor",
        label: "Cursor CLI",
        credentialEnv: ["CURSOR_API_KEY"],
        hint: "Cursor CLI requires one of: CURSOR_API_KEY (api-key); ~/.config/cursor/auth.json (oauth-file)",
      }),
    ];
    const plain = formatRuntimeReport(sample);
    const colored = formatRuntimeReport(sample, { color: true });
    expect(colored.replace(/\x1b\[[0-9;]*m/g, "")).toBe(plain);
    expect(colored).toContain("\x1b[1;36mcursor");
    expect(colored).toContain("\x1b[1;32mready");
    expect(colored).toContain("\x1b[1;33mnot ready");
    expect(colored).toContain("\x1b[33mmissing");
    expect(colored).toContain("\x1b[36mCURSOR_API_KEY (api-key)");
    expect(plain).not.toContain("\x1b[");
  });
});

describe("runtimes API and UI", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });

  it("serves GET /api/v1/runtimes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-runtimes-"));
    temps.push(root);
    saveState(root, emptyState());
    const server = await startControlPlaneServer({
      root,
      port: 0,
      loadState,
      saveState,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}${API_ROUTES.runtimes}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runtimes: Array<{ kind: string; ready: boolean }> };
      expect(body.runtimes.map((r) => r.kind)).toEqual(WORKER_RUNTIME_KINDS);
      expect(body.runtimes[0]).toMatchObject({ kind: "dsh", ready: true });
    } finally {
      await server.close();
    }
  });

  it("Services cards accept the violet runtime tone and a not-ready label", () => {
    const src = readFileSync(join(process.cwd(), "web/src/pages/Services.tsx"), "utf8");
    expect(src).toMatch(/tone: "teal" \| "copper" \| "violet"/);
    expect(src).toContain('notReadyLabel="not ready"');
  });
});
