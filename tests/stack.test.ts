import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyState, loadState, saveState } from "../src/controller.js";
import { isQueuePaused } from "../src/queue.js";
import { DEFAULT_STACK_MANIFEST, stackDown, stackStatus, stackUp } from "../src/stack.ts";

const minimalFleet = `
apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: p
spec:
  maxReplicas: 4
  permissions:
    deny: []
    requireApproval: []
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: worker
spec:
  scale: onDemand
  maxConcurrent: 2
  idleTTLMs: 0
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
`;

describe("stack control", () => {
  it("defaults to down", () => {
    const state = emptyState();
    expect(stackStatus(state).status).toBe("down");
  });

  it("stack up applies manifest and resumes queue", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-stack-"));
    const fleetPath = join(root, "fleet.yaml");
    writeFileSync(fleetPath, minimalFleet);
    const state = emptyState();
    saveState(root, state);

    const result = await stackUp(root, state, {
      manifest: fleetPath,
      tick: false,
      root,
    });
    saveState(root, state);

    expect(result.ok).toBe(true);
    expect(result.stack.status).toBe("up");
    expect(isQueuePaused(state)).toBe(false);
    expect(loadState(root).desired.length).toBeGreaterThan(0);
  });

  it("stack down pauses queue", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-stack-"));
    const state = emptyState();
    state.stack = {
      status: "up",
      manifest: DEFAULT_STACK_MANIFEST,
      updatedAt: new Date().toISOString(),
    };
    const result = stackDown(root, state, { root });
    expect(result.ok).toBe(true);
    expect(result.stack.status).toBe("down");
    expect(isQueuePaused(state)).toBe(true);
  });
});
