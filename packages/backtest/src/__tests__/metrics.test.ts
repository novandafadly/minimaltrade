import { describe, expect, it } from "vitest";
import { computeMetrics, segmentMetrics } from "../metrics.js";
import type { TradeOutcome } from "../fillSimulation.js";

function outcome(overrides: Partial<TradeOutcome> & { netPnl: number; status: "filled" | "partial" | "no_fill" }): TradeOutcome {
  const { status, ...rest } = overrides;
  return {
    symbol: "TEST",
    tradingDate: "2026-01-01",
    plan: {} as TradeOutcome["plan"],
    fill: { status, fillPrice: status === "no_fill" ? null : 1000, filledLots: status === "no_fill" ? 0 : 10, fillDate: null, note: null },
    exits: [],
    grossPnl: 0,
    fees: 0,
    slippage: 0,
    netRR: null,
    ruleAdherence: true,
    ...rest
  };
}

describe("computeMetrics", () => {
  it("returns all-zero metrics for an empty batch", () => {
    const m = computeMetrics([]);
    expect(m.tradeCount).toBe(0);
    expect(m.fillRate).toBe(0);
    expect(m.profitFactor).toBe(0);
  });

  it("computes fill rate across filled/partial/no_fill", () => {
    const m = computeMetrics([
      outcome({ status: "filled", netPnl: 100 }),
      outcome({ status: "partial", netPnl: 50 }),
      outcome({ status: "no_fill", netPnl: 0 })
    ]);
    expect(m.tradeCount).toBe(3);
    expect(m.filledCount).toBe(2);
    expect(m.noFillCount).toBe(1);
    expect(m.fillRate).toBeCloseTo(2 / 3);
  });

  it("computes net expectancy only over filled trades", () => {
    const m = computeMetrics([
      outcome({ status: "filled", netPnl: 100 }),
      outcome({ status: "filled", netPnl: -40 }),
      outcome({ status: "no_fill", netPnl: 0 })
    ]);
    expect(m.netExpectancy).toBeCloseTo(30); // (100 - 40) / 2, no_fill excluded
  });

  it("computes profit factor as gross wins / abs(gross losses)", () => {
    const m = computeMetrics([
      outcome({ status: "filled", netPnl: 300 }),
      outcome({ status: "filled", netPnl: 100 }),
      outcome({ status: "filled", netPnl: -100 })
    ]);
    expect(m.profitFactor).toBeCloseTo(4); // 400 / 100
  });

  it("returns Infinity profit factor when there are wins and no losses", () => {
    const m = computeMetrics([outcome({ status: "filled", netPnl: 50 })]);
    expect(m.profitFactor).toBe(Infinity);
  });

  it("computes max drawdown on the cumulative equity curve in outcome order", () => {
    // equity curve: 100, 150 (peak), 50 (drawdown 100), 120
    const m = computeMetrics([
      outcome({ status: "filled", netPnl: 100 }),
      outcome({ status: "filled", netPnl: 50 }),
      outcome({ status: "filled", netPnl: -100 }),
      outcome({ status: "filled", netPnl: 70 })
    ]);
    expect(m.maxDrawdown).toBeCloseTo(100);
  });

  it("averages netRR only over non-null values", () => {
    const m = computeMetrics([
      outcome({ status: "filled", netPnl: 100, netRR: 2 }),
      outcome({ status: "filled", netPnl: 100, netRR: 4 }),
      outcome({ status: "filled", netPnl: 100, netRR: null })
    ]);
    expect(m.avgNetRR).toBeCloseTo(3);
  });

  it("counts false-accumulation as filled trades whose first exit leg is an SL", () => {
    const m = computeMetrics([
      outcome({ status: "filled", netPnl: -50, exits: [{ reason: "sl", price: 900, lots: 10, date: "2026-01-02", gapped: false }] }),
      outcome({ status: "filled", netPnl: 100, exits: [{ reason: "tp1", price: 1100, lots: 10, date: "2026-01-02", gapped: false }] })
    ]);
    expect(m.falseAccumulationRate).toBeCloseTo(0.5);
  });
});

describe("segmentMetrics", () => {
  it("groups outcomes by key and computes metrics independently per group", () => {
    const outcomes = [
      outcome({ status: "filled", netPnl: 100 }),
      outcome({ status: "filled", netPnl: -50 }),
      outcome({ status: "no_fill", netPnl: 0 })
    ];
    const keys = ["a", "b", "a"];
    const grouped = segmentMetrics(outcomes, (_o) => keys[outcomes.indexOf(_o)]!);
    expect(Object.keys(grouped).sort()).toEqual(["a", "b"]);
    expect(grouped.a!.tradeCount).toBe(2);
    expect(grouped.b!.tradeCount).toBe(1);
  });
});
