import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../lib/db";
import { schema } from "@idx/db";
import { buildSessionCalendar, isWithinSession, loadEnv } from "@idx/config";
import { deriveHealthStatus } from "../../../lib/health";
import type { HealthResponse } from "../../../lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Best-effort read of apps/worker's own health snapshot, published to Redis
 * at `idx:worker:health` (see apps/worker/src/health.ts, TTL 10 min). Tries
 * briefly and gives up fast on any connection error — the DB-derived
 * fallback below always runs regardless, so this can never make the route
 * slow or fail. Duck-typed rather than importing from apps/worker (which we
 * must not depend on / modify) so a shape change there degrades gracefully
 * instead of breaking the build.
 */
interface WorkerHealthSnapshotShape {
  upstreamOk: boolean;
  upstreamMessage: string | null;
  circuitState: "closed" | "open" | "half-open";
  requestBudget: { used: number; limit: number; reserveRemaining: number };
  lastSuccessfulScreenerPollAt: string | null;
  updatedAt: string;
}

async function readWorkerHealthSnapshot(redisUrl: string): Promise<WorkerHealthSnapshotShape | null> {
  try {
    const { Redis } = await import("ioredis");
    const client = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 800,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null
    });
    try {
      await client.connect();
      const raw = await client.get("idx:worker:health");
      return raw ? (JSON.parse(raw) as WorkerHealthSnapshotShape) : null;
    } finally {
      client.disconnect();
    }
  } catch {
    return null;
  }
}

/**
 * GET /api/health — market status, API budget, and a worker-health signal.
 *
 * Prefers apps/worker's own published health snapshot (Redis
 * `idx:worker:health`, see readWorkerHealthSnapshot above) when reachable —
 * it carries real upstream/circuit-breaker state the BFF has no other way
 * to see. When that's unavailable (worker not running yet, Redis
 * unreachable, or the key hasn't been written/has expired), this falls back
 * to deriving a health signal directly from request_ledger/market_snapshot
 * freshness in Postgres, so the endpoint always returns something
 * meaningful. `worker.source` in the response says which mode produced the
 * result so the header can label it honestly.
 */
