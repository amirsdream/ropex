import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scripts/cloud-agent-start.sh", () => {
  it("exits 0 quickly when node_modules and dist/ui exist", () => {
    expect(existsSync("node_modules")).toBe(true);
    expect(existsSync("dist/ui/index.html")).toBe(true);
    const out = execFileSync("bash", ["scripts/cloud-agent-start.sh"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toMatch(/cloud start ok/);
  });
});
