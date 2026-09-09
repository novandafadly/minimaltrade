import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import type { OhlcvBar } from "@idx/domain";
import { buildFixturePlan } from "../fixtures/syntheticFixture.js";
import { simulateEntry, simulateExit, simulateTradePlan } from "../fillSimulation.js";

function bar(date: string, open: number, high: number, low: number, close: number, volume: number): OhlcvBar {
  return { date, open, high, low, close, volume, turnover: volume * close };
}

// entry=1000, sl=940 (priceRisk=60) -> maxBuyPrice=1005, tp1=1120, tp2=1180,
// totalLots=5. See ../fixtures/syntheticFixture.ts buildAAAA for why sl=940
// rather than a closer stop (minNetRewardToRisk gate).
describe("simulateEntry", () => {
  const plan = buildFixturePlan("TEST", "2026-02-02", 1000, 940);

  it("rejects entry on a gap-up past maxBuyPrice", () => {
    const result = simulateEntry(plan, bar("2026-02-02", 1050, 1060, 1040, 1055, 500_000), DEFAULT_STRATEGY_CONFIG);
    expect(result.status).toBe("no_fill");
    expect(result.note).toMatch(/gap-up/);
  });

  it("does not fill when price never trades down to entryTrigger", () => {
    const result = simulateEntry(plan, bar("2026-02-02", 1005, 1015, 1002, 1010, 500_000), DEFAULT_STRATEGY_CONFIG);
    expect(result.status).toBe("no_fill");
    expect(result.note).toMatch(/never traded down/);
  });

  it("fills at the open when open is already at/below entryTrigger", () => {
    const result = simulateEntry(plan, bar("2026-02-02", 995, 1005, 990, 998, 500_000), DEFAULT_STRATEGY_CONFIG);
    expect(result.status).toBe("filled");
    expect(result.fillPrice).toBe(995);
    expect(result.filledLots).toBe(plan.totalLots);
  });

  it("fills at the limit (entryTrigger) when open is above trigger but the bar trades down through it", () => {
    const result = simulateEntry(plan, bar("2026-02-02", 1005, 1015, 995, 1000, 500_000), DEFAULT_STRATEGY_CONFIG);
    expect(result.status).toBe("filled");
    expect(result.fillPrice).toBe(1000);
  });

  it("caps fill at the volume-participation fraction for a thin bar (partial fill)", () => {
    // plan.totalLots is 5; 8,000 shares volume * 5% / 100 shares/lot = 4 fillable lots.
    const result = simulateEntry(plan, bar("2026-02-02", 995, 1005, 990, 998, 8_000), DEFAULT_STRATEGY_CONFIG);
    expect(result.status).toBe("partial");
    expect(result.filledLots).toBe(4);
    expect(result.filledLots).toBeLessThan(plan.totalLots);
  });

  it("returns no_fill when the bar is too thin to fill even one lot", () => {
    const result = simulateEntry(plan, bar("2026-02-02", 995, 1005, 990, 998, 100), DEFAULT_STRATEGY_CONFIG);
    expect(result.status).toBe("no_fill");
    expect(result.filledLots).toBe(0);
  });
});

