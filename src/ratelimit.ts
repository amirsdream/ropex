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
    };
    state.rateLimits = state.rateLimits.filter((b) => b.key !== key);
    state.rateLimits.push(bucket);
  }

  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, bucket };
  }
  bucket.count += 1;
  return { allowed: true, remaining: Math.max(0, limit - bucket.count), bucket };
}
