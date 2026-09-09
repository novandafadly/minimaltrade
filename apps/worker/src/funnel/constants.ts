/**
 * Named V1 thresholds for the funnel stages (blueprint §4). The blueprint
 * does not give exact numbers for most of these (only the target
 * candidate-count ranges, which live in StrategyConfig.funnel), so these are
 * documented, hardcoded, configurable-shaped defaults for a first release.
 * Nothing below is read as a scattered magic number at call sites.
 */

// --- Top funnel (blueprint §4.1) ---------------------------------------
/** Minimum turnover (Rupiah) for a symbol to be liquid enough to consider.
 * Screener-only data has no multi-day history, so this approximates the
 * blueprint's "minimum median turnover" with a single-day floor. */
export const TOP_FUNNEL_MIN_TURNOVER_IDR = 500_000_000; // Rp 500 juta
/** Maximum bid/offer spread as a fraction of price, when spread is available. */
export const TOP_FUNNEL_MAX_SPREAD_PCT = 0.03;
/** Reject prices at or below this (gocap/junk-price noise). */
export const TOP_FUNNEL_MIN_PRICE = 51;
/** Special-notation codes treated as high-risk and excluded outright.
 * "UMA" (Unusual Market Activity) is the blueprint's explicit example. */
export const HIGH_RISK_NOTATIONS = new Set([
  "UMA",
  "SUSPEND",
  "ML", // margin/short-selling restriction notations vary by source; treated conservatively
  "AM", // "Ada Marabahaya"-style Additional Monitoring notations
  "WATCHLIST_BEI"
]);

// --- Mid funnel (blueprint §4.2) ----------------------------------------
export const MID_FUNNEL_WEIGHTS = {
  liquidity: 0.5,
  gain: 0.2,
  chasePenalty: 0.15,
  distributionPenalty: 0.15
} as const;
/** "Volume big but negative price response" distribution penalty trigger:
 * today's volume vs the 20d baseline (cheap, from the cached history call). */
export const MID_FUNNEL_DISTRIBUTION_VOLUME_SPIKE_RATIO = 1.5;
/** distribution penalty only applies when price response is non-positive. */
export const MID_FUNNEL_DISTRIBUTION_WEAK_PRICE_PCT_MAX = 0;
/** Chase-penalty proxy: mid funnel has no broker-summary (that's a deep-
 * funnel call), so "too far above B-Avg" is approximated as "too far above
 * the recent (5-session) average close" from the cheap cached history call.
 * This is intentionally a coarse proxy — the deep funnel applies the real
 * B-Avg-based chase gate once broker-summary is available. */
export const MID_FUNNEL_CHASE_LOOKBACK_DAYS = 5;

// --- Deep funnel (blueprint §4.3) ---------------------------------------
/** Preliminary stop-loss distance used only to seed the scoring engine's
 * netRewardToRiskEstimate input before the real risk plan is built from the
 * actual ScoreResult. Expressed as a fraction below the trigger price. */
export const DEEP_FUNNEL_PRELIMINARY_STOP_PCT = 0.03;
