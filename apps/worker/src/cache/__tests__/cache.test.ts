import { describe, expect, it, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { getOrFetch } from "../cache.js";

// ioredis-mock v6+ shares in-memory state across instances on the same
// host:port (to emulate multiple real clients against one server); give
// every test its own port so tests stay isolated from each other.
let portCounter = 21000;
function freshRedis(): Redis {
  portCounter += 1;
  return new RedisMock(portCounter) as unknown as Redis;
}

describe("getOrFetch single-flight lease", () => {
  it("dedupes concurrent callers for the same key into one upstream fetch", async () => {
    const redis = freshRedis();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return { value: "fresh" };
    };

    const results = await Promise.all([
      getOrFetch(redis, "screenerLatest", "universe", 60, fetcher),
      getOrFetch(redis, "screenerLatest", "universe", 60, fetcher),
      getOrFetch(redis, "screenerLatest", "universe", 60, fetcher)
    ]);

    expect(calls).toBe(1); // stampede prevented: only the leaseholder fetched
    for (const r of results) {
      expect(r.value).toEqual({ value: "fresh" });
    }
  });

  it("serves a cache hit on a second call without invoking the fetcher again", async () => {
    const redis = freshRedis();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return { n: calls };
    };

    const first = await getOrFetch(redis, "health", "singleton", 300, fetcher);
    const second = await getOrFetch(redis, "health", "singleton", 300, fetcher);

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(calls).toBe(1);
  });

  it("falls back to a stale value when the fresh fetch fails and a stale copy exists", async () => {
    const redis = freshRedis();
    // seed a successful fetch first so a stale copy exists
    await getOrFetch(redis, "marketCap", "universe", 60, async () => ({ v: 1 }));
    // expire the primary cache entry to force a miss, simulating TTL elapse
    await redis.del("idx:cache:marketCap:universe");

    const failing = vi.fn(async () => {
      throw new Error("upstream down");
    });

    const result = await getOrFetch(redis, "marketCap", "universe", 60, failing);
    expect(result.stale).toBe(true);
    expect(result.value).toEqual({ v: 1 });
  });

  it("does not cache when ttlSeconds is 0 (search: single-flight only, no TTL cache)", async () => {
    const redis = freshRedis();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return calls;
    };
    await getOrFetch(redis, "search", "bbca", 0, fetcher);
    await getOrFetch(redis, "search", "bbca", 0, fetcher);
    expect(calls).toBe(2); // no cache entry -> every call is a fresh fetch once the lease is free
  });

  it("a follower gives up waiting and fetches directly if the lease wait budget is exhausted", async () => {
    const redis = freshRedis();
    const fetcher = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 500)); // longer than the follower's wait budget
      return "value";
    });

    const [leaderResult, followerResult] = await Promise.all([
      getOrFetch(redis, "history", "BBCA", 60, fetcher),
      getOrFetch(redis, "history", "BBCA", 60, fetcher, { leaseWaitMs: 50, pollIntervalMs: 10 })
    ]);

    expect(fetcher).toHaveBeenCalledTimes(2); // leader + timed-out follower duplicate call (documented worst case)
    expect(leaderResult.value).toBe("value");
    expect(followerResult.value).toBe("value");
  });
});
