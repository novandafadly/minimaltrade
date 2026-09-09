import { NextRequest } from "next/server";
import { desc, gt } from "drizzle-orm";
import { getDb } from "../../../lib/db";
import { schema } from "@idx/db";
import { loadEnv } from "@idx/config";
import type { SseEnvelope } from "../../../lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DB_POLL_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 15000;
const REDIS_CHANNEL = "idx:signals";

function sseFrame(event: SseEnvelope["type"], data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * GET /api/sse — Server-Sent Events relay.
 *
 * Baseline (always active): polls the `signal` table every
 * DB_POLL_INTERVAL_MS for rows generated since the last poll and emits one
 * `signal_update` per changed symbol, plus a `heartbeat` every 15s so the
 * client can detect a dead connection. This works correctly even if
 * apps/worker's Redis publisher isn't wired up yet.
 *
 * Best-effort (on top): also subscribes to the Redis pub/sub channel
 * `idx:signals` that apps/worker publishes `{type, payload}` envelopes to,
 * for lower-latency updates than the poll interval. Connection errors are
 * caught and logged, never thrown — the DB poll keeps the stream correct
 * without it.
 */
export async function GET(req: NextRequest) {
  const db = getDb();
  let closed = false;
  let lastSeenGeneratedAt = new Date();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (frame: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // controller already closed (client disconnected mid-write)
        }
      };

      send(sseFrame("heartbeat", { now: new Date().toISOString() }));

      const heartbeat = setInterval(() => {
        send(sseFrame("heartbeat", { now: new Date().toISOString() }));
      }, HEARTBEAT_INTERVAL_MS);

      const pollDb = setInterval(async () => {
        try {
          const rows = await db
            .select({ symbol: schema.signal.symbol, category: schema.signal.category, generatedAt: schema.signal.generatedAt })
            .from(schema.signal)
            .where(gt(schema.signal.generatedAt, lastSeenGeneratedAt))
            .orderBy(desc(schema.signal.generatedAt))
            .limit(200);

          if (rows.length > 0) {
            const newest = rows.reduce(
              (max, r) => (new Date(r.generatedAt) > max ? new Date(r.generatedAt) : max),
              lastSeenGeneratedAt
            );
            lastSeenGeneratedAt = newest;
            const seen = new Set<string>();
            for (const row of rows) {
              if (seen.has(row.symbol)) continue;
              seen.add(row.symbol);
              send(
                sseFrame("signal_update", {
                  symbol: row.symbol,
                  category: row.category,
                  reason: "db_poll"
                })
              );
            }
          }
        } catch (err) {
          // don't tear down the stream on a transient DB error; the client
          // will notice via missed heartbeats/health_update if it persists
          console.error("[sse] db poll failed", err);
        }
      }, DB_POLL_INTERVAL_MS);

      // Best-effort Redis subscription. Never blocks or throws the stream.
      let redisClient: import("ioredis").Redis | null = null;
      try {
        const env = loadEnv();
        const { Redis } = await import("ioredis");
        redisClient = new Redis(env.REDIS_URL, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          retryStrategy: () => null // don't hammer retries; DB poll is the safety net
        });
        redisClient.on("error", (err) => {
          console.warn("[sse] redis connection error (falling back to db poll only)", err.message);
        });
        await redisClient.connect();
        await redisClient.subscribe(REDIS_CHANNEL);
        redisClient.on("message", (_channel, message) => {
          try {
            const envelope = JSON.parse(message) as { type?: string; payload?: unknown };
            if (envelope.type === "signal_update" || envelope.type === "health_update") {
              send(sseFrame(envelope.type, envelope.payload));
            }
          } catch {
            // ignore malformed pub/sub payloads
          }
        });
      } catch (err) {
        console.warn(
          "[sse] redis unreachable, continuing on db-poll fallback only:",
          err instanceof Error ? err.message : err
        );
        redisClient = null;
      }

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearInterval(pollDb);
        if (redisClient) {
          redisClient.disconnect();
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      closed = true;
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
