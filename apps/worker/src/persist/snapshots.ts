import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@idx/db";
import { schema } from "@idx/db";
import type { DataEnvelope, ScreenerRow, BrokerSummaryData, HistoryData } from "@idx/domain";
import type { FeatureSnapshot, Signal, TradePlan } from "@idx/domain";

/**
 * Idempotent persistence for funnel outputs (blueprint: "Idempotency key
 * mencegah alert ganda dan duplikasi snapshot"). The cache layer (cache.ts)
 * is the idempotency mechanism for HTTP calls; this module is the analogous
 * guard for DB writes so a symbol+tradingDate(+revisionId) combination is
 * never written twice, even if the funnel re-runs over the same cached
 * envelope (e.g. after a process restart mid-run).
 */

export async function insertMarketSnapshotIdempotent(
  db: Db,
  envelope: DataEnvelope<ScreenerRow>,
  rawPayloadId: string | null
): Promise<string> {
  const existing = await db
    .select({ id: schema.marketSnapshot.id })
    .from(schema.marketSnapshot)
    .where(
      and(
        eq(schema.marketSnapshot.symbol, envelope.symbol),
        eq(schema.marketSnapshot.tradingDate, envelope.tradingDate),
        envelope.revisionId
          ? eq(schema.marketSnapshot.revisionId, envelope.revisionId)
          : isNull(schema.marketSnapshot.revisionId)
      )
    )
    .limit(1);

  if (existing[0]) return existing[0].id;

  const id = randomUUID();
  await db.insert(schema.marketSnapshot).values({
    id,
    symbol: envelope.symbol,
    tradingDate: envelope.tradingDate,
    eventTime: envelope.eventTime ? new Date(envelope.eventTime) : null,
    publishedAt: envelope.publishedAt ? new Date(envelope.publishedAt) : null,
    receivedAt: new Date(envelope.receivedAt),
    source: envelope.source,
    segment: envelope.segment,
    revisionId: envelope.revisionId,
    status: envelope.status,
    price: String(envelope.data.price),
    priceChangePct: String(envelope.data.priceChangePct),
    volume: String(envelope.data.volume),
    turnover: String(envelope.data.turnover),
    bestBid: envelope.data.bestBid !== null ? String(envelope.data.bestBid) : null,
    bestOffer: envelope.data.bestOffer !== null ? String(envelope.data.bestOffer) : null,
    spread: envelope.data.spread !== null ? String(envelope.data.spread) : null,
    isSuspended: envelope.data.isSuspended,
    rawPayloadId
  });
  return id;
}

export async function upsertBrokerSnapshot(
  db: Db,
  envelope: DataEnvelope<BrokerSummaryData>,
  rawPayloadId: string | null
): Promise<void> {
  for (const row of envelope.data.brokers) {
    const id = randomUUID();
    await db
      .insert(schema.brokerSnapshot)
      .values({
        id,
        symbol: envelope.symbol,
        tradingDate: envelope.tradingDate,
        brokerCode: row.brokerCode,
        segment: envelope.segment,
        buyVolume: String(row.buyVolume),
        buyValue: String(row.buyValue),
        sellVolume: String(row.sellVolume),
        sellValue: String(row.sellValue),
        netVolume: String(row.netVolume),
        netValue: String(row.netValue),
        avgBuyPrice: row.avgBuyPrice !== null ? String(row.avgBuyPrice) : null,
        avgSellPrice: row.avgSellPrice !== null ? String(row.avgSellPrice) : null,
        status: envelope.status,
        receivedAt: new Date(envelope.receivedAt),
        rawPayloadId
      })
      .onConflictDoUpdate({
        target: [schema.brokerSnapshot.symbol, schema.brokerSnapshot.tradingDate, schema.brokerSnapshot.brokerCode],
        set: {
          buyVolume: String(row.buyVolume),
          buyValue: String(row.buyValue),
          sellVolume: String(row.sellVolume),
          sellValue: String(row.sellValue),
          netVolume: String(row.netVolume),
          netValue: String(row.netValue),
          avgBuyPrice: row.avgBuyPrice !== null ? String(row.avgBuyPrice) : null,
          avgSellPrice: row.avgSellPrice !== null ? String(row.avgSellPrice) : null,
          status: envelope.status,
          receivedAt: new Date(envelope.receivedAt),
          rawPayloadId
        }
      });
  }
}

/**
 * Persists true OHLCV bars from `/api/history/{code}` into `daily_bar`, one
 * upsert per bar (a history response typically returns a rolling window, so
 * re-fetching the same day is expected and must be idempotent). This is what
 * lets `packages/backtest`'s PostgresDataSource do real gap detection and
 * same-bar SL/TP resolution instead of degrading to a single EOD price point
 * (see that package's documented `market_snapshot`-only limitation).
 */
export async function upsertDailyBars(db: Db, envelope: DataEnvelope<HistoryData>): Promise<void> {
  for (const bar of envelope.data.bars) {
    await db
      .insert(schema.dailyBar)
      .values({
        id: randomUUID(),
        symbol: envelope.symbol,
        tradingDate: bar.date,
        open: String(bar.open),
        high: String(bar.high),
        low: String(bar.low),
        close: String(bar.close),
        volume: String(bar.volume),
        turnover: bar.turnover !== null ? String(bar.turnover) : null,
        source: envelope.source,
        receivedAt: new Date(envelope.receivedAt)
      })
      .onConflictDoUpdate({
        target: [schema.dailyBar.symbol, schema.dailyBar.tradingDate],
        set: {
          open: String(bar.open),
          high: String(bar.high),
          low: String(bar.low),
          close: String(bar.close),
          volume: String(bar.volume),
          turnover: bar.turnover !== null ? String(bar.turnover) : null,
          source: envelope.source,
          receivedAt: new Date(envelope.receivedAt)
        }
      });
  }
}

