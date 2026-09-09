import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import type { Db } from "@idx/db";
import { instrument, marketSnapshot, tradePlan as tradePlanTable } from "@idx/db";
import type { DataEnvelope, HistoryData, OhlcvBar, TradePlan } from "@idx/domain";
import type { LiquidUniverseEntry, ReplayDataSource } from "./types.js";

/**
 * Postgres-backed ReplayDataSource for real historical replay once the live
 * funnel has persisted enough `market_snapshot` history and the signal
 * pipeline has persisted `trade_plan` rows.
 *
 * KNOWN SCHEMA LIMITATION (documented, not fixed here -- packages/db/src/
 * schema.ts is read-only for this package per its build instructions):
 * `market_snapshot` stores a single EOD `price` per symbol/day, not a full
 * OHLC bar (no open/high/low columns). This data source maps that one price
 * to open=high=low=close for the day. That is enough to run the replay
 * pipeline end to end, but it silently degrades two things the fill
 * simulator is designed to model precisely:
 *   - gap detection (open vs prior close) never fires, since "open" here IS
 *     the snapshot price, not a real session open;
 *   - same-bar SL/TP ambiguity never arises, since high=low=close collapses
 *     every bar to a single price point.
 * For a real production backtest, either (a) persist true OHLC (add
 * open/high/low columns to market_snapshot, or a dedicated daily_bar table
 * fed from the `/api/history/{code}` endpoint's bars), or (b) source bars
 * from that history endpoint's archived raw_payload_archive rows instead of
 * market_snapshot directly. Flagged in this session's report rather than
 * changed here, per this package's constraints.
 */
export class PostgresDataSource implements ReplayDataSource {
  constructor(private readonly db: Db) {}

  async listTradingDates(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ tradingDate: marketSnapshot.tradingDate })
      .from(marketSnapshot)
      .orderBy(asc(marketSnapshot.tradingDate));
    return rows.map((r) => r.tradingDate);
  }

  async getHistoryAsOf(symbol: string, asOf: string): Promise<DataEnvelope<HistoryData> | null> {
    const asOfDate = asOf.slice(0, 10);
    const rows = await this.db
      .select()
      .from(marketSnapshot)
      .where(
        and(
          eq(marketSnapshot.symbol, symbol),
          lte(marketSnapshot.tradingDate, asOfDate),
          lte(marketSnapshot.receivedAt, new Date(asOf))
        )
      )
      .orderBy(asc(marketSnapshot.tradingDate));

    if (rows.length === 0) return null;
    const last = rows[rows.length - 1];
    if (!last) return null;

    const bars: OhlcvBar[] = rows.map(rowToBar);
    const volumes = [...bars.map((b) => b.volume)].sort((a, b) => a - b);
    const baselineMedianVolume20d = volumes.length > 0 ? (volumes[Math.floor(volumes.length / 2)] ?? null) : null;

    return {
      symbol,
      tradingDate: last.tradingDate,
      eventTime: last.eventTime ? last.eventTime.toISOString() : null,
      publishedAt: last.publishedAt ? last.publishedAt.toISOString() : null,
      receivedAt: last.receivedAt.toISOString(),
      source: last.source,
      segment: (last.segment as DataEnvelope<HistoryData>["segment"]) ?? "unknown",
      revisionId: last.revisionId,
      status: (last.status as DataEnvelope<HistoryData>["status"]) ?? "final",
      data: { symbol, bars: bars.slice(-20), baselineMedianVolume20d }
    };
  }

  async listUniverseAsOf(asOf: string): Promise<LiquidUniverseEntry[]> {
    const asOfDate = asOf.slice(0, 10);
    const rows = await this.db
      .select()
      .from(marketSnapshot)
      .where(and(lte(marketSnapshot.tradingDate, asOfDate), lte(marketSnapshot.receivedAt, new Date(asOf))))
      .orderBy(asc(marketSnapshot.tradingDate));

    const bySymbol = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = bySymbol.get(r.symbol);
      if (arr) arr.push(r);
      else bySymbol.set(r.symbol, [r]);
    }

    const sectorBySymbol = new Map<string, string | null>();
    const instruments = await this.db.select().from(instrument);
    for (const i of instruments) sectorBySymbol.set(i.symbol, i.sector);

    const result: LiquidUniverseEntry[] = [];
    for (const [symbol, symbolRows] of bySymbol) {
      if (symbolRows.length < 5) continue;
      const window = symbolRows.slice(-20);
      const avgVolume20d = window.reduce((s, r) => s + Number(r.volume), 0) / window.length;
      const avgTurnover20d = window.reduce((s, r) => s + Number(r.turnover), 0) / window.length;
      const last = window[window.length - 1];
      if (!last) continue;
      result.push({
        symbol,
        avgVolume20d,
        avgTurnover20d,
        lastClose: Number(last.price),
        sector: sectorBySymbol.get(symbol) ?? null,
        marketCap: null
      });
    }
    return result;
  }

  async getTradePlansForDate(tradingDate: string): Promise<TradePlan[]> {
    const rows = await this.db.select().from(tradePlanTable).where(eq(tradePlanTable.tradingDate, tradingDate));
    return rows.filter((r) => !r.isNoTrade).map(rowToTradePlan);
  }

  async getBarOn(symbol: string, date: string): Promise<OhlcvBar | null> {
    const rows = await this.db
      .select()
      .from(marketSnapshot)
      .where(and(eq(marketSnapshot.symbol, symbol), eq(marketSnapshot.tradingDate, date)))
      .orderBy(desc(marketSnapshot.receivedAt))
      .limit(1);
    const row = rows[0];
    return row ? rowToBar(row) : null;
  }

  async getSimulationBars(symbol: string, afterDate: string, maxBars: number): Promise<OhlcvBar[]> {
    const rows = await this.db
      .select()
      .from(marketSnapshot)
      .where(and(eq(marketSnapshot.symbol, symbol), gt(marketSnapshot.tradingDate, afterDate)))
      .orderBy(asc(marketSnapshot.tradingDate))
      .limit(maxBars);
    return rows.map(rowToBar);
  }
}

