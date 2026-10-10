import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentImagePayload } from "../src/image.ts";
import { expandDesired, parseManifests } from "../src/spec.ts";

const agentYaml = (workspace: string) => `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  replicas: 1
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: shared
    learning: false
    skills: []
  workspace:
${workspace}
`;

describe("workspace spec", () => {
  it("requires workspace.path", () => {
    expect(() => parseManifests(agentYaml("    remote: origin"))).toThrow(/workspace\.path is required/);
  });

  it("defaults remote to origin", () => {
    const agent = expandDesired(parseManifests(agentYaml("    path: /tmp/app")))[0];
    expect(agent.spec.workspace).toEqual({ path: "/tmp/app", remote: "origin" });
  });

  it("keeps an explicit remote and base", () => {
    const agent = expandDesired(
      parseManifests(agentYaml("    path: /tmp/app\n    remote: upstream\n    base: develop")),
    )[0];
    expect(agent.spec.workspace).toEqual({ path: "/tmp/app", remote: "upstream", base: "develop" });
  });

  it("copies workspace from a fleet template", () => {
    const fleet = `
apiVersion: ropex.dev/v1
kind: Fleet
metadata:
  name: builders
spec:
  scale: onDemand
  maxConcurrent: 1
  replicas: 1
  template:
    spec:
      harness:
        profile: minimal
        plugins: []
      hermes:
        memory: shared
        learning: false
        skills: []
      workspace:
        path: /tmp/app
        remote: upstream
`;
    const agent = expandDesired(parseManifests(fleet))[0];
    expect(agent.spec.workspace).toEqual({ path: "/tmp/app", remote: "upstream" });
  });

  it("leaves the image payload unchanged when only workspace differs", () => {
    const withPath = expandDesired(parseManifests(agentYaml("    path: /tmp/one")))[0];
    const otherPath = expandDesired(parseManifests(agentYaml("    path: /tmp/two\n    base: dev")))[0];
    expect(agentImagePayload(withPath, "")).toBe(agentImagePayload(otherPath, ""));
    const bare = expandDesired(
      parseManifests(`
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  replicas: 1
  harness:
    profile: minimal
    plugins: []
  hermes:
    memory: shared
    learning: false
    skills: []
`),
    )[0];
    expect(agentImagePayload(bare, "")).toBe(agentImagePayload(withPath, ""));
  });

  it("parses the workspace example fleet", () => {
    const text = readFileSync(new URL("../fleets/examples/workspace-local.yaml", import.meta.url), "utf8");
    const agents = expandDesired(parseManifests(text));
    expect(agents.map((agent) => agent.metadata.name)).toContain("builder");
    const builder = agents.find((agent) => agent.metadata.name === "builder");
    expect(builder?.spec.workspace).toEqual({
      path: "/home/you/my-app",
      remote: "origin",
      base: "main",
    });
  });
});
