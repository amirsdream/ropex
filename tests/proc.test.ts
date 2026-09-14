import { describe, expect, it } from "vitest";
import { runProcess, runProcessSync } from "../src/proc.ts";

describe("runProcess", () => {
  it("captures stdout and a zero exit", async () => {
    const res = await runProcess(process.execPath, ["-e", "process.stdout.write('ok')"], {
      timeoutMs: 5_000,
    });
    expect(res.timedOut).toBe(false);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("ok");
  });

  it("writes stdin to the child", async () => {
    const res = await runProcess(
      process.execPath,
      ["-e", "let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => process.stdout.write(s))"],
      { stdin: "brief-from-stdin", timeoutMs: 5_000 },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("brief-from-stdin");
  });

  it("escalates SIGTERM to SIGKILL and still resolves when the child ignores SIGTERM", async () => {
    const started = Date.now();
    const res = await runProcess(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { timeoutMs: 150, killGraceMs: 80, forceExitMs: 80 },
    );
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

describe("runProcessSync", () => {
  it("captures stdout", () => {
    const res = runProcessSync(process.execPath, ["-e", "process.stdout.write('sync')"], {
      timeoutMs: 5_000,
    });
    expect(res.timedOut).toBe(false);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("sync");
  });
});