function rowToBar(row: { tradingDate: string; price: string; volume: string; turnover: string }): OhlcvBar {
  const price = Number(row.price);
  return {
    date: row.tradingDate,
    // See class docstring: market_snapshot has no open/high/low, only a
    // single EOD price. Collapsing all four to that price is a documented
    // approximation, not a real OHLC bar.
    open: price,
    high: price,
    low: price,
    close: price,
    volume: Number(row.volume),
    turnover: Number(row.turnover)
  };
}

function rowToTradePlan(row: {
  symbol: string;
  tradingDate: string;
  formulaVersion: string;
  configVersion: string;
  generatedAt: Date;
  expiry: Date;
  entryTrigger: string;
  maxBuyPrice: string;
  totalLots: number;
  estimatedCapital: string;
  tp1Price: string;
  tp1Lots: number;
  tp2Price: string;
  tp2Lots: number;
  slPrice: string;
  slRemainingLots: number;
  grossReward: string;
  estimatedFees: string;
  slippageAllowance: string;
  netReward: string;
  maxNetLoss: string;
  netRewardToRisk: string;
  isNoTrade: boolean;
  noTradeReason: string | null;
}): TradePlan {
  return {
    symbol: row.symbol,
    tradingDate: row.tradingDate,
    formulaVersion: row.formulaVersion,
    configVersion: row.configVersion,
    generatedAt: row.generatedAt.toISOString(),
    expiry: row.expiry.toISOString(),
    entryTrigger: Number(row.entryTrigger),
    maxBuyPrice: Number(row.maxBuyPrice),
    totalLots: row.totalLots,
    estimatedCapital: Number(row.estimatedCapital),
    tp1Price: Number(row.tp1Price),
    tp1Lots: row.tp1Lots,
    tp2Price: Number(row.tp2Price),
    tp2Lots: row.tp2Lots,
    slPrice: Number(row.slPrice),
    slRemainingLots: row.slRemainingLots,
    grossReward: Number(row.grossReward),
    estimatedFees: Number(row.estimatedFees),
    slippageAllowance: Number(row.slippageAllowance),
    netReward: Number(row.netReward),
    maxNetLoss: Number(row.maxNetLoss),
    netRewardToRisk: Number(row.netRewardToRisk),
    isNoTrade: row.isNoTrade,
    noTradeReason: row.noTradeReason
  };
}
