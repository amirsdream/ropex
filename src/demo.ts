/**
 * End-to-end sandbox demo — apply → webhook → drain → metrics → journal.
 * Pure local; no network or API keys.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { applyManifestText, loadState, saveState } from "./controller.js";
import { metricsSnapshot } from "./metrics.js";
import { queueSummary } from "./queue.js";
import { drainQueue } from "./scheduler.js";
import { ingestGithubWebhook, signGithubPayload } from "./webhook.js";
import { syncGitRepos } from "./gitrepo.js";

export type DemoResult = {
  root: string;
  workers: number;
  drained: number;
  deliveries: number;
  metrics: ReturnType<typeof metricsSnapshot>;
  steps: string[];
};

export async function runSandboxDemo(
  root: string,
  opts: { exampleYaml?: string; concurrency?: number } = {},
): Promise<DemoResult> {
  mkdirSync(root, { recursive: true });
  const steps: string[] = [];

  const yaml =
    opts.exampleYaml ??
    (existsSync(join(process.cwd(), "fleets/examples/github-control-plane.yaml"))
      ? readFileSync(join(process.cwd(), "fleets/examples/github-control-plane.yaml"), "utf8")
      : minimalYaml());

  const fleetsDir = join(root, "fleets");
  mkdirSync(fleetsDir, { recursive: true });
  writeFileSync(join(fleetsDir, "demo.yaml"), yaml);

  const { plan } = applyManifestText(root, yaml, fleetsDir);
  steps.push(`apply create=${plan.create.length} retire=${plan.retire.length}`);

  let state = loadState(root);
  const sync = syncGitRepos(root, state);
  steps.push(`sync ok=${sync.filter((s) => s.ok).length}/${sync.length}`);
  state = loadState(root);

  const payload = {
    action: "opened",
    repository: { full_name: "acme/app" },
    issue: { title: "demo login bug", number: 42, labels: [{ name: "bug" }] },
  };
  const raw = JSON.stringify(payload);
  const secret = "demo-secret";
  const ingested = ingestGithubWebhook(
    state,
    raw,
    {
      "x-github-event": "issues",
      "x-github-delivery": `demo-${Date.now()}`,
      "x-hub-signature-256": signGithubPayload(secret, raw),
    },
    secret,
  );
  steps.push(`webhook enqueued=${ingested.enqueued.length} ok=${ingested.ok}`);

  const results = await drainQueue(state, {
    root,
    concurrency: opts.concurrency ?? 2,
  });
  steps.push(`drain results=${results.length} concurrency=${opts.concurrency ?? 2}`);
  saveState(root, state);

  const metrics = metricsSnapshot(state);
  steps.push(`queue ${JSON.stringify(queueSummary(state))}`);

  return {
    root,
    workers: state.workers.filter((w) => w.status !== "retired").length,
    drained: results.length,
    deliveries: state.deliveries.length,
    metrics,
    steps,
  };
}

function minimalYaml(): string {
  return `apiVersion: ropex.dev/v1
kind: Policy
metadata:
  name: demo
spec:
  maxReplicas: 50
  permissions:
    deny: [exfiltrate]
    requireApproval: []
---
apiVersion: ropex.dev/v1
kind: GitRepo
metadata:
  name: local
spec:
  url: file://local
  path: fleets/
  interval: 5s
---
apiVersion: ropex.dev/v1
kind: Agent
metadata:
  name: triage
spec:
  scale: onDemand
  maxConcurrent: 2
  idleTTLMs: 0
  harness:
    profile: minimal
    plugins: [github]
  hermes:
    memory: shared
    learning: true
    skills: [issue-triage]
  github:
    events: [issues.opened]
    deliver: comment
  selector:
    matchLabels:
      org: acme
`;
}
