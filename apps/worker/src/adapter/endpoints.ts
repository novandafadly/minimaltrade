import type { Env } from "@idx/config";
import type { Db } from "@idx/db";
import type { ZodType, ZodTypeDef } from "zod";
import {
  screenerLatestResponseSchema,
  historyResponseSchema,
  brokerSummaryResponseSchema,
  brokerAccumulationResponseSchema,
  analysisResponseSchema,
  seasonalResponseSchema,
  marketCapResponseSchema,
  searchResponseSchema,
  healthResponseSchema,
  financialStatementResponseSchema,
  insidersResponseSchema,
  type DataEnvelope,
  type ScreenerRow,
  type ScreenerSignalRow,
  type HistoryData,
  type BrokerSummaryData,
  type BrokerAccumulationData,
  type AnalysisData,
  type SeasonalData,
  type MarketCapEntry,
  type SearchResultEntry,
  type HealthStatus,
  type FinancialStatementData,
  type InsiderTransaction
} from "@idx/domain";
import { callUpstream, type HttpCallOptions } from "./httpClient.js";
import { archiveRawPayload } from "./archive.js";
import { SchemaValidationError } from "./errors.js";
import { buildEnvelope, isoDateOnly } from "./envelope.js";
import {
  normalizeScreenerSignalRow,
  normalizeHistory,
  quoteFromHistory,
  normalizeBrokerSummary,
  normalizeBrokerAccumulation,
  normalizeAnalysis,
  normalizeSeasonal,
  normalizeMarketCapEntries,
  normalizeSearchResults,
  normalizeHealth,
  normalizeFinancialStatement,
  normalizeInsiders
} from "./normalize.js";

/** Endpoint path identifiers used consistently across the adapter, cache
 * TTL config, and request ledger — one source of truth for naming. */
export const ENDPOINTS = {
  screenerLatest: "/api/screener/latest",
  analysis: "/api/analysis/{code}",
  brokerSummary: "/api/broker-summary/{code}",
  brokerAccumulation: "/api/broker-accumulation/{code}",
  history: "/api/history/{code}",
  seasonal: "/api/seasonal/{code}",
  marketCap: "/api/market-cap",
  search: "/api/search",
  health: "/api/health",
  financialStatements: "/api/financial-statements/{code}",
  insiders: "/api/insiders/{code}"
} as const;

export type EndpointName = keyof typeof ENDPOINTS;

export interface AdapterContext {
  env: Env;
  db: Db;
  httpOptions?: HttpCallOptions;
  /** skip S3 archive push (tests) */
  skipS3Archive?: boolean;
}

/** YYYY-MM-DD for a timestamp in the exchange's local timezone. */
function localDateOnly(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(iso)
    );
  } catch {
    return isoDateOnly(iso);
  }
}

/** 0-11 month index for a timestamp in the exchange's local timezone. */
function localMonthIndex(iso: string, timeZone: string): number {
  try {
    const m = new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric" }).format(new Date(iso));
    return Number(m) - 1;
  } catch {
    return new Date(iso).getUTCMonth();
  }
}

/** Shared plumbing: call upstream, validate through the given schema, and
 * archive the raw payload either way (schemaValid true/false). */
async function fetchAndValidate<TSchema>(
  ctx: AdapterContext,
  endpointLabel: string,
  path: string,
  symbol: string | null,
  schema: ZodType<TSchema, ZodTypeDef, unknown>
): Promise<{ parsed: TSchema; requestedAt: string; receivedAt: string; rawPayloadId: string }> {
  const result = await callUpstream(ctx.env, path, ctx.httpOptions);
  const parseResult = schema.safeParse(result.json);

  if (!parseResult.success) {
    const rawPayloadId = await archiveRawPayload(
      ctx.db,
      ctx.env,
      {
        endpoint: endpointLabel,
        symbol,
        requestedAt: result.requestedAt,
        receivedAt: result.receivedAt,
        httpStatus: result.status,
        payload: result.json,
        schemaValid: false,
        schemaErrors: parseResult.error.issues
      },
      { skipS3: ctx.skipS3Archive }
    );
    const err = new SchemaValidationError(endpointLabel, parseResult.error.issues, result.json);
    (err as SchemaValidationError & { rawPayloadId?: string }).rawPayloadId = rawPayloadId;
    throw err;
  }

  const rawPayloadId = await archiveRawPayload(
    ctx.db,
    ctx.env,
    {
      endpoint: endpointLabel,
      symbol,
      requestedAt: result.requestedAt,
      receivedAt: result.receivedAt,
      httpStatus: result.status,
      payload: result.json,
      schemaValid: true,
      schemaErrors: null
    },
    { skipS3: ctx.skipS3Archive }
  );

  return { parsed: parseResult.data, requestedAt: result.requestedAt, receivedAt: result.receivedAt, rawPayloadId };
}

// ---------------------------------------------------------------------
// 1. GET /api/screener/latest -- curated signal shortlist (candidate list)
// ---------------------------------------------------------------------
export interface ScreenerLatestFetchResult {
  asOf: string;
  tradingDate: string;
  rawHeadline: string | null;
  candidates: DataEnvelope<ScreenerSignalRow>[];
}

