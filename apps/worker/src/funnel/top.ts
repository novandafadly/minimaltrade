import type { DataEnvelope, ScreenerSignalRow } from "@idx/domain";
import type { FunnelBudget } from "@idx/config";
import { TOP_FUNNEL_EXCLUDED_BUCKET_MARKERS } from "./constants.js";

/**
 * Top of Funnel (blueprint §4.1, adapted to the real upstream).
 *
 * `stock.arjum.com/api/screener/latest` does NOT return a whole-universe
 * quote list — it returns an already-curated pattern-signal shortlist
 * (~8-20 names) bucketed by the upstream's own verdict. So the top funnel's
 * job here is not liquidity/price filtering (there is no price/volume at
 * this stage) but dropping the buckets that are explicit distribution/trap
 * warnings, then ranking the rest by the upstream's historical edge stats.
 * Per-symbol liquidity and quote data are fetched in the deep funnel.
 */
export interface TopFunnelResult {
  survivors: DataEnvelope<ScreenerSignalRow>[];
  excludedCount: number;
  reasons: Record<string, number>;
}

function edgeRank(row: ScreenerSignalRow): number {
  // Historical event win-rate weighted by projected upside; a missing stat
  // contributes neutrally (win-rate ~50, potential ~0) so a row is neither
  // boosted nor buried purely for lacking a field.
  const wr = row.wrEvent ?? 50;
  const potential = row.potential ?? 0;
  return (wr / 100) * (1 + potential / 100);
}

export function runTopFunnel(
  candidates: DataEnvelope<ScreenerSignalRow>[],
  funnelBudget: FunnelBudget
): TopFunnelResult {
  const reasons: Record<string, number> = {};
  const bump = (reason: string) => {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  };

  const filtered = candidates.filter((envelope) => {
    const row = envelope.data;
    if (envelope.status === "provisional") {
      bump("stale_or_provisional");
      return false;
    }
    const bucket = (row.bucket ?? "").toLowerCase();
    const summary = (row.summary ?? "").toLowerCase();
    if (
      TOP_FUNNEL_EXCLUDED_BUCKET_MARKERS.some(
        (marker) => bucket.includes(marker) || summary.includes(marker)
      )
    ) {
      bump("distribution_or_trap_bucket");
      return false;
    }
    return true;
  });

  const ranked = [...filtered].sort((a, b) => edgeRank(b.data) - edgeRank(a.data));
  const survivors = ranked.slice(0, funnelBudget.topFunnelTargetMax);

  return {
    survivors,
    excludedCount: candidates.length - survivors.length,
    reasons
  };
}
