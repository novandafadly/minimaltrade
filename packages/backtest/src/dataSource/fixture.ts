import type { DataEnvelope, HistoryData, OhlcvBar, TradePlan } from "@idx/domain";
import type { FixtureSymbolData } from "../fixtures/syntheticFixture.js";
import type { LiquidUniverseEntry, ReplayDataSource } from "./types.js";

/**
 * In-memory ReplayDataSource backed by a deterministic synthetic fixture
 * (see ../fixtures/syntheticFixture.ts). Used by this package's own tests
 * and by `--source=fixture` in the CLI as a "does the pipeline work"
 * harness when no real historical Postgres data exists yet.
 */
export class FixtureDataSource implements ReplayDataSource {
  private readonly symbols: FixtureSymbolData[];
  private readonly barsBySymbol: Map<string, OhlcvBar[]>;
  private readonly planBySymbolAndDate: Map<string, TradePlan>;

  constructor(symbols: FixtureSymbolData[]) {
    this.symbols = symbols;
    this.barsBySymbol = new Map(symbols.map((s) => [s.symbol, [...s.bars].sort((a, b) => a.date.localeCompare(b.date))]));
    this.planBySymbolAndDate = new Map(symbols.map((s) => [`${s.symbol}|${s.plan.tradingDate}`, s.plan]));
  }

  async listTradingDates(): Promise<string[]> {
    const dates = new Set<string>();
    for (const bars of this.barsBySymbol.values()) {
      for (const b of bars) dates.add(b.date);
    }
    return [...dates].sort();
  }

  async getHistoryAsOf(symbol: string, asOf: string): Promise<DataEnvelope<HistoryData> | null> {
    const bars = this.barsBySymbol.get(symbol);
    if (!bars) return null;
    const asOfDate = asOf.slice(0, 10);
    const visible = bars.filter((b) => b.date <= asOfDate);
    if (visible.length === 0) return null;
    const last = visible[visible.length - 1];
    if (!last) return null;
    const window = visible.slice(-20);
    const baselineMedianVolume20d =
      window.length > 0 ? [...window.map((b) => b.volume)].sort((a, b) => a - b)[Math.floor(window.length / 2)] ?? null : null;

    return {
      symbol,
      tradingDate: last.date,
      eventTime: `${last.date}T16:00:00.000Z`,
      publishedAt: `${last.date}T16:00:00.000Z`,
      // Fixture data models same-day EOD publication: the bar for date D is
      // "received" at D 16:00 UTC (after IDX close), never before.
      receivedAt: `${last.date}T16:00:00.000Z`,
      source: "fixture",
      segment: "regular",
      revisionId: null,
      status: "final",
      data: { symbol, bars: visible, baselineMedianVolume20d }
    };
  }

  async listUniverseAsOf(asOf: string): Promise<LiquidUniverseEntry[]> {
    const asOfDate = asOf.slice(0, 10);
    const result: LiquidUniverseEntry[] = [];
    for (const symbol of this.barsBySymbol.keys()) {
      const bars = (this.barsBySymbol.get(symbol) ?? []).filter((b) => b.date <= asOfDate);
      if (bars.length < 5) continue;
      const window = bars.slice(-20);
      const avgVolume20d = window.reduce((s, b) => s + b.volume, 0) / window.length;
      const avgTurnover20d = window.reduce((s, b) => s + (b.turnover ?? 0), 0) / window.length;
      const last = window[window.length - 1];
      if (!last) continue;
      result.push({ symbol, avgVolume20d, avgTurnover20d, lastClose: last.close, sector: null, marketCap: null });
    }
    return result;
  }

  async getTradePlansForDate(tradingDate: string): Promise<TradePlan[]> {
    const plans: TradePlan[] = [];
    for (const s of this.symbols) {
      if (s.plan.tradingDate === tradingDate) plans.push(s.plan);
    }
    return plans;
  }

  async getBarOn(symbol: string, date: string): Promise<OhlcvBar | null> {
    const bars = this.barsBySymbol.get(symbol);
    if (!bars) return null;
    return bars.find((b) => b.date === date) ?? null;
  }

  async getSimulationBars(symbol: string, afterDate: string, maxBars: number): Promise<OhlcvBar[]> {
    const bars = this.barsBySymbol.get(symbol);
    if (!bars) return [];
    return bars.filter((b) => b.date > afterDate).slice(0, maxBars);
  }

  /** Test/CLI helper: the full HistoryData for a symbol, unfiltered. */
  historyBySymbol(): Map<string, HistoryData> {
    const map = new Map<string, HistoryData>();
    for (const [symbol, bars] of this.barsBySymbol) {
      map.set(symbol, { symbol, bars, baselineMedianVolume20d: null });
    }
    return map;
  }
}
