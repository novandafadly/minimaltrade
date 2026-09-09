import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Db } from "@idx/db";
import { schema } from "@idx/db";
import type { SignalCategory } from "@idx/domain";

/**
 * Alert engine (blueprint §11 dedup/cooldown; §9.2 alert_log). Publishes a
 * signal-category-change alert onto a Redis pub/sub channel that apps/web's
 * SSE endpoint (built separately) subscribes to.
 *
 * Message envelope (documented contract for the SSE consumer):
 * {
 *   "type": "signal.category_changed",
 *   "payload": {
 *     "symbol": string,
 *     "tradingDate": string,
 *     "previousCategory": SignalCategory | null,
 *     "newCategory": SignalCategory,
 *     "compositeScore": number,
 *     "signalId": string,
 *     "generatedAt": string  // ISO
 *   }
 * }
 */

export const SIGNAL_ALERT_CHANNEL = "idx:signals";

/** Minimum time between two alerts for the same symbol+alertType, even if
 * the category keeps flapping. */
export const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

export interface AlertEnvelope {
  type: "signal.category_changed";
  payload: {
    symbol: string;
    tradingDate: string;
    previousCategory: SignalCategory | null;
    newCategory: SignalCategory;
    compositeScore: number;
    signalId: string;
    generatedAt: string;
  };
}

function idempotencyKeyFor(symbol: string, tradingDate: string, newCategory: SignalCategory): string {
  return createHash("sha256").update(`${symbol}|${tradingDate}|${newCategory}`).digest("hex");
}

/**
 * Publishes an alert when a symbol's signal category changed since the last
 * known category for that trading date, applying cooldown + idempotency via
 * `alert_log`'s unique `idempotency_key`. Returns whether an alert was
 * actually published (false = deduped/suppressed).
 */
export async function maybePublishCategoryChangeAlert(
  db: Db,
  redis: Redis,
  params: {
    symbol: string;
    tradingDate: string;
    previousCategory: SignalCategory | null;
    newCategory: SignalCategory;
    compositeScore: number;
    signalId: string;
    generatedAt?: string;
    now?: Date;
  }
): Promise<boolean> {
  if (params.previousCategory === params.newCategory) return false;

  const now = params.now ?? new Date();
  const idempotencyKey = idempotencyKeyFor(params.symbol, params.tradingDate, params.newCategory);

  const existing = await db
    .select({ id: schema.alertLog.id, cooldownUntil: schema.alertLog.cooldownUntil })
    .from(schema.alertLog)
    .where(eq(schema.alertLog.idempotencyKey, idempotencyKey))
    .limit(1);

  if (existing[0]) {
    // Same symbol+date+category combination already alerted — dedup even if
    // cooldown has elapsed, since it's the identical transition.
    return false;
  }

  // Cooldown: suppress if we alerted on ANY category for this symbol very
  // recently, to avoid rapid flapping spamming multiple alerts.
  const recentKey = `idx:alert:cooldown:${params.symbol}`;
  const cooldownActive = await redis.get(recentKey);
  if (cooldownActive) return false;

  const generatedAt = params.generatedAt ?? now.toISOString();

  await db.insert(schema.alertLog).values({
    id: randomUUID(),
    idempotencyKey,
    symbol: params.symbol,
    alertType: `category_changed:${params.newCategory}`,
    sentAt: now,
    cooldownUntil: new Date(now.getTime() + ALERT_COOLDOWN_MS)
  });

  await redis.set(recentKey, "1", "PX", ALERT_COOLDOWN_MS);

  const envelope: AlertEnvelope = {
    type: "signal.category_changed",
    payload: {
      symbol: params.symbol,
      tradingDate: params.tradingDate,
      previousCategory: params.previousCategory,
      newCategory: params.newCategory,
      compositeScore: params.compositeScore,
      signalId: params.signalId,
      generatedAt
    }
  };

  await redis.publish(SIGNAL_ALERT_CHANNEL, JSON.stringify(envelope));
  return true;
}
