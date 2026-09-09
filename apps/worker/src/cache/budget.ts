import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Db } from "@idx/db";
import { schema } from "@idx/db";
import type { EndpointName } from "./ttl.js";
import { REDIS_KEYS } from "./ttl.js";
import { BudgetExceededError } from "../adapter/errors.js";

/**
 * Daily request budget (blueprint §4.4/§11): hard cap `DAILY_REQUEST_BUDGET`
 * (1000), with `DAILY_REQUEST_RESERVE` (250) held back for retries/manual
 * use. Normal scheduled traffic (`allowReserve: false`, the default) is
 * refused once count >= budget - reserve; only explicit manual/retry calls
 * (`allowReserve: true`) may dip into the reserve, and nothing may ever push
 * the count past the hard budget itself.
 *
 * Redis INCR is the fast path checked before every upstream call; every
 * call (success, error, or cache_hit) is also durably recorded to
 * `request_ledger` for the header's "API budget" display and audit — the
 * Redis counter is derived/ephemeral, Postgres is the durable record.
 */

export interface BudgetCheckResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
}

export function dayBucketFor(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Reserve/dip into budget check. Does NOT increment — call
 * `reserveRequest` (which checks-then-increments atomically) for the actual
 * gate used before a real upstream call. This is exposed separately for
 * read-only "how much budget is left" displays. */
export async function getBudgetStatus(
  redis: Redis,
  dailyBudget: number,
  dailyReserve: number,
  now: Date = new Date()
): Promise<BudgetCheckResult & { reserveRemaining: number }> {
  const dayBucket = dayBucketFor(now);
  const raw = await redis.get(REDIS_KEYS.dailyCount(dayBucket));
  const currentCount = raw ? Number(raw) : 0;
  const softLimit = dailyBudget - dailyReserve;
  return {
    allowed: currentCount < softLimit,
    currentCount,
    limit: dailyBudget,
    reserveRemaining: Math.max(0, dailyBudget - currentCount)
  };
}

/**
 * Atomically checks-and-increments the daily counter. Throws
 * BudgetExceededError without incrementing if the call would breach the
 * applicable ceiling (soft limit = budget - reserve for normal callers,
 * hard budget itself for `allowReserve: true` callers). Returns the new
 * count on success.
 */
export async function reserveRequest(
  redis: Redis,
  dailyBudget: number,
  dailyReserve: number,
  endpoint: EndpointName,
  options: { allowReserve?: boolean; now?: Date } = {}
): Promise<number> {
  const now = options.now ?? new Date();
  const dayBucket = dayBucketFor(now);
  const ceiling = options.allowReserve ? dailyBudget : dailyBudget - dailyReserve;
  const key = REDIS_KEYS.dailyCount(dayBucket);

  // Lua-free two-step check: INCR then verify, rolling back on breach. This
  // is safe under concurrency because INCR itself is atomic in Redis — two
  // concurrent callers each get a distinct post-increment value, so at most
  // one of them can be the one that pushes past the ceiling and needs to
  // roll back its own increment.
  const newCount = await redis.incr(key);
  if (newCount === 1) {
    // first write of the day for this key: set expiry so old counters don't
    // accumulate forever
    await redis.expire(key, 3 * 24 * 60 * 60);
  }
  await redis.incr(REDIS_KEYS.dailyCountByEndpoint(dayBucket, endpoint));

  if (newCount > ceiling) {
    await redis.decr(key);
    throw new BudgetExceededError(endpoint, newCount, ceiling);
  }

  return newCount;
}

export type LedgerStatus = "success" | "error" | "cache_hit";

export interface LedgerRecordInput {
  endpoint: string;
  status: LedgerStatus;
  latencyMs: number | null;
  cacheHit: boolean;
  requestedAt?: Date;
}

/** Durable record of every request attempt (blueprint: header's "API
 * budget" display + audit). Called for cache hits too (cacheHit: true,
 * status "cache_hit") so the ledger reflects true call volume, not just
 * upstream hits. */
export async function recordLedgerEntry(db: Db, input: LedgerRecordInput): Promise<void> {
  const requestedAt = input.requestedAt ?? new Date();
  await db.insert(schema.requestLedger).values({
    id: randomUUID(),
    endpoint: input.endpoint,
    requestedAt,
    status: input.status,
    latencyMs: input.latencyMs,
    cacheHit: input.cacheHit,
    dayBucket: dayBucketFor(requestedAt)
  });
}