export async function getScreenerLatest(ctx: AdapterContext): Promise<ScreenerLatestFetchResult> {
  const { parsed, receivedAt } = await fetchAndValidate(
    ctx,
    ENDPOINTS.screenerLatest,
    ENDPOINTS.screenerLatest,
    null,
    screenerLatestResponseSchema
  );
  const tz = ctx.env.SESSION_TIMEZONE;
  const tradingDate = localDateOnly(receivedAt, tz);
  const rawHeadline = parsed.raw ? (parsed.raw.split("\n").find((l) => l.trim().length > 0) ?? null) : null;
  const candidates = parsed.rows.map((row) =>
    buildEnvelope<ScreenerSignalRow>({
      symbol: row.stock_code,
      tradingDate,
      eventTime: receivedAt,
      publishedAt: receivedAt,
      receivedAt,
      segment: "unknown",
      revisionId: null,
      declaredStatus: "final",
      data: normalizeScreenerSignalRow(row)
    })
  );
  return { asOf: receivedAt, tradingDate, rawHeadline, candidates };
}

// ---------------------------------------------------------------------
// 2. GET /api/analysis/{code}
// ---------------------------------------------------------------------
export async function getAnalysis(ctx: AdapterContext, symbol: string): Promise<DataEnvelope<AnalysisData>> {
  const path = ENDPOINTS.analysis.replace("{code}", symbol);
  const { parsed, receivedAt } = await fetchAndValidate(ctx, ENDPOINTS.analysis, path, symbol, analysisResponseSchema);
  return buildEnvelope<AnalysisData>({
    symbol: parsed.stock_code,
    tradingDate: localDateOnly(receivedAt, ctx.env.SESSION_TIMEZONE),
    eventTime: null,
    publishedAt: null,
    receivedAt,
    segment: "unknown",
    revisionId: null,
    declaredStatus: "final",
    data: normalizeAnalysis(parsed)
  });
}

// ---------------------------------------------------------------------
// 3. GET /api/broker-summary/{code}
// ---------------------------------------------------------------------
export async function getBrokerSummary(
  ctx: AdapterContext,
  symbol: string,
  assumeFinal = false
): Promise<DataEnvelope<BrokerSummaryData>> {
  const path = ENDPOINTS.brokerSummary.replace("{code}", symbol);
  const { parsed, receivedAt } = await fetchAndValidate(
    ctx,
    ENDPOINTS.brokerSummary,
    path,
    symbol,
    brokerSummaryResponseSchema
  );
  return buildEnvelope<BrokerSummaryData>({
    symbol: parsed.stock_code,
    tradingDate: parsed.broker_end_date,
    eventTime: null,
    publishedAt: null,
    receivedAt,
    segment: "regular",
    revisionId: null,
    declaredStatus: assumeFinal ? "final" : undefined,
    data: normalizeBrokerSummary(parsed)
  });
}

// ---------------------------------------------------------------------
// 4. GET /api/broker-accumulation/{code}
// ---------------------------------------------------------------------
export async function getBrokerAccumulation(
  ctx: AdapterContext,
  symbol: string
): Promise<DataEnvelope<BrokerAccumulationData>> {
  const path = ENDPOINTS.brokerAccumulation.replace("{code}", symbol);
  const { parsed, receivedAt } = await fetchAndValidate(
    ctx,
    ENDPOINTS.brokerAccumulation,
    path,
    symbol,
    brokerAccumulationResponseSchema
  );
  const data = normalizeBrokerAccumulation(parsed);
  const lastDay = data.days[data.days.length - 1];
  return buildEnvelope<BrokerAccumulationData>({
    symbol: data.symbol,
    tradingDate: lastDay?.date ?? null,
    eventTime: null,
    publishedAt: null,
    receivedAt,
    segment: "unknown",
    revisionId: null,
    data
  });
}

// ---------------------------------------------------------------------
// 5. GET /api/history/{code}
// ---------------------------------------------------------------------
export async function getHistory(ctx: AdapterContext, symbol: string): Promise<DataEnvelope<HistoryData>> {
  const path = ENDPOINTS.history.replace("{code}", symbol);
  const { parsed, receivedAt } = await fetchAndValidate(ctx, ENDPOINTS.history, path, symbol, historyResponseSchema);
  const data = normalizeHistory(parsed);
  const lastBar = data.bars[data.bars.length - 1];
  return buildEnvelope<HistoryData>({
    symbol: data.symbol,
    tradingDate: lastBar?.date ?? null,
    eventTime: null,
    publishedAt: null,
    receivedAt,
    segment: "regular",
    revisionId: null,
    declaredStatus: "final",
    data
  });
}

/**
 * Build the per-symbol quote snapshot (`ScreenerRow`) the feature engine
 * consumes from an already-fetched history envelope. The upstream screener
 * endpoint carries no price/volume, so the deep funnel calls this after
 * fetching `/api/history` for each candidate.
 */
