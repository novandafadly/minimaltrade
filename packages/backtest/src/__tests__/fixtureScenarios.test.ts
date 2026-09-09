import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import { FixtureDataSource } from "../dataSource/fixture.js";
import { withLeakGuard } from "../dataSource/leakGuard.js";
import { simulateTradePlan } from "../fillSimulation.js";
import { buildSyntheticFixture } from "../fixtures/syntheticFixture.js";

/**
 * End-to-end check that every hand-crafted fixture scenario (see
 * ../fixtures/syntheticFixture.ts) produces the fill-simulation outcome it
 * was designed to exercise, when driven entirely through the
 * ReplayDataSource contract (leak-guarded, exactly as the CLI/replay engine
 * would use it).
 */
describe("synthetic fixture scenarios", () => {
  const symbols = buildSyntheticFixture();
  const dataSource = withLeakGuard(new FixtureDataSource(symbols));

  it("has one fixture symbol per documented scenario", () => {
    const scenarios = new Set(symbols.map((s) => s.scenario));
    expect(scenarios).toEqual(new Set(["clean_winner", "stop_out", "gap_down", "no_fill", "partial_fill"]));
  });

  for (const s of symbols) {
    it(`${s.symbol} (${s.scenario}) resolves as expected end to end`, async () => {
      const entryBar = await dataSource.getBarOn(s.symbol, s.plan.tradingDate);
      const simBars = await dataSource.getSimulationBars(s.symbol, s.plan.tradingDate, 20);
      const outcome = simulateTradePlan(s.plan, entryBar, simBars, DEFAULT_STRATEGY_CONFIG);

      switch (s.scenario) {
        case "clean_winner":
          expect(outcome.fill.status).toBe("filled");
          expect(outcome.exits.map((e) => e.reason)).toEqual(["tp1", "tp2"]);
          expect(outcome.netPnl).toBeGreaterThan(0);
          break;
        case "stop_out":
          expect(outcome.fill.status).toBe("filled");
          expect(outcome.exits.map((e) => e.reason)).toEqual(["sl"]);
          expect(outcome.netPnl).toBeLessThan(0);
          break;
        case "gap_down":
          expect(outcome.fill.status).toBe("filled");
          expect(outcome.exits).toHaveLength(1);
          expect(outcome.exits[0]).toMatchObject({ reason: "sl", gapped: true });
          // gapped exit must be worse than the theoretical SL price
          expect(outcome.exits[0]!.price).toBeLessThan(s.plan.slPrice);
          break;
        case "no_fill":
          expect(outcome.fill.status).toBe("no_fill");
          expect(outcome.exits).toEqual([]);
          expect(outcome.netPnl).toBe(0);
          break;
        case "partial_fill":
          expect(outcome.fill.status).toBe("partial");
          expect(outcome.fill.filledLots).toBeGreaterThan(0);
          expect(outcome.fill.filledLots).toBeLessThan(s.plan.totalLots);
          expect(outcome.exits.map((e) => e.reason)).toEqual(["tp1", "tp2"]);
          expect(outcome.netPnl).toBeGreaterThan(0);
          break;
      }
    });
  }

  it("getHistoryAsOf never leaks bars beyond the requested asOf for any fixture symbol", async () => {
    for (const s of symbols) {
      const midDate = s.bars[Math.floor(s.bars.length / 2)]!.date;
      const envelope = await dataSource.getHistoryAsOf(s.symbol, `${midDate}T23:59:59.999Z`);
      expect(envelope).not.toBeNull();
      for (const b of envelope!.data.bars) {
        expect(b.date <= midDate).toBe(true);
      }
    }
  });
});
