import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startControlPlaneServer } from "../src/api.ts";
import {
  CLI_RUNTIMES,
  classifyPolicy,
  isKnownRopexTool,
} from "../src/cli-runtimes.ts";
import { API_ROUTES } from "../src/contracts.ts";
import { emptyState, saveState, loadState } from "../src/controller.ts";
import { buildAgentImage } from "../src/image.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import {
  credentialPresent,
  resolveRuntimeBin,
  resolveRuntimeKind,
  runtimeBinEnvVar,
  workerRuntimeScaffold,
  WORKER_RUNTIME_KINDS,
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

  it("points codex at the API key over HTTPS instead of the login websocket", () => {
    const argv = CLI_RUNTIMES.codex.argv({
      prompt: "do the thing",
      cwd: "/wt",
      apiKeyEnv: "OPENAI_API_KEY",
      permissionArgs: ["--sandbox", "workspace-write", "-c", "approval_policy=never"],
    });
    expect(argv).toContain('model_provider="ropex"');
    expect(argv).toContain('model_providers.ropex.env_key="OPENAI_API_KEY"');
    expect(argv).toContain('model_providers.ropex.base_url="https://api.openai.com/v1"');
    expect(argv).toContain("model_providers.ropex.supports_websockets=false");
    expect(argv).toContain("model_providers.ropex.requires_openai_auth=false");
    expect(argv.join(" ")).not.toContain("sk-");
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
    const inside = CLI_RUNTIMES.codex.permissions({ deny: [], requireApproval: [], isolated: true });
    expect(inside.args).toEqual(["--sandbox", "danger-full-access", "-c", "approval_policy=never"]);
    const insideLocked = CLI_RUNTIMES.codex.permissions({
      deny: ["fs"],
      requireApproval: [],
      isolated: true,
    });
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

    const noKey = workerRuntimeScaffold({
      PATH: "",
      ROPEX_RUNTIME_BIN_CODEX: process.execPath,
    }).find((s) => s.kind === "codex");
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