export function quoteEnvelopeFromHistory(historyEnvelope: DataEnvelope<HistoryData>): DataEnvelope<ScreenerRow> {
  return {
    ...historyEnvelope,
    data: quoteFromHistory(historyEnvelope.data)
  };
}

// ---------------------------------------------------------------------
// 6. GET /api/seasonal/{code}
// ---------------------------------------------------------------------
export async function getSeasonal(ctx: AdapterContext, symbol: string): Promise<DataEnvelope<SeasonalData>> {
  const path = ENDPOINTS.seasonal.replace("{code}", symbol);
  const { parsed, receivedAt } = await fetchAndValidate(ctx, ENDPOINTS.seasonal, path, symbol, seasonalResponseSchema);
  return buildEnvelope<SeasonalData>({
    symbol: parsed.stock_code,
    tradingDate: localDateOnly(receivedAt, ctx.env.SESSION_TIMEZONE),
    eventTime: null,
    publishedAt: null,
    receivedAt,
    segment: "unknown",
    revisionId: null,
    declaredStatus: "final",
    data: normalizeSeasonal(parsed, localMonthIndex(receivedAt, ctx.env.SESSION_TIMEZONE))
  });
}

// ---------------------------------------------------------------------
// 7. GET /api/market-cap -- paginated whole-universe (page 1 by default)
// ---------------------------------------------------------------------
export async function getMarketCap(
  ctx: AdapterContext,
  page?: number
): Promise<{ asOf: string | null; totalPages: number; entries: DataEnvelope<MarketCapEntry>[] }> {
  const path = page && page > 1 ? `${ENDPOINTS.marketCap}?page=${page}` : ENDPOINTS.marketCap;
  const { parsed, receivedAt } = await fetchAndValidate(ctx, ENDPOINTS.marketCap, path, null, marketCapResponseSchema);
  const entries = normalizeMarketCapEntries(parsed).map((entry) =>
    buildEnvelope<MarketCapEntry>({
      symbol: entry.symbol,
      tradingDate: parsed.date ?? localDateOnly(receivedAt, ctx.env.SESSION_TIMEZONE),
      eventTime: null,
      publishedAt: null,
      receivedAt,
      segment: "unknown",
      revisionId: null,
      declaredStatus: "final",
      data: entry
    })
  );
  return { asOf: parsed.date ?? null, totalPages: parsed.total_pages ?? 1, entries };
}

// ---------------------------------------------------------------------
// 8. GET /api/search
// ---------------------------------------------------------------------
export async function search(ctx: AdapterContext, query: string): Promise<SearchResultEntry[]> {
  const path = `${ENDPOINTS.search}?q=${encodeURIComponent(query)}`;
  const { parsed } = await fetchAndValidate(ctx, ENDPOINTS.search, path, null, searchResponseSchema);
  return normalizeSearchResults(parsed);
}

// ---------------------------------------------------------------------
// 9. GET /api/health
// ---------------------------------------------------------------------
export async function getHealth(ctx: AdapterContext): Promise<HealthStatus> {
  const { parsed } = await fetchAndValidate(ctx, ENDPOINTS.health, ENDPOINTS.health, null, healthResponseSchema);
  return normalizeHealth(parsed);
}

// ---------------------------------------------------------------------
// 10. GET /api/financial-statements/{code}  (403 for API keys — callers must
//     tolerate an UpstreamHttpError from this one)
// ---------------------------------------------------------------------
export async function getFinancialStatements(
  ctx: AdapterContext,
  symbol: string
): Promise<DataEnvelope<FinancialStatementData>> {
  const path = ENDPOINTS.financialStatements.replace("{code}", symbol);
  const { parsed, receivedAt } = await fetchAndValidate(
    ctx,
    ENDPOINTS.financialStatements,
    path,
    symbol,
    financialStatementResponseSchema
  );
  return buildEnvelope<FinancialStatementData>({
    symbol: parsed.stock_code ?? parsed.symbol ?? symbol,
    tradingDate: localDateOnly(receivedAt, ctx.env.SESSION_TIMEZONE),
    eventTime: null,
    publishedAt: null,
    receivedAt,
    segment: "unknown",
    revisionId: parsed.fiscal_period ?? null,
    declaredStatus: "final",
    data: normalizeFinancialStatement(parsed)
  });
}

// ---------------------------------------------------------------------
// 11. GET /api/insiders/{code}
// ---------------------------------------------------------------------
export async function getInsiders(ctx: AdapterContext, symbol: string): Promise<DataEnvelope<InsiderTransaction[]>> {
  const path = ENDPOINTS.insiders.replace("{code}", symbol);
  const { parsed, receivedAt } = await fetchAndValidate(ctx, ENDPOINTS.insiders, path, symbol, insidersResponseSchema);
  const transactions = normalizeInsiders(parsed);
  const lastDate = transactions[transactions.length - 1]?.date ?? null;
  return buildEnvelope<InsiderTransaction[]>({
    symbol: parsed.stock_code,
    tradingDate: lastDate,
    eventTime: null,
    publishedAt: null,
    receivedAt,
    segment: "unknown",
    revisionId: null,
    data: transactions
  });
}
