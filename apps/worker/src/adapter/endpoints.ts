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
  normalizeScreenerRow,
  normalizeHistory,
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

/** Shared plumbing: call upstream, validate through the given schema, and
 * archive the raw payload either way (schemaValid true/false). Never
 * retries a schema-validation failure — that only happens after a
 * successful HTTP call, and callUpstream's own retry loop has already run
 * for transient HTTP failures. */
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
    // rawPayloadId isn't part of the error type but useful for logs/tests
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
// 1. GET /api/screener/latest -- whole-universe, top-funnel-only endpoint
// ---------------------------------------------------------------------
export async function getScreenerLatest(
  ctx: AdapterContext
): Promise<{ asOf: string; tradingDate: string | null; rows: DataEnvelope<ScreenerRow>[] }> {
  const { parsed, receivedAt } = await fetchAndValidate(
    ctx,
    ENDPOINTS.screenerLatest,
    ENDPOINTS.screenerLatest,
    null,
    screenerLatestResponseSchema
  );
  const rows = parsed.data.map((row) =>
    buildEnvelope<ScreenerRow>({
      symbol: row.symbol,
      tradingDate: parsed.trading_date ?? isoDateOnly(parsed.as_of),
      eventTime: parsed.as_of,
      publishedAt: parsed.as_of,
      receivedAt,
      segment: "unknown",
      revisionId: null,
      declaredStatus: parsed.status,
      data: normalizeScreenerRow(row)
    })
  );
  return { asOf: parsed.as_of, tradingDate: parsed.trading_date ?? null, rows };
}

// ---------------------------------------------------------------------
// 2. GET /api/analysis/{code}
// ---------------------------------------------------------------------
export async function getAnalysis(ctx: AdapterContext, symbol: string): Promise<DataEnvelope<AnalysisData>> {
  const path = ENDPOINTS.analysis.replace("{code}", symbol);
  const { parsed, receivedAt } = await fetchAndValidate(ctx, ENDPOINTS.analysis, path, symbol, analysisResponseSchema);
  return buildEnvelope<AnalysisData>({
    symbol: parsed.symbol,
    tradingDate: parsed.as_of ? isoDateOnly(parsed.as_of) : null,
    eventTime: parsed.as_of ?? null,
    publishedAt: parsed.as_of ?? null,
    receivedAt,
    segment: "unknown",
    revisionId: null,
    data: normalizeAnalysis(parsed)
  });
}

// ---------------------------------------------------------------------
// 3. GET /api/broker-summary/{code}
// ---------------------------------------------------------------------
export async function getBrokerSummary(
  ctx: AdapterContext,
  symbol: string
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
    symbol: parsed.symbol,
    tradingDate: parsed.trading_date,
    eventTime: null,
    publishedAt: null,
    receivedAt,
    segment: parsed.segment ?? "unknown",
    revisionId: null,
    declaredStatus: parsed.status,
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
  const lastDay = parsed.days[parsed.days.length - 1];
  return buildEnvelope<BrokerAccumulationData>({
    symbol: parsed.symbol,
    tradingDate: lastDay?.date ?? null,
    eventTime: null,
    publishedAt: null,
    receivedAt,
    segment: "unknown",
    revisionId: null,
    data: normalizeBrokerAccumulation(parsed)
  });
}

// ---------------------------------------------------------------------
// 5. GET /api/history/{code}
// ---------------------------------------------------------------------
export async function getHistory(ctx: AdapterContext, symbol: string): Promise<DataEnvelope<HistoryData>> {
  const path = ENDPOINTS.history.replace("{code}", symbol);
  const { parsed, receivedAt } = await fetchAndValidate(ctx, ENDPOINTS.history, path, symbol, historyResponseSchema);
  const lastBar = parsed.bars[parsed.bars.length - 1];
  return buildEnvelope<HistoryData>({
    symbol: parsed.symbol,
    tradingDate: lastBar?.date ?? null,
    eventTime: null,
    publishedAt: null,
    receivedAt,
    segment: "unknown",
    revisionId: null,
    data: normalizeHistory(parsed)
  });
}

// ---------------------------------------------------------------------
// 6. GET /api/seasonal/{code}
// ---------------------------------------------------------------------
export async function getSeasonal(ctx: AdapterContext, symbol: string): Promise<DataEnvelope<SeasonalData>> {
  const path = ENDPOINTS.seasonal.replace("{code}", symbol);
  const { parsed, receivedAt } = await fetchAndValidate(ctx, ENDPOINTS.seasonal, path, symbol, seasonalResponseSchema);
  return buildEnvelope<SeasonalData>({
    symbol: parsed.symbol,
    // seasonal data is a statistical aggregate, not tied to one trading date;
    // it is timestamped by receipt for freshness bookkeeping only.
    tradingDate: isoDateOnly(receivedAt),
    eventTime: null,
    publishedAt: null,
    receivedAt,
    segment: "unknown",
    revisionId: null,
    declaredStatus: "final",
    data: normalizeSeasonal(parsed)
  });
}

// ---------------------------------------------------------------------
// 7. GET /api/market-cap -- whole-universe
// ---------------------------------------------------------------------
export async function getMarketCap(
  ctx: AdapterContext
): Promise<{ asOf: string | null; entries: DataEnvelope<MarketCapEntry>[] }> {
  const { parsed, receivedAt } = await fetchAndValidate(
    ctx,
    ENDPOINTS.marketCap,
    ENDPOINTS.marketCap,
    null,
    marketCapResponseSchema
  );
  const entries = normalizeMarketCapEntries(parsed).map((entry) =>
    buildEnvelope<MarketCapEntry>({
      symbol: entry.symbol,
      tradingDate: parsed.as_of ? isoDateOnly(parsed.as_of) : null,
      eventTime: parsed.as_of ?? null,
      publishedAt: parsed.as_of ?? null,
      receivedAt,
      segment: "unknown",
      revisionId: null,
      declaredStatus: "final",
      data: entry
    })
  );
  return { asOf: parsed.as_of ?? null, entries };
}

// ---------------------------------------------------------------------
// 8. GET /api/search -- on-demand, no envelope/freshness semantics needed
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
// 10. GET /api/financial-statements/{code}
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
    symbol: parsed.symbol,
    tradingDate: isoDateOnly(receivedAt),
    eventTime: null,
    publishedAt: null,
    receivedAt,
    segment: "unknown",
    revisionId: parsed.fiscal_period,
    declaredStatus: "final",
    data: normalizeFinancialStatement(parsed)
  });
}

// ---------------------------------------------------------------------
// 11. GET /api/insiders/{code}
// ---------------------------------------------------------------------
export async function getInsiders(
  ctx: AdapterContext,
  symbol: string
): Promise<DataEnvelope<InsiderTransaction[]>> {
  const path = ENDPOINTS.insiders.replace("{code}", symbol);
  const { parsed, receivedAt } = await fetchAndValidate(ctx, ENDPOINTS.insiders, path, symbol, insidersResponseSchema);
  const transactions = normalizeInsiders(parsed);
  const lastDate = transactions[transactions.length - 1]?.date ?? null;
  return buildEnvelope<InsiderTransaction[]>({
    symbol,
    tradingDate: lastDate,
    eventTime: null,
    publishedAt: null,
    receivedAt,
    segment: "unknown",
    revisionId: null,
    data: transactions
  });
}