export async function upsertFeatureSnapshot(
  db: Db,
  snapshot: FeatureSnapshot,
  dataStale: boolean,
  segmentMixed: boolean
): Promise<string> {
  const id = randomUUID();
  // IMPORTANT: on conflict (existing row for this symbol+tradingDate), the
  // UPDATE does not touch `id`, so the pre-existing row keeps its original
  // id -- `.returning()` is what tells us that real id (rather than the
  // fresh `id` generated above, which is only used if this is a genuine
  // insert). Callers (insertSignal's featureSnapshotId FK) depend on this
  // being the actual persisted row id.
  const [row] = await db
    .insert(schema.featureSnapshot)
    .values({
      id,
      symbol: snapshot.symbol,
      tradingDate: snapshot.tradingDate,
      formulaVersion: snapshot.formulaVersion,
      generatedAt: new Date(snapshot.generatedAt),
      inputSnapshotId: snapshot.inputSnapshotId,
      features: snapshot as unknown as object,
      ownerStatus: snapshot.ownerStatus,
      dataStale,
      segmentMixed
    })
    .onConflictDoUpdate({
      target: [schema.featureSnapshot.symbol, schema.featureSnapshot.tradingDate],
      set: {
        formulaVersion: snapshot.formulaVersion,
        generatedAt: new Date(snapshot.generatedAt),
        inputSnapshotId: snapshot.inputSnapshotId,
        features: snapshot as unknown as object,
        ownerStatus: snapshot.ownerStatus,
        dataStale,
        segmentMixed
      }
    })
    .returning({ id: schema.featureSnapshot.id });
  return row?.id ?? id;
}

/**
 * Idempotent on (symbol, trading_date): a re-run of the deep funnel for the
 * same day (worker restart, manual trigger) updates the existing signal row
 * instead of adding a duplicate. Returns the real row id (existing or new)
 * so the trade-plan FK stays stable. `gates` is the ScoreResult's hard-gate
 * results, persisted for the dashboard's "why NO_TRADE / AVOID" view.
 */
export async function insertSignal(
  db: Db,
  sig: Signal,
  gates: object,
  featureSnapshotId: string | null
): Promise<string> {
  const id = randomUUID();
  const values = {
    id,
    symbol: sig.symbol,
    tradingDate: sig.tradingDate,
    generatedAt: new Date(sig.generatedAt),
    expiry: new Date(sig.expiry),
    category: sig.category,
    compositeScore: String(sig.compositeScore),
    confidence: sig.confidence,
    noTradeReason: sig.noTradeReason,
    gates,
    formulaVersion: sig.formulaVersion,
    configVersion: sig.configVersion,
    inputSnapshotId: sig.inputSnapshotId,
    featureSnapshotId
  };
  const [row] = await db
    .insert(schema.signal)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.signal.symbol, schema.signal.tradingDate],
      set: {
        generatedAt: values.generatedAt,
        expiry: values.expiry,
        category: values.category,
        compositeScore: values.compositeScore,
        confidence: values.confidence,
        noTradeReason: values.noTradeReason,
        gates: values.gates,
        formulaVersion: values.formulaVersion,
        configVersion: values.configVersion,
        inputSnapshotId: values.inputSnapshotId,
        featureSnapshotId: values.featureSnapshotId
      }
    })
    .returning({ id: schema.signal.id });
  return row?.id ?? id;
}

/** Idempotent on signal_id (one trade plan per signal). */
export async function insertTradePlan(db: Db, signalId: string, plan: TradePlan): Promise<string> {
  const id = randomUUID();
  const values = {
    id,
    signalId,
    symbol: plan.symbol,
    tradingDate: plan.tradingDate,
    formulaVersion: plan.formulaVersion,
    configVersion: plan.configVersion,
    generatedAt: new Date(plan.generatedAt),
    expiry: new Date(plan.expiry),
    entryTrigger: String(plan.entryTrigger),
    maxBuyPrice: String(plan.maxBuyPrice),
    totalLots: plan.totalLots,
    estimatedCapital: String(plan.estimatedCapital),
    tp1Price: String(plan.tp1Price),
    tp1Lots: plan.tp1Lots,
    tp2Price: String(plan.tp2Price),
    tp2Lots: plan.tp2Lots,
    slPrice: String(plan.slPrice),
    slRemainingLots: plan.slRemainingLots,
    grossReward: String(plan.grossReward),
    estimatedFees: String(plan.estimatedFees),
    slippageAllowance: String(plan.slippageAllowance),
    netReward: String(plan.netReward),
    maxNetLoss: String(plan.maxNetLoss),
    netRewardToRisk: String(plan.netRewardToRisk),
    isNoTrade: plan.isNoTrade,
    noTradeReason: plan.noTradeReason
  };
  const updatable: Record<string, unknown> = { ...values };
  delete updatable.id;
  delete updatable.signalId;
  const [row] = await db
    .insert(schema.tradePlan)
    .values(values)
    .onConflictDoUpdate({ target: schema.tradePlan.signalId, set: updatable })
    .returning({ id: schema.tradePlan.id });
  return row?.id ?? id;
}
