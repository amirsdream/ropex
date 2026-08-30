import { describe, expect, it } from "vitest";
import { emptyState, planReconcile } from "../src/controller.ts";
import { deliverOutbound, outboundFor, signOutboundBody } from "../src/deliver.ts";
import { recordDelivery } from "../src/journal.ts";
import {
  cordonWorker,
  uncordonWorker,
  evictWorker,
  cordonedWorkers,
} from "../src/lifecycle.ts";
import { enqueueTask, claimPending, pickIdleWorker } from "../src/queue.ts";
import { parseManifests } from "../src/spec.ts";

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: triage
spec:
  scale: static
  replicas: 2
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
`;

describe("outbound delivery stub", () => {
  it("rejects live https and records stub mode", () => {
    const state = emptyState();
    const worker = {
      id: "triage:0",
      agent: "triage",
      replica: 0,
      status: "idle" as const,
      imageDigest: "abcabcabcabcabcd",
      harness: "minimal" as const,
      plugins: [],
      skills: [],
      model: "x",
    };
    const del = recordDelivery(state, {
      task: { id: "t1", agent: "triage", prompt: "hi", event: { type: "issues.opened", repo: "a/b", number: 1 } },
      worker,
      imageDigest: "abcabcabcabcabcd",
      delivery: { kind: "comment", body: "done" },
    })!;
    const live = deliverOutbound(state, del, { mode: "live" });
    expect(live.status).toBe("rejected");
    const stub = deliverOutbound(state, del, {
      mode: "stub",
      secret: "s3cret",
      url: "https://hooks.example/ropex",
    });
    expect(stub.status).toBe("simulated");
    expect(stub.headers["x-hub-signature-256"]).toBe(signOutboundBody("s3cret", stub.body));
    expect(outboundFor(state, { status: "simulated" }).length).toBe(1);
  });
});

describe("cordon and evict", () => {
  it("skips cordoned workers when claiming", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    const a = next.workers.find((w) => w.replica === 0)!;
    const b = next.workers.find((w) => w.replica === 1)!;
    cordonWorker(next, a.id);
    expect(cordonedWorkers(next)).toHaveLength(1);
    enqueueTask(next, { id: "j1", agent: "triage", prompt: "work" });
    const { claimed } = claimPending(next, 1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].workerId).toBe(b.id);
    uncordonWorker(next, a.id);
    expect(a.cordoned).toBe(false);
  });

  it("evicts idle workers and defers running ones", () => {
    const { next } = planReconcile(emptyState(), parseManifests(yaml), "t");
    const idle = next.workers[0];
    const running = next.workers[1];
    running.status = "running";
    expect(evictWorker(next, idle.id).status).toBe("retired");
    expect(idle.status).toBe("retired");
    expect(evictWorker(next, running.id).status).toBe("cordoned");
    expect(running.cordoned).toBe(true);
    expect(pickIdleWorker(next, "triage")?.id).not.toBe(running.id);
  });
});
