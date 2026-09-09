import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import { computeFeatureSnapshot } from "../feature.js";
import type { FeatureEngineInput } from "../interfaces.js";
import type { BrokerRow, BrokerSummaryData, ScreenerRow } from "../../types/marketData.js";

function broker(partial: Partial<BrokerRow> & { brokerCode: string }): BrokerRow {
  return {
    buyVolume: 0,
    buyValue: 0,
    sellVolume: 0,
    sellValue: 0,
    netVolume: 0,
    netValue: 0,
    avgBuyPrice: null,
    avgSellPrice: null,
    ...partial
  };
}

function daySummary(brokers: BrokerRow[]): BrokerSummaryData {
  return {
    symbol: "TEST",
    segment: "regular",
    brokers,
    totalVolume: brokers.reduce((a, b) => a + b.buyVolume + b.sellVolume, 0),
    totalValue: brokers.reduce((a, b) => a + b.buyValue + b.sellValue, 0)
  };
}

const baseScreener: ScreenerRow = {
  symbol: "TEST",
  board: "RG",
  price: 1000,
  priceChange: 10,
  priceChangePct: 1,
  volume: 1_000_000,
  turnover: 1_000_000_000,
  bestBid: 995,
  bestOffer: 1000,
  spread: 5,
  isSuspended: false,
  notation: null
};

function baseInput(overrides: Partial<FeatureEngineInput> = {}): FeatureEngineInput {
  return {
    symbol: "TEST",
    tradingDate: "2026-09-09",
    inputSnapshotId: "snap-1",
    screener: baseScreener,
    history: null,
    brokerSummaryByDay: [],
    brokerAccumulation: null,
    seasonal: null,
    insiders: null,
    segmentSeparable: true,
    dataStale: false,
    ...overrides
  };
}

describe("B-Avg (golden)", () => {
  it("computes gross buy value / gross buy shares over accumulator brokers only", () => {
    const brokers = [
      broker({ brokerCode: "AA", buyVolume: 1000, buyValue: 1_000_000, netVolume: 1000, netValue: 1_000_000 }),
      broker({ brokerCode: "BB", buyVolume: 500, buyValue: 510_000, netVolume: 500, netValue: 510_000 }),
      // non-accumulator (net sell) must be excluded even though it has buy activity
      broker({
        brokerCode: "CC",
        buyVolume: 2000,
        buyValue: 1_900_000,
        sellVolume: 3000,
        sellValue: 3_000_000,
        netVolume: -1000,
        netValue: -1_100_000
      })
    ];
    const input = baseInput({ brokerSummaryByDay: [daySummary(brokers)] });
    const snapshot = computeFeatureSnapshot(input, DEFAULT_STRATEGY_CONFIG, "2026-09-09T10:00:00Z");
    // (1_000_000 + 510_000) / (1000 + 500) = 1_510_000 / 1500 = 1006.666...
    expect(snapshot.brokerFlow.bAvg).toBeCloseTo(1006.6666666667, 6);
    expect(snapshot.brokerFlow.bAvgConfidence).toBe("high");
  });

  it("reports low confidence with null bAvg when no accumulator gross data is available", () => {
    const input = baseInput({ brokerSummaryByDay: [daySummary([])] });
    const snapshot = computeFeatureSnapshot(input, DEFAULT_STRATEGY_CONFIG, "2026-09-09T10:00:00Z");
    expect(snapshot.brokerFlow.bAvg).toBeNull();
    expect(snapshot.brokerFlow.bAvgConfidence).toBe("low");
  });
});

