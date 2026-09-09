import type { Redis } from "ioredis";
import type { Env } from "@idx/config";
import type { Db } from "@idx/db";
import { getHealth } from "./adapter/endpoints.js";
import type { AdapterContext } from "./adapter/endpoints.js";
import { isCircuitOpen, sharedCircuitBreaker } from "./adapter/circuitBreaker.js";
import { getOrFetch } from "./cache/cache.js";
import { CACHE_TTL_SECONDS, REDIS_KEYS } from "./cache/ttl.js";
import { getBudgetStatus } from "./cache/budget.js";

/**
 * Worker health snapshot (blueprint: expose upstream ok, circuit breaker
 * state, today's request count vs budget, last successful screener poll
 * time). This is ephemeral operational state for the web BFF's header, so
 * it lives in Redis (documented shape + TTL below) rather than Postgres.
 */
export interface WorkerHealthSnapshot {
  upstreamOk: boolean;
  upstreamMessage: string | null;
  upstreamLatencyMs: number | null;
  circuitState: "closed" | "open" | "half-open";
  requestBudget: {
    used: number;
    limit: number;
    reserveRemaining: number;
  };
  lastSuccessfulScreenerPollAt: string | null;
  updatedAt: string;
}

const HEALTH_SNAPSHOT_TTL_SECONDS = 10 * 60; // outlives the 5-min health cache with margin

const LAST_SCREENER_POLL_KEY = "idx:worker:lastScreenerPollAt";

export async function recordScreenerPollSuccess(redis: Redis, at: string = new Date().toISOString()): Promise<void> {
  await redis.set(LAST_SCREENER_POLL_KEY, at);
}

export async function getLastScreenerPollAt(redis: Redis): Promise<string | null> {
  return redis.get(LAST_SCREENER_POLL_KEY);
}

/**
 * Computes and persists the worker health snapshot to Redis
 * (`idx:worker:health`, TTL 10 minutes). Calls `/api/health` through the
 * standard 5-minute cache — this function is safe to call frequently (e.g.
 * every scheduler tick) without spending extra budget beyond the endpoint's
 * own TTL.
 */
export async function computeWorkerHealth(
  ctx: AdapterContext & { redis: Redis; env: Env; db: Db }
): Promise<WorkerHealthSnapshot> {
  const { redis, env } = ctx;

  let upstreamOk = false;
  let upstreamMessage: string | null = null;
  let upstreamLatencyMs: number | null = null;

  try {
    const result = await getOrFetch(
      redis,
      "health",
      "singleton",
      CACHE_TTL_SECONDS.health,
      () => getHealth(ctx),
      {}
    );
    upstreamOk = result.value.upstreamOk && !result.stale;
    upstreamMessage = result.value.message;
    upstreamLatencyMs = result.value.latencyMs;
  } catch (err) {
    upstreamOk = false;
    upstreamMessage = err instanceof Error ? err.message : String(err);
  }

  const budget = await getBudgetStatus(redis, env.DAILY_REQUEST_BUDGET, env.DAILY_REQUEST_RESERVE);
  const lastScreenerPollAt = await getLastScreenerPollAt(redis);

  const snapshot: WorkerHealthSnapshot = {
    upstreamOk,
    upstreamMessage,
    upstreamLatencyMs,
    circuitState: sharedCircuitBreaker.getState(),
    requestBudget: {
      used: budget.currentCount,
      limit: budget.limit,
      reserveRemaining: budget.reserveRemaining
    },
    lastSuccessfulScreenerPollAt: lastScreenerPollAt,
    updatedAt: new Date().toISOString()
  };

  await redis.set(REDIS_KEYS.workerHealth(), JSON.stringify(snapshot), "EX", HEALTH_SNAPSHOT_TTL_SECONDS);
  return snapshot;
}

export async function readWorkerHealth(redis: Redis): Promise<WorkerHealthSnapshot | null> {
  const raw = await redis.get(REDIS_KEYS.workerHealth());
  return raw ? (JSON.parse(raw) as WorkerHealthSnapshot) : null;
}

export { isCircuitOpen };
