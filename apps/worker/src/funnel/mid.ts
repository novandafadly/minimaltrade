import type { DataEnvelope, ScreenerSignalRow } from "@idx/domain";
import type { FunnelBudget } from "@idx/config";

/**
 * Mid Funnel (blueprint §4.2, adapted).
 *
 * The upstream screener shortlist that reaches here is already small
 * (~8-20 rows) and pre-filtered. With no per-symbol quote/history data at
 * this stage (that is a deep-funnel cost), the mid funnel simply re-ranks
 * the top-funnel survivors by the upstream's historical edge — win-rate,
 * projected upside, and a light penalty for larger historical drawdown —
 * and caps the list at `midFunnelTargetMax` before the deep funnel spends
 * its per-symbol request budget.
 */
export interface MidFunnelScored {
  symbol: string;
  signal: DataEnvelope<ScreenerSignalRow>;
  edgeScore: number;
}

function edgeScore(row: ScreenerSignalRow): number {
  const wr = (row.wrEvent ?? 50) / 100; // 0-1
  const potential = Math.max(0, row.potential ?? 0) / 100; // 0+
  const drawdownPenalty = Math.min(0.5, Math.abs(row.drawdown ?? 0) / 100); // cap at 0.5
  return wr * (1 + potential) * (1 - drawdownPenalty);
}

export function runMidFunnel(
  candidates: DataEnvelope<ScreenerSignalRow>[],
  funnelBudget: FunnelBudget
): MidFunnelScored[] {
  if (candidates.length === 0) return [];
  return candidates
    .map((signal) => ({ symbol: signal.symbol, signal, edgeScore: edgeScore(signal.data) }))
    .sort((a, b) => b.edgeScore - a.edgeScore)
    .slice(0, funnelBudget.midFunnelTargetMax);
}
