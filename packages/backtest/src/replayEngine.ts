import type { StrategyConfig } from "@idx/config";
import type { HistoryData, TradePlan } from "@idx/domain";
import {
  randomLiquidUniverseStrategy,
  volumeOnlyRankingStrategy,
  type BaselineStrategyDeps
} from "./baselines.js";
import type { ReplayDataSource } from "./dataSource/types.js";
import { simulateTradePlan, type SimulationOptions, type TradeOutcome } from "./fillSimulation.js";
import { computeMetrics, segmentMetrics, type ReplayMetrics } from "./metrics.js";
import { signalFromHistoryStrategy } from "./signalFromHistory.js";

/**
 * Orchestrates a full replay batch (blueprint Phase 6 / §13.2): for each
 * trading date in the data source, gather candidate TradePlans from each
 * named strategy, simulate their fill/exit against subsequent real bars,
 * and aggregate metrics -- including the two named baseline comparisons.
 */

export type StrategyName =
  | "signal_driven"
  | "signal_from_history"
  | "random_liquid_universe"
  | "volume_only_ranking";

/**
 * Which bar a plan is filled on.
 *
 *  - "nextSession" (default, the only honest choice for real data): every plan
 *    is built from the CLOSE of its trading date, so it can only be acted on
 *    from the next session. The entry order is evaluated against the first bar
 *    AFTER the plan date; exits walk from the bar after that.
 *  - "sameBar": fill on the plan date's own bar. This is look-ahead on real data
 *    (the plan's entry is that bar's close, yet it fills at min(open, close) --
 *    a price nobody deciding after the close could get; Phase 0G measured it at
 *    ~+3 points of net return per trade). It exists ONLY because the synthetic
 *    fixture scenarios are constructed around a same-bar fill.
 */
export type EntryConvention = "nextSession" | "sameBar";

export interface ReplayBatchOptions {
  dataSource: ReplayDataSource;
  config: StrategyConfig;
  simulation?: SimulationOptions;
  entryConvention?: EntryConvention;
  /** How many candidates each baseline selects per day (matches the signal-driven deep-funnel trade-plan cap by default). */
  maxCandidatesPerDay?: number;
  /** Seed for the random-liquid-universe baseline's PRNG; fixed by default for reproducibility. */
  randomSeed?: number;
  /** Restrict the replay to this inclusive date range; omit for the data source's full range. */
  fromDate?: string;
  toDate?: string;
}

export interface StrategyResult {
  strategy: StrategyName;
  outcomes: TradeOutcome[];
  overall: ReplayMetrics;
  byCategory: Record<string, ReplayMetrics>;
}

export interface ReplayBatchResult {
  tradingDates: string[];
  strategies: Record<StrategyName, StrategyResult>;
}

async function simulateForDate(
  dataSource: ReplayDataSource,
  config: StrategyConfig,
  simulation: SimulationOptions | undefined,
  plans: TradePlan[],
  entryConvention: EntryConvention
): Promise<TradeOutcome[]> {
  const outcomes: TradeOutcome[] = [];
  const maxHoldingBars = simulation?.maxHoldingBars ?? 20;
  for (const plan of plans) {
    if (entryConvention === "sameBar") {
      const entryBar = await dataSource.getBarOn(plan.symbol, plan.tradingDate);
      const simBars = await dataSource.getSimulationBars(plan.symbol, plan.tradingDate, maxHoldingBars);
      outcomes.push(simulateTradePlan(plan, entryBar, simBars, config, simulation));
    } else {
      // first bar after the plan date is the entry session; the walk starts after it
      const after = await dataSource.getSimulationBars(plan.symbol, plan.tradingDate, maxHoldingBars + 1);
      outcomes.push(simulateTradePlan(plan, after[0] ?? null, after.slice(1), config, simulation));
    }
  }
  return outcomes;
}

