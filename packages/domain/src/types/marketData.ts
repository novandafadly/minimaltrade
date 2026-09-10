/**
 * Shared market-data contracts (blueprint section 3). Every adapter response,
 * regardless of upstream endpoint, is normalized into one of these shapes
 * plus a DataEnvelope carrying freshness/audit metadata. Nothing downstream
 * (funnel, feature engine, scoring) may read fields outside this contract.
 */

export type MarketSegment = "regular" | "cash" | "negotiated" | "unknown";
export type DataFinality = "final" | "provisional";

/** Metadata required on every piece of market data before it may influence a signal. */
export interface DataEnvelope<T> {
  symbol: string;
  /** trading date this data pertains to, YYYY-MM-DD (exchange-local) */
  tradingDate: string;
  /** event/quote timestamp from the source, ISO 8601, if known */
  eventTime: string | null;
  /** when the source published/finalized this data, if known */
  publishedAt: string | null;
  /** when our adapter received/fetched this data */
  receivedAt: string;
  source: string; // e.g. "arjum"
  segment: MarketSegment;
  revisionId: string | null;
  status: DataFinality;
  data: T;
}

/**
 * A single per-symbol quote snapshot (last trading day): price/volume/turnover
 * and, when available, top-of-book. On the real stock.arjum.com API this is
 * NOT what `/api/screener/latest` returns (that endpoint is a curated signal
 * shortlist, see ScreenerSignalRow); the adapter derives a ScreenerRow from
 * the latest `/api/history/{code}` bar instead. The name is kept for
 * compatibility with the feature engine, which consumes this shape.
 */
export interface ScreenerRow {
  symbol: string;
  board: string | null;
  price: number;
  priceChange: number;
  priceChangePct: number; // fraction (0.02 == +2%), not percent
  volume: number;
  turnover: number;
  bestBid: number | null;
  bestOffer: number | null;
  spread: number | null;
  isSuspended: boolean;
  notation: string[] | null; // special notation codes (UMA etc) if present
}

/**
 * One row of the real `/api/screener/latest` payload: a curated pattern-based
 * signal, already filtered down from the whole universe by the upstream
 * screener. Carries the upstream's own verdict (`bucket`) and historical
 * event stats, but NO price/volume/liquidity — those come from `/api/history`
 * during deep-funnel enrichment.
 */
export interface ScreenerSignalRow {
  symbol: string;
  name: string | null;
  bucket: string; // e.g. "🟢 SINYAL BERSIH", "🥷 SINYAL SENYAP", "⏰ SINYAL TELAT", "⚔️ KONFLIK DISTRIBUSI"
  summary: string | null;
  note: string | null;
  drawdown: number | null; // % (typically negative), historical event drawdown
  wrEvent: number | null; // historical event win-rate, % (0-100)
  potential: number | null; // % upside the upstream projects
}

export interface OhlcvBar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number | null;
}

export interface HistoryData {
  symbol: string;
  bars: OhlcvBar[];
  baselineMedianVolume20d: number | null;
}

export interface BrokerRow {
  brokerCode: string;
  buyVolume: number;
  buyValue: number;
  sellVolume: number;
  sellValue: number;
  netVolume: number;
  netValue: number;
  avgBuyPrice: number | null;
  avgSellPrice: number | null;
}

export interface BrokerSummaryData {
  symbol: string;
  segment: MarketSegment;
  brokers: BrokerRow[];
  totalVolume: number;
  totalValue: number;
}

export interface BrokerAccumulationDayEntry {
  date: string;
  netBuyBrokers: string[];
  topBuyerCode: string | null;
  topBuyerShare: number | null;
}

export interface BrokerAccumulationData {
  symbol: string;
  windowDays: number;
  days: BrokerAccumulationDayEntry[];
}

export interface AnalysisData {
  symbol: string;
  sector: string | null;
  marketCap: number | null;
  narrative: Record<string, unknown> | null;
}

export interface SeasonalData {
  symbol: string;
  month: number;
  historicalWinRate: number | null;
  sampleSize: number;
}

export interface MarketCapEntry {
  symbol: string;
  sharesOutstanding: number;
  marketCap: number;
  close: number | null;
  turnoverRatio: number | null; // day turnover / market cap (liquidity proxy)
}

export interface SearchResultEntry {
  symbol: string;
  name: string;
}

export interface FinancialStatementData {
  symbol: string;
  fiscalPeriod: string;
  revenue: number | null;
  netIncome: number | null;
  debtToEquity: number | null;
  redFlags: string[];
}

export interface InsiderTransaction {
  symbol: string;
  date: string;
  insiderName: string | null;
  action: "buy" | "sell";
  shares: number;
}

/** Result of `/api/screener/latest` after normalization. */
export interface ScreenerLatestResult {
  asOf: string; // ISO timestamp of the screener run (best-effort: adapter receive time)
  tradingDate: string; // YYYY-MM-DD (exchange-local)
  rawHeadline: string | null; // the upstream's own one-line market summary, if present
  candidates: ScreenerSignalRow[];
}

export interface HealthStatus {
  upstreamOk: boolean;
  latencyMs: number | null;
  message: string | null;
}
