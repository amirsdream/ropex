import type { ClusterState, DesiredAgent, GithubEvent, Task, Worker } from "./types.js";
import { labelsMatch } from "./spec.js";
import { pickIdleWorker } from "./queue.js";

export function agentsForEvent(state: ClusterState, event: GithubEvent): DesiredAgent[] {
  const repoLabels = repoToLabels(event.repo);
  return state.desired.filter((agent) => {
    if (!agent.spec.github?.events.includes(event.type)) return false;
    return labelsMatch(repoLabels, agent.spec.selector);
  });
}

export function workersForAgent(state: ClusterState, agentName: string): Worker[] {
  return state.workers.filter((w) => w.agent === agentName && w.status !== "retired");
}

/** Fair pick: idle/pending only, least-recently-used first. */
export function pickWorker(state: ClusterState, agentName: string): Worker | undefined {
  return pickIdleWorker(state, agentName) ?? workersForAgent(state, agentName)[0];
}

export function eventToTask(agent: DesiredAgent, event: GithubEvent): Task {
  const title = event.title ?? event.type;
  return {
    id: `${event.repo}:${event.type}:${event.number ?? title}`,
    agent: agent.metadata.name,
    prompt: `${event.type} ${event.repo}: ${title}`,
    event,
  };
}

function repoToLabels(repo: string): Record<string, string> {
  const [org, name] = repo.split("/");
  return {
    repo,
    org: org ?? "",
    name: name ?? repo,
  };
}
