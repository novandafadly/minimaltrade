import type {
  ScreenerRow,
  ScreenerSignalRow,
  OhlcvBar,
  HistoryData,
  BrokerRow,
  BrokerSummaryData,
  BrokerAccumulationData,
  AnalysisData,
  SeasonalData,
  MarketCapEntry,
  SearchResultEntry,
  FinancialStatementData,
  InsiderTransaction,
  HealthStatus
} from "@idx/domain";
import type {
  ScreenerLatestResponse,
  HistoryResponse,
  BrokerSummaryResponse,
  BrokerAccumulationResponse,
  AnalysisResponse,
  SeasonalResponse,
  MarketCapResponse,
  SearchResponse,
  HealthResponse,
  FinancialStatementResponse,
  InsidersResponse
} from "@idx/domain";

/**
 * Pure mappers from upstream (stock.arjum.com) shapes to the shared domain
 * contracts in packages/domain/src/types/marketData.ts. No envelope/audit
 * concerns here — see envelope.ts and endpoints.ts.
 */

const num = (v: number | string | null | undefined, fallback = 0): number => {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : fallback;
};
const numOrNull = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
};
/** Parse strings like "+317,892" / "7,819,950" into a number. */
const parseLooseNumber = (v: string | null | undefined): number => {
  if (!v) return 0;
  const n = Number(v.replace(/[,+\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

export const MONTH_KEYS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

// ---------------------------------------------------------------------
// /api/screener/latest
// ---------------------------------------------------------------------
export function normalizeScreenerSignalRow(row: ScreenerLatestResponse["rows"][number]): ScreenerSignalRow {
  return {
    symbol: row.stock_code,
    name: row.stock_name ?? null,
    bucket: row.bucket ?? "",
    summary: row.summary ?? null,
    note: row.note ?? null,
    drawdown: numOrNull(row.drawdown),
    wrEvent: numOrNull(row.wr_event),
    potential: numOrNull(row.potential)
  };
}

// ---------------------------------------------------------------------
// /api/history/{code}
// ---------------------------------------------------------------------
export function normalizeOhlcvBar(bar: HistoryResponse["rows"][number]): OhlcvBar {
  return {
    date: bar.date,
    open: num(bar.open),
    high: num(bar.high),
    low: num(bar.low),
    close: num(bar.close),
    volume: num(bar.volume),
    turnover: numOrNull(bar.value)
  };
}

/** Median of the last `window` bars' volume, excluding the most recent bar
 * (the "today" bar being evaluated), matching the blueprint's "20d baseline
 * median volume, ex-today" definition. The real API does not return this
 * field, so the adapter computes it from the returned history window. */
function medianVolumeExcludingLast(bars: OhlcvBar[], window = 20): number | null {
  const pool = bars.slice(0, -1).slice(-window).map((b) => b.volume).filter((v) => v > 0);
  if (pool.length === 0) return null;
  const sorted = [...pool].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

export function normalizeHistory(resp: HistoryResponse): HistoryData {
  // Upstream returns rows newest-first; the domain contract (and the feature
  // engine's `bars[bars.length - 1]` "today" access) expects oldest-first.
  const ascending = [...resp.rows].sort((a, b) => a.date.localeCompare(b.date));
  const bars = ascending.map(normalizeOhlcvBar);
  return {
    symbol: resp.stock_code,
    bars,
    baselineMedianVolume20d: medianVolumeExcludingLast(bars, 20)
  };
}

/**
 * Derive the per-symbol quote snapshot the feature engine consumes
 * (`ScreenerRow`) from the latest `/api/history` bar. On this upstream the
 * screener endpoint carries no price/volume, so the deep funnel builds this
 * after fetching history for each candidate.
 */
export function quoteFromHistory(history: HistoryData): ScreenerRow {
  const last = history.bars[history.bars.length - 1] ?? null;
  const prev = history.bars[history.bars.length - 2] ?? null;
  const price = last?.close ?? 0;
  const prevClose = prev?.close ?? price;
  const priceChange = price - prevClose;
  const priceChangePct = prevClose > 0 ? priceChange / prevClose : 0; // fraction
  return {
    symbol: history.symbol,
    board: null,
    price,
    priceChange,
    priceChangePct,
    volume: last?.volume ?? 0,
    turnover: last?.turnover ?? 0,
    bestBid: null,
    bestOffer: null,
    spread: null,
    isSuspended: false,
    notation: null
  };
}

// ---------------------------------------------------------------------
// /api/broker-summary/{code}  (unchanged shape — VERIFIED)
// ---------------------------------------------------------------------
function normalizeBrokerRow(row: BrokerSummaryResponse["brokers"][number]): BrokerRow {
  const buyVolume = num(row.bvol);
  const sellVolume = num(row.svol);
  const buyValue = num(row.bval);
  const sellValue = num(row.sval);
  return {
    brokerCode: row.broker_code,
    buyVolume,
    buyValue,
    sellVolume,
    sellValue,
    netVolume: row.nvol !== undefined ? num(row.nvol) : buyVolume - sellVolume,
    netValue: row.nval !== undefined ? num(row.nval) : buyValue - sellValue,
    avgBuyPrice: buyVolume > 0 ? buyValue / buyVolume : null,
    avgSellPrice: sellVolume > 0 ? sellValue / sellVolume : null
  };
}

export function normalizeBrokerSummary(resp: BrokerSummaryResponse): BrokerSummaryData {
  const brokers = resp.brokers.map(normalizeBrokerRow);
  return {
    symbol: resp.stock_code,
    segment: "regular",
    brokers,
    totalVolume: brokers.reduce((sum, b) => sum + b.buyVolume + b.sellVolume, 0),
    totalValue: brokers.reduce((sum, b) => sum + b.buyValue + b.sellValue, 0)
  };
}

// ---------------------------------------------------------------------
// /api/broker-accumulation/{code}
// ---------------------------------------------------------------------
export function normalizeBrokerAccumulation(resp: BrokerAccumulationResponse): BrokerAccumulationData {
  // Real payload is per-broker time series; the domain contract wants
  // per-day rows. Pivot: for each date, which brokers were net buyers and
  // who was the single largest net buyer (by net value) that day.
  const byDate = new Map<string, { code: string; nval: number }[]>();
  for (const series of resp.series) {
    for (const p of series.points) {
      const arr = byDate.get(p.date) ?? [];
      arr.push({ code: series.broker_code, nval: num(p.nval) });
      byDate.set(p.date, arr);
    }
  }
  const days = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => {
      const positive = rows.filter((r) => r.nval > 0);
      const totalPositive = positive.reduce((s, r) => s + r.nval, 0);
      const top = positive.reduce<{ code: string; nval: number } | null>(
        (best, r) => (best === null || r.nval > best.nval ? r : best),
        null
      );
      return {
        date,
        netBuyBrokers: positive.map((r) => r.code),
        topBuyerCode: top?.code ?? null,
        topBuyerShare: top && totalPositive > 0 ? top.nval / totalPositive : null
      };
    });
  return { symbol: resp.code, windowDays: days.length, days };
}

// ---------------------------------------------------------------------
// /api/analysis/{code}  — unstructured markdown; kept as narrative only.
// ---------------------------------------------------------------------
export function normalizeAnalysis(resp: AnalysisResponse): AnalysisData {
  return {
    symbol: resp.stock_code,
    sector: null,
    marketCap: null,
    narrative: { output: resp.output }
  };
}

// ---------------------------------------------------------------------
// /api/seasonal/{code}
// ---------------------------------------------------------------------
export function normalizeSeasonal(resp: SeasonalResponse, monthIndex: number): SeasonalData {
  const key = MONTH_KEYS[((monthIndex % 12) + 12) % 12] ?? "Jan";
  const entry = resp.summary[key];
  const upProb = entry ? numOrNull(entry.up_prob) : null;
  return {
    symbol: resp.stock_code,
    month: (((monthIndex % 12) + 12) % 12) + 1,
    // up_prob is a percentage (0-100); the confluence score expects 0-1.
    historicalWinRate: upProb !== null ? upProb / 100 : null,
    sampleSize: entry?.total ?? 0
  };
}

// ---------------------------------------------------------------------
// /api/market-cap
// ---------------------------------------------------------------------
export function normalizeMarketCapEntries(resp: MarketCapResponse): MarketCapEntry[] {
  return resp.data.map((e) => ({
    symbol: e.code,
    sharesOutstanding: num(e.listed_shares),
    marketCap: num(e.market_cap)
  }));
}

// ---------------------------------------------------------------------
// /api/search
// ---------------------------------------------------------------------
export function normalizeSearchResults(resp: SearchResponse): SearchResultEntry[] {
  return resp.map((e) => ({ symbol: e.stock_code, name: e.stock_name }));
}

// ---------------------------------------------------------------------
// /api/health
// ---------------------------------------------------------------------
export function normalizeHealth(resp: HealthResponse): HealthStatus {
  const s = resp.status.toLowerCase();
  return {
    upstreamOk: resp.ok ?? (s === "ok" || s === "healthy"),
    latencyMs: numOrNull(resp.latency_ms),
    message: resp.message ?? null
  };
}

// ---------------------------------------------------------------------
// /api/financial-statements/{code}
// ---------------------------------------------------------------------
export function normalizeFinancialStatement(resp: FinancialStatementResponse): FinancialStatementData {
  return {
    symbol: resp.stock_code ?? resp.symbol ?? "",
    fiscalPeriod: resp.fiscal_period ?? "",
    revenue: numOrNull(resp.revenue),
    netIncome: numOrNull(resp.net_income),
    debtToEquity: numOrNull(resp.debt_to_equity),
    redFlags: resp.red_flags ?? []
  };
}

// ---------------------------------------------------------------------
// /api/insiders/{code}
// ---------------------------------------------------------------------
export function normalizeInsiderTransaction(
  t: InsidersResponse["items"][number],
  symbol: string
): InsiderTransaction {
  return {
    symbol,
    date: t.date,
    insiderName: t.name ?? null,
    action: t.action_type.toLowerCase() === "buy" ? "buy" : "sell",
    shares: Math.abs(parseLooseNumber(t.changes_value))
  };
}

export function normalizeInsiders(resp: InsidersResponse): InsiderTransaction[] {
  return resp.items.map((t) => normalizeInsiderTransaction(t, resp.stock_code));
}
