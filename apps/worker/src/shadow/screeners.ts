import type { HistoryData, MarketCapEntry, OhlcvBar, ScreenerSignalRow } from "@idx/domain";
import {
  CONSENSUS_MIN_AGREEMENT,
  MCAP_MAX_MARKET_CAP,
  MCAP_MIN_MARKET_CAP,
  MCAP_MIN_TURNOVER_RATIO,
  SHADOW_MIN_HISTORY_BARS,
  SHADOW_SHORTLIST_SIZE,
  TECHNICAL_BREAKOUT_PROXIMITY,
  TECHNICAL_MIN_AVG_TURNOVER_IDR,
  TECHNICAL_MIN_PRICE,
  TECHNICAL_UNIVERSE_SIZE
} from "./constants.js";

/**
 * Shadow-mode screeners. Each produces a ranked shortlist of symbols from a
 * candidate pool using ONLY price/volume/market-cap data — no feature engine,
 * no scoring. The point of the forward-test is to isolate *which shortlist*
 * produces profitable setups, independent of the composite score.
 *
 *   arjum      — the raw ARJUM `/api/screener/latest` shortlist, ranked by
 *                ARJUM's own edge (wr_event × potential)
 *   marketcap  — arjum ∩ a liquidity/size band (option B)
 *   technical  — a classic liquid-momentum-breakout screen over a bounded
 *                universe of the most liquid names (option D)
 *   consensus  — symbols that ≥2 of the above agree on (ensemble)
 */

const N = SHADOW_SHORTLIST_SIZE;

function sma(bars: OhlcvBar[], period: number, endExclusive = bars.length): number | null {
  const start = endExclusive - period;
  if (start < 0) return null;
  let sum = 0;
  for (let i = start; i < endExclusive; i++) sum += bars[i]!.close;
  return sum / period;
}

function avgTurnover(bars: OhlcvBar[], period: number): number {
  const slice = bars.slice(-period);
  if (slice.length === 0) return 0;
  const sum = slice.reduce((a, b) => a + (b.turnover ?? b.close * b.volume), 0);
  return sum / slice.length;
}

function ret(bars: OhlcvBar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const now = bars[bars.length - 1]!.close;
  const then = bars[bars.length - 1 - period]!.close;
  return then > 0 ? now / then - 1 : null;
}

export function hasEnoughHistory(h: HistoryData | undefined): h is HistoryData {
  return !!h && h.bars.length >= SHADOW_MIN_HISTORY_BARS;
}

/** ARJUM shortlist, ranked by the upstream's own conviction. */
export function arjumShortlist(
  rows: ScreenerSignalRow[],
  histories: Map<string, HistoryData>
): string[] {
  return rows
    .filter((r) => hasEnoughHistory(histories.get(r.symbol)))
    .map((r) => ({
      symbol: r.symbol,
      edge: ((r.wrEvent ?? 50) / 100) * (1 + (r.potential ?? 0) / 100)
    }))
    .sort((a, b) => b.edge - a.edge)
    .slice(0, N)
    .map((r) => r.symbol);
}

/** ARJUM shortlist ∩ liquidity/size band, ranked by turnover ratio. */
export function marketcapShortlist(
  rows: ScreenerSignalRow[],
  mcap: Map<string, MarketCapEntry>,
  histories: Map<string, HistoryData>
): string[] {
  return rows
    .filter((r) => hasEnoughHistory(histories.get(r.symbol)))
    .map((r) => mcap.get(r.symbol))
    .filter((e): e is MarketCapEntry => !!e)
    .filter(
      (e) =>
        e.marketCap >= MCAP_MIN_MARKET_CAP &&
        e.marketCap <= MCAP_MAX_MARKET_CAP &&
        (e.turnoverRatio ?? 0) >= MCAP_MIN_TURNOVER_RATIO
    )
    .sort((a, b) => (b.turnoverRatio ?? 0) - (a.turnoverRatio ?? 0))
    .slice(0, N)
    .map((e) => e.symbol);
}

/**
 * The bounded universe the technical screen runs over: the most liquid names
 * by turnover ratio. Callers fetch `/api/history` for these (budget-capped).
 */
export function technicalUniverse(mcap: MarketCapEntry[]): string[] {
  return [...mcap]
    .filter((e) => (e.close ?? 0) >= TECHNICAL_MIN_PRICE && (e.turnoverRatio ?? 0) > 0)
    .sort((a, b) => (b.turnoverRatio ?? 0) - (a.turnoverRatio ?? 0))
    .slice(0, TECHNICAL_UNIVERSE_SIZE)
    .map((e) => e.symbol);
}

/** Liquid momentum-breakout screen. Pure OHLCV. */
export function technicalShortlist(histories: Map<string, HistoryData>, universe: string[]): string[] {
  const scored: { symbol: string; score: number }[] = [];
  for (const symbol of universe) {
    const h = histories.get(symbol);
    if (!hasEnoughHistory(h)) continue;
    const bars = h.bars;
    const last = bars[bars.length - 1]!;
    if (last.close < TECHNICAL_MIN_PRICE) continue;
    if (avgTurnover(bars, 20) < TECHNICAL_MIN_AVG_TURNOVER_IDR) continue;

    const sma20 = sma(bars, 20);
    const sma50 = sma(bars, 50) ?? sma(bars, Math.min(50, bars.length - 1));
    if (sma20 === null || sma50 === null) continue;
    if (!(last.close > sma20 && sma20 > sma50)) continue; // uptrend

    const high20 = Math.max(...bars.slice(-20).map((b) => b.high));
    if (last.close < high20 * (1 - TECHNICAL_BREAKOUT_PROXIMITY)) continue; // near breakout

    const r20 = ret(bars, 20);
    if (r20 === null || r20 <= 0) continue;

    const avgVol20 = bars.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;
    const volPace = avgVol20 > 0 ? last.volume / avgVol20 : 1;

    scored.push({ symbol, score: r20 * Math.max(volPace, 0.1) });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, N)
    .map((s) => s.symbol);
}

/** Symbols ≥CONSENSUS_MIN_AGREEMENT of the given shortlists agree on. */
export function consensusShortlist(shortlists: string[][]): string[] {
  const votes = new Map<string, number>();
  for (const list of shortlists) {
    for (const sym of new Set(list)) votes.set(sym, (votes.get(sym) ?? 0) + 1);
  }
  return [...votes.entries()]
    .filter(([, v]) => v >= CONSENSUS_MIN_AGREEMENT)
    .sort((a, b) => b[1] - a[1])
    .slice(0, N)
    .map(([sym]) => sym);
}
