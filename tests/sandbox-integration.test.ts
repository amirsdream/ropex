import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireSandbox } from "../src/sandbox.ts";

/**
 * Real container smoke test. Needs a container runtime and network (it builds an
 * image), so it only runs when asked: ROPEX_TEST_DOCKER=1 npx vitest run tests/sandbox-integration.test.ts
 */
describe.runIf(process.env.ROPEX_TEST_DOCKER === "1")("docker sandbox against a real runtime", () => {
  it("builds an env image, execs in /workspace, and removes the container", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-sbx-live-"));
    try {
      const sandbox = await acquireSandbox(
        { provider: "docker", image: { base: "debian:bookworm-slim" } },
        { root, worker: { id: "live:0", agent: "live", imageDigest: "x" }, taskId: "live-1" },
      );
      try {
        const pwd = await sandbox.exec("pwd", []);
        expect(pwd.stdout.trim()).toBe("/workspace");
        expect(await sandbox.resolveBin("sh")).toMatch(/sh$/);
        expect(await sandbox.resolveBin("definitely-not-installed")).toBeUndefined();
      } finally {
        await sandbox.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 600_000);
});
