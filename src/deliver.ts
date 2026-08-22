/**
 * Outbound webhook delivery stub — records intended POSTs without network.
 * https/live transport fails closed until a GitHub App / webhook client is wired.
 */

import { createHmac } from "node:crypto";
import { recordAudit } from "./audit.js";
import type { ClusterState, DeliveryRecord, OutboundDelivery } from "./types.js";

export function ensureOutbound(state: ClusterState): void {
  if (!state.outbound) state.outbound = [];
}

export type DeliverOutboundOptions = {
  /** Target URL (default env-shaped stub). */
  url?: string;
  /** HMAC secret for X-Hub-Signature-256 (optional). */
  secret?: string;
  /**
   * stub = always record locally (even for https URLs).
   * live = reject https/remote (network-free fail-closed).
   * Default: live when URL is remote, stub for file/local.
   */
  mode?: "stub" | "live";
};

function isRemoteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function signOutboundBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * Build and record an outbound webhook for a journal delivery.
 * Does not perform HTTP — proves the delivery contract offline.
 */
export function deliverOutbound(
  state: ClusterState,
  delivery: DeliveryRecord,
  opts: DeliverOutboundOptions = {},
): OutboundDelivery {
  ensureOutbound(state);
  const url = opts.url ?? "https://example.invalid/ropex/hooks/delivery";
  const body = JSON.stringify({
    kind: delivery.kind,
    body: delivery.body,
    agent: delivery.agent,
    taskId: delivery.taskId,
    workerId: delivery.workerId,
    repo: delivery.repo,
    number: delivery.number,
    imageDigest: delivery.imageDigest,
    at: delivery.at,
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-ropex-delivery": delivery.id,
    "x-ropex-agent": delivery.agent,
  };
  if (opts.secret) {
    headers["x-hub-signature-256"] = signOutboundBody(opts.secret, body);
  }

  const mode = opts.mode ?? (isRemoteUrl(url) ? "live" : "stub");
  let status: OutboundDelivery["status"] = "simulated";
  let reason: string | undefined;
  if (mode === "live" && isRemoteUrl(url)) {
    status = "rejected";
    reason = "live outbound HTTP not wired (use mode=stub for offline record)";
  }

  const rec: OutboundDelivery = {
    id: `out-${delivery.id}-${Date.now()}`,
    at: new Date().toISOString(),
    url,
    method: "POST",
    headers,
    body,
    status,
    reason,
    deliveryId: delivery.id,
    agent: delivery.agent,
    taskId: delivery.taskId,
  };
  state.outbound.push(rec);
  recordAudit(state, {
    kind: "info",
    message: `outbound ${status} ${delivery.kind}`,
    agent: delivery.agent,
    taskId: delivery.taskId,
    meta: { url, status, deliveryId: delivery.id },
  });
  return rec;
}

export function outboundFor(
  state: ClusterState,
  filter: { status?: OutboundDelivery["status"]; limit?: number } = {},
): OutboundDelivery[] {
  ensureOutbound(state);
  let rows = [...state.outbound];
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  rows.reverse();
  if (filter.limit) rows = rows.slice(0, filter.limit);
  return rows;
}
