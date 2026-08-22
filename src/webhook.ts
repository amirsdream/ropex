/**
 * GitHub webhook ingress — HMAC verify + enqueue.
 * First slice: no live App; prove verify → parse → queue without network.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
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
};

/**
 * Verify HMAC (when secret set), rate-limit, parse event, match agents, enqueue.
 * When `secret` is empty, signature check is skipped (local simulate).
 */
export function ingestGithubWebhook(
  state: ClusterState,
  rawBody: string,
  headers: WebhookHeaders,
  secret = "",
  rateLimit: RateLimitOptions = {},
): IngestResult {
  if (secret) {
    const sig = headers["x-hub-signature-256"];
    if (!verifyGithubSignature(secret, rawBody, sig)) {
      return { ok: false, reason: "invalid signature", enqueued: [] };
    }
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

  const rateKey = event.repo || headers["x-github-delivery"] || "default";
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
    return { ok: true, reason: "no matching agents", event, enqueued: [], remaining: rl.remaining };
  }

  const enqueued: QueuedTask[] = [];
  for (const agent of matched) {
    const task = eventToTask(agent, event);
    const delivery = headers["x-github-delivery"];
    if (delivery) {
      task.id = `${delivery}:${agent.metadata.name}`;
    }
    enqueued.push(enqueueTask(state, task, "webhook"));
  }

  return { ok: true, event, enqueued, remaining: rl.remaining };
}
