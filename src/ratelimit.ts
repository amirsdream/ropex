/**
 * Sliding-window rate limiter for webhook ingress (per repo / delivery key).
 */

import type { ClusterState, RateLimitBucket } from "./types.js";

export type RateLimitOptions = {
  /** Max events per window (default 60). */
  limit?: number;
  /** Window length in ms (default 60s). */
  windowMs?: number;
};

export function ensureRateLimits(state: ClusterState): void {
  if (!state.rateLimits) state.rateLimits = [];
}

/**
 * Returns true if the key is allowed and increments the counter.
 * Returns false when over limit (caller should reject with 429 semantics).
 */
export function checkRateLimit(
  state: ClusterState,
  key: string,
  opts: RateLimitOptions = {},
  now = Date.now(),
): { allowed: boolean; remaining: number; bucket: RateLimitBucket } {
  ensureRateLimits(state);
  const limit = opts.limit ?? 60;
  const windowMs = opts.windowMs ?? 60_000;
  let bucket = state.rateLimits.find((b) => b.key === key);
  const windowStart = bucket ? Date.parse(bucket.windowStartedAt) : NaN;

  if (!bucket || !Number.isFinite(windowStart) || now - windowStart >= windowMs) {
    bucket = {
      key,
      windowStartedAt: new Date(now).toISOString(),
      count: 0,
      limit,
      windowMs,
    };
    state.rateLimits = state.rateLimits.filter((b) => b.key !== key);
    state.rateLimits.push(bucket);
  }

  const cap = bucket.limit ?? limit;
  if (bucket.count >= cap) {
    return { allowed: false, remaining: 0, bucket };
  }
  bucket.count += 1;
  bucket.limit = cap;
  bucket.windowMs = bucket.windowMs ?? windowMs;
  return { allowed: true, remaining: Math.max(0, cap - bucket.count), bucket };
}

export type RateLimitReport = {
  limit: number;
  windowMs: number;
  buckets: number;
  nearLimit: number;
  rows: Array<{
    key: string;
    count: number;
    remaining: number;
    limit: number;
    windowMs: number;
    windowStartedAt: string;
    saturated: boolean;
  }>;
};

/** Snapshot active rate-limit buckets for UI / metrics (does not increment). */
export function rateLimitReport(
  state: ClusterState,
  opts: RateLimitOptions & { now?: number } = {},
): RateLimitReport {
  ensureRateLimits(state);
  const defaultLimit = opts.limit ?? 60;
  const defaultWindowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now();
  const rows = (state.rateLimits ?? [])
    .map((b) => {
      const windowMs = b.windowMs ?? defaultWindowMs;
      const limit = b.limit ?? defaultLimit;
      const start = Date.parse(b.windowStartedAt);
      return { b, windowMs, limit, start };
    })
    .filter(({ start, windowMs }) => Number.isFinite(start) && now - start < windowMs)
    .map(({ b, windowMs, limit }) => ({
      key: b.key,
      count: b.count,
      remaining: Math.max(0, limit - b.count),
      limit,
      windowMs,
      windowStartedAt: b.windowStartedAt,
      saturated: b.count >= limit,
    }))
    .sort((a, b) => b.count - a.count);
  return {
    limit: defaultLimit,
    windowMs: defaultWindowMs,
    buckets: rows.length,
    nearLimit: rows.filter((r) => r.remaining <= Math.max(1, Math.floor(r.limit * 0.1))).length,
    rows: rows.slice(0, 40),
  };
}
