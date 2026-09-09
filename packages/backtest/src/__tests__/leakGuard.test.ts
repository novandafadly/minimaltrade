import { describe, expect, it } from "vitest";
import type { DataEnvelope, HistoryData, OhlcvBar, TradePlan } from "@idx/domain";
import { FutureLeakageError, withLeakGuard } from "../dataSource/leakGuard.js";
import type { LiquidUniverseEntry, ReplayDataSource } from "../dataSource/types.js";

/**
 * Proves the no-future-leakage guard actually catches a buggy data source,
 * not just that a correct one passes. This is the "test the guard itself"
 * requirement from the blueprint §13.2 no-future-leakage constraint.
 */

function bar(date: string, price: number): OhlcvBar {
  return { date, open: price, high: price, low: price, close: price, volume: 1000, turnover: price * 1000 };
}

/** A deliberately buggy data source: ignores `asOf` entirely and always
 * returns its full history, including bars/receivedAt dated after asOf. */
class LeakyDataSource implements ReplayDataSource {
  private readonly bars: OhlcvBar[] = [bar("2026-01-05", 1000), bar("2026-01-06", 1010), bar("2026-01-07", 1020)];

  async listTradingDates(): Promise<string[]> {
    return this.bars.map((b) => b.date);
  }

  async getHistoryAsOf(symbol: string, _asOf: string): Promise<DataEnvelope<HistoryData> | null> {
    // BUG: returns everything regardless of asOf, including future bars and
    // a receivedAt stamped from the last (future-relative-to-asOf) bar.
    const last = this.bars[this.bars.length - 1];
    if (!last) return null;
    return {
      symbol,
      tradingDate: last.date,
      eventTime: `${last.date}T16:00:00.000Z`,
      publishedAt: `${last.date}T16:00:00.000Z`,
      receivedAt: `${last.date}T16:00:00.000Z`,
      source: "leaky-fixture",
      segment: "regular",
      revisionId: null,
      status: "final",
      data: { symbol, bars: this.bars, baselineMedianVolume20d: null }
    };
  }

  async listUniverseAsOf(_asOf: string): Promise<LiquidUniverseEntry[]> {
    return [];
  }

  async getTradePlansForDate(_tradingDate: string): Promise<TradePlan[]> {
    return [];
  }

  async getBarOn(_symbol: string, date: string): Promise<OhlcvBar | null> {
    return this.bars.find((b) => b.date === date) ?? null;
  }

  async getSimulationBars(_symbol: string, afterDate: string, maxBars: number): Promise<OhlcvBar[]> {
    return this.bars.filter((b) => b.date > afterDate).slice(0, maxBars);
  }
}

/** A correct counterpart: actually filters by asOf. */
class HonestDataSource extends LeakyDataSource {
  override async getHistoryAsOf(symbol: string, asOf: string): Promise<DataEnvelope<HistoryData> | null> {
    const asOfDate = asOf.slice(0, 10);
    const visible = (await super.getHistoryAsOf(symbol, asOf))?.data.bars.filter((b) => b.date <= asOfDate) ?? [];
    if (visible.length === 0) return null;
    const last = visible[visible.length - 1];
    if (!last) return null;
    return {
      symbol,
      tradingDate: last.date,
      eventTime: `${last.date}T16:00:00.000Z`,
      publishedAt: `${last.date}T16:00:00.000Z`,
      receivedAt: `${last.date}T16:00:00.000Z`,
      source: "honest-fixture",
      segment: "regular",
      revisionId: null,
      status: "final",
      data: { symbol, bars: visible, baselineMedianVolume20d: null }
    };
  }
}

describe("withLeakGuard", () => {
  it("throws FutureLeakageError when a buggy source leaks bars dated after asOf", async () => {
    const guarded = withLeakGuard(new LeakyDataSource());
    // asOf = 2026-01-06 end of day; the leaky source returns a bar dated
    // 2026-01-07, which the guard must catch.
    await expect(guarded.getHistoryAsOf("TEST", "2026-01-06T23:59:59.999Z")).rejects.toThrow(FutureLeakageError);
  });

  it("throws FutureLeakageError when a buggy source's envelope receivedAt is after asOf", async () => {
    const guarded = withLeakGuard(new LeakyDataSource());
    // asOf strictly before the leaky source's fixed receivedAt (2026-01-07T16:00Z)
    await expect(guarded.getHistoryAsOf("TEST", "2026-01-06T00:00:00.000Z")).rejects.toThrow(FutureLeakageError);
  });

  it("does not throw for an honest source that correctly filters by asOf", async () => {
    const guarded = withLeakGuard(new HonestDataSource());
    const envelope = await guarded.getHistoryAsOf("TEST", "2026-01-06T23:59:59.999Z");
    expect(envelope).not.toBeNull();
    expect(envelope?.data.bars.map((b) => b.date)).toEqual(["2026-01-05", "2026-01-06"]);
  });

  it("passes through cleanly when asOf is at/after the last known bar", async () => {
    const guarded = withLeakGuard(new HonestDataSource());
    const envelope = await guarded.getHistoryAsOf("TEST", "2026-01-07T23:59:59.999Z");
    expect(envelope?.data.bars).toHaveLength(3);
  });
});
