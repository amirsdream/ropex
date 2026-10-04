import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyHarnessCall, type WorkspaceExec } from "../src/plugins.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function hostExec(dir: string): WorkspaceExec {
  return async (bin, args, opts) => {
    const { spawnSync } = await import("node:child_process");
    const res = spawnSync(bin, args, {
      cwd: dir,
      input: opts?.stdin,
      env: { ...process.env, ...opts?.env },
      encoding: "utf8",
    });
    return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", timedOut: false };
  };
}

describe("harness calls", () => {
  it("applies a command or a file from any tool name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ropex-harness-call-"));
    temps.push(dir);
    const exec = hostExec(dir);

    const wrote = await applyHarnessCall(exec, "editor", {
      path: "src/note.txt",
      content: "hello\n",
    });
    expect(wrote).toMatchObject({ ok: true, tool: "editor", path: "src/note.txt" });
    expect(readFileSync(join(dir, "src", "note.txt"), "utf8")).toBe("hello\n");

    const ran = await applyHarnessCall(exec, "browser", { argv: ["echo", "ping"] });
    expect(ran).toMatchObject({ ok: true, tool: "browser", argv: ["echo", "ping"], stdout: "ping" });
  });

  it("leaves a tool call with no workspace effect alone", async () => {
    const exec: WorkspaceExec = async () => {
      throw new Error("workspace should not run");
    };
    expect(await applyHarnessCall(exec, "github", { action: "comment", body: "triaged" })).toBeUndefined();
    expect(await applyHarnessCall(exec, "web", { url: "https://example.com" })).toBeUndefined();
    expect(await applyHarnessCall(exec, "fs", { action: "search", query: "login" })).toBeUndefined();
  });
});