function categoryKey(plan: TradePlan): string {
  // TradePlan itself doesn't carry SignalCategory (that lives on Signal);
  // segment by whether the plan is a live trade vs a computed-but-rejected
  // NO_TRADE plan instead, which IS available on every TradePlan.
  return plan.isNoTrade ? "no_trade" : "trade";
}

export async function runReplayBatch(options: ReplayBatchOptions): Promise<ReplayBatchResult> {
  const { dataSource, config } = options;
  const maxCandidatesPerDay = options.maxCandidatesPerDay ?? config.funnel.deepFunnelTradePlanMax;
  const randomSeed = options.randomSeed ?? 42;
  const entryConvention: EntryConvention = options.entryConvention ?? "nextSession";

  const allDates = await dataSource.listTradingDates();
  const tradingDates = allDates.filter(
    (d) => (!options.fromDate || d >= options.fromDate) && (!options.toDate || d <= options.toDate)
  );

  const signalOutcomes: TradeOutcome[] = [];
  const signalFromHistoryOutcomes: TradeOutcome[] = [];
  const randomOutcomes: TradeOutcome[] = [];
  const volumeOutcomes: TradeOutcome[] = [];

  for (const date of tradingDates) {
    // --- signal-driven: replay plans already persisted for this date ---
    const persistedPlans = (await dataSource.getTradePlansForDate(date)).filter((p) => !p.isNoTrade);
    signalOutcomes.push(...(await simulateForDate(dataSource, config, options.simulation, persistedPlans, entryConvention)));

    // --- baselines: build candidates purely from liquidity/volume, no broker-flow/score logic ---
    const universe = await dataSource.listUniverseAsOf(date);
    if (universe.length === 0) continue;

    const historyBySymbol = new Map<string, HistoryData>();
    for (const u of universe) {
      const envelope = await dataSource.getHistoryAsOf(u.symbol, `${date}T23:59:59.999Z`);
      if (envelope) historyBySymbol.set(u.symbol, envelope.data);
    }

    const baseDeps: BaselineStrategyDeps = {
      universe,
      historyBySymbol,
      tradingDate: date,
      sessionEndIso: `${date}T08:49:00.000Z`,
      config,
      maxCandidates: maxCandidatesPerDay
    };

    const randomPlans = randomLiquidUniverseStrategy(baseDeps, randomSeed + hashDate(date));
    randomOutcomes.push(...(await simulateForDate(dataSource, config, options.simulation, randomPlans, entryConvention)));

    const volumePlans = volumeOnlyRankingStrategy(baseDeps);
    volumeOutcomes.push(...(await simulateForDate(dataSource, config, options.simulation, volumePlans, entryConvention)));

    // --- signal-from-history: reconstruct FeatureEngineInput as-of `date`
    // and run the real scoring engine (only if the data source can serve
    // historical broker flow). ---
    if (dataSource.getBrokerHistoryAsOf) {
      const sfhPlans = await signalFromHistoryStrategy({
        dataSource,
        universe,
        historyBySymbol,
        tradingDate: date,
        sessionEndIso: `${date}T08:49:00.000Z`,
        config,
        maxCandidates: maxCandidatesPerDay
      });
      signalFromHistoryOutcomes.push(...(await simulateForDate(dataSource, config, options.simulation, sfhPlans, entryConvention)));
    }
  }

  const toResult = (strategy: StrategyName, outcomes: TradeOutcome[]): StrategyResult => ({
    strategy,
    outcomes,
    overall: computeMetrics(outcomes),
    byCategory: segmentMetrics(outcomes, (o) => categoryKey(o.plan))
  });

  return {
    tradingDates,
    strategies: {
      signal_driven: toResult("signal_driven", signalOutcomes),
      signal_from_history: toResult("signal_from_history", signalFromHistoryOutcomes),
      random_liquid_universe: toResult("random_liquid_universe", randomOutcomes),
      volume_only_ranking: toResult("volume_only_ranking", volumeOutcomes)
    }
  };
}

function hashDate(date: string): number {
  let h = 0;
  for (let i = 0; i < date.length; i++) {
    h = (h * 31 + date.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
