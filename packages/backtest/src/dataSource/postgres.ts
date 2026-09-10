import { and, asc, desc, eq, gt, inArray, lte } from "drizzle-orm";
import type { Db } from "@idx/db";
import { brokerSnapshot, dailyBar, instrument, marketSnapshot, tradePlan as tradePlanTable } from "@idx/db";
import type { BrokerSummaryData, DataEnvelope, HistoryData, OhlcvBar, TradePlan } from "@idx/domain";
import type { LiquidUniverseEntry, ReplayDataSource } from "./types.js";

/**
 * Postgres-backed ReplayDataSource for real historical replay.
 *
 * Bars are sourced from `daily_bar` (true OHLCV, persisted by
 * `apps/worker`'s deep funnel from `/api/history/{code}`) when available for
 * a symbol/date. This is what the fill simulator needs for accurate gap
 * detection and same-bar SL/TP-priority resolution.
 *
 * FALLBACK (documented, intentional): for a symbol/date with no `daily_bar`
 * row yet -- e.g. a fresh deployment that hasn't run the deep funnel through
 * a full day, or historical `market_snapshot` rows collected before
 * `daily_bar` existed -- this source falls back to `market_snapshot`'s
 * single EOD `price`, collapsed to open=high=low=close for that day. That
 * silently degrades gap detection (no real session open) and same-bar
 * SL/TP ambiguity (high=low=close), same as before `daily_bar` existed, but
 * only for the days lacking real bar data; it keeps the replay pipeline
 * runnable rather than failing outright on partial history.
 */
export class PostgresDataSource implements ReplayDataSource {
  constructor(private readonly db: Db) {}

  async listTradingDates(): Promise<string[]> {
    // Prefer daily_bar (true OHLCV, and what the historical backfill populates);
    // fall back to market_snapshot for pre-daily_bar deployments.
    const barDates = await this.db
      .selectDistinct({ tradingDate: dailyBar.tradingDate })
      .from(dailyBar)
      .orderBy(asc(dailyBar.tradingDate));
    if (barDates.length > 0) return barDates.map((r) => r.tradingDate);

    const rows = await this.db
      .selectDistinct({ tradingDate: marketSnapshot.tradingDate })
      .from(marketSnapshot)
      .orderBy(asc(marketSnapshot.tradingDate));
    return rows.map((r) => r.tradingDate);
  }

