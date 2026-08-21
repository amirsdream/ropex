import { describe, expect, it } from "vitest";
import { emptyState } from "../src/controller.ts";
import { agentsForEvent, eventToTask } from "../src/github.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";

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
    memory: sqlite
    learning: true
    skills: [issue-triage]
  github:
    events: [issues.opened]
    deliver: comment
  selector:
    matchLabels:
      org: acme
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: other-org
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
      org: other
`;

describe("github routing", () => {
  it("routes an issue to agents that match org + event", () => {
    const state = emptyState();
    state.desired = expandDesired(parseManifests(yaml));
    const matched = agentsForEvent(state, {
      type: "issues.opened",
      repo: "acme/app",
      title: "login is broken",
    });
    expect(matched.map((a) => a.metadata.name)).toEqual(["triage"]);
    expect(eventToTask(matched[0], { type: "issues.opened", repo: "acme/app", title: "login is broken" }).prompt).toContain("login is broken");
  });

  it("ignores events the agent does not listen for", () => {
    const state = emptyState();
    state.desired = expandDesired(parseManifests(yaml));
    expect(
      agentsForEvent(state, { type: "pull_request.opened", repo: "acme/app" }),
    ).toHaveLength(0);
  });
});
