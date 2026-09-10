import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "@idx/config";
import { buildRiskPlan, type OhlcvBar, type ScoreResult, type TradePlan } from "@idx/domain";

/**
 * Hand-crafted, fully deterministic multi-day OHLCV fixture used by this
 * package's own tests and by `--source=fixture` in the CLI. Five symbols,
 * each engineered to exercise one fill-simulation branch end to end:
 *
 *  - AAAA: clean winner -- normal entry fill, TP1 then TP2, no gaps.
 *  - BBBB: stop-out -- normal entry fill, SL hit before any TP.
 *  - CCCC: gap-down -- normal entry fill, next bar gaps through SL (fills
 *          AT the gapped open, worse than the theoretical SL price).
 *  - DDDD: no-fill -- price never trades down to entryTrigger; plan expires
 *          unfilled at end of session.
 *  - EEEE: partial-fill -- entry day volume is thin relative to plan size,
 *          so only a fraction of totalLots fills; the filled remainder then
 *          proceeds to TP1.
 *
 * Every symbol gets 15 days of quiet pre-signal history (for liquidity/
 * universe stats) followed by the signal day and a handful of post-signal
 * days for the exit walk. Bars are hand-picked numbers, not randomly
 * generated, so tests assert exact expected outcomes.
 */

export const FIXTURE_SESSION_CLOSE_UTC = "T08:49:00.000Z"; // ~15:49 WIB, IDX Friday half-day-safe close

/**
 * Fixed capital for the synthetic fixtures. These fixtures assert exact lot
 * counts (entry 1000 / SL 940 -> totalLots 5, so an 8k-share bar partial-
 * fills at 4), so they must NOT track whatever capital the live
 * DEFAULT_STRATEGY_CONFIG currently carries. Pinned to the original
 * Rp 5,000,000 / Rp 3,000,000 sizing the fixtures were designed against.
 */
export const FIXTURE_STRATEGY_CONFIG: StrategyConfig = {
  ...DEFAULT_STRATEGY_CONFIG,
  risk: { ...DEFAULT_STRATEGY_CONFIG.risk, totalCapital: 5_000_000, maxDeployedCapital: 3_000_000, minNetRewardToRisk: 2 }
};

function preHistory(symbol: string, startDate: string, days: number, basePrice: number, baseVolume: number): OhlcvBar[] {
  const bars: OhlcvBar[] = [];
  const start = new Date(`${startDate}T00:00:00.000Z`);
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    // gentle, deterministic wiggle so history isn't perfectly flat
    const wiggle = (i % 3) - 1; // -1, 0, 1 repeating
    const close = basePrice + wiggle * (basePrice <= 200 ? 1 : 5);
    bars.push({
      date,
      open: close,
      high: close + (basePrice <= 200 ? 1 : 5),
      low: close - (basePrice <= 200 ? 1 : 5),
      close,
      volume: baseVolume,
      turnover: baseVolume * close
    });
  }
  return bars;
}

function bar(date: string, open: number, high: number, low: number, close: number, volume: number): OhlcvBar {
  return { date, open, high, low, close, volume, turnover: volume * close };
}

function dummyScore(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    symbol: "TEST",
    tradingDate: "2026-01-01",
    formulaVersion: DEFAULT_STRATEGY_CONFIG.formulaVersion,
    configVersion: DEFAULT_STRATEGY_CONFIG.version,
    components: {
      brokerFlowQuality: 0.8,
      volumeAnomaly: 0.7,
      smartMoneyMargin: 0.6,
      priceResponse: 0.6,
      confluence: 0.5
    },
    compositeScore: 82,
    category: "STRONG_BUY",
    gates: [],
    noTradeReason: null,
    confidence: "high",
    ...overrides
  };
}

/** Builds a TradePlan via the real domain risk engine, matching how the live pipeline would. */
export function buildFixturePlan(
  symbol: string,
  tradingDate: string,
  entryTrigger: number,
  stopLossRaw: number,
  config: StrategyConfig = FIXTURE_STRATEGY_CONFIG,
  scoreOverrides: Partial<ScoreResult> = {}
): TradePlan {
  return buildRiskPlan(
    {
      symbol,
      tradingDate,
      entryTrigger,
      stopLossRaw,
      score: dummyScore({ symbol, tradingDate, ...scoreOverrides }),
      sessionEndIso: `${tradingDate}${FIXTURE_SESSION_CLOSE_UTC}`
    },
    config
  );
}

export interface FixtureSymbolData {
  symbol: string;
  bars: OhlcvBar[]; // full history including pre-signal + signal + post-signal
  plan: TradePlan; // the TradePlan "generated" on the signal day
  scenario: "clean_winner" | "stop_out" | "gap_down" | "no_fill" | "partial_fill";
}

const PRE_DAYS = 15;
const PRE_START = "2026-01-05"; // a Monday

