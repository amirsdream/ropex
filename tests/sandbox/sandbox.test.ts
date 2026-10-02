import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitTask } from "../../src/admission.ts";
import { emptyState } from "../../src/controller.ts";
import { buildAgentImage } from "../../src/image.ts";
import { sandboxReport, sandboxScaffold, needsHostWorktree, acquireSandbox } from "../../src/sandbox/index.ts";
import { ensureEnvImage, planEnvImage, renderDockerfile } from "../../src/sandbox/image.ts";
import { admitSandbox, resolveAptPackages } from "../../src/sandbox/spec.ts";
import {
  evictSnapshots,
  loadCatalog,
  planEviction,
  registerSnapshot,
  warmSnapshotKey,
  type SnapshotRecord,
} from "../../src/sandbox/store.ts";
import { expandDesired, parseManifests } from "../../src/spec.ts";
import type { Policy } from "../../src/types.ts";
import { fakeDocker } from "./fake-docker.ts";

const temps: string[] = [];
const tmp = (prefix = "ropex-sbx-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const agentYaml = (sandbox = "") => `
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: builder
spec:
  scale: onDemand
  maxConcurrent: 1
${sandbox}
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: none
    learning: false
    skills: []
`;

const dockerBlock = `  sandbox:
    provider: docker
    image:
      base: node:22-bookworm
      tools: [git, ffmpeg]
      apt: [libavcodec-extra]
      npm: ["@openai/codex"]
      pip: [requests]
      setup: ["corepack enable"]
    repo:
      url: https://github.com/org/repo.git
      ref: main
      depth: 1
      tokenEnv: GITHUB_TOKEN
    env: { CI: "1" }
    secrets: [OPENAI_API_KEY]
    resources: { cpus: 2, memory: 4g, pids: 256, network: bridge }
    lifecycle: { after: snapshot, warmSnapshot: true, keep: 3, ttlMs: 86400000 }`;

describe("sandbox spec", () => {
  it("parses a docker sandbox and carries it through Fleet templates", () => {
    const [agent] = expandDesired(parseManifests(agentYaml(dockerBlock)));
    expect(agent.spec.sandbox?.provider).toBe("docker");
    expect(agent.spec.sandbox?.image?.npm).toEqual(["@openai/codex"]);

    const fleet = `
apiVersion: ropex.dev/v1
kind: Fleet
metadata:
  name: builders
spec:
  replicas: 2
  scale: onDemand
  template:
    spec:
${dockerBlock.replace(/^/gm, "    ")}
      harness: { profile: minimal, plugins: [github] }
      hermes: { memory: none, learning: false, skills: [] }
`;
    const [derived] = expandDesired(parseManifests(fleet));
    expect(derived.spec.sandbox?.repo?.tokenEnv).toBe("GITHUB_TOKEN");
  });

  it("parses the example docker-sandbox fleet", () => {
    const manifests = parseManifests(readFileSync(join(process.cwd(), "fleets/examples/docker-sandbox.yaml"), "utf8"));
    const agents = expandDesired(manifests);
    expect(agents.find((a) => a.metadata.name === "builder")?.spec.sandbox?.provider).toBe("docker");
    expect(agents.find((a) => a.metadata.name === "triage")?.spec.sandbox).toBeUndefined();
    const policy = manifests.find((m) => m.kind === "Policy") as Policy;
    expect(admitSandbox([policy], agents[0].spec.sandbox).ok).toBe(true);
  });

  it.each([
    ["unknown provider", "  sandbox:\n    provider: vm", /unsupported/],
    ["shell injection in apt", "  sandbox:\n    provider: docker\n    image:\n      apt: ['curl; rm -rf /']", /image\.apt/],
    ["newline in setup", '  sandbox:\n    provider: docker\n    image:\n      setup: ["a\\nRUN b"]', /single line/],
    ["unknown tool preset", "  sandbox:\n    provider: docker\n    image:\n      tools: [nope]", /unknown/],
    ["dockerfile with recipe", "  sandbox:\n    provider: docker\n    image:\n      dockerfile: Dockerfile\n      apt: [curl]", /cannot be combined/],
    ["absolute dockerfile", "  sandbox:\n    provider: docker\n    image:\n      dockerfile: /etc/passwd", /relative/],
    ["token value instead of name", "  sandbox:\n    provider: docker\n    repo:\n      url: https://x/y.git\n      tokenEnv: ghp_abc123!!", /environment variable name/],
    ["clone without url", "  sandbox:\n    provider: docker\n    repo:\n      ref: main", /repo\.url/],
    ["local with image", "  sandbox:\n    provider: local\n    image:\n      base: node:22", /requires provider: docker/],
    ["snapshot on local", "  sandbox:\n    lifecycle:\n      after: snapshot", /provider: docker/],
    ["bad memory", "  sandbox:\n    provider: docker\n    resources:\n      memory: lots", /memory/],
    ["warm snapshot without repo", "  sandbox:\n    provider: docker\n    lifecycle:\n      warmSnapshot: true", /needs a repo/],
  ])("rejects %s", (_name, block, message) => {
    expect(() => parseManifests(agentYaml(block))).toThrow(message);
  });

  it("rejects Policy.sandbox.allowProviders naming an unknown provider", () => {
    const policy = `
apiVersion: ropex.dev/v1
kind: Policy
metadata: { name: p }
spec:
  maxReplicas: 2
  permissions: { deny: [], requireApproval: [] }
  sandbox: { allowProviders: [ssh] }
`;
    expect(() => parseManifests(policy)).toThrow(/allowProviders/);
  });

  it("leaves the image digest alone when sandbox is absent and rolls it when present", () => {
    const plain = expandDesired(parseManifests(agentYaml()))[0];
    const withBlock = expandDesired(parseManifests(agentYaml(dockerBlock)))[0];
    const changed = expandDesired(parseManifests(agentYaml(dockerBlock.replace("node:22-bookworm", "node:20-bookworm"))))[0];
    expect(buildAgentImage(plain).digest).toBe(buildAgentImage(expandDesired(parseManifests(agentYaml()))[0]).digest);
    expect(buildAgentImage(withBlock).digest).not.toBe(buildAgentImage(plain).digest);
    expect(buildAgentImage(changed).digest).not.toBe(buildAgentImage(withBlock).digest);
  });

  it("treats key order and list order as the same sandbox", () => {
    const a = expandDesired(parseManifests(agentYaml("  sandbox:\n    provider: docker\n    secrets: [B, A]")))[0];
    const b = expandDesired(parseManifests(agentYaml("  sandbox:\n    secrets: [A, B]\n    provider: docker")))[0];
    expect(buildAgentImage(a).digest).toBe(buildAgentImage(b).digest);
  });

  it("only local and docker-mount sandboxes need a host worktree", () => {
    expect(needsHostWorktree(undefined)).toBe(true);
    expect(needsHostWorktree({ provider: "local" })).toBe(true);
    expect(needsHostWorktree({ provider: "docker" })).toBe(false);
    expect(needsHostWorktree({ provider: "docker", repo: { workspace: "mount" } })).toBe(true);
  });
});

describe("environment image", () => {
  const spec = expandDesired(parseManifests(agentYaml(dockerBlock)))[0].spec.sandbox;

  it("renders a deterministic Dockerfile from the recipe", () => {
    const text = renderDockerfile(spec);
    expect(text).toBe(renderDockerfile(structuredClone(spec)));
    expect(text.startsWith("FROM node:22-bookworm\n")).toBe(true);
    expect(text).toContain("apt-get install -y --no-install-recommends ca-certificates ffmpeg git libavcodec-extra python3 python3-pip");
    expect(resolveAptPackages(spec)).toEqual(
      ["ca-certificates", "ffmpeg", "git", "libavcodec-extra", "python3", "python3-pip"],
    );
    expect(text).toContain("npm install -g --no-fund --no-audit '@openai/codex'");
    expect(text).toContain("pip3 install 'requests'");
    expect(text).toContain("RUN corepack enable");
    expect(text).toContain("WORKDIR /workspace");
  });

  it("tags the image by recipe digest, so different recipes get different images", () => {
    const a = planEnvImage(spec, "/nowhere");
    const b = planEnvImage({ ...spec, image: { ...spec?.image, apt: ["htop"] } }, "/nowhere");
    expect(a.ref).toMatch(/^ropex-env:[a-f0-9]{16}$/);
    expect(a.ref).not.toBe(b.ref);
  });

  it("builds on a miss and skips the build on a hit", async () => {
    const docker = fakeDocker();
    const first = await ensureEnvImage(docker.run, spec, "/nowhere");
    expect(first.built).toBe(true);
    expect(docker.verbs()).toEqual(["image", "build"]);
    const second = await ensureEnvImage(docker.run, spec, "/nowhere");
    expect(second.built).toBe(false);
    expect(docker.verbs()).toEqual(["image", "build", "image"]);
  });

  it("shares one build between concurrent callers", async () => {
    const docker = fakeDocker();
    await Promise.all([
      ensureEnvImage(docker.run, spec, "/nowhere"),
      ensureEnvImage(docker.run, spec, "/nowhere"),
    ]);
    expect(docker.verbs().filter((v) => v === "build")).toHaveLength(1);
  });

  it("surfaces a failed build with the runtime's message", async () => {
    const docker = fakeDocker({ failBuild: true });
    await expect(ensureEnvImage(docker.run, { provider: "docker" }, "/nowhere")).rejects.toThrow(/build exploded/);
  });

  it("builds from a workspace Dockerfile when image.dockerfile is set", async () => {
    const root = tmp();
    writeFileSync(join(root, "Dockerfile.agent"), "FROM alpine:3.20\n");
    const docker = fakeDocker();
    const image = await ensureEnvImage(
      docker.run,
      { provider: "docker", image: { dockerfile: "Dockerfile.agent" } },
      root,
    );
    const build = docker.calls.find((c) => c.args[0] === "build")!;
    expect(build.args).toContain(join(root, "Dockerfile.agent"));
    expect(build.args[build.args.length - 1]).toBe(root);
    expect(image.dockerfile).toBe("FROM alpine:3.20\n");
  });
});

describe("sandbox policy", () => {
  const policy = (sandbox: Policy["spec"]["sandbox"]): Policy => ({
    apiVersion: "ropex.dev/v1",
    kind: "Policy",
    metadata: { name: "guard" },
    spec: { maxReplicas: 4, permissions: { deny: [], requireApproval: [] }, sandbox },
  });

  it("restricts providers and base images, failing closed", () => {
    const only = policy({ allowProviders: ["local"] });
    expect(admitSandbox([only], { provider: "docker" }).ok).toBe(false);
    expect(admitSandbox([only], undefined).ok).toBe(true);

    const images = policy({ allowBaseImages: ["node:*", "ghcr.io/org/*"] });
    expect(admitSandbox([images], { provider: "docker", image: { base: "node:22-bookworm" } }).ok).toBe(true);
    expect(admitSandbox([images], { provider: "docker", image: { base: "ubuntu:24.04" } }).ok).toBe(false);
    expect(admitSandbox([images], { provider: "docker", image: { dockerfile: "Dockerfile" } }).ok).toBe(false);
  });

  it("denies enqueue for an agent whose sandbox the policy forbids", () => {
    const state = emptyState();
    state.desired = expandDesired(parseManifests(agentYaml(dockerBlock)));
    state.policies = [policy({ allowProviders: ["local"] })];
    const decision = admitTask(state, { id: "t", agent: "builder", prompt: "go" });
    expect(decision.status).toBe("deny");
  });

  it("refuses to acquire a docker sandbox inside a session container", async () => {
    await expect(
      acquireSandbox({ provider: "docker" }, {
        root: tmp(),
        worker: { id: "builder:0", agent: "builder", imageDigest: "x" },
        env: { ROPEX_IN_SESSION: "1" },
        docker: fakeDocker().run,
      }),
    ).rejects.toThrow(/session container/);
  });
});

describe("snapshot store", () => {
  const rec = (key: string, daysAgo: number, bytes: number, envDigest = "env1"): SnapshotRecord => {
    const at = new Date(Date.UTC(2026, 0, 31) - daysAgo * 86_400_000).toISOString();
    return { key, kind: "task", imageRef: `ropex-snap:${key}`, envDigest, bytes, createdAt: at, lastUsedAt: at, labels: {} };
  };
  const now = Date.UTC(2026, 0, 31);

  it("keeps the newest N per environment", () => {
    const records = [rec("a", 1, 1), rec("b", 2, 1), rec("c", 3, 1), rec("x", 9, 1, "env2")];
    expect(planEviction(records, { keep: 2, now }).sort()).toEqual(["c"]);
  });

  it("evicts by idle ttl", () => {
    const records = [rec("fresh", 1, 1), rec("stale", 10, 1)];
    expect(planEviction(records, { ttlMs: 5 * 86_400_000, now })).toEqual(["stale"]);
  });

  it("evicts least recently used first until under the byte cap", () => {
    const records = [rec("old", 5, 100), rec("mid", 3, 100), rec("new", 1, 100)];
    expect(planEviction(records, { maxBytes: 150, now }).sort()).toEqual(["mid", "old"]);
  });

  it("evicting removes the tarball, the image, and the catalog entry", async () => {
    const now = Date.UTC(2026, 0, 31);
    const dir = tmp();
    const tar = join(dir, "old.tar.gz");
    writeFileSync(tar, "x");
    registerSnapshot(dir, { ...rec("old", 40, 1), tarPath: tar });
    registerSnapshot(dir, rec("new", 0, 1));
    const docker = fakeDocker();
    const evicted = await evictSnapshots(docker.run, dir, { ttlMs: 86_400_000 * 2, now });
    expect(evicted.map((e) => e.key)).toEqual(["old"]);
    expect(existsSync(tar)).toBe(false);
    expect(docker.calls.map((c) => c.args.join(" "))).toEqual(["rmi ropex-snap:old"]);
    expect(loadCatalog(dir).snapshots.map((s) => s.key)).toEqual(["new"]);
  });

  it("keys warm snapshots by environment, repo, ref and depth", () => {
    const k = warmSnapshotKey("env1", "https://x/y.git", "main", 1);
    expect(k).toBe(warmSnapshotKey("env1", "https://x/y.git", "main", 1));
    expect(k).not.toBe(warmSnapshotKey("env1", "https://x/y.git", "dev", 1));
    expect(k).not.toBe(warmSnapshotKey("env2", "https://x/y.git", "main", 1));
  });
});

describe("sandbox report", () => {
  it("lists providers and never touches docker when no fleet uses it", () => {
    const state = emptyState();
    const report = sandboxReport(tmp(), state, { env: {} });
    expect(report.providers.map((p) => p.kind)).toEqual(["local", "docker"]);
    expect(report.providers[0].ready).toBe(true);
    expect(report.containersSkipped).toMatch(/no docker sandbox/);
    expect(sandboxScaffold({ PATH: "" }).find((p) => p.kind === "docker")?.ready).toBe(false);
  });

  it("lists live containers for a docker fleet", () => {
    const state = emptyState();
    state.desired = expandDesired(parseManifests(agentYaml(dockerBlock)));
    const report = sandboxReport(tmp(), state, {
      docker: () => ({ code: 0, stdout: "ropex-sbx-builder_0-aa\tbuilder:0\n", stderr: "", timedOut: false }),
    });
    expect(report.agents).toEqual([
      { agent: "builder", provider: "docker", base: "node:22-bookworm", repo: "https://github.com/org/repo.git" },
    ]);
    expect(report.containers).toEqual([{ name: "ropex-sbx-builder_0-aa", worker: "builder:0" }]);
  });
});
