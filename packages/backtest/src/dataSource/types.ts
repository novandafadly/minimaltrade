import type { BrokerSummaryData, DataEnvelope, HistoryData, OhlcvBar } from "@idx/domain";
import type { TradePlan } from "@idx/domain";

/**
 * Replay data access contract (blueprint §13.2: "no future leakage").
 *
 * Every method on this interface falls into exactly one of two categories,
 * and the category is load-bearing:
 *
 * DECISION-TIME methods (`...AsOf` / `...ForDate`) — these answer "what did
 * we know at the moment the plan was generated?" They MUST NOT return any
 * row whose `receivedAt`/`publishedAt` is after the `asOf` boundary, and
 * MUST NOT return any OHLCV bar dated after `asOf`. This is the freshness
 * contract from `DataEnvelope` (packages/domain/src/types/marketData.ts)
 * applied to historical replay. `withLeakGuard` (./leakGuard.ts) wraps any
 * implementation and throws if this is violated, so a buggy data source
 * fails loudly instead of silently producing an over-optimistic backtest.
 *
 * SIMULATION-TIME methods (`getSimulationBars`, `getBarOn`) — these
 * deliberately return bars AFTER the decision date. That is not a leak: the
 * entire point of a fill/exit simulation is to walk forward through real
 * subsequent price action to see whether an already-generated TradePlan
 * would have filled and how it would have resolved. Never call these to
 * *decide* whether to take a trade — only to *simulate the outcome* of a
 * trade plan that decision-time data already produced.
 */

export interface LiquidUniverseEntry {
  symbol: string;
  avgVolume20d: number;
  avgTurnover20d: number;
  lastClose: number;
  sector: string | null;
  marketCap: number | null;
}

export interface ReplayDataSource {
  /** Ascending list of trading dates (YYYY-MM-DD) this data source can replay. */
  listTradingDates(): Promise<string[]>;

  /**
   * DECISION-TIME. Historical OHLCV + envelope metadata for `symbol`, as
   * known at `asOf` (ISO timestamp). Implementations must filter out any
   * bar dated after `asOf` and must not return an envelope whose
   * `receivedAt`/`publishedAt` is after `asOf`.
   */
  getHistoryAsOf(symbol: string, asOf: string): Promise<DataEnvelope<HistoryData> | null>;

  /**
   * DECISION-TIME. Liquid universe as of `asOf` (trading date, YYYY-MM-DD),
   * computed only from data received on/before that date.
   */
  listUniverseAsOf(asOf: string): Promise<LiquidUniverseEntry[]>;

  /**
   * DECISION-TIME. Trade plans actually generated (by the live funnel, or a
   * prior signal-generation run) ON `tradingDate`. This is the input to the
   * "signal-driven" replay strategy -- the backtest package does not
   * regenerate signals from raw broker/screener data (that is the funnel's
   * and domain engines' job); it replays plans that already exist.
   */
  getTradePlansForDate(tradingDate: string): Promise<TradePlan[]>;

  /**
   * DECISION-TIME (optional — only the Postgres source implements it). Per-day
   * broker flow for `symbol` over the last `days` trading days on/before
   * `asOf`, ascending (most recent last). Used to reconstruct a historical
   * `FeatureEngineInput.brokerSummaryByDay` for the signal-from-history
   * replay strategy.
   */
  getBrokerHistoryAsOf?(symbol: string, asOf: string, days?: number): Promise<BrokerSummaryData[]>;

  /**
   * SIMULATION-TIME (NOT asOf-guarded). The bar for `symbol` on `date`
   * itself, used to evaluate whether a plan's entry trigger fills.
   */
  getBarOn(symbol: string, date: string): Promise<OhlcvBar | null>;

  /**
   * SIMULATION-TIME (NOT asOf-guarded). Bars for `symbol` strictly after
   * `afterDate`, ascending, capped at `maxBars`. Used to walk the exit
   * simulation forward (TP1/TP2/SL) after entry has filled.
   */
  getSimulationBars(symbol: string, afterDate: string, maxBars: number): Promise<OhlcvBar[]>;
}