export async function GET() {
  try {
    const db = getDb();
    const env = loadEnv();
    const cal = buildSessionCalendar(env);
    const now = new Date();
    const jakartaNow = new Date(now.toLocaleString("en-US", { timeZone: cal.timezone }));
    const dayOfWeek = jakartaNow.getDay();
    const minutesSinceMidnight = jakartaNow.getHours() * 60 + jakartaNow.getMinutes();
    const marketOpen = isWithinSession(cal, dayOfWeek, minutesSinceMidnight);
    const sessionLabel = marketOpen
      ? minutesSinceMidnight < cal.morning.closeMinutes
        ? "Sesi pagi (open)"
        : "Sesi siang (open)"
      : dayOfWeek === 0 || dayOfWeek === 6
        ? "Akhir pekan (closed)"
        : "Di luar sesi (closed)";

    const dayBucket = jakartaNow.toISOString().slice(0, 10);

    const [budgetRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.requestLedger)
      .where(eq(schema.requestLedger.dayBucket, dayBucket));
    const budgetUsed = budgetRow?.count ?? 0;

    const [lastSnapshot] = await db
      .select({ receivedAt: schema.marketSnapshot.receivedAt })
      .from(schema.marketSnapshot)
      .orderBy(desc(schema.marketSnapshot.receivedAt))
      .limit(1);

    const [lastSignal] = await db
      .select({ generatedAt: schema.signal.generatedAt })
      .from(schema.signal)
      .orderBy(desc(schema.signal.generatedAt))
      .limit(1);

    const [errorStats] = await db
      .select({
        total: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where ${schema.requestLedger.status} = 'error')::int`
      })
      .from(schema.requestLedger)
      .where(eq(schema.requestLedger.dayBucket, dayBucket));

    const lastMarketSnapshotAgeSeconds = lastSnapshot
      ? Math.round((now.getTime() - new Date(lastSnapshot.receivedAt).getTime()) / 1000)
      : null;
    const lastSignalAgeSeconds = lastSignal
      ? Math.round((now.getTime() - new Date(lastSignal.generatedAt).getTime()) / 1000)
      : null;

    const derived = deriveHealthStatus({
      marketOpen,
      lastMarketSnapshotAgeSeconds,
      lastSignalAgeSeconds,
      budgetUsed,
      budgetTotal: env.DAILY_REQUEST_BUDGET,
      budgetReserve: env.DAILY_REQUEST_RESERVE
    });

    const workerSnapshot = await readWorkerHealthSnapshot(env.REDIS_URL);

    let status = derived.status;
    let notes = derived.notes;
    let apiBudgetUsed = budgetUsed;
    let source: HealthResponse["worker"]["source"] = "derived_fallback";

    notes = [
      "Worker health is derived from request_ledger/market_snapshot freshness (fallback).",
      ...notes
    ];

    if (workerSnapshot) {
      source = "worker_reported";
      apiBudgetUsed = workerSnapshot.requestBudget.used;
      const workerNotes: string[] = [
        `Worker-reported: upstream ${workerSnapshot.upstreamOk ? "ok" : "not ok"}${workerSnapshot.upstreamMessage ? ` (${workerSnapshot.upstreamMessage})` : ""}, circuit breaker ${workerSnapshot.circuitState}.`
      ];
      // Severity order: down > degraded > unknown > ok. Take the worse of
      // the DB-derived signal and the worker's own reported state, so a
      // healthy-looking DB snapshot can never mask a tripped circuit
      // breaker or a confirmed upstream failure, and vice versa.
      const severity: Record<HealthResponse["status"], number> = { down: 3, degraded: 2, unknown: 1, ok: 0 };
      let workerStatus: HealthResponse["status"] = "ok";
      if (workerSnapshot.circuitState === "open" || !workerSnapshot.upstreamOk) {
        workerStatus = "down";
      } else if (workerSnapshot.circuitState === "half-open") {
        workerStatus = "degraded";
      }
      status = severity[workerStatus] >= severity[derived.status] ? workerStatus : derived.status;
      notes = [...workerNotes, ...notes];
    }

    const body: HealthResponse = {
      status,
      marketOpen,
      sessionLabel,
      now: now.toISOString(),
      apiBudget: {
        used: apiBudgetUsed,
        total: env.DAILY_REQUEST_BUDGET,
        reserve: env.DAILY_REQUEST_RESERVE,
        dayBucket
      },
      worker: {
        source,
        lastMarketSnapshotAt: lastSnapshot ? new Date(lastSnapshot.receivedAt).toISOString() : null,
        lastMarketSnapshotAgeSeconds,
        lastSignalGeneratedAt: lastSignal ? new Date(lastSignal.generatedAt).toISOString() : null,
        lastSignalAgeSeconds,
        recentErrorRate: errorStats && errorStats.total > 0 ? errorStats.errors / errorStats.total : null
      },
      notes
    };

    return NextResponse.json(body);
  } catch (err) {
    const body: HealthResponse = {
      status: "unknown",
      marketOpen: false,
      sessionLabel: "unknown",
      now: new Date().toISOString(),
      apiBudget: { used: 0, total: 1000, reserve: 250, dayBucket: "" },
      worker: {
        source: "derived_fallback",
        lastMarketSnapshotAt: null,
        lastMarketSnapshotAgeSeconds: null,
        lastSignalGeneratedAt: null,
        lastSignalAgeSeconds: null,
        recentErrorRate: null
      },
      notes: [`health_query_failed: ${err instanceof Error ? err.message : "unknown error"}`]
    };
    return NextResponse.json(body, { status: 500 });
  }
}
