/**
 * Shadow-mode screener thresholds. PROVISIONAL — these exist only to let the
 * forward-test compare *screener* quality (which shortlist to feed the
 * funnel) in isolation from *engine* quality. None of this touches the live
 * feature/scoring/risk math. Tune from the shadow dashboard once ~20+ plans
 * per source have been evaluated.
 */

/** Min bars of OHLCV history a symbol needs before any screener will rank it. */
export const SHADOW_MIN_HISTORY_BARS = 30;

/** How many names each screener promotes to a shadow plan per day. */
export const SHADOW_SHORTLIST_SIZE = 5;

// --- marketcap liquidity / size filter (option B: ARJUM shortlist ∩ this) ---
export const MCAP_MIN_TURNOVER_RATIO = 0.002; // ≥0.2% of market cap traded that day
export const MCAP_MIN_MARKET_CAP = 300_000_000_000; // Rp 300bn floor — skip micro gorengan
export const MCAP_MAX_MARKET_CAP = 50_000_000_000_000; // Rp 50tn ceiling — broker flow is noise on mega caps

// --- technical screen (option D) over a bounded universe ---
/** Universe = top-N liquid names by turnover ratio from /api/market-cap. Caps
 *  the number of extra /api/history fetches per day (budget ~1000 req/day). */
export const TECHNICAL_UNIVERSE_SIZE = 60;
export const TECHNICAL_MIN_PRICE = 51;
export const TECHNICAL_MIN_AVG_TURNOVER_IDR = 2_000_000_000; // 20-bar avg close*volume
/** close must be within this fraction of the 20-bar high to count as a breakout. */
export const TECHNICAL_BREAKOUT_PROXIMITY = 0.03;

/** A symbol is a "consensus" pick when at least this many screeners list it. */
export const CONSENSUS_MIN_AGREEMENT = 2;
