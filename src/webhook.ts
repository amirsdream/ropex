/**
 * GitHub webhook ingress — HMAC verify + enqueue.
 * First slice: no live App; prove verify → parse → queue without network.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { recordAudit } from "./audit.js";
import { agentsForEvent, eventToTask } from "./github.js";
import { enqueueTask } from "./queue.js";
import { checkRateLimit, type RateLimitOptions } from "./ratelimit.js";
import type { ClusterState, GithubEvent, QueuedTask } from "./types.js";

export type WebhookHeaders = {
  "x-hub-signature-256"?: string;
  "x-github-event"?: string;
  "x-github-delivery"?: string;
};

export function signGithubPayload(secret: string, rawBody: string): string {
  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
  return `sha256=${digest}`;
}

export function verifyGithubSignature(secret: string, rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = signGithubPayload(secret, rawBody);
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signatureHeader);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Map a GitHub webhook JSON body + event name into a Ropex GithubEvent. */
export function parseGithubWebhook(eventName: string, payload: unknown): GithubEvent | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const repoObj = p.repository as { full_name?: string } | undefined;
  const repo = repoObj?.full_name;
  if (!repo) return undefined;

  const action = typeof p.action === "string" ? p.action : undefined;
  const type = action ? `${eventName}.${action}` : eventName;

  if (eventName === "issues" || eventName === "issue") {
    const issue = p.issue as { title?: string; body?: string; number?: number; labels?: Array<{ name?: string }> } | undefined;
    return {
      type,
      repo,
      title: issue?.title,
      body: issue?.body,
      number: issue?.number,
      labels: (issue?.labels ?? []).map((l) => l.name).filter((n): n is string => Boolean(n)),
    };
  }

  if (eventName === "pull_request") {
    const pr = p.pull_request as { title?: string; body?: string; number?: number; labels?: Array<{ name?: string }> } | undefined;
    return {
      type,
      repo,
      title: pr?.title,
      body: pr?.body,
      number: pr?.number,
      labels: (pr?.labels ?? []).map((l) => l.name).filter((n): n is string => Boolean(n)),
    };
  }

  return {
    type,
    repo,
    title: typeof p.title === "string" ? p.title : eventName,
  };
}

export type IngestResult = {
  ok: boolean;
  reason?: string;
  event?: GithubEvent;
  enqueued: QueuedTask[];
  rateLimited?: boolean;
  remaining?: number;
  /** True when x-github-delivery was already processed. */
  duplicate?: boolean;
};

export const WEBHOOK_SEEN_MAX = 2_000;

export function ensureWebhookSeen(state: ClusterState): void {
  if (!state.webhookSeen) state.webhookSeen = [];
  if (!state.metrics) state.metrics = { tasksCompleted: 0, tasksFailed: 0, tasksEnqueued: 0 };
  if (state.metrics.webhookDuplicates === undefined) state.metrics.webhookDuplicates = 0;
}

export function rememberWebhookDelivery(state: ClusterState, deliveryId: string): void {
  ensureWebhookSeen(state);
  if (state.webhookSeen!.includes(deliveryId)) return;
  state.webhookSeen!.push(deliveryId);
  if (state.webhookSeen!.length > WEBHOOK_SEEN_MAX) {
    state.webhookSeen = state.webhookSeen!.slice(-WEBHOOK_SEEN_MAX);
  }
}

export function hasSeenWebhookDelivery(state: ClusterState, deliveryId: string): boolean {
  ensureWebhookSeen(state);
  return state.webhookSeen!.includes(deliveryId);
}

/**
 * Verify HMAC (when secret set), rate-limit, idempotency, parse event, match agents, enqueue.
 * When `secret` is empty, signature check is skipped (local simulate).
 */
export function ingestGithubWebhook(
  state: ClusterState,
  rawBody: string,
  headers: WebhookHeaders,
  secret = "",
  rateLimit: RateLimitOptions = {},
): IngestResult {
  ensureWebhookSeen(state);
  if (secret) {
    const sig = headers["x-hub-signature-256"];
    if (!verifyGithubSignature(secret, rawBody, sig)) {
      return { ok: false, reason: "invalid signature", enqueued: [] };
    }
  }

  const deliveryId = headers["x-github-delivery"];
  if (deliveryId && hasSeenWebhookDelivery(state, deliveryId)) {
    state.metrics.webhookDuplicates = (state.metrics.webhookDuplicates ?? 0) + 1;
    recordAudit(state, {
      kind: "webhook",
      message: `duplicate delivery ${deliveryId}`,
      meta: { delivery: deliveryId, duplicate: true },
    });
    return {
      ok: true,
      reason: `duplicate delivery ${deliveryId}`,
      enqueued: [],
      duplicate: true,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "invalid json", enqueued: [] };
  }

  const eventName = headers["x-github-event"] ?? "unknown";
  const event = parseGithubWebhook(eventName, payload);
  if (!event) {
    return { ok: false, reason: "unrecognized payload", enqueued: [] };
  }

  const rateKey = event.repo || deliveryId || "default";
  const rl = checkRateLimit(state, rateKey, rateLimit);
  if (!rl.allowed) {
    return {
      ok: false,
      reason: `rate limited for ${rateKey}`,
      event,
      enqueued: [],
      rateLimited: true,
      remaining: 0,
    };
  }

  const matched = agentsForEvent(state, event);
  if (!matched.length) {
    if (deliveryId) rememberWebhookDelivery(state, deliveryId);
    return { ok: true, reason: "no matching agents", event, enqueued: [], remaining: rl.remaining };
  }

  const enqueued: QueuedTask[] = [];
  for (const agent of matched) {
    const task = eventToTask(agent, event);
    if (deliveryId) {
      task.id = `${deliveryId}:${agent.metadata.name}`;
    }
    enqueued.push(enqueueTask(state, task, "webhook"));
  }

  if (deliveryId) rememberWebhookDelivery(state, deliveryId);

  recordAudit(state, {
    kind: "webhook",
    message: `${event.type} → ${enqueued.length} task(s)`,
    meta: {
      event: event.type,
      repo: event.repo,
      enqueued: enqueued.length,
      delivery: deliveryId ?? null,
    },
  });

  return { ok: true, event, enqueued, remaining: rl.remaining };
}
