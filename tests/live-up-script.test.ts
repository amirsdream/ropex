import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { hermesPackageInstalled } from "../src/hermes.ts";
import { dshPackageInstalled } from "../src/dsh.ts";

describe("scripts/live-up.sh", () => {
  it("fails closed on --check when live peers or API keys are missing", () => {
    expect(hermesPackageInstalled()).toBe(false);
    expect(dshPackageInstalled()).toBe(false);
    try {
      execFileSync("bash", ["scripts/live-up.sh", "--check"], {
        encoding: "utf8",
        env: { ...process.env, OPENAI_API_KEY: "", DEEPSEEK_API_KEY: "" },
      });
      throw new Error("expected live-up --check to exit non-zero");
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
      if (e.message?.includes("expected live-up")) throw err;
      expect(e.status).toBe(1);
      const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      expect(out).toMatch(/hermes-agent|@deepseek-ai\/dsh|OPENAI_API_KEY/);
    }
  });

  it("rejects unknown flags", () => {
    try {
      execFileSync("bash", ["scripts/live-up.sh", "--not-a-flag"], { encoding: "utf8" });
      throw new Error("expected unknown flag to exit non-zero");
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
      if (e.message?.includes("expected unknown")) throw err;
      expect(e.status).toBe(2);
      expect(`${e.stdout ?? ""}${e.stderr ?? ""}`).toMatch(/unknown arg/);
    }
  });
});
