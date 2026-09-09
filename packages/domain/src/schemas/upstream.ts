import { z } from "zod";

/**
 * Zod schemas for the 11 upstream endpoints (blueprint section 3 / prompt
 * section 15), source: https://stock.arjum.com, auth via X-API-Key header.
 *
 * STATUS: PROVISIONAL for every schema below except where a live sample was
 * supplied and verified (see packages/domain/src/schemas/README.md, updated
 * as real payloads arrive). Field names/casing are best-effort guesses from
 * the blueprint's prose contract (symbol, event time/trading date,
 * published_at, received_at, source, market segment, revision id,
 * final/provisional status) and are deliberately permissive (`.passthrough()`
 * is NOT used — unknown extra fields are fine, but every field we depend on
 * downstream is required so a mismatch fails fast at the adapter boundary
 * instead of silently producing NaN/undefined deep in scoring).
 *
 * When tightening a schema against a real payload, change only that schema
 * (single source of truth) and update its status comment.
 */

const numeric = z.union([z.number(), z.string().transform((s) => Number(s))]);

export const screenerRowSchema = z.object({
  symbol: z.string(),
  board: z.string().nullable().optional(),
  price: numeric,
  change: numeric.optional(),
  change_pct: numeric.optional(),
  volume: numeric,
  turnover: numeric,
  best_bid: numeric.nullable().optional(),
  best_offer: numeric.nullable().optional(),
  is_suspended: z.boolean().optional().default(false),
  notation: z.array(z.string()).nullable().optional()
});

export const screenerLatestResponseSchema = z.object({
  as_of: z.string(), // required per blueprint contract; adapter rejects payloads missing this
  trading_date: z.string().optional(),
  status: z.enum(["final", "provisional"]).optional().default("provisional"),
  data: z.array(screenerRowSchema)
});

export const ohlcvBarSchema = z.object({
  date: z.string(),
  open: numeric,
  high: numeric,
  low: numeric,
  close: numeric,
  volume: numeric,
  turnover: numeric.nullable().optional()
});

export const historyResponseSchema = z.object({
  symbol: z.string(),
  bars: z.array(ohlcvBarSchema),
  baseline_median_volume_20d: numeric.nullable().optional()
});

export const brokerRowSchema = z.object({
  broker_code: z.string(),
  buy_volume: numeric,
  buy_value: numeric,
  sell_volume: numeric,
  sell_value: numeric,
  net_volume: numeric.optional(),
  net_value: numeric.optional(),
  avg_buy_price: numeric.nullable().optional(),
  avg_sell_price: numeric.nullable().optional()
});

export const brokerSummaryResponseSchema = z.object({
  symbol: z.string(),
  trading_date: z.string(),
  segment: z.enum(["regular", "cash", "negotiated", "unknown"]).optional().default("unknown"),
  status: z.enum(["final", "provisional"]).optional().default("provisional"),
  brokers: z.array(brokerRowSchema)
});

export const brokerAccumulationDaySchema = z.object({
  date: z.string(),
  net_buy_brokers: z.array(z.string()),
  top_buyer_code: z.string().nullable().optional(),
  top_buyer_share: numeric.nullable().optional()
});

export const brokerAccumulationResponseSchema = z.object({
  symbol: z.string(),
  window_days: z.number().int().optional().default(5),
  days: z.array(brokerAccumulationDaySchema)
});

export const analysisResponseSchema = z.object({
  symbol: z.string(),
  sector: z.string().nullable().optional(),
  market_cap: numeric.nullable().optional(),
  as_of: z.string().optional()
});

export const seasonalResponseSchema = z.object({
  symbol: z.string(),
  month: z.number().int(),
  historical_win_rate: numeric.nullable().optional(),
  sample_size: z.number().int().optional().default(0)
});

export const marketCapEntrySchema = z.object({
  symbol: z.string(),
  shares_outstanding: numeric,
  market_cap: numeric
});

export const marketCapResponseSchema = z.object({
  as_of: z.string().optional(),
  data: z.array(marketCapEntrySchema)
});

export const searchResponseSchema = z.object({
  data: z.array(z.object({ symbol: z.string(), name: z.string() }))
});

export const healthResponseSchema = z.object({
  status: z.string(),
  latency_ms: numeric.nullable().optional(),
  message: z.string().nullable().optional()
});

export const financialStatementResponseSchema = z.object({
  symbol: z.string(),
  fiscal_period: z.string(),
  revenue: numeric.nullable().optional(),
  net_income: numeric.nullable().optional(),
  debt_to_equity: numeric.nullable().optional(),
  red_flags: z.array(z.string()).optional().default([])
});

export const insiderTransactionSchema = z.object({
  symbol: z.string(),
  date: z.string(),
  insider_name: z.string().nullable().optional(),
  action: z.enum(["buy", "sell"]),
  shares: numeric
});

export const insidersResponseSchema = z.object({
  symbol: z.string(),
  data: z.array(insiderTransactionSchema)
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
