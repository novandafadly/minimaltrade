import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import type { BrokerSummaryData, HistoryData, OhlcvBar } from "@idx/domain";
import { signalFromHistoryStrategy } from "../signalFromHistory.js";
import type { LiquidUniverseEntry, ReplayDataSource } from "../dataSource/types.js";

function bars(symbol: string, n: number, base: number): OhlcvBar[] {
  const out: OhlcvBar[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 5, 1) + i * 86400000).toISOString().slice(0, 10);
    const close = base + i; // gentle uptrend
    out.push({ date: d, open: close - 1, high: close + 2, low: close - 2, close, volume: 5_000_000, turnover: close * 5_000_000 });
  }
  return out;
}

/** A day of broker flow with N diffuse net buyers (healthy concentration) all
 * accumulating just below the current price. */
function brokerDay(symbol: string, buyers: number, avgBuy: number): BrokerSummaryData {
  const brokers = Array.from({ length: buyers }, (_, i) => ({
    brokerCode: `B${i}`,
    buyVolume: 100_000,
    buyValue: 100_000 * avgBuy,
    sellVolume: 0,
    sellValue: 0,
    netVolume: 100_000,
    netValue: 100_000 * avgBuy,
    avgBuyPrice: avgBuy,
    avgSellPrice: null
  }));
  return {
    symbol,
    segment: "regular",
    brokers,
    totalVolume: brokers.reduce((s, b) => s + b.buyVolume, 0),
    totalValue: brokers.reduce((s, b) => s + b.buyValue, 0)
  };
}

function fakeSource(history: HistoryData, brokerHistory: BrokerSummaryData[]): ReplayDataSource {
  return {
    listTradingDates: async () => [],
    getHistoryAsOf: async () => null,
    listUniverseAsOf: async () => [],
    getTradePlansForDate: async () => [],
    getBarOn: async () => null,
    getSimulationBars: async () => [],
    getBrokerHistoryAsOf: async () => brokerHistory
  };
}

const universe: LiquidUniverseEntry[] = [
  { symbol: "TEST", avgVolume20d: 5_000_000, avgTurnover20d: 5_000_000_000, lastClose: 1030, sector: null, marketCap: null }
];

describe("signalFromHistoryStrategy", () => {
  it("returns [] when the data source cannot serve historical broker flow", async () => {
    const src = fakeSource({ symbol: "TEST", bars: bars("TEST", 30, 1000), baselineMedianVolume20d: 5_000_000 }, []);
    delete (src as { getBrokerHistoryAsOf?: unknown }).getBrokerHistoryAsOf;

    const plans = await signalFromHistoryStrategy({
      dataSource: src,
      universe,
      historyBySymbol: new Map([["TEST", { symbol: "TEST", bars: bars("TEST", 30, 1000), baselineMedianVolume20d: 5_000_000 }]]),
      tradingDate: "2026-06-30",
      sessionEndIso: "2026-06-30T08:49:00.000Z",
      config: DEFAULT_STRATEGY_CONFIG,
      maxCandidates: 3
    });
    expect(plans).toEqual([]);
  });

  it("runs the real engines and is deterministic", async () => {
    const history: HistoryData = { symbol: "TEST", bars: bars("TEST", 30, 1000), baselineMedianVolume20d: 5_000_000 };
    const brokerHistory = [
      brokerDay("TEST", 6, 1015),
      brokerDay("TEST", 6, 1018),
      brokerDay("TEST", 6, 1020),
      brokerDay("TEST", 6, 1022),
      brokerDay("TEST", 6, 1024)
    ];
    const deps = {
      dataSource: fakeSource(history, brokerHistory),
      universe,
      historyBySymbol: new Map([["TEST", history]]),
      tradingDate: "2026-06-30",
      sessionEndIso: "2026-06-30T08:49:00.000Z",
      config: DEFAULT_STRATEGY_CONFIG,
      maxCandidates: 3
    };
    const a = await signalFromHistoryStrategy(deps);
    const b = await signalFromHistoryStrategy(deps);
    expect(a).toEqual(b);
    // every returned plan is a real, non-NO_TRADE plan for a universe symbol
    for (const p of a) {
      expect(p.symbol).toBe("TEST");
      expect(p.isNoTrade).toBe(false);
      expect(p.totalLots).toBeGreaterThan(0);
    }
  });

  it("skips symbols with too little history", async () => {
    const shortHistory: HistoryData = { symbol: "TEST", bars: bars("TEST", 10, 1000), baselineMedianVolume20d: 5_000_000 };
    const plans = await signalFromHistoryStrategy({
      dataSource: fakeSource(shortHistory, [brokerDay("TEST", 6, 1015)]),
      universe,
      historyBySymbol: new Map([["TEST", shortHistory]]),
      tradingDate: "2026-06-30",
      sessionEndIso: "2026-06-30T08:49:00.000Z",
      config: DEFAULT_STRATEGY_CONFIG,
      maxCandidates: 3
    });
    expect(plans).toEqual([]);
  });
});
