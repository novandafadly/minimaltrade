import { ENDPOINTS, type EndpointName } from "../adapter/endpoints.js";

/**
 * Freshness / cache TTL table (blueprint §3). Named constants, one place —
 * never scatter magic TTL numbers at call sites. Values are seconds.
 *
 * A few endpoints don't fit a flat TTL:
 *  - screenerLatest: 60s, but ONLY meaningful during session (outside
 *    session the last snapshot simply doesn't get refreshed — the funnel's
 *    session-awareness check, not this cache, is what prevents useless
 *    off-hours polling).
 *  - health: 5 minutes, same "during session" caveat as above.
 *  - search: no cache — debounced client-side, always a fresh (or
 *    in-flight-deduped) call. TTL of 0 signals "don't cache, single-flight
 *    only" to the cache layer.
 *  - brokerSummary/brokerAccumulation/history/insiders: "once per day" ==
 *    cached until the next trading day; we approximate this with a 24h TTL,
 *    which is simple and self-correcting (a slightly-early or slightly-late
 *    refresh across a day boundary is harmless here).
 */
export const CACHE_TTL_SECONDS: Record<EndpointName, number> = {
  screenerLatest: 60,
  health: 300,
  search: 0,
  marketCap: 24 * 60 * 60,
  history: 24 * 60 * 60,
  brokerSummary: 24 * 60 * 60,
  brokerAccumulation: 24 * 60 * 60,
  insiders: 24 * 60 * 60,
  seasonal: 7 * 24 * 60 * 60,
  financialStatements: 14 * 24 * 60 * 60, // midpoint of the blueprint's 7-30 day range
  // analysis: "EOD/per source timestamp" -- treat as once-per-day like the
  // other EOD-only endpoints above.
  analysis: 24 * 60 * 60
};

export function ttlForEndpoint(endpoint: EndpointName): number {
  return CACHE_TTL_SECONDS[endpoint];
}

/** Redis key namespace helpers, kept in one place so cache.ts, budget.ts and
 * tests agree on shape. */
export const REDIS_KEYS = {
  cacheEntry: (endpoint: EndpointName, paramKey: string) => `idx:cache:${endpoint}:${paramKey}`,
  lease: (endpoint: EndpointName, paramKey: string) => `idx:lease:${endpoint}:${paramKey}`,
  dailyCount: (dayBucket: string) => `idx:budget:count:${dayBucket}`,
  dailyCountByEndpoint: (dayBucket: string, endpoint: EndpointName) =>
    `idx:budget:count:${dayBucket}:${endpoint}`,
  workerHealth: () => `idx:worker:health`
} as const;

// Re-exported so callers of ttl.ts don't need a separate import for the
// endpoint name list.
export { ENDPOINTS };
export type { EndpointName };
