import { z } from "zod";

/**
 * Zod schemas for the 11 upstream endpoints of https://stock.arjum.com
 * (auth: `X-API-Key` header).
 *
 * STATUS: every schema below was tightened against a real captured payload on
 * 2026-09-09 (BBCA where a symbol is required) — see
 * packages/domain/src/schemas/README.md. Schemas are deliberately permissive
 * on fields the pipeline does not consume (unknown extra keys are ignored and
 * rarely-present keys are `.optional()`), while every field the
 * funnel/feature/scoring engines depend on is required so a real contract
 * drift fails fast at the adapter boundary.
 */

const numeric = z.union([z.number(), z.string().transform((s) => Number(s))]);
const nullableNumeric = numeric.nullable().optional();

// ---------------------------------------------------------------------
// /api/screener/latest  — curated signal shortlist (NOT a universe)
// ---------------------------------------------------------------------
export const screenerSignalRowSchema = z.object({
  stock_code: z.string(),
  stock_name: z.string().nullable().optional(),
  bucket: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  drawdown: nullableNumeric,
  wr_event: nullableNumeric,
  potential: nullableNumeric
});

export const screenerLatestResponseSchema = z.object({
  date: z.string().optional(),
  source: z.string().optional(),
  cached_for_seconds: z.number().optional(),
  raw: z.string().optional(),
  rows: z.array(screenerSignalRowSchema)
});

// ---------------------------------------------------------------------
// /api/history/{code}  — daily candlestick + volume (full OHLCV)
// ---------------------------------------------------------------------
export const historyRowSchema = z.object({
  date: z.string(),
  open: numeric,
  high: numeric,
  low: numeric,
  close: numeric,
  volume: numeric,
  value: nullableNumeric, // rupiah turnover
  change: nullableNumeric,
  change_pct: nullableNumeric,
  freq: nullableNumeric,
  f_buy: nullableNumeric,
  f_sell: nullableNumeric,
  n_foreign: nullableNumeric,
  avg: nullableNumeric
});

export const historyResponseSchema = z.object({
  stock_code: z.string(),
  frame: z.string().optional(),
  rows: z.array(historyRowSchema)
});

// ---------------------------------------------------------------------
// /api/broker-summary/{code}  — VERIFIED 2026-09-09, unchanged shape
// ---------------------------------------------------------------------
export const brokerRowSchema = z.object({
  broker_code: z.string(),
  broker_name: z.string().optional(),
  bval: numeric,
  bvol: numeric,
  bfrq: numeric.optional(),
  sval: numeric,
  svol: numeric,
  sfrq: numeric.optional(),
  nval: numeric.optional(),
  nvol: numeric.optional()
});

export const brokerLevelSideSchema = z.object({
  broker_code: z.string(),
  broker_name: z.string().optional(),
  bval: numeric.optional(),
  bvol: numeric.optional(),
  bfrq: numeric.optional(),
  bavg: numeric.optional(),
  sval: numeric.optional(),
  svol: numeric.optional(),
  sfrq: numeric.optional(),
  savg: numeric.optional()
});

export const brokerLevelSchema = z.object({
  buy: brokerLevelSideSchema.optional(),
  sell: brokerLevelSideSchema.optional()
});

export const brokerSummaryResponseSchema = z.object({
  stock_code: z.string(),
  brokers: z.array(brokerRowSchema),
  broker_levels: z.array(brokerLevelSchema).optional().default([]),
  broker_start_date: z.string(),
  broker_end_date: z.string(),
  broker_date_min: z.string().optional(),
  broker_date_max: z.string().optional(),
  broker_net: z.boolean().optional(),
  flow: z.string().optional()
});

// ---------------------------------------------------------------------
// /api/broker-accumulation/{code}  — per-broker net-flow time series
// ---------------------------------------------------------------------
export const brokerAccumulationPointSchema = z.object({
  date: z.string(),
  nval: numeric,
  nvol: nullableNumeric,
  cum_nval: nullableNumeric,
  bavg: nullableNumeric,
  savg: nullableNumeric
});

export const brokerAccumulationSeriesSchema = z.object({
  broker_code: z.string(),
  broker_name: z.string().optional(),
  points: z.array(brokerAccumulationPointSchema)
});

export const brokerAccumulationTotalSchema = z.object({
  broker_code: z.string(),
  broker_name: z.string().optional(),
  total_nval: numeric
});