describe("Top1Share / Top3Share / HHI (golden)", () => {
  it("computes shares of total positive net buy", () => {
    const brokers = [
      broker({ brokerCode: "A", netVolume: 500 }),
      broker({ brokerCode: "B", netVolume: 300 }),
      broker({ brokerCode: "C", netVolume: 150 }),
      broker({ brokerCode: "D", netVolume: 50 }),
      broker({ brokerCode: "E", netVolume: -200 }) // seller, excluded from buyer concentration
    ];
    const input = baseInput({ brokerSummaryByDay: [daySummary(brokers)] });
    const snapshot = computeFeatureSnapshot(input, DEFAULT_STRATEGY_CONFIG, "2026-09-09T10:00:00Z");
    // total positive net buy = 1000
    expect(snapshot.brokerFlow.top1Share).toBeCloseTo(0.5, 10);
    expect(snapshot.brokerFlow.top3Share).toBeCloseTo(0.95, 10);
    // HHI = 0.5^2 + 0.3^2 + 0.15^2 + 0.05^2 = 0.25 + 0.09 + 0.0225 + 0.0025 = 0.365
    expect(snapshot.brokerFlow.hhi).toBeCloseTo(0.365, 10);
  });

  it("seller top1Share mirrors the buyer formula over positive net sell magnitude", () => {
    const brokers = [
      broker({ brokerCode: "A", netVolume: 500 }),
      broker({ brokerCode: "X", netVolume: -400 }),
      broker({ brokerCode: "Y", netVolume: -100 })
    ];
    const input = baseInput({ brokerSummaryByDay: [daySummary(brokers)] });
    const snapshot = computeFeatureSnapshot(input, DEFAULT_STRATEGY_CONFIG, "2026-09-09T10:00:00Z");
    // total positive net sell = 500, top seller X = 400/500 = 0.8
    expect(snapshot.brokerFlow.sellerConcentrationTop1Share).toBeCloseTo(0.8, 10);
  });
});

describe("persistence", () => {
  it("counts qualifying days within the trailing window", () => {
    const qualifyingDay = daySummary([
      broker({ brokerCode: "A", netVolume: 500 }),
      broker({ brokerCode: "B", netVolume: 500 })
    ]);
    const nonQualifyingDay = daySummary([]); // no meaningful buyers
    const input = baseInput({
      brokerSummaryByDay: [qualifyingDay, nonQualifyingDay, qualifyingDay, qualifyingDay, qualifyingDay]
    });
    const snapshot = computeFeatureSnapshot(input, DEFAULT_STRATEGY_CONFIG, "2026-09-09T10:00:00Z");
    expect(snapshot.brokerFlow.persistenceDays).toBe(4);
    expect(snapshot.brokerFlow.persistenceWindowDays).toBe(5);
  });
});

describe("brokerFlip", () => {
  it("is false with fewer than 2 days of history (insufficient data, not stale)", () => {
    const input = baseInput({ brokerSummaryByDay: [daySummary([broker({ brokerCode: "A", netVolume: 100 })])] });
    const snapshot = computeFeatureSnapshot(input, DEFAULT_STRATEGY_CONFIG, "2026-09-09T10:00:00Z");
    expect(snapshot.brokerFlow.brokerFlip).toBe(false);
  });

  it("is true when yesterday's top buyer becomes today's top seller", () => {
    const dayPrior = daySummary([
      broker({ brokerCode: "A", netVolume: 1000 }),
      broker({ brokerCode: "B", netVolume: -500 })
    ]);
    const dayToday = daySummary([
      broker({ brokerCode: "A", netVolume: -800 }),
      broker({ brokerCode: "B", netVolume: 300 })
    ]);
    const input = baseInput({ brokerSummaryByDay: [dayPrior, dayToday] });
    const snapshot = computeFeatureSnapshot(input, DEFAULT_STRATEGY_CONFIG, "2026-09-09T10:00:00Z");
    expect(snapshot.brokerFlow.brokerFlip).toBe(true);
  });
});

describe("ownerStatus", () => {
  it("is always UNVERIFIED regardless of broker breadth", () => {
    const brokers = Array.from({ length: 20 }, (_, i) => broker({ brokerCode: `B${i}`, netVolume: 100 }));
    const input = baseInput({ brokerSummaryByDay: [daySummary(brokers)] });
    const snapshot = computeFeatureSnapshot(input, DEFAULT_STRATEGY_CONFIG, "2026-09-09T10:00:00Z");
    expect(snapshot.ownerStatus).toBe("UNVERIFIED");
  });
});

describe("segmentMixed pass-through", () => {
  it("mirrors !segmentSeparable from input", () => {
    const input = baseInput({ segmentSeparable: false });
    const snapshot = computeFeatureSnapshot(input, DEFAULT_STRATEGY_CONFIG, "2026-09-09T10:00:00Z");
    expect(snapshot.segmentMixed).toBe(true);
  });
});
