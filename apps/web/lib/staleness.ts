/**
 * Staleness policy shared by the BFF (to compute `dataStale`/row-level
 * disabling) and the UI (to explain why). Blueprint: "Dashboard tidak pernah
 * menampilkan sinyal aktif dari data stale atau tanpa timestamp" — so a row
 * flagged stale must never allow the plan action.
 *
 * A row is considered stale if either:
 *  - the FeatureSnapshot itself was computed with `dataStale: true` (the
 *    domain engine's own freshness gate already fired), or
 *  - its age exceeds the session-aware threshold below (looser while the
 *    market is closed, since no new prints are expected then).
 */
export const STALE_THRESHOLD_MS_WHEN_OPEN = 15 * 60 * 1000; // 15 minutes intraday
export const STALE_THRESHOLD_MS_WHEN_CLOSED = 20 * 60 * 60 * 1000; // 20 hours outside session

export function staleThresholdMs(marketOpen: boolean): number {
  return marketOpen ? STALE_THRESHOLD_MS_WHEN_OPEN : STALE_THRESHOLD_MS_WHEN_CLOSED;
}

export function isRowStale(params: {
  featureDataStale: boolean;
  ageMs: number;
  marketOpen: boolean;
}): boolean {
  if (params.featureDataStale) return true;
  return params.ageMs > staleThresholdMs(params.marketOpen);
}
