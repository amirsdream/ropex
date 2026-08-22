import { describe, expect, it } from "vitest";
import { emptyState } from "../src/controller.ts";
import { expandWorkers, runTask } from "../src/runtime.ts";
import { checkRateLimit } from "../src/ratelimit.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";
import { exportTrajectoriesJsonl, trajectoriesFor } from "../src/trajectory.ts";
import { ingestGithubWebhook, signGithubPayload } from "../src/webhook.ts";

const yaml = `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: triage
spec:
  replicas: 1
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
  github:
    events: [issues.opened]
    deliver: comment
  selector:
    matchLabels:
      org: acme
`;

describe("trajectories", () => {
  it("records and exports trajectories after runTask", async () => {
    const desired = expandDesired(parseManifests(yaml));
    const worker = expandWorkers(desired[0])[0];
    worker.status = "idle";
    const state = emptyState();
    state.desired = desired;
    state.workers = [worker];

    await runTask(state, worker, { id: "t-traj", agent: "triage", prompt: "summarize" });
    expect(state.trajectories.length).toBe(1);
    expect(trajectoriesFor(state, { agent: "triage" })[0].taskId).toBe("t-traj");
    const jsonl = exportTrajectoriesJsonl(state);
    expect(jsonl).toContain("t-traj");
    expect(JSON.parse(jsonl).steps.length).toBeGreaterThan(0);
  });
});

describe("webhook rate limit", () => {
  it("allows within window then rejects", () => {
    const state = emptyState();
    const a = checkRateLimit(state, "acme/app", { limit: 2, windowMs: 60_000 }, 1_000);
    const b = checkRateLimit(state, "acme/app", { limit: 2, windowMs: 60_000 }, 1_100);
    const c = checkRateLimit(state, "acme/app", { limit: 2, windowMs: 60_000 }, 1_200);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(c.allowed).toBe(false);
    expect(c.remaining).toBe(0);
  });

  it("ingestGithubWebhook returns rateLimited when over cap", () => {
    const state = emptyState();
    state.desired = expandDesired(parseManifests(yaml));
    const payload = {
      action: "opened",
      repository: { full_name: "acme/app" },
      issue: { title: "x", number: 1, labels: [] },
    };
    const raw = JSON.stringify(payload);
    const headers = {
      "x-github-event": "issues",
      "x-github-delivery": "d1",
      "x-hub-signature-256": signGithubPayload("s", raw),
    };
    const opts = { limit: 1, windowMs: 60_000 };
    expect(ingestGithubWebhook(state, raw, headers, "s", opts).ok).toBe(true);
    const second = ingestGithubWebhook(state, raw, { ...headers, "x-github-delivery": "d2" }, "s", opts);
    expect(second.ok).toBe(false);
    expect(second.rateLimited).toBe(true);
  });
});
