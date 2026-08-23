/**
 * Pipeline planner — decompose a prompt into staged tasks against declared Agents.
 * Engine-neutral: any UI (e.g. Magentic) can POST the plan or accept the default heuristic.
 */

import type { ClusterState } from "./types.js";

export type PipelineStagePlan = {
  id: string;
  agent: string;
  prompt: string;
  /** Optional display role label for UIs. */
  role?: string;
};

const ROLE_ALIASES: Record<string, string[]> = {
  researcher: ["research", "researcher", "scout"],
  analyzer: ["analyz", "analysis", "analyzer"],
  synthesizer: ["synth", "writer", "report", "summar"],
  planner: ["plan", "planner", "coordinator"],
  coder: ["cod", "dev", "build", "engineer"],
};

function findAgent(agents: string[], ...roleKeys: (keyof typeof ROLE_ALIASES)[]): string | undefined {
  for (const key of roleKeys) {
    const aliases = ROLE_ALIASES[key] ?? [key];
    const hit = agents.find((a) => aliases.some((alias) => a.toLowerCase().includes(alias)));
    if (hit) return hit;
  }
  return undefined;
}

/** Build a multi-stage plan from a user prompt and fleet agents. */
export function planPipeline(
  prompt: string,
  state: ClusterState,
  opts: { agents?: string[]; stages?: PipelineStagePlan[] } = {},
): PipelineStagePlan[] {
  if (opts.stages?.length) return opts.stages;

  const agents = opts.agents?.length
    ? opts.agents
    : state.desired.map((a) => a.metadata.name);
  if (!agents.length) {
    return [{ id: "run", agent: "default", prompt, role: "worker" }];
  }

  const p = prompt.toLowerCase();
  const stages: PipelineStagePlan[] = [];

  if (/compare|versus|\bvs\b|research|investigate|sources?/i.test(prompt)) {
    const researcher = findAgent(agents, "researcher") ?? agents[0];
    const analyzer = findAgent(agents, "analyzer");
    const synthesizer = findAgent(agents, "synthesizer") ?? agents[agents.length - 1];
    stages.push({
      id: "research",
      agent: researcher,
      role: "researcher",
      prompt: `Research and gather sources: ${prompt}`,
    });
    if (analyzer && analyzer !== researcher) {
      stages.push({
        id: "analyze",
        agent: analyzer,
        role: "analyzer",
        prompt: `Analyze findings for: ${prompt}`,
      });
    }
    if (synthesizer && synthesizer !== researcher) {
      stages.push({
        id: "synthesize",
        agent: synthesizer,
        role: "synthesizer",
        prompt: `Write a cited synthesis: ${prompt}`,
      });
    }
    return stages;
  }

  if (/implement|fix|code|test|bug|refactor|build/i.test(prompt)) {
    const planner = findAgent(agents, "planner") ?? agents[0];
    const coder = findAgent(agents, "coder") ?? agents[0];
    stages.push({ id: "plan", agent: planner, role: "planner", prompt: `Plan approach: ${prompt}` });
    if (coder !== planner) {
      stages.push({ id: "execute", agent: coder, role: "coder", prompt: `Implement: ${prompt}` });
    }
    return stages;
  }

  if (p.split(/\s+/).length > 12 && agents.length >= 2) {
    stages.push({
      id: "draft",
      agent: agents[0],
      role: "worker",
      prompt: `First pass: ${prompt}`,
    });
    stages.push({
      id: "refine",
      agent: agents[1] ?? agents[0],
      role: "reviewer",
      prompt: `Review and refine: ${prompt}`,
    });
    return stages;
  }

  return [{ id: "run", agent: agents[0], role: "worker", prompt }];
}