function preDaysFor(symbol: string, basePrice: number, baseVolume: number): { bars: OhlcvBar[]; signalDate: string } {
  const bars = preHistory(symbol, PRE_START, PRE_DAYS, basePrice, baseVolume);
  const lastPre = bars[bars.length - 1];
  if (!lastPre) throw new Error("empty pre-history");
  const signalDateObj = new Date(`${lastPre.date}T00:00:00.000Z`);
  signalDateObj.setUTCDate(signalDateObj.getUTCDate() + 1);
  return { bars, signalDate: signalDateObj.toISOString().slice(0, 10) };
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function buildAAAA(): FixtureSymbolData {
  const symbol = "AAAA";
  const { bars: pre, signalDate } = preDaysFor(symbol, 1000, 500_000);
  // tick 5 at this price tier; maxBuyPrice 1005. SL 940 (not 970) is
  // deliberately far enough below entry that the risk engine's own
  // minNetRewardToRisk gate (blueprint 7.x, config.risk.minNetRewardToRisk)
  // passes -- a closer stop here would compute to a NO_TRADE plan (fixed
  // fee/slippage overhead swamps a small price risk), which would make
  // every fixture "trade" scenario below actually be a no-op. Verified via
  // buildRiskPlan directly: sl=940 -> lots=5, rr=2.09 (>= the 2.0 minimum).
  const plan = buildFixturePlan(symbol, signalDate, 1000, 940);
  // priceRisk = 60 -> tp1 = entry + 2*60 = 1120, tp2 = entry + 3*60 = 1180
  const day1 = bar(signalDate, 995, 1005, 990, 998, 600_000); // fills at open 995 (open<=entryTrigger 1000)
  const day2 = bar(addDays(signalDate, 1), 1010, 1130, 1000, 1115, 600_000); // TP1 hit within bar (high>=1120)
  const day3 = bar(addDays(signalDate, 2), 1120, 1190, 1050, 1185, 600_000); // TP2 hit within bar (high>=1180), low stays above breakeven
  return { symbol, bars: [...pre, day1, day2, day3], plan, scenario: "clean_winner" };
}

function buildBBBB(): FixtureSymbolData {
  const symbol = "BBBB";
  const { bars: pre, signalDate } = preDaysFor(symbol, 1000, 500_000);
  const plan = buildFixturePlan(symbol, signalDate, 1000, 940);
  const day1 = bar(signalDate, 995, 1005, 990, 998, 600_000); // fills at open 995
  const day2 = bar(addDays(signalDate, 1), 990, 1000, 920, 925, 600_000); // SL (940) hit within bar, no TP touched
  return { symbol, bars: [...pre, day1, day2], plan, scenario: "stop_out" };
}

function buildCCCC(): FixtureSymbolData {
  const symbol = "CCCC";
  const { bars: pre, signalDate } = preDaysFor(symbol, 1000, 500_000);
  const plan = buildFixturePlan(symbol, signalDate, 1000, 940);
  const day1 = bar(signalDate, 995, 1005, 990, 998, 600_000); // fills at open 995
  const day2 = bar(addDays(signalDate, 1), 900, 910, 890, 895, 600_000); // gap-down: open 900 < SL 940
  return { symbol, bars: [...pre, day1, day2], plan, scenario: "gap_down" };
}

function buildDDDD(): FixtureSymbolData {
  const symbol = "DDDD";
  const { bars: pre, signalDate } = preDaysFor(symbol, 1000, 500_000);
  const plan = buildFixturePlan(symbol, signalDate, 1000, 940);
  // Price never trades down to entryTrigger 1000 during the session -> no
  // fill (open 1003 is still comfortably below maxBuyPrice 1005, so this
  // exercises the "never traded down to trigger" branch, not the separate
  // gap-up-past-maxBuyPrice rejection branch).
  const day1 = bar(signalDate, 1003, 1015, 1002, 1010, 600_000);
  return { symbol, bars: [...pre, day1], plan, scenario: "no_fill" };
}

function buildEEEE(): FixtureSymbolData {
  const symbol = "EEEE";
  const { bars: pre, signalDate } = preDaysFor(symbol, 1000, 500_000);
  const plan = buildFixturePlan(symbol, signalDate, 1000, 940);
  // Thin entry-day volume relative to plan size -> partial fill only.
  // totalLots for this plan is 5; at the 5% fill-fraction heuristic, 8,000
  // shares of volume caps the fill at floor(8000*0.05/100)=4 lots.
  const day1 = bar(signalDate, 995, 1005, 990, 998, 8_000);
  const day2 = bar(addDays(signalDate, 1), 1010, 1130, 1000, 1115, 600_000); // TP1 hit for the filled remainder
  const day3 = bar(addDays(signalDate, 2), 1120, 1190, 1050, 1185, 600_000); // TP2 hit
  return { symbol, bars: [...pre, day1, day2, day3], plan, scenario: "partial_fill" };
}

export function buildSyntheticFixture(): FixtureSymbolData[] {
  return [buildAAAA(), buildBBBB(), buildCCCC(), buildDDDD(), buildEEEE()];
}
