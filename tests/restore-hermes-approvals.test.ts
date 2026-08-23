import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildControlPlaneView, startControlPlaneServer } from "../src/api.ts";
import { requestApprovals, decideApproval } from "../src/approval.ts";
import { emptyState, planReconcile, saveState, loadState } from "../src/controller.ts";
import { liveHermesScaffold } from "../src/hermes.ts";
import { parseManifests } from "../src/spec.ts";
import { restoreSnapshot, writeSnapshot, parseSnapshot } from "../src/snapshot.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: snap
spec:
  scale: static
  replicas: 1
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
`;

describe("snapshot restore", () => {
  it("round-trips state through write + restore", () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-snap-"));
    temps.push(root);
    const { next } = planReconcile(emptyState("t"), parseManifests(yaml), "t");
    next.revision = 9;
    next.queuePaused = true;
    const { path } = writeSnapshot(root, next);
    const doc = restoreSnapshot(root, path, { save: saveState });
    expect(doc.meta.revision).toBe(9);
    const loaded = loadState(root);
    expect(loaded.revision).toBe(9);
    expect(loaded.queuePaused).toBe(true);
    expect(loaded.desired[0].metadata.name).toBe("snap");
  });

  it("parses bare ClusterState JSON", () => {
    const state = emptyState("bare");
    state.revision = 2;
    const doc = parseSnapshot(JSON.stringify(state));
    expect(doc.state.revision).toBe(2);
    expect(doc.meta.revision).toBe(2);
  });
});

describe("hermes scaffold + approvals API", () => {
  it("exposes liveHermesScaffold and hermesLive on the view", () => {
    const scaffold = liveHermesScaffold();
    expect(scaffold.liveReady).toBe(false);
    expect(scaffold.steps.length).toBeGreaterThan(3);
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    const view = buildControlPlaneView(next);
    expect(view.hermesLive.liveReady).toBe(false);
    expect(view.hermesLive.scaffoldHint).toMatch(/hermes-agent/i);
  });

  it("POST /api/v1/approvals decides pending requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "ropex-apr-"));
    temps.push(root);
    const state = emptyState();
    requestApprovals(state, {
      taskId: "t1",
      agent: "snap",
      workerId: "snap:0",
      tools: [{ name: "force-push", reason: "gated" }],
    });
    saveState(root, state);
    const server = await startControlPlaneServer({
      root,
      port: 0,
      loadState,
      saveState,
    });
    try {
      const id = loadState(root).approvals[0].id;
      const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/approvals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, decision: "approved" }),
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("approved");
      expect(loadState(root).approvals[0].status).toBe("approved");
      expect(decideApproval(loadState(root), id, "rejected")).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