export const brokerAccumulationResponseSchema = z.object({
  code: z.string(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  series: z.array(brokerAccumulationSeriesSchema),
  top_buyers: z.array(brokerAccumulationTotalSchema).optional().default([]),
  top_sellers: z.array(brokerAccumulationTotalSchema).optional().default([])
});

// ---------------------------------------------------------------------
// /api/analysis/{code}  — human-readable markdown blob
// ---------------------------------------------------------------------
export const analysisResponseSchema = z.object({
  stock_code: z.string(),
  output: z.string()
});

// ---------------------------------------------------------------------
// /api/seasonal/{code}  — monthly seasonality win-rate matrix
// ---------------------------------------------------------------------
export const seasonalSummaryEntrySchema = z.object({
  avg: nullableNumeric,
  up: z.number().optional(),
  down: z.number().optional(),
  total: z.number().optional(),
  up_prob: nullableNumeric
});

export const seasonalResponseSchema = z.object({
  stock_code: z.string(),
  years: z.array(z.string()).optional(),
  monthly_returns: z.record(z.string(), z.record(z.string(), numeric)).optional(),
  summary: z.record(z.string(), seasonalSummaryEntrySchema),
  yearly_avg: z.record(z.string(), numeric).optional()
});

// ---------------------------------------------------------------------
// /api/market-cap  — paginated whole-universe market cap
// ---------------------------------------------------------------------
export const marketCapEntrySchema = z.object({
  code: z.string(),
  name: z.string().optional(),
  close: nullableNumeric,
  listed_shares: numeric,
  market_cap: numeric,
  turnover_ratio: nullableNumeric // day turnover / market cap
});

export const marketCapResponseSchema = z.object({
  date: z.string().optional(),
  total: z.number().optional(),
  page: z.number().optional(),
  per_page: z.number().optional(),
  total_pages: z.number().optional(),
  data: z.array(marketCapEntrySchema)
});

// ---------------------------------------------------------------------
// /api/search  — bare array (autocomplete)
// ---------------------------------------------------------------------
export const searchResponseSchema = z.array(
  z.object({
    stock_code: z.string(),
    stock_name: z.string(),
    last_date: z.string().optional()
  })
);

// ---------------------------------------------------------------------
// /api/health
// ---------------------------------------------------------------------
export const healthResponseSchema = z.object({
  ok: z.boolean().optional(),
  status: z.string(),
  latency_ms: nullableNumeric,
  message: z.string().nullable().optional()
});

// ---------------------------------------------------------------------
// /api/financial-statements/{code}  — NOT available to API keys (403);
// schema kept permissive so a future grant does not require a code change.
// ---------------------------------------------------------------------
export const financialStatementResponseSchema = z.object({
  stock_code: z.string().optional(),
  symbol: z.string().optional(),
  fiscal_period: z.string().optional(),
  revenue: nullableNumeric,
  net_income: nullableNumeric,
  debt_to_equity: nullableNumeric,
  red_flags: z.array(z.string()).optional().default([])
});

// ---------------------------------------------------------------------
// /api/insiders/{code}  — paginated insider transactions
// ---------------------------------------------------------------------
export const insiderItemSchema = z.object({
  name: z.string().nullable().optional(),
  date: z.string(),
  action_type: z.string(),
  nationality: z.string().optional(),
  changes_value: z.string().nullable().optional(),
  current_value: z.string().nullable().optional(),
  price_formatted: z.string().nullable().optional(),
  broker_code: z.string().nullable().optional(),
  badges: z.array(z.string()).optional()
});

export const insidersResponseSchema = z.object({
  stock_code: z.string(),
  count: z.number().optional(),
  total: z.number().optional(),
  page: z.number().optional(),
  page_size: z.number().optional(),
  total_pages: z.number().optional(),
  items: z.array(insiderItemSchema)
});

export type ScreenerLatestResponse = z.infer<typeof screenerLatestResponseSchema>;
export type HistoryResponse = z.infer<typeof historyResponseSchema>;
export type BrokerSummaryResponse = z.infer<typeof brokerSummaryResponseSchema>;
export type BrokerAccumulationResponse = z.infer<typeof brokerAccumulationResponseSchema>;
export type AnalysisResponse = z.infer<typeof analysisResponseSchema>;
export type SeasonalResponse = z.infer<typeof seasonalResponseSchema>;
export type MarketCapResponse = z.infer<typeof marketCapResponseSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type FinancialStatementResponse = z.infer<typeof financialStatementResponseSchema>;
export type InsidersResponse = z.infer<typeof insidersResponseSchema>;
