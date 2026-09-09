// Loads the repo-root .env into process.env for local dev (`pnpm dev:worker`).
// Production doesn't need this: Docker Compose's `env_file:` injects real
// container env vars directly, before Node ever starts. A missing .env here
// (e.g. in CI, which sets real env vars itself) is silently a no-op.
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: new URL("../../../.env", import.meta.url).pathname });

import { loadEnv, buildSessionCalendar, isWithinSession, DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import { createDbClient, schema } from "@idx/db";
import { eq } from "drizzle-orm";
import { createRedisClient } from "./cache/redis.js";
import { getScreenerLatest, type AdapterContext } from "./adapter/endpoints.js";
import { getOrFetch } from "./cache/cache.js";
import { CACHE_TTL_SECONDS } from "./cache/ttl.js";
import { reserveRequest, recordLedgerEntry } from "./cache/budget.js";
import { runTopFunnel } from "./funnel/top.js";
import { runMidFunnel } from "./funnel/mid.js";
import { runDeepFunnel } from "./funnel/deep.js";
import { computeWorkerHealth, recordScreenerPollSuccess } from "./health.js";
import { maybePublishCategoryChangeAlert } from "./alerts/index.js";

/**
 * Worker scheduler (blueprint §4/§11): a plain `setInterval` loop is enough
 * for V1 — one process, one poller, no cross-instance coordination beyond
 * the Redis single-flight lease which already protects against duplicate
 * upstream calls if a second instance is ever run. A full job-queue library
 * (BullMQ etc.) would add real value once there are multiple job types with
 * different retry/priority needs or multiple worker processes; neither is
 * true yet, so it's deliberately not introduced here.
 *
 * Every tick:
 *  1. If outside trading session -> no-op (health check still runs).
 *  2. If within session -> refresh screener cache, run top+mid funnel.
 *  3. Once per trading day, after the session's final close -> run deep
 *     funnel + signal/alert generation (guarded by a Redis flag so it only
 *     runs once even though the interval keeps ticking).
 */

const DEEP_FUNNEL_RUN_FLAG_PREFIX = "idx:worker:deepFunnelRanOn:";

/** Local wall-clock minutes-since-midnight and day-of-week (0=Sun) for a
 * given IANA timezone, used to evaluate isWithinSession against the
 * exchange's actual local time rather than the server's UTC clock. */
function localSessionClock(date: Date, timeZone: string): { minutesSinceMidnight: number; dayOfWeek: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short"
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour")) % 24; // Intl can return "24" for midnight
  const minute = Number(get("minute"));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = weekdayMap[get("weekday")] ?? date.getUTCDay();
  return { minutesSinceMidnight: hour * 60 + minute, dayOfWeek };
}

async function main() {
  const env = loadEnv();
  const db = createDbClient(env.DATABASE_URL);
  const redis = createRedisClient(env.REDIS_URL);
  const sessionCalendar = buildSessionCalendar(env);

  const strategyConfig = await loadActiveStrategyConfig();

  console.log(`[worker] starting in ${env.NODE_ENV} mode, poll interval ${env.WORKER_POLL_INTERVAL_MS}ms`);

  const tick = async () => {
    try {
      await computeWorkerHealth({ env, db, redis } as never);
      const nowDate = new Date();
      const { minutesSinceMidnight, dayOfWeek } = localSessionClock(nowDate, env.SESSION_TIMEZONE);
      const withinSession = isWithinSession(sessionCalendar, dayOfWeek, minutesSinceMidnight);

      if (withinSession) {
        await runTopAndMidFunnel({ env, db, redis }, strategyConfig);
      }

      await maybeRunDeepFunnelOnceToday({ env, db, redis }, strategyConfig, sessionCalendar);
    } catch (err) {
      console.error("[worker] tick failed:", err);
    }
  };

  await tick();
  setInterval(tick, env.WORKER_POLL_INTERVAL_MS);
}

async function loadActiveStrategyConfig() {
  // Kept intentionally simple: DEFAULT_STRATEGY_CONFIG is the seeded active
  // row (see packages/db/src/seed.ts); a future revision can read the
  // active `strategy_config` row from Postgres here if overrides are added
  // at runtime.
  return DEFAULT_STRATEGY_CONFIG;
}

async function runTopAndMidFunnel(ctx: AdapterContext & { redis: import("ioredis").default }, strategyConfig: typeof DEFAULT_STRATEGY_CONFIG) {
  const { redis, env, db } = ctx;

  await reserveRequest(redis, env.DAILY_REQUEST_BUDGET, env.DAILY_REQUEST_RESERVE, "screenerLatest");
  const start = Date.now();
  let status: "success" | "error" | "cache_hit" = "success";
  try {
    const { value, cacheHit } = await getOrFetch(
      redis,
      "screenerLatest",
      "universe",
      CACHE_TTL_SECONDS.screenerLatest,
      () => getScreenerLatest(ctx)
    );
    status = cacheHit ? "cache_hit" : "success";
    await recordScreenerPollSuccess(redis);

    // During the session this is informational only: the screener shortlist
    // is logged so operators can see the day's candidates forming. The
    // signal-producing run is the once-daily deep funnel after EOD.
    const top = runTopFunnel(value.candidates, strategyConfig.funnel);
    const mid = runMidFunnel(top.survivors, strategyConfig.funnel);
    console.log(
      `[funnel] intraday screener: candidates=${value.candidates.length} top=${top.survivors.length} mid=${mid.length}` +
        ` (excluded: ${JSON.stringify(top.reasons)})`
    );
  } catch (err) {
    status = "error";
    throw err;
  } finally {
    await recordLedgerEntry(db, {
      endpoint: "screenerLatest",
      status,
      latencyMs: Date.now() - start,
      cacheHit: status === "cache_hit"
    });
  }
}

async function maybeRunDeepFunnelOnceToday(
  ctx: AdapterContext & { redis: import("ioredis").default },
  strategyConfig: typeof DEFAULT_STRATEGY_CONFIG,
  sessionCalendar: ReturnType<typeof buildSessionCalendar>
) {
  const { redis, env, db } = ctx;
  const now = new Date();
  // Bucket by the EXCHANGE-LOCAL date, not UTC — otherwise the once-per-day
  // guard rolls over at 07:00 WIB instead of at the trading-day boundary.
  const dayBucket = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.SESSION_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
  const flagKey = `${DEEP_FUNNEL_RUN_FLAG_PREFIX}${dayBucket}`;

  const { minutesSinceMidnight, dayOfWeek } = localSessionClock(now, env.SESSION_TIMEZONE);
  const stillWithinSession = isWithinSession(sessionCalendar, dayOfWeek, minutesSinceMidnight);
  if (stillWithinSession) return; // only run after EOD (outside session hours)
  if (dayOfWeek === 0 || dayOfWeek === 6) return; // no trading day

  const alreadyRan = await redis.set(flagKey, "1", "EX", 20 * 60 * 60, "NX");
  if (alreadyRan !== "OK") return;

  console.log("[funnel] running deep funnel (EOD)");

  const { value: screenerResult } = await getOrFetch(
    redis,
    "screenerLatest",
    "universe",
    CACHE_TTL_SECONDS.screenerLatest,
    () => getScreenerLatest(ctx)
  );
  const top = runTopFunnel(screenerResult.candidates, strategyConfig.funnel);
  const mid = runMidFunnel(top.survivors, strategyConfig.funnel);

  const deepResult = await runDeepFunnel(mid, { env, db, redis, strategyConfig });

  console.log(
    `[funnel] deep funnel complete: watchlist=${deepResult.activeWatchlist.length} tradePlans=${deepResult.tradePlanCandidates.length} skipped=${deepResult.skipped.length}`
  );

  for (const candidate of deepResult.activeWatchlist) {
    const previous = await db
      .select({ category: schema.signal.category })
      .from(schema.signal)
      .where(eq(schema.signal.symbol, candidate.symbol))
      .limit(1);

    await maybePublishCategoryChangeAlert(db, redis, {
      symbol: candidate.symbol,
      tradingDate: candidate.signal.tradingDate,
      previousCategory: (previous[0]?.category as never) ?? null,
      newCategory: candidate.signal.category,
      compositeScore: candidate.signal.compositeScore,
      signalId: candidate.symbol // placeholder id; real signal.id is generated inside insertSignal
    });
  }
}

main().catch((err) => {
  console.error("[worker] fatal error:", err);
  process.exit(1);
});
