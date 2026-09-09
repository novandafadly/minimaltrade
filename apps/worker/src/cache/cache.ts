import type { Redis } from "ioredis";
import type { EndpointName } from "./ttl.js";
import { REDIS_KEYS } from "./ttl.js";

/**
 * TTL cache + single-flight lease (blueprint §11: "Gunakan single-flight
 * lease agar beberapa instance tidak menggandakan request upstream").
 *
 * Design:
 *  - Cache entry: `idx:cache:<endpoint>:<key>` (JSON, TTL = freshness table).
 *  - Stale shadow copy: `idx:cache:stale:<endpoint>:<key>` (JSON, longer TTL,
 *    always refreshed alongside the main entry). Used as a degraded fallback
 *    when a fresh fetch fails and nothing fresher is available — callers are
 *    told `stale: true` and must treat the value as ineligible for an
 *    active signal per the envelope-level staleness rule.
 *  - Lease: `idx:lease:<endpoint>:<key>` (SET NX PX <leaseTtlMs>). Only the
 *    caller that wins the SETNX performs the actual upstream call; other
 *    concurrent callers poll the cache entry until it appears or the lease
 *    wait budget is exhausted, at which point they fetch directly rather
 *    than deadlock (a rare worst-case duplicate call is preferable to an
 *    indefinite stall).
 */

export interface CacheEntry<T> {
  value: T;
  cachedAt: string;
}

export interface GetOrFetchResult<T> {
  value: T;
  cacheHit: boolean;
  stale: boolean;
}

export interface GetOrFetchOptions {
  leaseTtlMs?: number;
  /** how long a follower waits (polling) for the leaseholder before giving up
   * and fetching directly itself */
  leaseWaitMs?: number;
  pollIntervalMs?: number;
  staleTtlSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const DEFAULTS = {
  leaseTtlMs: 15_000,
  leaseWaitMs: 5_000,
  pollIntervalMs: 150,
  staleTtlSeconds: 3 * 24 * 60 * 60,
  sleep: defaultSleep
};

export async function getOrFetch<T>(
  redis: Redis,
  endpoint: EndpointName,
  paramKey: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
  options: GetOrFetchOptions = {}
): Promise<GetOrFetchResult<T>> {
  const opts = { ...DEFAULTS, ...options };
  const cacheKey = REDIS_KEYS.cacheEntry(endpoint, paramKey);
  const staleKey = `idx:cache:stale:${endpoint}:${paramKey}`;
  const leaseKey = REDIS_KEYS.lease(endpoint, paramKey);

  // ttlSeconds === 0 means "no caching, single-flight only" (search).
  if (ttlSeconds > 0) {
    const hit = await redis.get(cacheKey);
    if (hit !== null) {
      const entry = JSON.parse(hit) as CacheEntry<T>;
      return { value: entry.value, cacheHit: true, stale: false };
    }
  }

  const acquired = await redis.set(leaseKey, "1", "PX", opts.leaseTtlMs, "NX");

  if (acquired === "OK") {
    try {
      const value = await fetcher();
      if (ttlSeconds > 0) {
        const entry: CacheEntry<T> = { value, cachedAt: new Date().toISOString() };
        await redis.set(cacheKey, JSON.stringify(entry), "EX", ttlSeconds);
        await redis.set(staleKey, JSON.stringify(entry), "EX", opts.staleTtlSeconds);
      }
      return { value, cacheHit: false, stale: false };
    } catch (err) {
      const staleHit = await redis.get(staleKey);
      if (staleHit !== null) {
        const entry = JSON.parse(staleHit) as CacheEntry<T>;
        return { value: entry.value, cacheHit: false, stale: true };
      }
      throw err;
    } finally {
      await redis.del(leaseKey);
    }
  }

  // Follower path: poll for the leaseholder's result instead of duplicating
  // the upstream call.
  const deadline = Date.now() + opts.leaseWaitMs;
  while (Date.now() < deadline) {
    await opts.sleep(opts.pollIntervalMs);
    if (ttlSeconds > 0) {
      const hit = await redis.get(cacheKey);
      if (hit !== null) {
        const entry = JSON.parse(hit) as CacheEntry<T>;
        return { value: entry.value, cacheHit: true, stale: false };
      }
    }
    const stillLeased = await redis.get(leaseKey);
    if (stillLeased === null) break; // leaseholder finished (or lease expired) without writing cache (ttl=0 case, e.g. search)
  }

  // Lease wait exhausted (or leaseholder finished without a cache write,
  // e.g. search's ttl=0): fetch directly rather than deadlock.
  const value = await fetcher();
  return { value, cacheHit: false, stale: false };
}
