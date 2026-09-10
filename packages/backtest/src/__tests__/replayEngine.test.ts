import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import { FixtureDataSource } from "../dataSource/fixture.js";
import { withLeakGuard } from "../dataSource/leakGuard.js";
import { buildSyntheticFixture } from "../fixtures/syntheticFixture.js";
import { runReplayBatch } from "../replayEngine.js";

describe("runReplayBatch", () => {
  it("runs the signal-driven strategy and both baselines over the fixture, producing metrics for each", async () => {
    const dataSource = withLeakGuard(new FixtureDataSource(buildSyntheticFixture()));
    const result = await runReplayBatch({ dataSource, config: DEFAULT_STRATEGY_CONFIG, maxCandidatesPerDay: 3, randomSeed: 1 });

    expect(result.tradingDates.length).toBeGreaterThan(0);
    expect(Object.keys(result.strategies).sort()).toEqual([
      "random_liquid_universe",
      "signal_driven",
      "signal_from_history",
      "volume_only_ranking"
    ]);
    // FixtureDataSource has no getBrokerHistoryAsOf -> signal_from_history is empty.
    expect(result.strategies.signal_from_history.outcomes).toHaveLength(0);

    // signal-driven replays exactly the 5 fixture plans (one per symbol, on
    // its own signal day) -- 4 fill (clean_winner/stop_out/gap_down/partial)
    // + 1 no_fill (DDDD).
    const signal = result.strategies.signal_driven;
    expect(signal.outcomes).toHaveLength(5);
    expect(signal.overall.noFillCount).toBe(1);
    expect(signal.overall.filledCount).toBe(4);

    // baselines produced at least some candidate plans from the liquid
    // universe (all 5 fixture symbols clear the liquidity floor once they
    // have 20 days of pre-history).
    expect(result.strategies.random_liquid_universe.outcomes.length).toBeGreaterThan(0);
    expect(result.strategies.volume_only_ranking.outcomes.length).toBeGreaterThan(0);
  });

  it("is deterministic across repeated runs with the same seed", async () => {
    const buildResult = async () => {
      const dataSource = withLeakGuard(new FixtureDataSource(buildSyntheticFixture()));
      return runReplayBatch({ dataSource, config: DEFAULT_STRATEGY_CONFIG, maxCandidatesPerDay: 3, randomSeed: 7 });
    };
    const a = await buildResult();
    const b = await buildResult();
    expect(a.strategies.random_liquid_universe.overall).toEqual(b.strategies.random_liquid_universe.overall);
    expect(a.strategies.signal_driven.overall).toEqual(b.strategies.signal_driven.overall);
  });

  it("respects fromDate/toDate range filtering", async () => {
    const dataSource = withLeakGuard(new FixtureDataSource(buildSyntheticFixture()));
    const full = await runReplayBatch({ dataSource, config: DEFAULT_STRATEGY_CONFIG });
    const narrowed = await runReplayBatch({
      dataSource,
      config: DEFAULT_STRATEGY_CONFIG,
      fromDate: full.tradingDates[0],
      toDate: full.tradingDates[0]
    });
    expect(narrowed.tradingDates).toEqual([full.tradingDates[0]]);
  });
});
