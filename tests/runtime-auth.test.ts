import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLI_RUNTIMES,
  CODEX_AUTH_MOUNT,
  authProbe,
  selectRuntimeAuth,
} from "../src/cli-runtimes.ts";
import { prepareRuntimeAuth } from "../src/worker-runtime.ts";
import type { AgentSpec } from "../src/types.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function authFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ropex-auth-"));
  temps.push(dir);
  const path = join(dir, "auth.json");
  writeFileSync(path, "{}\n");
  return path;
}

const codexSpec = (auth?: AgentSpec["runtime"]): AgentSpec =>
  ({
    replicas: 1,
    harness: { profile: "code", plugins: ["fs"] },
    runtime: { kind: "codex", ...auth },
    hermes: { memory: "none", learning: false, skills: [] },
  }) as AgentSpec;

describe("runtime auth selection", () => {
  const none = authProbe({}, { fileExists: () => false, homedir: () => "/home/tester" });

  it("uses the only strategy that has material", () => {
    const claude = selectRuntimeAuth(
      CLI_RUNTIMES["claude-code"],
      undefined,
      authProbe({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" }, { fileExists: () => false }),
    );
    expect(claude).toEqual({ method: "oauth", envName: "CLAUDE_CODE_OAUTH_TOKEN" });
    const applied = CLI_RUNTIMES["claude-code"].applyAuth({ ...claude, container: true });
    expect(applied.args).toEqual([]);
    expect(applied.env).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(applied.mount).toBeUndefined();
  });

  it("fails when claude has both an API key and an OAuth token", () => {
    expect(() =>
      selectRuntimeAuth(
        CLI_RUNTIMES["claude-code"],
        undefined,
        authProbe(
          { ANTHROPIC_API_KEY: "sk", CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
          { fileExists: () => false },
        ),
      ),
    ).toThrow(/spec.runtime.auth/);
  });

  it("lets spec.runtime.auth pick the API key when a login file is also present", () => {
    const file = authFile();
    const selected = selectRuntimeAuth(
      CLI_RUNTIMES.codex,
      "api-key",
      authProbe(
        { OPENAI_API_KEY: "sk-test", ROPEX_AUTH_FILE_CODEX: file },
        { fileExists: () => false, homedir: () => "/home/tester" },
      ),
    );
    expect(selected).toEqual({ method: "api-key", envName: "OPENAI_API_KEY" });
    const applied = CLI_RUNTIMES.codex.applyAuth({
      ...selected,
      baseUrl: "https://example.test/v1",
      container: true,
    });
    expect(applied.args).toContain('model_providers.ropex.base_url="https://example.test/v1"');
    expect(applied.args.join(" ")).not.toContain("sk-test");
    expect(applied.mount).toBeUndefined();
  });

  it("mounts a Codex login file inside a container and does not rewrite the provider", () => {
    const file = authFile();
    const selected = selectRuntimeAuth(
      CLI_RUNTIMES.codex,
      "oauth-file",
      authProbe({ ROPEX_AUTH_FILE_CODEX: file, OPENAI_API_KEY: "sk-test" }),
    );
    expect(selected.method).toBe("oauth-file");
    expect(selected.hostFile).toBe(file);
    const applied = CLI_RUNTIMES.codex.applyAuth({ ...selected, container: true });
    expect(applied.args).toEqual([]);
    expect(applied.env).toEqual([]);
    expect(applied.injectEnv).toEqual({ CODEX_HOME: CODEX_AUTH_MOUNT });
    expect(applied.mount).toEqual({ source: dirname(file), target: CODEX_AUTH_MOUNT });
    expect(JSON.stringify(applied)).not.toContain("sk-test");
  });

  it("fails closed when Codex has both an API key and a login file", () => {
    const file = authFile();
    expect(() =>
      selectRuntimeAuth(
        CLI_RUNTIMES.codex,
        undefined,
        authProbe({ OPENAI_API_KEY: "sk", ROPEX_AUTH_FILE_CODEX: file }),
      ),
    ).toThrow(/api-key, oauth-file/);
  });

  it("uses the default Codex login path and leaves CODEX_HOME unset on the host", () => {
    const home = "/home/tester";
    const path = `${home}/.codex/auth.json`;
    const selected = selectRuntimeAuth(
      CLI_RUNTIMES.codex,
      undefined,
      authProbe({}, { homedir: () => home, fileExists: (candidate) => candidate === path }),
    );
    expect(selected).toEqual({ method: "oauth-file", hostFile: path });
    const applied = CLI_RUNTIMES.codex.applyAuth({ ...selected, container: false, homeDir: home });
    expect(applied.injectEnv).toEqual({});
    expect(applied.mount).toBeUndefined();
    expect(applied.args).toEqual([]);
  });

  it("accepts a login file alone", () => {
    const file = authFile();
    const selected = selectRuntimeAuth(
      CLI_RUNTIMES.codex,
      undefined,
      authProbe({ ROPEX_AUTH_FILE_CODEX: file }, { homedir: () => "/home/tester" }),
    );
    expect(selected.method).toBe("oauth-file");
  });

  it("names every strategy when nothing is present", () => {
    expect(() => selectRuntimeAuth(CLI_RUNTIMES.codex, undefined, none)).toThrow(/OPENAI_API_KEY/);
    expect(() => selectRuntimeAuth(CLI_RUNTIMES.codex, undefined, none)).toThrow(/oauth-file/);
    expect(() => selectRuntimeAuth(CLI_RUNTIMES.codex, "api-key", none)).toThrow(/auth api-key has no credentials/);
  });

  it("rejects a credential path that is not auth.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "ropex-auth-"));
    temps.push(dir);
    const path = join(dir, "token.json");
    writeFileSync(path, "{}\n");
    expect(() =>
      selectRuntimeAuth(
        CLI_RUNTIMES.codex,
        "oauth-file",
        authProbe({ ROPEX_AUTH_FILE_CODEX: path }),
      ),
    ).toThrow(/must be named auth.json/);
  });

  it("prepareRuntimeAuth skips dsh and forwards only the selected env name", () => {
    const dsh = prepareRuntimeAuth(
      { ...codexSpec(), runtime: undefined } as AgentSpec,
      { container: true, env: { OPENAI_API_KEY: "sk" }, fileExists: () => false },
    );
    expect(dsh).toBeUndefined();
    const prepared = prepareRuntimeAuth(codexSpec({ auth: "api-key" }), {
      container: false,
      env: { OPENAI_API_KEY: "sk", CODEX_API_KEY: "other" },
      fileExists: () => false,
    });
    expect(prepared?.env).toEqual(["OPENAI_API_KEY"]);
    expect(prepared?.mount).toBeUndefined();
  });
});
