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

/**
 * VERIFIED against a real payload from https://stock.arjum.com/api/broker-summary/{code}
 * (2026-09-09, symbol BBCA) -- see packages/domain/src/schemas/README.md. Field
 * names/shape are Stockbit-broker-summary-derived, not the blueprint's guessed
 * snake_case contract: `stock_code` (not `symbol`), per-broker totals as
 * `bval`/`bvol`/`bfrq`/`sval`/`svol`/`sfrq`/`nval`/`nvol` (not
 * `buy_value`/`buy_volume`/...), and no `status`/`trading_date` field at all --
 * the endpoint returns a DATE RANGE (`broker_start_date`..`broker_end_date`),
 * not a single trading day; average buy/sell price per broker must be derived
 * (bval/bvol, sval/svol), not read from a field.
 */
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

/** One row of `broker_levels`: the Nth-largest buyer paired with the Nth-largest
 * seller (by rank, not by counterparty match) -- evidence-only, not consumed by
 * the feature engine's B-Avg/HHI/breadth math (those use `brokers[]` totals). */
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
