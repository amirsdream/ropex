/**
 * An interaction resolves a fleet, then the existing executor runs it.
 * Reuse a pin or a named definition. Otherwise mint a selection from the
 * agents already loaded. The session still dies after learn.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClusterState, FleetPin, InFlightFleet } from "./types.js";

export type FleetBinding = {
  mode: "reuse" | "mint";
  fleet: string;
  agents: string[];
  pinned: boolean;
  key: string;
};

const MAX_PINS = 64;
const MAX_INFLIGHT = 32;

export function fleetKey(prompt: string, simple?: boolean): string {
  if (simple) return "simple";
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "task";
}

/** Agents that belong to a named fleet, or the one agent with that name. */
export function agentsInFleet(state: ClusterState, name: string): string[] {
  const derived = state.desired
    .filter((a) => a.derivedFrom?.fleet === name)
    .map((a) => a.metadata.name);
  if (derived.length) return derived;
  const labeled = state.desired
    .filter((a) => a.metadata.labels?.fleet === name)
    .map((a) => a.metadata.name);
  if (labeled.length) return labeled;
  const one = state.desired.find((a) => a.metadata.name === name);
  return one ? [one.metadata.name] : [];
}

function defaultWorkingSet(state: ClusterState): string[] {
  const names = state.desired.map((a) => a.metadata.name);
  const triage = names.find((n) => n === "triage");
  const reviewer = names.find((n) => n === "reviewer");
  if (triage && reviewer) return [triage, reviewer];
  return names.slice(0, 2);
}

function known(state: ClusterState, agents: string[]): string[] {
  const have = new Set(state.desired.map((a) => a.metadata.name));
  return agents.filter((a) => have.has(a));
}

function rememberPin(state: ClusterState, pin: FleetPin): void {
  const pins = state.fleetPins ?? [];
  const i = pins.findIndex((p) => p.key === pin.key);
  if (i >= 0) pins[i] = pin;
  else pins.unshift(pin);
  state.fleetPins = pins.slice(0, MAX_PINS);
}

/** Write a readable copy of a pin. The control plane reuses the state record. */
export function reflectFleetPin(root: string, pin: FleetPin): string {
  const dir = join(root, ".ropex", "pinned");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${pin.key}.yaml`);
  const body = [
    "# Reusable fleet. The next matching interaction reads this set from state.",
    `name: ${pin.fleet}`,
    `key: ${pin.key}`,
    `agents: [${pin.agents.join(", ")}]`,
    `prompt: ${JSON.stringify(pin.prompt)}`,
    "",
  ].join("\n");
  writeFileSync(path, body);
  return path;
}

export function bindFleet(
  state: ClusterState,
  opts: {
    prompt: string;
    simple?: boolean;
    fleet?: string;
    agents?: string[];
    pin?: boolean;
    reflect?: boolean;
    root?: string;
  },
): FleetBinding {
  const key = opts.fleet?.trim() || fleetKey(opts.prompt, opts.simple);
  const pins = state.fleetPins ?? [];
  const existing = pins.find((p) => p.key === key);
  const shouldPin = opts.pin !== false && (opts.pin === true || Boolean(opts.simple) || Boolean(existing));

  let mode: FleetBinding["mode"] = "mint";
  let fleet = `inflight-${key}`;
  let agents: string[] = [];

  if (opts.fleet?.trim()) {
    const named = agentsInFleet(state, opts.fleet.trim());
    if (!named.length && !existing) {
      throw new Error(`unknown fleet: ${opts.fleet.trim()}`);
    }
    agents = named.length ? named : known(state, existing?.agents ?? []);
    if (!agents.length) throw new Error(`unknown fleet: ${opts.fleet.trim()}`);
    mode = "reuse";
    fleet = opts.fleet.trim();
  } else if (opts.agents?.length) {
    agents = opts.agents;
    mode = "reuse";
    fleet = existing?.fleet ?? `picked-${key}`;
  } else if (existing) {
    const still = known(state, existing.agents);
    if (still.length) {
      agents = still;
      mode = "reuse";
      fleet = existing.fleet;
    }
  }

  if (!agents.length) {
    agents = defaultWorkingSet(state);
    mode = "mint";
    fleet = `inflight-${key}`;
  }

  const pinned = shouldPin && agents.length > 0;
  if (pinned) {
    const pin: FleetPin = {
      key,
      fleet,
      agents,
      prompt: opts.prompt.slice(0, 240),
      at: new Date().toISOString(),
      reflected: existing?.reflected,
    };
    if (opts.reflect && opts.root) {
      pin.reflected = reflectFleetPin(opts.root, pin);
    }
    rememberPin(state, pin);
  }

  return { mode, fleet, agents, pinned, key };
}

export function openInFlight(state: ClusterState, pipelineId: string, binding: FleetBinding): InFlightFleet {
  const row: InFlightFleet = {
    id: pipelineId,
    fleet: binding.fleet,
    mode: binding.mode,
    agents: binding.agents,
    pipelineId,
    status: "open",
    createdAt: new Date().toISOString(),
  };
  state.inflightFleets = [row, ...(state.inflightFleets ?? [])].slice(0, MAX_INFLIGHT);
  return row;
}

/** The plan finished. Workers are destroyed by the existing idle sweep. */
export function closeInFlight(state: ClusterState, pipelineId: string): void {
  const row = (state.inflightFleets ?? []).find((f) => f.pipelineId === pipelineId && f.status === "open");
  if (!row) return;
  row.status = "closed";
  row.closedAt = new Date().toISOString();
}