describe("simulateExit", () => {
  const plan = buildFixturePlan("TEST", "2026-02-02", 1000, 940); // tp1=1120, tp2=1180, sl=940
  const fillPrice = 995;

  it("hits SL cleanly when only SL is touched", () => {
    const exits = simulateExit(plan, fillPrice, plan.totalLots, [bar("2026-02-03", 990, 1000, 920, 925, 500_000)]);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ reason: "sl", price: plan.slPrice, gapped: false });
  });

  it("gap-fills SL AT the gapped open when the next bar opens below the stop", () => {
    const exits = simulateExit(plan, fillPrice, plan.totalLots, [bar("2026-02-03", 900, 910, 890, 895, 500_000)]);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ reason: "sl", price: 900, gapped: true });
    // gapped SL fill must be worse than (i.e. below) the theoretical plan.slPrice
    expect(exits[0]!.price).toBeLessThan(plan.slPrice);
  });

  it("resolves an ambiguous same-bar SL+TP1 touch conservatively as SL", () => {
    const exits = simulateExit(plan, fillPrice, plan.totalLots, [bar("2026-02-03", 1000, 1130, 930, 1000, 500_000)]);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reason).toBe("sl");
  });

  it("moves SL to breakeven after TP1 and later stops the remainder there", () => {
    const exits = simulateExit(plan, fillPrice, plan.totalLots, [
      bar("2026-02-03", 1010, 1130, 1000, 1115, 500_000), // TP1 hits within bar
      bar("2026-02-04", 1000, 1005, fillPrice - 5, 993, 500_000) // opens above breakeven, dips through it intrabar (no gap)
    ]);
    expect(exits.map((e) => e.reason)).toEqual(["tp1", "sl"]);
    expect(exits[1]!.price).toBe(fillPrice); // breakeven = actual entry fill price
  });

  it("hits TP1 then TP2 across two bars", () => {
    const exits = simulateExit(plan, fillPrice, plan.totalLots, [
      bar("2026-02-03", 1010, 1130, 1000, 1115, 500_000),
      bar("2026-02-04", 1120, 1190, 1050, 1185, 500_000)
    ]);
    expect(exits.map((e) => e.reason)).toEqual(["tp1", "tp2"]);
  });

  it("hits TP1 and TP2 within the same bar when both levels are touched", () => {
    const exits = simulateExit(plan, fillPrice, plan.totalLots, [bar("2026-02-03", 1010, 1200, 1000, 1195, 500_000)]);
    expect(exits.map((e) => e.reason)).toEqual(["tp1", "tp2"]);
    expect(exits.every((e) => !e.gapped)).toBe(true);
  });

  it("gap-fills both TP1 and TP2 at the open when a huge gap opens through both targets", () => {
    const exits = simulateExit(plan, fillPrice, plan.totalLots, [bar("2026-02-03", 1200, 1210, 1195, 1205, 500_000)]);
    expect(exits.map((e) => e.reason)).toEqual(["tp1", "tp2"]);
    expect(exits.every((e) => e.gapped && e.price === 1200)).toBe(true);
  });

  it("gap-fills TP1 at the open then continues checking the rest of the bar for TP2/SL", () => {
    // open gaps up through tp1 (1120) but not tp2 (1180); the bar's high
    // still reaches tp2 within the same session.
    const exits = simulateExit(plan, fillPrice, plan.totalLots, [bar("2026-02-03", 1125, 1185, 1120, 1180, 500_000)]);
    expect(exits.map((e) => e.reason)).toEqual(["tp1", "tp2"]);
    expect(exits[0]!.gapped).toBe(true);
    expect(exits[1]!.gapped).toBe(false);
  });

  it("force-closes at the last bar's close as expiry when no level is ever touched", () => {
    const exits = simulateExit(plan, fillPrice, plan.totalLots, [
      bar("2026-02-03", 1000, 1010, 995, 1005, 500_000),
      bar("2026-02-04", 1005, 1015, 1000, 1010, 500_000)
    ]);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ reason: "expiry", price: 1010 });
  });
});

describe("simulateTradePlan", () => {
  const plan = buildFixturePlan("TEST", "2026-02-02", 1000, 940);

  it("produces a zero-P&L no_fill outcome with an empty exits list", () => {
    const outcome = simulateTradePlan(plan, bar("2026-02-02", 1050, 1060, 1040, 1055, 500_000), [], DEFAULT_STRATEGY_CONFIG);
    expect(outcome.fill.status).toBe("no_fill");
    expect(outcome.exits).toEqual([]);
    expect(outcome.netPnl).toBe(0);
    expect(outcome.netRR).toBeNull();
  });

  it("nets fees/slippage out of gross P&L on a winning trade using StrategyConfig's own rates", () => {
    const entryBar = bar("2026-02-02", 995, 1005, 990, 998, 500_000);
    const simBars = [bar("2026-02-03", 1010, 1130, 1000, 1115, 500_000), bar("2026-02-04", 1120, 1190, 1050, 1185, 500_000)];
    const outcome = simulateTradePlan(plan, entryBar, simBars, DEFAULT_STRATEGY_CONFIG);
    expect(outcome.fill.status).toBe("filled");
    expect(outcome.grossPnl).toBeGreaterThan(0);
    expect(outcome.fees).toBeGreaterThan(0);
    expect(outcome.slippage).toBeGreaterThan(0);
    expect(outcome.netPnl).toBe(outcome.grossPnl - outcome.fees - outcome.slippage);
    expect(outcome.netRR).not.toBeNull();
  });

  it("caps the exit walk at maxHoldingBars and force-closes at expiry", () => {
    const entryBar = bar("2026-02-02", 995, 1005, 990, 998, 500_000);
    const flatBar = (d: string) => bar(d, 1000, 1010, 995, 1005, 500_000);
    const simBars = Array.from({ length: 10 }, (_, i) => flatBar(`2026-02-${String(3 + i).padStart(2, "0")}`));
    const outcome = simulateTradePlan(plan, entryBar, simBars, DEFAULT_STRATEGY_CONFIG, { maxHoldingBars: 3 });
    expect(outcome.exits).toHaveLength(1);
    expect(outcome.exits[0]!.reason).toBe("expiry");
    expect(outcome.exits[0]!.date).toBe("2026-02-05"); // the 3rd simulated bar, not the 10th
  });
});
