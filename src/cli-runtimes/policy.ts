/**
 * Ropex tool names and how a deny list is split before a CLI translates it.
 */

import type { PolicyInput } from "./types.js";

/**
 * Tool names the Ropex harness actually registers (`PROFILE_TOOLS` in
 * `harness.ts`, plus the memory port). A deny entry outside this set gates
 * nothing today and is treated as advisory.
 */
export const KNOWN_ROPEX_TOOLS = [
  "fs",
  "shell",
  "bash",
  "web",
  "github",
  "subagent",
  "inspect",
  "str_replace_editor",
  "memory",
] as const;

export function isKnownRopexTool(name: string): boolean {
  return (KNOWN_ROPEX_TOOLS as readonly string[]).includes(name);
}

/**
 * Split declared denials into ones this CLI must translate and ones that are
 * advisory. `requireApproval` folds into deny: a headless CLI cannot pause for
 * a Ropex approval mid-run, so the conservative reading is to forbid outright.
 */
export function classifyPolicy(policy: PolicyInput): {
  toolDenies: string[];
  advisory: string[];
} {
  const all = [...new Set([...policy.deny, ...policy.requireApproval])];
  return {
    toolDenies: all.filter(isKnownRopexTool),
    advisory: all.filter((name) => !isKnownRopexTool(name)),
  };
}

/**
 * Translate tool denials through a lookup table.
 * `[]` means the CLI never exposes that capability (deny trivially satisfied);
 * `undefined` means it cannot be expressed → unmappable → fail closed.
 */
export function mapDenies(
  toolDenies: string[],
  table: Record<string, string[] | undefined>,
): { patterns: string[]; unmappable: string[] } {
  const patterns: string[] = [];
  const unmappable: string[] = [];
  for (const tool of toolDenies) {
    const mapped = table[tool];
    if (mapped === undefined) {
      unmappable.push(tool);
      continue;
    }
    patterns.push(...mapped);
  }
  return { patterns: [...new Set(patterns)], unmappable };
}