  async getHistoryAsOf(symbol: string, asOf: string): Promise<DataEnvelope<HistoryData> | null> {
    const asOfDate = asOf.slice(0, 10);

    const barRows = await this.db
      .select()
      .from(dailyBar)
      .where(and(eq(dailyBar.symbol, symbol), lte(dailyBar.tradingDate, asOfDate), lte(dailyBar.receivedAt, new Date(asOf))))
      .orderBy(asc(dailyBar.tradingDate));

    if (barRows.length > 0) {
      const allBars: OhlcvBar[] = barRows.map(dailyBarRowToBar);
      const last = barRows[barRows.length - 1];
      if (!last) return null;
      return {
        symbol,
        tradingDate: last.tradingDate,
        eventTime: null,
        publishedAt: null,
        receivedAt: last.receivedAt.toISOString(),
        source: last.source,
        segment: "regular",
        revisionId: null,
        status: "final",
        // Return a deeper window (the feature engine reads bars[-21..-1] for
        // the turnover baseline and bars[-1] for "today"); baseline median is
        // computed EX-today over the trailing 20, matching the live adapter.
        data: { symbol, bars: allBars.slice(-40), baselineMedianVolume20d: medianVolumeExToday(allBars, 20) }
      };
    }

    // Fallback: no daily_bar rows for this symbol/window yet -- degrade to
    // market_snapshot's single-price-per-day approximation (see class doc).
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

    const sectorBySymbol = new Map<string, string | null>();
    const instruments = await this.db.select().from(instrument);
    for (const i of instruments) sectorBySymbol.set(i.symbol, i.sector);

    // Prefer daily_bar (real OHLCV). turnover falls back to close*volume when
    // the bar's own turnover column is null.
    const barRows = await this.db
      .select()
      .from(dailyBar)
      .where(and(lte(dailyBar.tradingDate, asOfDate), lte(dailyBar.receivedAt, new Date(asOf))))
      .orderBy(asc(dailyBar.tradingDate));

    if (barRows.length > 0) {
      const bySymbol = new Map<string, typeof barRows>();
      for (const r of barRows) {
        const arr = bySymbol.get(r.symbol);
        if (arr) arr.push(r);
        else bySymbol.set(r.symbol, [r]);
      }
      const result: LiquidUniverseEntry[] = [];
      for (const [symbol, rows] of bySymbol) {
        if (rows.length < 5) continue;
        const window = rows.slice(-20);
        const avgVolume20d = window.reduce((s, r) => s + Number(r.volume), 0) / window.length;
        const avgTurnover20d =
          window.reduce((s, r) => s + (r.turnover !== null ? Number(r.turnover) : Number(r.close) * Number(r.volume)), 0) /
          window.length;
        const last = window[window.length - 1];
        if (!last) continue;
        result.push({
          symbol,
          avgVolume20d,
          avgTurnover20d,
          lastClose: Number(last.close),
          sector: sectorBySymbol.get(symbol) ?? null,
          marketCap: null
        });
      }
      return result;
    }

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

  /**
   * DECISION-TIME. Per-day broker flow for `symbol` over the last `days`
   * trading days on/before `asOf` (ascending, most recent last — the
   * FeatureEngineInput.brokerSummaryByDay contract). Reconstructed from
   * `broker_snapshot` rows; on backfilled data those carry only NET flow
   * approximated onto one side (see backfill.ts).
   */
  async getBrokerHistoryAsOf(symbol: string, asOf: string, days = 5): Promise<BrokerSummaryData[]> {
    const asOfDate = asOf.slice(0, 10);
    const rows = await this.db
      .select()
      .from(brokerSnapshot)
      .where(
        and(
          eq(brokerSnapshot.symbol, symbol),
          lte(brokerSnapshot.tradingDate, asOfDate),
          lte(brokerSnapshot.receivedAt, new Date(asOf))
        )
      )
      .orderBy(asc(brokerSnapshot.tradingDate));

    if (rows.length === 0) return [];

    const distinctDates = [...new Set(rows.map((r) => r.tradingDate))].sort();
    const keepDates = new Set(distinctDates.slice(-days));

    const byDate = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!keepDates.has(r.tradingDate)) continue;
      const arr = byDate.get(r.tradingDate);
      if (arr) arr.push(r);
      else byDate.set(r.tradingDate, [r]);
    }

    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, dayRows]) => {
        const brokers = dayRows.map((r) => ({
          brokerCode: r.brokerCode,
          buyVolume: Number(r.buyVolume),
          buyValue: Number(r.buyValue),
          sellVolume: Number(r.sellVolume),
          sellValue: Number(r.sellValue),
          netVolume: Number(r.netVolume),
          netValue: Number(r.netValue),
          avgBuyPrice: r.avgBuyPrice !== null ? Number(r.avgBuyPrice) : null,
          avgSellPrice: r.avgSellPrice !== null ? Number(r.avgSellPrice) : null
        }));
        return {
          symbol,
          segment: "regular" as const,
          brokers,
          totalVolume: brokers.reduce((s, b) => s + b.buyVolume + b.sellVolume, 0),
          totalValue: brokers.reduce((s, b) => s + b.buyValue + b.sellValue, 0)
        };
      });
  }

  /** Symbols that have any broker_snapshot row on/before `asOf`. */
  async symbolsWithBrokerHistoryAsOf(asOf: string, candidates: string[]): Promise<Set<string>> {
    if (candidates.length === 0) return new Set();
    const rows = await this.db
      .selectDistinct({ symbol: brokerSnapshot.symbol })
      .from(brokerSnapshot)
      .where(and(inArray(brokerSnapshot.symbol, candidates), lte(brokerSnapshot.receivedAt, new Date(asOf))));
    return new Set(rows.map((r) => r.symbol));
  }

  async getTradePlansForDate(tradingDate: string): Promise<TradePlan[]> {
    const rows = await this.db.select().from(tradePlanTable).where(eq(tradePlanTable.tradingDate, tradingDate));
    return rows.filter((r) => !r.isNoTrade).map(rowToTradePlan);
  }

  async getBarOn(symbol: string, date: string): Promise<OhlcvBar | null> {
    const barRows = await this.db
      .select()
      .from(dailyBar)
      .where(and(eq(dailyBar.symbol, symbol), eq(dailyBar.tradingDate, date)))
      .limit(1);
    const barRow = barRows[0];
    if (barRow) return dailyBarRowToBar(barRow);

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
    const barRows = await this.db
      .select()
      .from(dailyBar)
      .where(and(eq(dailyBar.symbol, symbol), gt(dailyBar.tradingDate, afterDate)))
      .orderBy(asc(dailyBar.tradingDate))
      .limit(maxBars);
    if (barRows.length > 0) return barRows.map(dailyBarRowToBar);

    const rows = await this.db
      .select()
      .from(marketSnapshot)
      .where(and(eq(marketSnapshot.symbol, symbol), gt(marketSnapshot.tradingDate, afterDate)))
      .orderBy(asc(marketSnapshot.tradingDate))
      .limit(maxBars);
    return rows.map(rowToBar);
  }
}

/** Median volume over the trailing `window` bars, EXCLUDING the most recent
 * (the "today" bar) — matches the live adapter's medianVolumeExcludingLast. */
function medianVolumeExToday(bars: OhlcvBar[], window = 20): number | null {
  const pool = bars
    .slice(0, -1)
    .slice(-window)
    .map((b) => b.volume)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  if (pool.length === 0) return null;
  const mid = Math.floor(pool.length / 2);
  return pool.length % 2 === 0 ? ((pool[mid - 1] ?? 0) + (pool[mid] ?? 0)) / 2 : (pool[mid] ?? 0);
}

function dailyBarRowToBar(row: {
  tradingDate: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  turnover: string | null;
}): OhlcvBar {
  return {
    date: row.tradingDate,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    turnover: row.turnover !== null ? Number(row.turnover) : null
  };
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
