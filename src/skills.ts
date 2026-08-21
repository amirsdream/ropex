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
