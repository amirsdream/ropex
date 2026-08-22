/**
 * Skill registry — versioned, shareable skills across the fleet.
 * Hermes learn() still writes LearnedSkill; registry tracks versions + sharing.
 */

import type { ClusterState, LearnedSkill, SkillRecord } from "./types.js";

export function ensureSkillRegistry(state: ClusterState): void {
  if (!state.skillRegistry) state.skillRegistry = [];
}

export function registerSkill(
  state: ClusterState,
  learned: LearnedSkill,
  summary?: string,
): SkillRecord {
  ensureSkillRegistry(state);
  const existing = state.skillRegistry.filter((s) => s.name === learned.name);
  const version = existing.length ? Math.max(...existing.map((s) => s.version)) + 1 : 1;
  const rec: SkillRecord = {
    name: learned.name,
    version,
    originAgent: learned.agent,
    fromTask: learned.fromTask,
    at: learned.at,
    sharedWith: [],
    summary: summary ?? `Learned from: ${learned.fromTask}`,
  };
  state.skillRegistry.push(rec);
  return rec;
}

/** Share the latest version of a skill with another agent. */
export function shareSkill(
  state: ClusterState,
  name: string,
  toAgent: string,
): SkillRecord | undefined {
  ensureSkillRegistry(state);
  const latest = latestSkill(state, name);
  if (!latest) return undefined;
  if (latest.originAgent === toAgent) return latest;
  if (!latest.sharedWith.includes(toAgent)) {
    latest.sharedWith = [...latest.sharedWith, toAgent];
  }
  return latest;
}

/**
 * Promote a skill fleet-wide: share the latest version with every desired agent
 * (or an explicit target list). Origin agent is skipped.
 */
export function promoteSkill(
  state: ClusterState,
  name: string,
  opts: { toAgents?: string[] } = {},
): SkillRecord | undefined {
  ensureSkillRegistry(state);
  const latest = latestSkill(state, name);
  if (!latest) return undefined;
  const targets =
    opts.toAgents ??
    state.desired.map((a) => a.metadata.name).filter((n) => n !== latest.originAgent);
  for (const to of targets) {
    shareSkill(state, name, to);
  }
  return latestSkill(state, name);
}

/** All registered versions of a skill, newest first. */
export function skillVersions(state: ClusterState, name: string): SkillRecord[] {
  ensureSkillRegistry(state);
  return state.skillRegistry
    .filter((s) => s.name === name)
    .slice()
    .sort((a, b) => b.version - a.version);
}

export function latestSkill(state: ClusterState, name: string): SkillRecord | undefined {
  ensureSkillRegistry(state);
  const rows = state.skillRegistry.filter((s) => s.name === name);
  if (!rows.length) return undefined;
  return rows.reduce((a, b) => (a.version >= b.version ? a : b));
}

/** Skills an agent may load: origin or explicitly shared. */
export function skillsForAgent(state: ClusterState, agent: string): SkillRecord[] {
  ensureSkillRegistry(state);
  const byName = new Map<string, SkillRecord>();
  for (const s of state.skillRegistry) {
    if (s.originAgent !== agent && !s.sharedWith.includes(agent)) continue;
    const prev = byName.get(s.name);
    if (!prev || s.version > prev.version) byName.set(s.name, s);
  }
  return [...byName.values()];
}

export type SkillCatalogEntry = {
  name: string;
  version: number;
  originAgent: string;
  sharedWith: string[];
  summary: string;
  at: string;
  versions: number;
  coverage: number;
};

/** Latest skill per name with version count and fleet share coverage. */
export function skillsCatalog(state: ClusterState): SkillCatalogEntry[] {
  ensureSkillRegistry(state);
  const names = [...new Set(state.skillRegistry.map((s) => s.name))];
  const desired = (state.desired ?? []).map((a) => a.metadata.name);
  return names
    .map((name) => {
      const latest = latestSkill(state, name)!;
      const versions = skillVersions(state, name).length;
      const targets = desired.filter((n) => n !== latest.originAgent);
      const covered = targets.filter((t) => latest.sharedWith.includes(t)).length;
      const coverage = targets.length ? Math.round((100 * covered) / targets.length) : 100;
      return {
        name: latest.name,
        version: latest.version,
        originAgent: latest.originAgent,
        sharedWith: [...latest.sharedWith],
        summary: latest.summary,
        at: latest.at,
        versions,
        coverage,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
