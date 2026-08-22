/**
 * Event-sourced cluster audit log — append-only control-plane trail.
 * Complements delivery journal (GitHub-shaped) with reconcile / queue / lease events.
 */

import type { AuditEvent, AuditKind, ClusterState } from "./types.js";

export type { AuditEvent, AuditKind };

/** Soft cap so overnight loops cannot unbounded-grow state.json. */
export const AUDIT_MAX = 5_000;

export function ensureAudit(state: ClusterState): void {
  if (!state.audit) state.audit = [];
}

export function recordAudit(
  state: ClusterState,
  input: {
    kind: AuditKind;
    message: string;
    agent?: string;
    workerId?: string;
    taskId?: string;
    meta?: Record<string, string | number | boolean | null>;
    at?: string;
  },
): AuditEvent {
  ensureAudit(state);
  const ev: AuditEvent = {
    id: `aud-${Date.now()}-${state.audit.length}`,
    at: input.at ?? new Date().toISOString(),
    kind: input.kind,
    message: input.message,
    agent: input.agent,
    workerId: input.workerId,
    taskId: input.taskId,
    revision: state.revision,
    meta: input.meta,
  };
  state.audit.push(ev);
  if (state.audit.length > AUDIT_MAX) {
    state.audit.splice(0, state.audit.length - AUDIT_MAX);
  }
  return ev;
}

export function auditsFor(
  state: ClusterState,
  filter: { kind?: AuditKind; agent?: string; taskId?: string; limit?: number } = {},
): AuditEvent[] {
  ensureAudit(state);
  let rows = [...state.audit];
  if (filter.kind) rows = rows.filter((e) => e.kind === filter.kind);
  if (filter.agent) rows = rows.filter((e) => e.agent === filter.agent);
  if (filter.taskId) rows = rows.filter((e) => e.taskId === filter.taskId);
  rows.reverse();
  if (filter.limit !== undefined) rows = rows.slice(0, filter.limit);
  return rows;
}

export function exportAuditJsonl(
  state: ClusterState,
  filter: { kind?: AuditKind; limit?: number } = {},
): string {
  const rows = auditsFor(state, { kind: filter.kind, limit: filter.limit ?? 1_000 });
  return [...rows].reverse().map((e) => JSON.stringify(e)).join("\n") + (rows.length ? "\n" : "");
}
