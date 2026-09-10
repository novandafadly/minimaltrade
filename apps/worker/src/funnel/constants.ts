/**
 * Named V1 thresholds for the funnel stages (blueprint §4). The blueprint
 * does not give exact numbers for most of these (only the target
 * candidate-count ranges, which live in StrategyConfig.funnel), so these are
 * documented, hardcoded, configurable-shaped defaults for a first release.
 * Nothing below is read as a scattered magic number at call sites.
 */

// --- Top funnel (blueprint §4.1) ---------------------------------------
/** `stock.arjum.com/api/screener/latest` buckets each pick by verdict. Rows
 * whose bucket or summary contains any of these markers are the upstream's
 * own distribution / pump / trap warnings and are dropped before ranking.
 * Matched case-insensitively as substrings. */
export const TOP_FUNNEL_EXCLUDED_BUCKET_MARKERS = [
  "konflik distribusi",
  "distribusi",
  "🧨", // jebakan historis (historical trap)
  "🚀⚠️", // pompa (pump)
  "🔥" // klimaks (climax)
];

/** Minimum turnover (Rupiah) for a symbol to be liquid enough to consider,
 * applied in the deep funnel once the per-symbol history quote is available
 * (the screener shortlist carries no volume/turnover). */
export const DEEP_FUNNEL_MIN_TURNOVER_IDR = 500_000_000; // Rp 500 juta
/** Reject prices at or below this (gocap/junk-price noise), deep funnel. */
export const DEEP_FUNNEL_MIN_PRICE = 51;

// --- Mid funnel (blueprint §4.2) ----------------------------------------
// The real screener shortlist is already small and pre-ranked; the mid
// funnel is a bounded re-rank by the upstream's historical edge stats
// (see funnel/mid.ts). No price/volume proxies here — the deep funnel does
// the real liquidity/chase/distribution gating once history + broker data
// are fetched.

// --- Deep funnel (blueprint §4.3) ---------------------------------------
/** Preliminary stop-loss distance used only to seed the scoring engine's
 * netRewardToRiskEstimate input before the real risk plan is built from the
 * actual ScoreResult. Expressed as a fraction below the trigger price. */
export const DEEP_FUNNEL_PRELIMINARY_STOP_PCT = 0.05;
