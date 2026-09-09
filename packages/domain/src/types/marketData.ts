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

export interface ScreenerRow {
  symbol: string;
  board: string | null;
  price: number;
  priceChange: number;
  priceChangePct: number;
  volume: number;
  turnover: number;
  bestBid: number | null;
  bestOffer: number | null;
  spread: number | null;
  isSuspended: boolean;
  notation: string[] | null; // special notation codes (UMA etc) if present
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

export interface HealthStatus {
  upstreamOk: boolean;
  latencyMs: number | null;
  message: string | null;
}
