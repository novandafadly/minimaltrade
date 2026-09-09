import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import type { HistoryData, OhlcvBar } from "@idx/domain";
import { liquidCandidates, mulberry32, randomLiquidUniverseStrategy, volumeOnlyRankingStrategy } from "../baselines.js";
import type { LiquidUniverseEntry } from "../dataSource/types.js";

function makeHistory(symbol: string, close: number): HistoryData {
  const bars: OhlcvBar[] = Array.from({ length: 6 }, (_, i) => ({
    date: `2026-01-0${i + 1}`,
    open: close - 5,
    high: close + 10,
    // low is set far enough below close that the risk-engine-derived stop
    // distance clears the minimum net reward:risk gate (a small price risk
    // relative to entry gets swamped by fixed fee/slippage costs and would
    // otherwise produce a NO_TRADE plan, which planFromHistory filters out).
    low: close - 100,
    close,
    volume: 100_000,
    turnover: close * 100_000
  }));
  return { symbol, bars, baselineMedianVolume20d: null };
}

function universe(): LiquidUniverseEntry[] {
  return [
    { symbol: "LIQ1", avgVolume20d: 1_000_000, avgTurnover20d: 1_000_000_000, lastClose: 1000, sector: null, marketCap: null },
    { symbol: "LIQ2", avgVolume20d: 2_000_000, avgTurnover20d: 2_000_000_000, lastClose: 1500, sector: null, marketCap: null },
    { symbol: "THIN", avgVolume20d: 1_000, avgTurnover20d: 1_000_000, lastClose: 500, sector: null, marketCap: null }
  ];
}

describe("liquidCandidates", () => {
  it("filters out symbols below the turnover floor", () => {
    const eligible = liquidCandidates(universe());
    expect(eligible.map((e) => e.symbol)).toEqual(["LIQ1", "LIQ2"]);
  });
});

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });
});

describe("volumeOnlyRankingStrategy", () => {
  it("ranks eligible candidates by 20d average volume, highest first, and builds plans via the risk engine", () => {
    const historyBySymbol = new Map([
      ["LIQ1", makeHistory("LIQ1", 1000)],
      ["LIQ2", makeHistory("LIQ2", 1500)]
    ]);
    const plans = volumeOnlyRankingStrategy({
      universe: universe(),
      historyBySymbol,
      tradingDate: "2026-01-06",
      sessionEndIso: "2026-01-06T08:49:00.000Z",
      config: DEFAULT_STRATEGY_CONFIG,
      maxCandidates: 5
    });
    expect(plans.map((p) => p.symbol)).toEqual(["LIQ2", "LIQ1"]); // LIQ2 has higher avgVolume20d
    for (const p of plans) {
      expect(p.isNoTrade).toBe(false);
      expect(p.totalLots).toBeGreaterThan(0);
    }
  });

  it("respects maxCandidates", () => {
    const historyBySymbol = new Map([
      ["LIQ1", makeHistory("LIQ1", 1000)],
      ["LIQ2", makeHistory("LIQ2", 1500)]
    ]);
    const plans = volumeOnlyRankingStrategy({
      universe: universe(),
      historyBySymbol,
      tradingDate: "2026-01-06",
      sessionEndIso: "2026-01-06T08:49:00.000Z",
      config: DEFAULT_STRATEGY_CONFIG,
      maxCandidates: 1
    });
    expect(plans).toHaveLength(1);
  });
});

describe("randomLiquidUniverseStrategy", () => {
  it("only ever selects from the liquidity-filtered pool", () => {
    const historyBySymbol = new Map([
      ["LIQ1", makeHistory("LIQ1", 1000)],
      ["LIQ2", makeHistory("LIQ2", 1500)],
      ["THIN", makeHistory("THIN", 500)]
    ]);
    const plans = randomLiquidUniverseStrategy(
      {
        universe: universe(),
        historyBySymbol,
        tradingDate: "2026-01-06",
        sessionEndIso: "2026-01-06T08:49:00.000Z",
        config: DEFAULT_STRATEGY_CONFIG,
        maxCandidates: 5
      },
      1234
    );
    for (const p of plans) {
      expect(p.symbol).not.toBe("THIN");
    }
  });

  it("is reproducible for a fixed seed", () => {
    const historyBySymbol = new Map([
      ["LIQ1", makeHistory("LIQ1", 1000)],
      ["LIQ2", makeHistory("LIQ2", 1500)]
    ]);
    const deps = {
      universe: universe(),
      historyBySymbol,
      tradingDate: "2026-01-06",
      sessionEndIso: "2026-01-06T08:49:00.000Z",
      config: DEFAULT_STRATEGY_CONFIG,
      maxCandidates: 1
    };
    const first = randomLiquidUniverseStrategy(deps, 99).map((p) => p.symbol);
    const second = randomLiquidUniverseStrategy(deps, 99).map((p) => p.symbol);
    expect(first).toEqual(second);
  });
});
