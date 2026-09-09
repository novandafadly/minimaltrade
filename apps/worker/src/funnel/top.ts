import type { DataEnvelope, ScreenerRow } from "@idx/domain";
import type { FunnelBudget } from "@idx/config";
import {
  HIGH_RISK_NOTATIONS,
  TOP_FUNNEL_MAX_SPREAD_PCT,
  TOP_FUNNEL_MIN_PRICE,
  TOP_FUNNEL_MIN_TURNOVER_IDR
} from "./constants.js";

/**
 * Top of Funnel (blueprint §4.1): ONE screener call feeds this — it must
 * never call any per-symbol detail endpoint. Filters the whole universe
 * down to ~80-150 names by liquidity/validity, ranked by a cheap turnover
 * proxy for "volume pace" (no baseline/history data is available at this
 * stage; see constants.ts for the documented limitation).
 */
export interface TopFunnelResult {
  survivors: DataEnvelope<ScreenerRow>[];
  excludedCount: number;
  reasons: Record<string, number>;
}

export function runTopFunnel(rows: DataEnvelope<ScreenerRow>[], funnelBudget: FunnelBudget): TopFunnelResult {
  const reasons: Record<string, number> = {};
  const bump = (reason: string) => {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  };

  const filtered = rows.filter((envelope) => {
    const row = envelope.data;

    if (row.isSuspended) {
      bump("suspended");
      return false;
    }
    if (row.notation && row.notation.some((n) => HIGH_RISK_NOTATIONS.has(n.toUpperCase()))) {
      bump("high_risk_notation");
      return false;
    }
    if (envelope.status === "provisional") {
      bump("stale_or_provisional");
      return false;
    }
    if (!Number.isFinite(row.price) || row.price < TOP_FUNNEL_MIN_PRICE) {
      bump("invalid_or_low_price");
      return false;
    }
    if (!Number.isFinite(row.turnover) || row.turnover < TOP_FUNNEL_MIN_TURNOVER_IDR) {
      bump("below_min_turnover");
      return false;
    }
    if (row.spread !== null && row.price > 0) {
      const spreadPct = row.spread / row.price;
      if (spreadPct > TOP_FUNNEL_MAX_SPREAD_PCT) {
        bump("spread_too_wide");
        return false;
      }
    }
    return true;
  });

  // Rank by turnover as the cheap "volume pace" proxy (blueprint: "hitung
  // volume pace terhadap pola waktu yang sama" — a same-time-of-day
  // comparison needs intraday history the top-funnel screener call doesn't
  // have; turnover is the best available same-stage proxy for participation).
  const ranked = [...filtered].sort((a, b) => b.data.turnover - a.data.turnover);
  const survivors = ranked.slice(0, funnelBudget.topFunnelTargetMax);

  return {
    survivors,
    excludedCount: rows.length - survivors.length,
    reasons
  };
}
